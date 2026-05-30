import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const WIDGET_QUALIFYING_PLANS = ["growth", "business", "enterprise"];

let initialized = false;
export async function ensureWidgetTables() {
  if (initialized) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS widget_configs (
        business_id TEXT PRIMARY KEY,
        enabled BOOLEAN DEFAULT true,
        addon_purchased BOOLEAN DEFAULT false,
        color TEXT DEFAULT '#2E75B6',
        position TEXT DEFAULT 'bottom-right',
        delay_seconds INTEGER DEFAULT 3,
        greeting TEXT,
        agent_name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS widget_events (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        business_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        page_url TEXT,
        conversation_id TEXT,
        duration_seconds INTEGER,
        lead_name TEXT,
        lead_phone TEXT,
        topic TEXT,
        booking_made BOOLEAN DEFAULT false,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS widget_events_business_idx ON widget_events(business_id, created_at DESC)`
    );
    initialized = true;
    console.log("[Widget] Tables ensured");
  } catch (err: any) {
    console.error("[Widget] Table init error:", err.message);
  }
}

export async function getWidgetConfig(businessId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM widget_configs WHERE business_id = $1`,
    [businessId]
  );
  return rows[0] || null;
}

export async function upsertWidgetConfig(
  businessId: string,
  patch: Partial<{
    enabled: boolean;
    color: string;
    position: string;
    delay_seconds: number;
    greeting: string;
    agent_name: string;
    addon_purchased: boolean;
  }>
) {
  const existing = await getWidgetConfig(businessId);
  if (!existing) {
    await pool.query(
      `INSERT INTO widget_configs (business_id, enabled, color, position, delay_seconds, greeting, agent_name, addon_purchased)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        businessId,
        patch.enabled ?? true,
        patch.color ?? "#2E75B6",
        patch.position ?? "bottom-right",
        patch.delay_seconds ?? 3,
        patch.greeting ?? null,
        patch.agent_name ?? null,
        patch.addon_purchased ?? false,
      ]
    );
  } else {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v);
    }
    if (fields.length === 0) return getWidgetConfig(businessId);
    fields.push(`updated_at = NOW()`);
    values.push(businessId);
    await pool.query(
      `UPDATE widget_configs SET ${fields.join(", ")} WHERE business_id = $${i}`,
      values
    );
  }
  return getWidgetConfig(businessId);
}

export async function recordWidgetEvent(opts: {
  business_id: string;
  event_type: "open" | "conversation_start" | "conversation_end" | "lead_captured" | "booking";
  page_url?: string;
  conversation_id?: string;
  duration_seconds?: number;
  lead_name?: string;
  lead_phone?: string;
  topic?: string;
  booking_made?: boolean;
  metadata?: any;
}) {
  await pool.query(
    `INSERT INTO widget_events (business_id, event_type, page_url, conversation_id, duration_seconds, lead_name, lead_phone, topic, booking_made, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      opts.business_id,
      opts.event_type,
      opts.page_url || null,
      opts.conversation_id || null,
      opts.duration_seconds || null,
      opts.lead_name || null,
      opts.lead_phone || null,
      opts.topic || null,
      opts.booking_made || false,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ]
  );
}

export async function getWidgetAnalytics(businessId: string, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [openRes, convRes, leadRes, bookRes, durRes, pagesRes, topicsRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM widget_events WHERE business_id=$1 AND event_type='open' AND created_at >= $2`, [businessId, since]),
    pool.query(`SELECT COUNT(*)::int AS n FROM widget_events WHERE business_id=$1 AND event_type='conversation_start' AND created_at >= $2`, [businessId, since]),
    pool.query(`SELECT COUNT(*)::int AS n FROM widget_events WHERE business_id=$1 AND event_type='lead_captured' AND created_at >= $2`, [businessId, since]),
    pool.query(`SELECT COUNT(*)::int AS n FROM widget_events WHERE business_id=$1 AND booking_made = true AND created_at >= $2`, [businessId, since]),
    pool.query(`SELECT COALESCE(AVG(duration_seconds),0)::int AS avg FROM widget_events WHERE business_id=$1 AND event_type='conversation_end' AND duration_seconds > 0 AND created_at >= $2`, [businessId, since]),
    pool.query(`SELECT page_url, COUNT(*)::int AS n FROM widget_events WHERE business_id=$1 AND page_url IS NOT NULL AND created_at >= $2 GROUP BY page_url ORDER BY n DESC LIMIT 5`, [businessId, since]),
    pool.query(`SELECT topic, COUNT(*)::int AS n FROM widget_events WHERE business_id=$1 AND topic IS NOT NULL AND created_at >= $2 GROUP BY topic ORDER BY n DESC LIMIT 5`, [businessId, since]),
  ]);
  return {
    opens: openRes.rows[0].n,
    conversations: convRes.rows[0].n,
    leads: leadRes.rows[0].n,
    bookings: bookRes.rows[0].n,
    avgDuration: durRes.rows[0].avg,
    topPages: pagesRes.rows,
    topQuestions: topicsRes.rows,
  };
}

export function planQualifies(planId?: string | null): boolean {
  if (!planId) return false;
  return WIDGET_QUALIFYING_PLANS.includes(planId.toLowerCase());
}

ensureWidgetTables();
