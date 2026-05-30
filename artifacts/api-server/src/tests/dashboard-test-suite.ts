/**
 * Dashboard Functionality Test Suite
 *
 * Hits every admin dashboard endpoint and reports pass/fail/missing.
 *
 * Auth: logs in via POST /api/auth/login with credentials from
 *       TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD env vars. The original spec
 *       used a hand-written JWT with a fake signature — that doesn't validate
 *       against Supabase, so the entire suite would fail with 401s.
 *
 * Endpoint classification:
 *   PASS    — 2xx response
 *   FAIL    — endpoint exists but returned a non-2xx (real bug)
 *   MISSING — 404 on a path the spec asks us to test but isn't implemented
 *             yet (reported separately so the suite isn't reds-on-purpose)
 *
 * Cleanup: any support_tickets created by this suite are deleted at the end.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run test:dashboard
 */

const API_BASE = process.env.TEST_API_BASE || "http://localhost:8080";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;

// Spec endpoints that we know are not implemented in the API yet. A 404 from
// a path in this set is reported as MISSING (not FAIL), so the suite stays
// honest about the difference between "endpoint broken" and "endpoint not
// built yet". As of this run, every endpoint the spec asks for exists, so
// the set is empty — populate it again only if real 404s appear.
const KNOWN_MISSING = new Set<string>([]);

type TestResult = {
  name: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  durationMs: number;
  body: any;
  error?: string;
  classification: "PASS" | "FAIL" | "MISSING";
};

const createdTicketIds: string[] = [];

async function login(): Promise<string> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      "TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD must be set in the environment.",
    );
  }
  const r = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const j: any = await r.json();
  const token = j?.session?.access_token;
  if (!r.ok || !token) {
    throw new Error(
      `Login failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`,
    );
  }
  return token;
}

async function testEndpoint(
  token: string,
  name: string,
  method: string,
  path: string,
  body?: any,
): Promise<TestResult> {
  const started = Date.now();
  const key = `${method} ${path}`;
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data: any = null;
    try {
      data = await r.json();
    } catch {
      /* non-JSON response */
    }

    // Stash any tickets we created so cleanup can remove them.
    if (path.includes("/tickets") && method === "POST" && data?.id) {
      createdTicketIds.push(data.id);
    }
    if (path.includes("/automation/execute") && Array.isArray(data?.executionResults)) {
      for (const er of data.executionResults) {
        for (const a of er.actions || []) {
          if (a.type === "intelligent_ticket_created" && a.ticketId) {
            createdTicketIds.push(a.ticketId);
          }
        }
      }
    }

    const isMissing = r.status === 404 && KNOWN_MISSING.has(key);
    const classification: TestResult["classification"] = r.ok
      ? "PASS"
      : isMissing
        ? "MISSING"
        : "FAIL";

    const icon = classification === "PASS" ? "✅" : classification === "MISSING" ? "⚠️ " : "❌";
    console.log(`[${icon}] ${name.padEnd(36)} ${method.padEnd(4)} ${path}`);
    console.log(
      `        status=${r.status} | ${r.ok ? `ok in ${Date.now() - started}ms` : `err: ${data?.error || "(no body)"}`}`,
    );

    return {
      name,
      method,
      path,
      status: r.status,
      ok: r.ok,
      durationMs: Date.now() - started,
      body: data,
      error: r.ok ? undefined : data?.error,
      classification,
    };
  } catch (e: any) {
    console.log(`[❌] ${name.padEnd(36)} ${method.padEnd(4)} ${path}`);
    console.log(`        network error: ${e.message}`);
    return {
      name,
      method,
      path,
      status: 0,
      ok: false,
      durationMs: Date.now() - started,
      body: null,
      error: e.message,
      classification: "FAIL",
    };
  }
}

async function cleanup(token: string) {
  if (createdTicketIds.length === 0) return;
  console.log(`\n🧹 Cleanup: removing ${createdTicketIds.length} test tickets…`);
  // No bulk-delete admin endpoint is exposed — go straight to the existing
  // per-ticket DELETE if present, otherwise mark them with a note. We try the
  // common shape first; failures are non-fatal.
  for (const id of createdTicketIds) {
    try {
      const r = await fetch(`${API_BASE}/api/admin/tickets/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`   ${r.ok ? "✓" : "·"} ${id} (HTTP ${r.status})`);
    } catch (e: any) {
      console.log(`   · ${id} cleanup error: ${e.message}`);
    }
  }
}

async function runDashboardTests() {
  console.log("🚀 Dashboard Functionality Tests");
  console.log(`   API_BASE = ${API_BASE}`);
  console.log(`   admin    = ${ADMIN_EMAIL}\n`);

  const token = await login();
  console.log("🔐 Authenticated\n");

  const groups: Array<{ title: string; tests: Array<[string, string, string, any?]> }> = [
    {
      title: "📊 CUSTOMER MANAGEMENT",
      tests: [
        ["Get Customer List", "GET", "/api/admin/customers?limit=10"],
        ["Get Customer Details", "GET", "/api/admin/customers/demo-business"],
        ["Get Customer Health Score", "GET", "/api/admin/customers/demo-business/health"],
        ["Customer Intelligence", "GET", "/api/admin/analytics/segmentation"],
      ],
    },
    {
      title: "💰 REVENUE ANALYTICS",
      tests: [
        ["Revenue Overview", "GET", "/api/admin/analytics/overview"],
        ["Revenue Time Series", "GET", "/api/admin/analytics/revenue?timeRange=12m"],
        ["Cohort Analysis", "GET", "/api/admin/analytics/cohorts?cohortType=monthly"],
      ],
    },
    {
      title: "🤖 CHURN PREDICTION & ML",
      tests: [
        ["Basic Churn Risk", "GET", "/api/admin/analytics/churn-risk"],
        ["ML Churn Prediction", "GET", "/api/admin/analytics/churn-prediction?modelType=ensemble"],
        ["Feature Engineering", "GET", "/api/admin/analytics/churn-prediction?includeFeatures=true"],
      ],
    },
    {
      title: "📈 MONITORING",
      tests: [
        ["System Health", "GET", "/api/admin/monitoring/health?timeRange=24h"],
        ["Customer Impact", "GET", "/api/admin/monitoring/customers/demo-business/impact"],
        ["Monitoring Dashboard", "GET", "/api/admin/monitoring/dashboard"],
      ],
    },
    {
      title: "🎫 SUPPORT SYSTEM",
      tests: [
        ["Support Dashboard", "GET", "/api/admin/support/dashboard"],
        [
          "Create Test Ticket",
          "POST",
          "/api/admin/customers/demo-business/tickets",
          {
            title: "Dashboard Test Ticket",
            description: "Automated test ticket for dashboard validation",
            priority: "medium",
            category: "technical",
            assignedTo: "Test Team",
          },
        ],
      ],
    },
    {
      title: "📧 EMAIL SYSTEM",
      tests: [
        ["Email Templates", "GET", "/api/admin/emails/templates"],
        [
          "Email Preview",
          "POST",
          "/api/admin/emails/preview",
          { template: "welcome", data: { customerName: "Test User", businessName: "Test Business" } },
        ],
      ],
    },
    {
      title: "🔄 AUTOMATION",
      tests: [
        ["Basic Automation Triggers", "POST", "/api/admin/automation/evaluate-triggers"],
        ["Intelligent Workflows", "POST", "/api/admin/automation/intelligent-workflows", { dryRun: true }],
        ["Automation Dashboard", "GET", "/api/admin/automation/dashboard"],
        ["Intelligent Dashboard", "GET", "/api/admin/automation/intelligent-dashboard"],
      ],
    },
    {
      title: "🩺 SYSTEM HEALTH",
      tests: [["System Health Check", "GET", "/api/admin/system/health-check"]],
    },
  ];

  const all: TestResult[] = [];
  for (const group of groups) {
    console.log(`\n${group.title}`);
    for (const [name, method, path, body] of group.tests) {
      all.push(await testEndpoint(token, name, method, path, body));
    }
  }

  const passed = all.filter((r) => r.classification === "PASS").length;
  const failed = all.filter((r) => r.classification === "FAIL").length;
  const missing = all.filter((r) => r.classification === "MISSING").length;

  console.log("\n" + "=".repeat(64));
  console.log("📋 SUMMARY");
  console.log("=".repeat(64));
  console.log(`✅ Passed:  ${passed}/${all.length}`);
  console.log(`❌ Failed:  ${failed}`);
  console.log(`⚠️  Missing: ${missing} (spec endpoints not implemented yet)`);
  console.log(
    `📊 Coverage: ${(((passed + missing) / all.length) * 100).toFixed(1)}% (PASS+MISSING vs. real bugs)`,
  );

  if (missing > 0) {
    console.log("\n⚠️  Missing endpoints (404 — listed in KNOWN_MISSING):");
    for (const r of all.filter((x) => x.classification === "MISSING")) {
      console.log(`   - ${r.method} ${r.path}`);
    }
  }
  if (failed > 0) {
    console.log("\n❌ Real failures (not in KNOWN_MISSING):");
    for (const r of all.filter((x) => x.classification === "FAIL")) {
      console.log(`   - ${r.method} ${r.path} → HTTP ${r.status} ${r.error || ""}`);
    }
  }

  // Surface real numbers from a couple of headline endpoints if they passed.
  const churn = all.find((r) => r.path === "/api/admin/analytics/churn-prediction?modelType=ensemble");
  if (churn?.ok) {
    const dist = churn.body?.summary?.riskDistribution || {};
    console.log("\n🤖 Churn snapshot:");
    console.log(`   customers analyzed: ${churn.body?.customersAnalyzed}`);
    console.log(
      `   risk dist: critical=${dist.critical || 0}, high=${dist.high || 0}, medium=${dist.medium || 0}, low=${dist.low || 0}`,
    );
  }
  const health = all.find((r) => r.path === "/api/admin/system/health-check");
  if (health?.ok) {
    console.log("\n🩺 System health:");
    console.log(`   status=${health.body?.status} (${health.body?.overallHealth}%)`);
    for (const [name, c] of Object.entries(health.body?.checks || {})) {
      const cc: any = c;
      console.log(
        `   ${cc.ok ? "✓" : "✗"} ${name.padEnd(13)} rows=${cc.rowCount ?? "n/a"} ${cc.error ? "(" + cc.error + ")" : ""}`,
      );
    }
  }

  await cleanup(token);

  console.log("\n✅ Done.");
  return { passed, failed, missing };
}

runDashboardTests()
  .then((r) => process.exit(r.failed === 0 ? 0 : 1))
  .catch((err) => {
    console.error("❌ Suite crashed:", err.message);
    process.exit(2);
  });
