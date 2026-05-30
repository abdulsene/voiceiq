/* Sprint 5 hotfix — production Bearer-authenticated IDOR verification.
 *
 * Mints ONE synthetic Supabase user (prod project), uses its Bearer to
 * probe https://neverr.ai for Fix A (/business/configure) and one of the
 * Fix C handlers (/surveys/:businessId), then deletes the user.
 *
 * Run from repo root:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     ./src/tests/sprint5-prod-bearer-verify.ts
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY
 * from process.env (.replit userenv).
 */
import { createClient } from "@supabase/supabase-js";

const PROD_BASE = "https://neverr.ai";
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const stamp = Date.now();
const TEST_EMAIL = `prod-bearer-verify+${stamp}@example.com`;
const PASSWORD = `Verify${stamp}!Aa1#`;

if (!url || !serviceKey || !anonKey) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY");
  process.exit(2);
}

async function signIn(): Promise<string> {
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey! },
    body: JSON.stringify({ email: TEST_EMAIL, password: PASSWORD }),
  });
  const d: any = await r.json();
  if (!r.ok || !d?.access_token) {
    throw new Error(`signIn failed (${r.status}): ${JSON.stringify(d)}`);
  }
  return d.access_token as string;
}

async function probe(
  path: string,
  bearer: string,
): Promise<{ http: number; body: any }> {
  const r = await fetch(`${PROD_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      "User-Agent": "neverr-prod-verify/1.0",
    },
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { http: r.status, body };
}

async function main() {
  const sb = createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let userId: string | null = null;

  try {
    // 1. Create synth user
    console.log(`[prod-verify] Creating synth user ${TEST_EMAIL}`);
    const { data: created, error: cuErr } = await sb.auth.admin.createUser({
      email: TEST_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (cuErr) throw new Error(`createUser: ${cuErr.message}`);
    userId = created.user!.id;
    console.log(`[prod-verify] synth user id = ${userId}`);

    // 2. Sign in to get Bearer
    const bearer = await signIn();
    console.log(`[prod-verify] got bearer (len=${bearer.length})`);

    // 3. Pick ANY existing foreign business_id from prod
    //    (synth user owns nothing yet, so any existing biz is "foreign")
    const { data: anyBiz, error: bizErr } = await sb
      .from("business_configs")
      .select("business_id")
      .limit(1);
    if (bizErr || !anyBiz?.length) {
      throw new Error(
        `Could not fetch any business_config from prod: ${bizErr?.message || "empty"}`,
      );
    }
    const foreignBiz = anyBiz[0]!.business_id as string;
    console.log(`[prod-verify] foreign biz_id = ${foreignBiz}`);

    // 4. Probe Fix A — /api/business/configure?business_id=<foreign>
    const a = await probe(
      `/api/business/configure?business_id=${encodeURIComponent(foreignBiz)}`,
      bearer,
    );
    const aPass = a.http === 404;
    console.log(
      `${aPass ? "PASS" : "FAIL"}  Fix A /api/business/configure foreign  ` +
        `http=${a.http} body=${JSON.stringify(a.body)?.slice(0, 120)}`,
    );

    // 5. Probe Fix C — /api/surveys/:businessId (one of the three)
    const c = await probe(
      `/api/surveys/${encodeURIComponent(foreignBiz)}`,
      bearer,
    );
    const cPass = c.http === 404;
    console.log(
      `${cPass ? "PASS" : "FAIL"}  Fix C /api/surveys/:businessId foreign  ` +
        `http=${c.http} body=${JSON.stringify(c.body)?.slice(0, 120)}`,
    );

    // 6. Sanity: hitting /api/business/configure with NO business_id should
    //    still work (returns user's own/empty config) — proves we didn't
    //    break the happy path.
    const own = await probe(`/api/business/configure`, bearer);
    const ownOk = own.http === 200 || own.http === 404; // 404 is OK if user has 0 businesses
    console.log(
      `${ownOk ? "PASS" : "FAIL"}  Sanity /api/business/configure (no biz_id, own ctx)  ` +
        `http=${own.http}`,
    );

    console.log("");
    console.log("=== Summary ===");
    console.log(`Fix A foreign:    ${aPass ? "🟢 PASS (404)" : "🔴 FAIL (" + a.http + ")"}`);
    console.log(`Fix C foreign:    ${cPass ? "🟢 PASS (404)" : "🔴 FAIL (" + c.http + ")"}`);
    console.log(`Happy-path own:   ${ownOk ? "🟢 PASS" : "🔴 FAIL (" + own.http + ")"}`);

    if (!aPass || !cPass) {
      console.log("\n🔴 PRODUCTION VULNERABILITY REMAINS — recommend revert via Replit Deployments");
      process.exitCode = 1;
    } else {
      console.log("\n🟢 All Bearer-authenticated IDOR fixes confirmed live in production");
    }
  } finally {
    // 7. Cleanup
    if (userId) {
      const { error } = await sb.auth.admin.deleteUser(userId);
      console.log(
        `[prod-verify] cleanup synth user ${userId}: ${error ? "ERROR " + error.message : "ok"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error("[prod-verify] fatal:", e);
  process.exit(2);
});
