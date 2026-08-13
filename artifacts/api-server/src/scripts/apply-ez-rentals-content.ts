/**
 * Phase 6.2 — one-shot loader for EZ Rentals & Leasing tenant content.
 *
 * Writes tenant-authored answers (custom_faqs, never_say_list,
 * objection_handling) plus corrected identity (business_name,
 * business_hours text) into business_configs, and replaces the
 * business_hours-table schedule so the routing engine's is_open check
 * treats Sunday as closed.
 *
 * NOT a schema migration. Idempotent — safe to run multiple times.
 * Does NOT touch ElevenLabs. After running this, invoke the existing
 * scripts/resync-agent-prompt.ts to re-render + sync the agent prompt.
 *
 * Usage:
 *   # 1. Preview only — prints current-vs-new for every field, writes nothing.
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/apply-ez-rentals-content.ts <business_id> --dry-run
 *
 *   # 2. Apply.
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/apply-ez-rentals-content.ts <business_id>
 *
 *   # 3. Resync agent (existing script — re-renders + PATCHes ElevenLabs).
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/resync-agent-prompt.ts <business_id>
 *
 *   # 4. Measure post-load prompt size.
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/measure-prompt-blocks.ts <business_id>
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 *
 * Content sourced from the tenant's Phase 6.2 answers — see
 * conversation history for authoritative wording. Address lives in
 * a FAQ because business_configs has no dedicated column; Sunday
 * nuance is reinforced in three places (business_hours text + FAQ +
 * never_say_list) so Alex has consistent guidance regardless of
 * which block she pulls from.
 *
 * Exit codes:
 *   0 — success (or dry-run completed)
 *   1 — env missing / arg missing
 *   2 — business_configs row not found
 *   3 — write failed
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── Tenant-authored content (Phase 6.2) ─────────────────────────────

const BUSINESS_NAME = "EZ Rentals And Leasing";

// Alex-spoken hours string. Hours are hours — the Sunday operational
// nuance (no in-person services) lives in the "Are you open on
// Sunday?" FAQ and the never_say_list, not in this line. Keeping this
// string clean means BUSINESS INFORMATION doesn't conflict with the
// FAQ block if the tenant edits one and forgets the other.
const BUSINESS_HOURS_TEXT =
  "Mon-Fri 10:00 AM - 6:00 PM. Sat 10:00 AM - 4:00 PM. Sun 10:00 AM - 6:00 PM.";

// business_hours table rows. 0=Sunday. Sunday is OPEN 10-6 — staff
// are on the phone handling payments, answering questions, and
// booking appointments for Monday pickups. If we marked Sunday
// is_closed=true, the routing engine's is_open check would return
// false and every Sunday route_to_topic would fall through to
// after_hours_callback — leaving a caller in message-taking mode
// while a staff member sits there ready to help. The Sunday
// operational restrictions (no same-day pickups, no new contracts,
// no maintenance) are conveyed via the Sunday FAQ + never_say_list
// bullet, not via the hours table.
interface HoursRow {
  day_of_week: number;
  opens_at: string | null;
  closes_at: string | null;
  timezone: string;
  is_closed: boolean;
}
const TIMEZONE = "America/New_York";
const HOURS_ROWS: HoursRow[] = [
  { day_of_week: 0, opens_at: "10:00:00", closes_at: "18:00:00", timezone: TIMEZONE, is_closed: false }, // Sun
  { day_of_week: 1, opens_at: "10:00:00", closes_at: "18:00:00", timezone: TIMEZONE, is_closed: false }, // Mon
  { day_of_week: 2, opens_at: "10:00:00", closes_at: "18:00:00", timezone: TIMEZONE, is_closed: false }, // Tue
  { day_of_week: 3, opens_at: "10:00:00", closes_at: "18:00:00", timezone: TIMEZONE, is_closed: false }, // Wed
  { day_of_week: 4, opens_at: "10:00:00", closes_at: "18:00:00", timezone: TIMEZONE, is_closed: false }, // Thu
  { day_of_week: 5, opens_at: "10:00:00", closes_at: "18:00:00", timezone: TIMEZONE, is_closed: false }, // Fri
  { day_of_week: 6, opens_at: "10:00:00", closes_at: "16:00:00", timezone: TIMEZONE, is_closed: false }, // Sat
];

const CUSTOM_FAQS: Array<{ question: string; answer: string }> = [
  {
    question: "Where are you located?",
    answer:
      "4641 Reisterstown Road, Baltimore, Maryland, 21215.",
  },
  {
    question: "What vehicles do you have?",
    answer:
      "Full-size sedans and some SUVs. You take whatever is available at pickup — we don't reserve a specific vehicle in advance.",
  },
  {
    question: "Do you have anything available today?",
    answer:
      "Yes, we have vehicles available right now.",
  },
  {
    question: "What does it cost?",
    answer:
      "A flat ninety-five dollars a day, taxes and fees included. Unlimited mileage.",
  },
  {
    question: "Do you have any deals or promotions?",
    answer:
      "Yes — pay six days upfront and the seventh day is free.",
  },
  {
    question: "How much is the deposit and when do I get it back?",
    answer:
      "Seventy dollars. Refunded twenty business days after you return the vehicle — that's how long tickets and tolls take to process.",
  },
  {
    question: "What if I return the car late?",
    answer:
      "You pay for an extra day, or it comes out of your deposit.",
  },
  {
    question: "Is there a mileage limit?",
    answer:
      "No — unlimited mileage.",
  },
  {
    question: "Can I extend my rental?",
    answer:
      "Yes, you can extend day-by-day. We send a payment link each day you want to continue.",
  },
  {
    question: "What do I need to bring?",
    answer:
      "Just a valid driver's license.",
  },
  {
    question: "Are you open on Sunday?",
    answer:
      "Yes — Sunday 10 AM to 6 PM by phone. We handle payments, answer questions, and can book an appointment for you to pick up a car on Monday. What we don't do on Sundays is same-day pickups, new contracts, or maintenance — those are Monday through Saturday.",
  },
];

const NEVER_SAY_LIST: string[] = [
  "Discuss the vehicles-for-sale side of the business. If a caller asks about buying a car, invoke request_callback so someone can call them back.",
  "Tell a caller we are out of vehicles.",
  "Tell a caller we are open Sunday for pickups, new contracts, or maintenance — those services are Mon-Sat only.",
  "Negotiate on the security deposit or the daily rate — both are non-negotiable.",
];

const OBJECTION_HANDLING: Array<{ objection: string; response: string }> = [
  {
    objection:
      "That's too expensive / Can you give me a better rate?",
    response:
      "Open with: 'We're cheaper and more flexible than any rental car company in Baltimore.' Then state what's included: flat $95/day with taxes and fees included, unlimited mileage, daily extensions, and pay-six-get-one-free. Do not offer a discount.",
  },
  {
    objection:
      "Can you waive the deposit / lower the rate / make an exception?",
    response:
      "The $70 deposit and the $95 daily rate are non-negotiable. Say it once, politely. Do NOT soften the answer if they ask a second time. If they keep pushing, invoke request_callback so the owner can decide — do not offer any concession yourself.",
  },
  {
    objection:
      "I need the car today but I can't pay until tomorrow / Can you hold it overnight?",
    response:
      "Payment is due by 3pm the day of the rental — we cannot hold a vehicle without payment. This is a temporary disqualifier: invoke request_callback with disqualifier_id 'cannot_pay_by_3pm' so the team can reach back when they're ready to pay.",
  },
  {
    objection:
      "I'm just going into DC for one appointment / I'll only cross the state line once",
    response:
      "Our vehicles cannot enter DC under any circumstances — not once, not for a moment. This is a permanent disqualifier: invoke request_callback with disqualifier_id 'restricted_state' and thank them for calling.",
  },
];

// ── Runtime ─────────────────────────────────────────────────────────

interface BusinessConfigRow {
  business_id: string;
  business_name: string | null;
  business_hours: string | null;
  custom_faqs: unknown;
  never_say_list: unknown;
  objection_handling: unknown;
}

const SELECT_COLUMNS =
  "business_id, business_name, business_hours, custom_faqs, never_say_list, objection_handling";

function requireEnv(): { supaUrl: string; supaKey: string } {
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) {
    console.error("[apply] missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    process.exit(1);
  }
  return { supaUrl, supaKey };
}

function fmtValue(v: unknown): string {
  if (v == null) return "(null)";
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 117)}...` : v;
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (typeof v === "object") return `{${Object.keys(v).length} keys}`;
  return String(v);
}

function printDiff(current: BusinessConfigRow): void {
  console.log("");
  console.log("── business_configs field diff ─────────────────────────────");
  const rows: Array<[string, unknown, unknown]> = [
    ["business_name",      current.business_name,      BUSINESS_NAME],
    ["business_hours",     current.business_hours,     BUSINESS_HOURS_TEXT],
    ["custom_faqs",        current.custom_faqs,        CUSTOM_FAQS],
    ["never_say_list",     current.never_say_list,     NEVER_SAY_LIST],
    ["objection_handling", current.objection_handling, OBJECTION_HANDLING],
  ];
  for (const [field, cur, next] of rows) {
    console.log("");
    console.log(`  ${field}`);
    console.log(`    now:  ${fmtValue(cur)}`);
    console.log(`    next: ${fmtValue(next)}`);
  }
  console.log("");
  console.log("── business_hours table rows (delete+insert) ───────────────");
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const r of HOURS_ROWS) {
    const label = r.is_closed
      ? "closed"
      : `${r.opens_at} - ${r.closes_at} ${r.timezone}`;
    console.log(`    ${dayNames[r.day_of_week]}  ${label}`);
  }
  console.log("");
}

async function readCurrent(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessConfigRow | null> {
  const { data, error } = await supabase
    .from("business_configs")
    .select(SELECT_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) {
    console.error(`[apply] business_configs read failed: ${error.message}`);
    process.exit(2);
  }
  return (data as BusinessConfigRow | null) ?? null;
}

async function applyBusinessConfigs(
  supabase: SupabaseClient,
  businessId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("business_configs")
    .update({
      business_name: BUSINESS_NAME,
      business_hours: BUSINESS_HOURS_TEXT,
      custom_faqs: CUSTOM_FAQS,
      never_say_list: NEVER_SAY_LIST,
      objection_handling: OBJECTION_HANDLING,
      prompt_helpers_dirty_at: nowIso,
    })
    .eq("business_id", businessId);
  if (error) {
    console.error(`[apply] business_configs update failed: ${error.message}`);
    process.exit(3);
  }
  console.log(`[apply] business_configs updated (prompt_helpers_dirty_at=${nowIso})`);
}

async function applyBusinessHoursRows(
  supabase: SupabaseClient,
  businessId: string,
): Promise<void> {
  // Delete+insert mirrors the pattern in routes/hours.ts:handlePatchHours.
  const del = await supabase.from("business_hours").delete().eq("business_id", businessId);
  if (del.error) {
    console.error(`[apply] business_hours delete failed: ${del.error.message}`);
    process.exit(3);
  }
  const insertRows = HOURS_ROWS.map((r) => ({ business_id: businessId, ...r }));
  const ins = await supabase.from("business_hours").insert(insertRows);
  if (ins.error) {
    console.error(`[apply] business_hours insert failed: ${ins.error.message}`);
    process.exit(3);
  }
  console.log(`[apply] business_hours: 7 rows written (Sunday closed)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const businessId = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!businessId) {
    console.error("[apply] usage: tsx apply-ez-rentals-content.ts <business_id> [--dry-run]");
    process.exit(1);
  }

  const env = requireEnv();
  const supabase = createClient(env.supaUrl, env.supaKey, { auth: { persistSession: false } });

  console.log(`[apply] business_id=${businessId}${dryRun ? "  (DRY RUN)" : ""}`);

  const current = await readCurrent(supabase, businessId);
  if (!current) {
    console.error(`[apply] business_configs row not found for ${businessId}`);
    process.exit(2);
  }

  printDiff(current);

  if (dryRun) {
    console.log("[apply] dry-run — no writes performed.");
    return;
  }

  await applyBusinessConfigs(supabase, businessId);
  await applyBusinessHoursRows(supabase, businessId);

  console.log("");
  console.log("[apply] done. Next steps:");
  console.log(`  1. pnpm --filter @workspace/api-server exec tsx src/scripts/resync-agent-prompt.ts ${businessId}`);
  console.log(`  2. pnpm --filter @workspace/api-server exec tsx src/scripts/measure-prompt-blocks.ts ${businessId}`);
}

main().catch((err) => {
  console.error("[apply] unexpected:", err?.message || err);
  process.exit(1);
});
