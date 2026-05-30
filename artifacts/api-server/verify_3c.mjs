// Sprint 1 BUG-17 sub-step 3c verification harness — V1, V2, V3, V4, V5
// Run from /home/runner/workspace via:
//   cd artifacts/api-server && node /tmp/verify_3c.mjs
// (the cd is so node resolves stripe + @supabase/supabase-js from the api-server's deps)

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:80";

function signEvent(body) {
  return stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET });
}

function makeCheckoutEvent({ BIZ_A, customer, sub, withClientRef = true, withMetadataBiz = false, planMetadata = "professional", billingCycleMetadata = "monthly", id = `evt_test_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, subOverride = undefined } = {}) {
  return {
    id, object: "event", api_version: "2024-04-10",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.completed", livemode: false, pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: {
      id: `cs_test_${Math.random().toString(36).slice(2)}`, object: "checkout.session",
      client_reference_id: withClientRef ? BIZ_A : null,
      customer: customer.id, subscription: subOverride !== undefined ? subOverride : sub.id,
      metadata: withMetadataBiz
        ? { business_id: BIZ_A, plan: planMetadata, billing_cycle: billingCycleMetadata }
        : { plan: planMetadata, billing_cycle: billingCycleMetadata },
      mode: "subscription", payment_status: "paid", status: "complete",
    }},
  };
}

async function postWebhook(eventObj) {
  const body = JSON.stringify(eventObj);
  const sig = signEvent(body);
  const r = await fetch(`${BASE}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": sig },
    body,
  });
  return { status: r.status, body: await r.text() };
}

console.log("════════════════════════════════════════════════════════════════");
console.log("FIXTURE SETUP");
console.log("════════════════════════════════════════════════════════════════");

const ts = Math.floor(Date.now() / 1000);
const email = `webhook-3c-${ts}@neverr.test`;
const signupRes = await fetch(`${BASE}/api/auth/signup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email, password: "WebhookTest2026!",
    business_name: "Webhook 3c Test", industry: "plumbing",
  }),
});
const signup = await signupRes.json();
const BIZ_A = signup.business_id;
if (!BIZ_A) {
  console.error("FIXTURE FAILED: no business_id from signup", signup);
  process.exit(1);
}
console.log("BIZ_A=", BIZ_A);

const { data: pre } = await supabase.from("business_configs")
  .select("subscription_status, plan_id, trial_ends_at, current_period_end, stripe_subscription_id, stripe_customer_id")
  .eq("business_id", BIZ_A).single();
console.log("Initial row:", pre);

const customer = await stripe.customers.create({
  email, metadata: { businessId: BIZ_A, businessName: "Webhook 3c Test" },
});
console.log("Customer:", customer.id);

const PRO_MONTHLY = process.env.STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID;
const sub = await stripe.subscriptions.create({
  customer: customer.id,
  items: [{ price: PRO_MONTHLY }],
  trial_period_days: 7,
  payment_behavior: "default_incomplete",
  payment_settings: { save_default_payment_method: "on_subscription" },
  metadata: { businessId: BIZ_A, planId: "professional", billingCycle: "monthly" },
});
console.log("Subscription:", sub.id, "status:", sub.status, "trial_end:", sub.trial_end, "current_period_end:", sub.current_period_end);

const cleanup = async () => {
  console.log();
  console.log("CLEANUP");
  try { await stripe.subscriptions.cancel(sub.id); console.log("  cancelled sub", sub.id); } catch (e) { console.log("  cancel sub error:", e.message); }
  try { await stripe.customers.del(customer.id); console.log("  deleted customer", customer.id); } catch (e) { console.log("  delete customer error:", e.message); }
};

try {
  console.log();
  console.log("════════════════════════════════════════════════════════════════");
  console.log("V1+V2 — happy path (pending_payment → trialing via webhook)");
  console.log("════════════════════════════════════════════════════════════════");
  const evt1 = makeCheckoutEvent({ BIZ_A, customer, sub, withClientRef: true, withMetadataBiz: false });
  const r1 = await postWebhook(evt1);
  console.log("HTTP", r1.status, "body:", r1.body);

  const { data: post1 } = await supabase.from("business_configs")
    .select("subscription_status, plan_id, billing_cycle, stripe_subscription_id, stripe_customer_id, current_period_end, trial_ends_at, updated_at")
    .eq("business_id", BIZ_A).single();
  console.log("Post-V1 row:", post1);

  const trialEndDate = post1.trial_ends_at ? new Date(post1.trial_ends_at) : null;
  const expectedTrial = new Date(sub.trial_end * 1000);
  const trialMatches = trialEndDate && Math.abs(trialEndDate.getTime() - expectedTrial.getTime()) < 1000;
  const periodEndFuture = post1.current_period_end ? new Date(post1.current_period_end) > new Date() : false;

  console.log();
  console.log("V1+V2 assertions:");
  console.log("  HTTP 200?", r1.status === 200, "→", r1.status === 200 ? "PASS" : "FAIL");
  console.log("  status='trialing' (NOT 'active')?", post1.subscription_status === "trialing", "→", post1.subscription_status === "trialing" ? "PASS" : `FAIL (got ${post1.subscription_status})`);
  console.log("  stripe_subscription_id set?", post1.stripe_subscription_id === sub.id, "→", post1.stripe_subscription_id === sub.id ? "PASS" : "FAIL");
  console.log("  stripe_customer_id set?", post1.stripe_customer_id === customer.id, "→", post1.stripe_customer_id === customer.id ? "PASS" : "FAIL");
  console.log("  plan_id=professional?", post1.plan_id === "professional", "→", post1.plan_id === "professional" ? "PASS" : "FAIL");
  console.log("  billing_cycle=monthly?", post1.billing_cycle === "monthly", "→", post1.billing_cycle === "monthly" ? "PASS" : "FAIL");
  console.log("  current_period_end in future?", periodEndFuture, "→", periodEndFuture ? "PASS" : "FAIL");
  console.log("  trial_ends_at ~ +7d (matches sub.trial_end)?", trialMatches, "→", trialMatches ? "PASS" : `FAIL (got ${post1.trial_ends_at}, expected ${expectedTrial.toISOString()})`);

  console.log();
  console.log("════════════════════════════════════════════════════════════════");
  console.log("V3 — idempotency replay: same event id, same payload");
  console.log("════════════════════════════════════════════════════════════════");
  const updatedAtBeforeReplay = post1.updated_at;
  // Wait 1 second so we can detect updated_at changes if any
  await new Promise(r => setTimeout(r, 1100));
  const r3 = await postWebhook(evt1); // same event id
  console.log("HTTP", r3.status, "body:", r3.body);
  const { data: post3 } = await supabase.from("business_configs")
    .select("subscription_status, plan_id, current_period_end, trial_ends_at, updated_at")
    .eq("business_id", BIZ_A).single();
  console.log("Post-replay row:", post3);
  console.log("V3 assertions:");
  console.log("  HTTP 200?", r3.status === 200, "→", r3.status === 200 ? "PASS" : "FAIL");
  console.log("  status still 'trialing'?", post3.subscription_status === "trialing", "→", post3.subscription_status === "trialing" ? "PASS" : "FAIL");
  console.log("  updated_at UNCHANGED (proves no UPDATE was issued)?", post3.updated_at === updatedAtBeforeReplay, "→", post3.updated_at === updatedAtBeforeReplay ? "PASS" : `FAIL — row was touched (was ${updatedAtBeforeReplay}, now ${post3.updated_at})`);

  console.log();
  console.log("════════════════════════════════════════════════════════════════");
  console.log("V4 — confirm business_id_source was 'client_reference_id' in V1's log");
  console.log("════════════════════════════════════════════════════════════════");
  const logFile = execSync("ls -t /tmp/logs/artifactsapi-server* 2>/dev/null | head -1").toString().trim();
  if (logFile) {
    const grep = execSync(`grep -E '"business_id":"${BIZ_A}"|REPLAY_NOOP|NO_BUSINESS_ID' ${logFile} 2>/dev/null | tail -10`).toString();
    console.log(grep);
    const v4pass = grep.includes('"business_id_source":"client_reference_id"');
    console.log("  business_id_source: 'client_reference_id' present?", v4pass, "→", v4pass ? "PASS" : "FAIL");
    const v4replayPass = grep.includes('REPLAY_NOOP') && grep.includes(`"business_id":"${BIZ_A}"`);
    console.log("  REPLAY_NOOP log entry for BIZ_A present?", v4replayPass, "→", v4replayPass ? "PASS" : "FAIL");
  } else {
    console.log("  WARN: log file not found at /tmp/logs/artifactsapi-server*");
  }

  console.log();
  console.log("════════════════════════════════════════════════════════════════");
  console.log("V5 — missing business_id: synthetic event with NO client_ref AND NO metadata.business_id");
  console.log("════════════════════════════════════════════════════════════════");
  const evt5 = makeCheckoutEvent({ BIZ_A, customer, sub, withClientRef: false, withMetadataBiz: false });
  // count rows beforehand
  const { count: countBefore } = await supabase.from("business_configs").select("business_id", { count: "exact", head: true });
  const r5 = await postWebhook(evt5);
  console.log("HTTP", r5.status, "body:", r5.body);
  const { count: countAfter } = await supabase.from("business_configs").select("business_id", { count: "exact", head: true });
  const { data: post5 } = await supabase.from("business_configs")
    .select("subscription_status, updated_at").eq("business_id", BIZ_A).single();
  console.log("Post-V5 BIZ_A row (must equal post-V3 row, untouched):", post5);
  console.log("V5 assertions:");
  console.log("  HTTP 200 (don't make Stripe retry malformed event)?", r5.status === 200, "→", r5.status === 200 ? "PASS" : "FAIL");
  console.log("  Total business_configs row count UNCHANGED?", countBefore === countAfter, "→", countBefore === countAfter ? `PASS (${countBefore})` : `FAIL (was ${countBefore}, now ${countAfter})`);
  console.log("  BIZ_A row updated_at UNCHANGED?", post5.updated_at === post3.updated_at, "→", post5.updated_at === post3.updated_at ? "PASS" : "FAIL");
  if (logFile) {
    const grep5 = execSync(`grep -E 'NO_BUSINESS_ID' ${logFile} 2>/dev/null | tail -3`).toString();
    console.log("  NO_BUSINESS_ID log line emitted?", grep5.length > 0, "→", grep5.length > 0 ? "PASS" : "FAIL");
    console.log(grep5);
  }
} finally {
  await cleanup();
}
