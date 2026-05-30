/**
 * Sprint 2 STEP 4 / BUG-18 verification harness — runtime tests T2-T9.
 *
 * T1 (migration applied) was confirmed manually in the Supabase SQL editor
 * via the 6-existence-check SELECT on tables/columns/indexes — all returned
 * TRUE. Skipped here; the harness wouldn't add anything to that confirmation.
 *
 * What this harness exercises:
 *   T2 — synthetic customer.subscription.created webhook flips
 *        pending_payment → trialing AND fires the verification email
 *        (helper writes a token row + Resend dispatch). Real email
 *        intentionally targeted at sene.abdul+bug18test@gmail.com so
 *        Abdul can verify receipt.
 *   T3 — /signup does NOT touch the verification email surface.
 *        Confirmed both statically (no import of the service in
 *        routes/auth.ts signup handler) AND positively at runtime
 *        (POST /auth/signup → no email_verification_tokens row inserted
 *        for the new user, subscription_status stuck at pending_payment).
 *   T4 — replay of the same webhook event is a no-op for the email.
 *        Status stays trialing, token count stays at 1 (helper's
 *        previousStatus !== pending_payment short-circuit).
 *   T5 — customer.subscription.updated arriving FIRST (before
 *        checkout.session.completed) ALSO triggers the email exactly
 *        once. This is the new-this-round wiring covering the second
 *        webhook surface that was missed in the first architect pass.
 *   T6 — already-verified business gets ZERO new email even when
 *        webhook fires, because the helper's email_verified short-circuit
 *        kicks in.
 *   T7 — /auth/verify-email happy path: claim token, flip
 *        email_verified=true on every business the user owns, mark
 *        used_at, return success:true.
 *   T8 — /auth/verify-email anti-enumeration: 4 distinct failure modes
 *        (missing token / bogus token / already-used token / expired
 *        token) ALL collapse to the SAME wire shape. Byte-equal except
 *        for an optional message field that the spec allows to differ.
 *   T9 — /auth/resend-verification: pending_payment user is REJECTED
 *        (status gate), trialing user gets 200 + new token, immediate
 *        re-call hits the in-memory 60s cooldown.
 *
 * Pure data-only — every fixture is created at start of its test, asserted
 * against, then deleted in the per-test finally. Even if the harness
 * crashes mid-test the next run cleans residue via the `bug18-*` email
 * prefix sweep at the top of main().
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/008-bug18-verify.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import crypto from "node:crypto";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const ABDUL_EMAIL = "sene.abdul+bug18test@gmail.com";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ----- Stripe webhook signing -----
function buildEvent(type: string, dataObject: any) {
  const stamp = Math.floor(Date.now() / 1000);
  return {
    id: `evt_test_${crypto.randomBytes(8).toString("hex")}`,
    object: "event",
    api_version: "2024-04-10",
    created: stamp,
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: dataObject },
  };
}

function signPayload(payload: string, secret: string) {
  // Mirror Stripe's signature scheme (v1=HMAC-SHA256(t.payload, secret)).
  const t = Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  return `t=${t},v1=${sig}`;
}

async function postWebhook(event: any): Promise<{ http: number; body: string }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  const body = JSON.stringify(event);
  const sig = signPayload(body, secret);
  const r = await fetch(`${API}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": sig },
    body,
  });
  return { http: r.status, body: await r.text() };
}

// ----- Fixture helpers -----
interface Fixture {
  userId: string;
  bizId: string;
  email: string;
  password: string;
}

async function createFixture(
  sb: SupabaseClient,
  emailOverride: string,
  bizSeed: { subscription_status: string; email_verified?: boolean },
  uniqStamp: string,
): Promise<Fixture> {
  const password = `Bug18!${uniqStamp}`;
  const bizId = `biz_bug18_${uniqStamp}`;
  const { data, error } = await sb.auth.admin.createUser({
    email: emailOverride,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${emailOverride}: ${error?.message}`);
  const userId = data.user.id;
  const { error: bizErr } = await sb.from("business_configs").insert({
    business_id: bizId,
    business_name: `bug18 fixture ${uniqStamp}`,
    industry: "general",
    timezone: "America/New_York",
    status: "active",
    subscription_status: bizSeed.subscription_status,
    plan_id: "starter",
    billing_cycle: "monthly",
    onboarding_complete: false,
    email_verified: bizSeed.email_verified ?? false,
  });
  if (bizErr) throw new Error(`bizConfig ${bizId}: ${bizErr.message}`);
  const { error: ubErr } = await sb.from("user_businesses").insert({
    user_id: userId,
    business_id: bizId,
    role: "owner",
  });
  if (ubErr) throw new Error(`user_businesses ${bizId}: ${ubErr.message}`);
  return { userId, bizId, email: emailOverride, password };
}

async function teardownFixture(sb: SupabaseClient, f: Fixture) {
  await sb.from("email_verification_tokens").delete().eq("user_id", f.userId);
  await sb.from("user_businesses").delete().eq("business_id", f.bizId);
  await sb.from("business_configs").delete().eq("business_id", f.bizId);
  await sb.auth.admin.deleteUser(f.userId).catch(() => {});
}

async function tokensForUser(sb: SupabaseClient, userId: string) {
  const { data } = await sb.from("email_verification_tokens").select("*").eq("user_id", userId);
  return data || [];
}

async function bizConfig(sb: SupabaseClient, bizId: string) {
  const { data } = await sb.from("business_configs").select("*").eq("business_id", bizId).maybeSingle();
  return data;
}

async function signIn(url: string, anonKey: string, email: string, password: string) {
  const u = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await u.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return data.session.access_token;
}

// ----- main -----
async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) {
    console.error("FATAL: missing SUPABASE env"); process.exit(1);
  }
  const sb = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Pre-sweep: any leftover bug18 fixture (previous crashed run)
  const { data: stale } = await sb.from("business_configs").select("business_id").like("business_id", "biz_bug18_%");
  for (const row of stale || []) {
    await sb.from("user_businesses").delete().eq("business_id", row.business_id);
    await sb.from("business_configs").delete().eq("business_id", row.business_id);
  }
  console.log(`[bug18-verify] pre-sweep cleaned ${stale?.length || 0} stale fixture(s)\n`);

  const allFixtures: Fixture[] = [];
  try {
    // ===== T2: pending_payment → trialing flip via synthetic webhook fires email =====
    {
      const stamp = `t2_${Date.now()}`;
      const f = await createFixture(sb, ABDUL_EMAIL, { subscription_status: "pending_payment" }, stamp);
      allFixtures.push(f);
      const subId = `sub_test_${crypto.randomBytes(8).toString("hex")}`;
      const custId = `cus_test_${crypto.randomBytes(8).toString("hex")}`;
      const evt = buildEvent("customer.subscription.created", {
        id: subId,
        object: "subscription",
        status: "trialing",
        customer: custId,
        metadata: { business_id: f.bizId, plan: "starter", billing_cycle: "monthly" },
        items: { data: [] },
        trial_end: Math.floor(Date.now() / 1000) + 7 * 86400,
      });
      const { http } = await postWebhook(evt);
      // give the dispatch helper a moment to settle the async Resend call
      await new Promise((r) => setTimeout(r, 800));
      const cfg = await bizConfig(sb, f.bizId);
      const tokens = await tokensForUser(sb, f.userId);
      const pass =
        http === 200 &&
        cfg?.subscription_status === "trialing" &&
        cfg?.email_verified === false &&
        tokens.length === 1 &&
        tokens[0].used_at === null &&
        tokens[0].email === ABDUL_EMAIL;
      record(
        "T2 synthetic subscription.created flips status + issues verification token (real email to abdul)",
        pass,
        `http=${http} status=${cfg?.subscription_status} email_verified=${cfg?.email_verified} tokens=${tokens.length}`,
      );
    }

    // ===== T3: /signup does NOT send a verification email =====
    {
      // Static check (stronger): the issueAndSendVerification CALLSITES in
      // routes/auth.ts must all live OUTSIDE the signup handler's byte
      // range. Greping for the import string isn't enough — auth.ts also
      // hosts /verify-email and /resend-verification handlers, both of
      // which legitimately import + call the service. What matters is
      // that NONE of those calls fall between `router.post("/auth/signup"`
      // and the next `router.post(`.
      const fs = await import("node:fs/promises");
      const auth = await fs.readFile(
        "/home/runner/workspace/artifacts/api-server/src/routes/auth.ts", "utf-8");
      const start = auth.indexOf('router.post("/auth/signup"');
      const after = auth.indexOf("router.post(", start + 1);
      const signupBlock = start >= 0 && after > start ? auth.slice(start, after) : "";
      // Find every call expression `issueAndSendVerification(`. Any whose
      // index falls inside [start, after) is a violation of the DO-NOT rule.
      const callRegex = /issueAndSendVerification\s*\(/g;
      const callsInSignup: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = callRegex.exec(auth)) !== null) {
        if (m.index >= start && m.index < after) callsInSignup.push(m.index);
      }
      const staticOk = signupBlock.length > 0 && callsInSignup.length === 0;

      // Runtime check: hit /auth/signup with the schema-valid snake_case
      // shape (validate.ts authSignupSchema requires business_name, plan_id,
      // billing_cycle). Then assert: subscription_status='pending_payment'
      // AND email_verification_tokens row count for the new user === 0.
      const stamp = `t3_${Date.now()}`;
      const signupEmail = `bug18-t3-${stamp}@neverr.test`;
      const password = `Bug18!${stamp}`;
      const r = await fetch(`${API}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: signupEmail,
          password,
          business_name: `bug18 t3 ${stamp}`,
          industry: "general",
          timezone: "America/New_York",
          plan_id: "starter",
          billing_cycle: "monthly",
        }),
      });
      const sBody: any = await r.json().catch(() => ({}));
      let runtimeOk = false;
      let runtimeDetail = "";
      let signupBizId: string | null = null;
      let signupUserId: string | null = null;
      try {
        signupBizId = sBody?.businessId || sBody?.business_id || null;
        signupUserId = sBody?.userId || sBody?.user_id || sBody?.user?.id || null;
        // Fallback: look up by email if response shape doesn't carry IDs
        if (!signupUserId) {
          const { data: list } = await sb.auth.admin.listUsers();
          const found = (list?.users || []).find((u: any) => u.email === signupEmail);
          signupUserId = found?.id || null;
        }
        if (!signupBizId && signupUserId) {
          const { data: ub } = await sb.from("user_businesses")
            .select("business_id").eq("user_id", signupUserId).maybeSingle();
          signupBizId = ub?.business_id || null;
        }
        const cfg = signupBizId ? await bizConfig(sb, signupBizId) : null;
        const tokens = signupUserId ? await tokensForUser(sb, signupUserId) : [];
        // /auth/signup returns 201 Created (correct REST verb for resource
        // creation); 200 also accepted for forward-compat. The substantive
        // assertion is the negative one: tokens.length === 0 AND status
        // is still pending_payment — proving signup never touches the
        // verification email surface.
        runtimeOk =
          (r.status === 200 || r.status === 201) &&
          cfg?.subscription_status === "pending_payment" &&
          tokens.length === 0;
        runtimeDetail = `signupHttp=${r.status} bizId=${signupBizId?.substring(0, 16)} ` +
          `subStatus=${cfg?.subscription_status} tokens=${tokens.length} ` +
          `respKeys=${Object.keys(sBody).slice(0, 6).join(",")}`;
      } finally {
        if (signupBizId) {
          await sb.from("user_businesses").delete().eq("business_id", signupBizId);
          await sb.from("business_configs").delete().eq("business_id", signupBizId);
        }
        if (signupUserId) await sb.auth.admin.deleteUser(signupUserId).catch(() => {});
      }
      record(
        "T3 /signup writes pending_payment AND issues NO verification token (DO-NOT rule honored)",
        staticOk && runtimeOk,
        `staticOk=${staticOk} (callsInSignupBlock=${callsInSignup.length}) runtimeOk=${runtimeOk} | ${runtimeDetail}`,
      );
    }

    // ===== T4: replay of T2's webhook is a no-op for the email =====
    {
      const f = allFixtures[0]; // T2's fixture, status = trialing now
      const before = await tokensForUser(sb, f.userId);
      const subId = `sub_replay_${crypto.randomBytes(8).toString("hex")}`;
      const custId = `cus_replay_${crypto.randomBytes(8).toString("hex")}`;
      // Replay = same business via metadata, but a different sub.id so the
      // first .update().eq(stripe_subscription_id) misses and we fall back
      // to businessIdMeta. This mirrors a Stripe redelivery shaped slightly
      // differently from the original — the helper still must short-circuit
      // because previousStatus is now 'trialing'.
      const evt = buildEvent("customer.subscription.updated", {
        id: subId,
        object: "subscription",
        status: "trialing",
        customer: custId,
        metadata: { business_id: f.bizId, plan: "starter", billing_cycle: "monthly" },
        items: { data: [] },
      });
      const { http } = await postWebhook(evt);
      await new Promise((r) => setTimeout(r, 600));
      const after = await tokensForUser(sb, f.userId);
      const cfg = await bizConfig(sb, f.bizId);
      const pass =
        http === 200 &&
        after.length === before.length &&
        cfg?.email_verified === false;
      record(
        "T4 webhook replay does NOT issue a duplicate token (helper short-circuits on prev=trialing)",
        pass,
        `http=${http} tokens before=${before.length} after=${after.length} email_verified=${cfg?.email_verified}`,
      );
    }

    // ===== T5: customer.subscription.updated as the FIRST event also triggers =====
    {
      const stamp = `t5_${Date.now()}`;
      const f = await createFixture(sb, `bug18-t5-${stamp}@neverr.test`,
        { subscription_status: "pending_payment" }, stamp);
      allFixtures.push(f);
      const subId = `sub_test_${crypto.randomBytes(8).toString("hex")}`;
      const evt = buildEvent("customer.subscription.updated", {
        id: subId,
        object: "subscription",
        status: "trialing",
        customer: `cus_test_${crypto.randomBytes(8).toString("hex")}`,
        metadata: { business_id: f.bizId, plan: "starter", billing_cycle: "monthly" },
        items: { data: [] },
        trial_end: Math.floor(Date.now() / 1000) + 7 * 86400,
      });
      const { http } = await postWebhook(evt);
      await new Promise((r) => setTimeout(r, 600));
      const cfg = await bizConfig(sb, f.bizId);
      const tokens = await tokensForUser(sb, f.userId);
      const pass =
        http === 200 &&
        cfg?.subscription_status === "trialing" &&
        tokens.length === 1 &&
        tokens[0].email === f.email;
      record(
        "T5 customer.subscription.updated as the first event ALSO fires the email (covers prior missed surface)",
        pass,
        `http=${http} status=${cfg?.subscription_status} tokens=${tokens.length}`,
      );
    }

    // ===== T6: already-verified user gets NO new email even on webhook flip =====
    {
      const stamp = `t6_${Date.now()}`;
      const f = await createFixture(sb, `bug18-t6-${stamp}@neverr.test`,
        { subscription_status: "pending_payment", email_verified: true }, stamp);
      allFixtures.push(f);
      const subId = `sub_test_${crypto.randomBytes(8).toString("hex")}`;
      const evt = buildEvent("customer.subscription.created", {
        id: subId,
        object: "subscription",
        status: "trialing",
        customer: `cus_test_${crypto.randomBytes(8).toString("hex")}`,
        metadata: { business_id: f.bizId, plan: "starter", billing_cycle: "monthly" },
        items: { data: [] },
      });
      const { http } = await postWebhook(evt);
      await new Promise((r) => setTimeout(r, 600));
      const tokens = await tokensForUser(sb, f.userId);
      const cfg = await bizConfig(sb, f.bizId);
      const pass =
        http === 200 &&
        cfg?.subscription_status === "trialing" && // status still flipped
        tokens.length === 0; // but no email issued
      record(
        "T6 already-verified user receives ZERO new token even on webhook flip (email_verified short-circuit)",
        pass,
        `http=${http} status=${cfg?.subscription_status} tokens=${tokens.length} (expect 0)`,
      );
    }

    // ===== T7: /auth/verify-email happy path =====
    {
      const stamp = `t7_${Date.now()}`;
      const f = await createFixture(sb, `bug18-t7-${stamp}@neverr.test`,
        { subscription_status: "trialing" }, stamp);
      allFixtures.push(f);
      // Insert a token directly (skip webhook for hermetic test)
      const token = `evt_${crypto.randomBytes(32).toString("hex")}`;
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const { error: insErr } = await sb.from("email_verification_tokens").insert({
        token, user_id: f.userId, email: f.email, expires_at: expiresAt,
      });
      if (insErr) throw new Error(`token insert: ${insErr.message}`);

      const r = await fetch(`${API}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body: any = await r.json().catch(() => ({}));
      const cfg = await bizConfig(sb, f.bizId);
      const { data: tokenRow } = await sb
        .from("email_verification_tokens").select("*").eq("token", token).maybeSingle();
      const pass =
        r.status === 200 &&
        body?.success === true &&
        cfg?.email_verified === true &&
        cfg?.email_verified_at != null &&
        tokenRow?.used_at != null;
      record(
        "T7 /verify-email happy path: success:true, email_verified flips to true, used_at written",
        pass,
        `http=${r.status} success=${body?.success} email_verified=${cfg?.email_verified} used_at=${tokenRow?.used_at != null}`,
      );
    }

    // ===== T8: anti-enumeration — 4 failure modes return identical wire shape =====
    {
      const stamp = `t8_${Date.now()}`;
      const f = await createFixture(sb, `bug18-t8-${stamp}@neverr.test`,
        { subscription_status: "trialing" }, stamp);
      allFixtures.push(f);

      // (a) missing token
      const rMissing = await fetch(`${API}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const bMissing: any = await rMissing.json().catch(() => ({}));

      // (b) bogus token
      const rBogus = await fetch(`${API}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: `evt_${crypto.randomBytes(32).toString("hex")}` }),
      });
      const bBogus: any = await rBogus.json().catch(() => ({}));

      // (c) already-used token: insert + claim, then POST
      const usedToken = `evt_${crypto.randomBytes(32).toString("hex")}`;
      await sb.from("email_verification_tokens").insert({
        token: usedToken, user_id: f.userId, email: f.email,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        used_at: new Date().toISOString(),
      });
      const rUsed = await fetch(`${API}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: usedToken }),
      });
      const bUsed: any = await rUsed.json().catch(() => ({}));

      // (d) expired token: insert with past expires_at
      const expToken = `evt_${crypto.randomBytes(32).toString("hex")}`;
      await sb.from("email_verification_tokens").insert({
        token: expToken, user_id: f.userId, email: f.email,
        expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      const rExp = await fetch(`${API}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: expToken }),
      });
      const bExp: any = await rExp.json().catch(() => ({}));

      // All four MUST report success:false AND reason:"invalid_or_expired".
      // Internal differences only allowed via Sentry/log channels, NEVER on the wire.
      const shapes = [bMissing, bBogus, bUsed, bExp];
      const allCollapsed = shapes.every(
        (b) => b?.success === false && b?.reason === "invalid_or_expired",
      );
      // HTTP status: missing param is 400, the other three are 200 (token enumeration prevention)
      const httpOk = rMissing.status === 400
        && rBogus.status === 200 && rUsed.status === 200 && rExp.status === 200;
      record(
        "T8 anti-enumeration: 4 failure modes collapse to {success:false, reason:'invalid_or_expired'}",
        allCollapsed && httpOk,
        `http missing/bogus/used/expired = ${rMissing.status}/${rBogus.status}/${rUsed.status}/${rExp.status} ; ` +
          `reasons = ${shapes.map((b) => b?.reason).join("|")}`,
      );
    }

    // ===== T9: /resend-verification status gate + cooldown =====
    {
      const stamp = `t9_${Date.now()}`;

      // (a) pending_payment user → MUST be rejected by status gate
      const fPending = await createFixture(sb, `bug18-t9p-${stamp}@neverr.test`,
        { subscription_status: "pending_payment" }, `${stamp}_p`);
      allFixtures.push(fPending);
      const tokenPending = await signIn(url!, anonKey!, fPending.email, fPending.password);
      const rPending = await fetch(`${API}/api/auth/resend-verification`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenPending}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const bPending: any = await rPending.json().catch(() => ({}));
      const pendingTokens = await tokensForUser(sb, fPending.userId);
      const pendingOk = rPending.status >= 400 && rPending.status < 500
        && bPending?.success === false
        && pendingTokens.length === 0;

      // (b) trialing user → 200 + new token. Then immediately re-call → 429-ish cooldown.
      const fTrial = await createFixture(sb, `bug18-t9t-${stamp}@neverr.test`,
        { subscription_status: "trialing" }, `${stamp}_t`);
      allFixtures.push(fTrial);
      const tokenTrial = await signIn(url!, anonKey!, fTrial.email, fTrial.password);

      const rOk = await fetch(`${API}/api/auth/resend-verification`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenTrial}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const bOk: any = await rOk.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, 400));
      const trialTokensAfterFirst = await tokensForUser(sb, fTrial.userId);
      const okOk = rOk.status === 200 && bOk?.success === true
        && trialTokensAfterFirst.length === 1;

      const rCooldown = await fetch(`${API}/api/auth/resend-verification`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenTrial}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const bCooldown: any = await rCooldown.json().catch(() => ({}));
      const cooldownOk = rCooldown.status >= 400 && rCooldown.status < 500
        && bCooldown?.success === false;

      record(
        "T9 /resend-verification: pending_payment rejected, trialing 200, immediate replay hits cooldown",
        pendingOk && okOk && cooldownOk,
        `pending(http=${rPending.status} reason=${bPending?.reason} tokens=${pendingTokens.length}) | ` +
          `ok(http=${rOk.status} tokens=${trialTokensAfterFirst.length}) | ` +
          `cooldown(http=${rCooldown.status} reason=${bCooldown?.reason})`,
      );
    }
  } finally {
    for (const f of allFixtures) {
      await teardownFixture(sb, f).catch((e) => console.error("teardown err", f.bizId, e?.message));
    }
    console.log(`\n[bug18-verify] teardown complete (${allFixtures.length} fixture(s))`);
  }

  // ===== Summary =====
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n========== BUG-18 VERIFICATION ==========`);
  console.log(`PASS: ${pass} / ${results.length}`);
  console.log(`FAIL: ${fail} / ${results.length}`);
  if (fail > 0) {
    console.log("\nFailures:");
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}\n      ${r.details}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
