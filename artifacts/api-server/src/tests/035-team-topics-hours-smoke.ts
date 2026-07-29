/**
 * Phase 3.1a — team + topics + hours smoke. 15 cases (T1-T15) covering the
 * three new routers introduced in migrations 035-038.
 *
 *   T1  Clock in sets is_on_duty=true + on_duty_since=NOW()
 *   T2  Clock out clears both
 *   T3  GET /team returns tenant-scoped members + on-duty + assigned_topics
 *   T4  Cross-tenant access returns 404 (PATCH on a member from another biz)
 *   T5  Invite creates user_businesses row + staff_topics rows for initial_topics
 *   T6  PATCH /topics persists list, validates unique slugs + snake_case
 *   T7  POST /topics/reset copies industry_templates.default_topics into
 *       business_configs.departments
 *   T8  GET /hours returns structured rows sorted by day_of_week
 *   T9  PATCH /hours bulk upsert respects UNIQUE (business_id, day_of_week)
 *       via DELETE-then-INSERT
 *   T10 GET /hours/now — table-driven with 8 scenarios (weekday-open,
 *       weekend-closed, exact-open-boundary, exact-close-boundary,
 *       DST-spring-forward, tz-mismatch, is_closed=true day, empty schedule)
 *   T11 staff_topics UNIQUE via PATCH member — duplicate topic slug rejected
 *   T12 hours/now — is_open + next_opens_at across day-boundary + week-boundary
 *   T13 Invite call reaches supabase.auth.admin.inviteUserByEmail with the
 *       correct email and metadata
 *   T14 DELETE /team/:userId prevents self-removal (403)
 *   T15 lib/business-hours/parser — 15 real production samples parse cleanly
 *       or fall back to defaults
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/035-team-topics-hours-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleListTeam,
  handleInviteMember,
  handlePatchMember,
  handleDeleteMember,
  handleOnDuty,
  handleOffDuty,
  parseInviteBody,
  parseMemberPatchBody,
} from "../routes/team";
import {
  handleGetTopics,
  handlePatchTopics,
  handleResetTopics,
  parseTopicsBody,
  type Topic,
} from "../routes/topics";
import {
  handleGetHours,
  handlePatchHours,
  handleHoursNow,
  parseHoursBody,
} from "../routes/hours";
import {
  parseBusinessHours,
  computeIsOpenNow,
  type BusinessHoursRow,
} from "../lib/business-hours/parser";

// ── Test harness ────────────────────────────────────────────────────

interface TestResult {
  name: string;
  pass: boolean;
  details: string;
}
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient (extends the 034 pattern) ────────────────────

type FakeCall = {
  op: "select" | "insert" | "update" | "upsert" | "delete" | "rpc";
  table: string;
  selectColumns: string;
  selectOpts?: { count?: string };
  eqFilters: Array<{ column: string; value: any }>;
  inFilters: Array<{ column: string; values: any[] }>;
  orderBy?: { column: string; ascending: boolean };
  rangeFrom?: number;
  rangeTo?: number;
  payload?: any;
  upsertOptions?: any;
  rpcParams?: any;
};
type FakeResponse = {
  match: (call: FakeCall) => boolean;
  data?: any;
  count?: number;
  error?: { message: string } | null;
};

class FakeBuilder {
  constructor(private fake: FakeSupabaseClient, private call: FakeCall) {}
  select(cols: string, opts?: any) {
    this.call.selectColumns = cols;
    if (opts) this.call.selectOpts = opts;
    return this;
  }
  insert(payload: any) {
    this.call.op = "insert";
    this.call.payload = payload;
    return this;
  }
  update(payload: any) {
    this.call.op = "update";
    this.call.payload = payload;
    return this;
  }
  upsert(payload: any, options?: any) {
    this.call.op = "upsert";
    this.call.payload = payload;
    this.call.upsertOptions = options;
    return this;
  }
  delete() {
    this.call.op = "delete";
    return this;
  }
  eq(c: string, v: any) {
    this.call.eqFilters.push({ column: c, value: v });
    return this;
  }
  in(c: string, vs: any[]) {
    this.call.inFilters.push({ column: c, values: vs });
    return this;
  }
  is() {
    return this;
  }
  neq() {
    return this;
  }
  not() {
    return this;
  }
  or() {
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.call.orderBy = { column, ascending: opts?.ascending ?? true };
    return this;
  }
  range(from: number, to: number) {
    this.call.rangeFrom = from;
    this.call.rangeTo = to;
    return this;
  }
  limit() {
    return this;
  }
  async maybeSingle() {
    return this.fake.resolveCall(this.call);
  }
  async single() {
    return this.fake.resolveCall(this.call);
  }
  then(resolve: any, reject: any) {
    return this.fake.resolveCall(this.call).then(resolve, reject);
  }
  catch(handler: any) {
    return this.fake.resolveCall(this.call).catch(handler);
  }
}

class FakeSupabaseClient {
  responses: FakeResponse[] = [];
  calls: FakeCall[] = [];
  usersById = new Map<string, { email: string | null; user_metadata: any }>();
  inviteResponses: Array<{ email: string; user_id?: string; error?: string }> = [];
  listUsersResponse: Array<{ id: string; email: string }> = [];

  on(match: FakeResponse["match"], spec: Omit<FakeResponse, "match">) {
    this.responses.push({ match, ...spec });
  }
  from(table: string) {
    const call: FakeCall = {
      op: "select",
      table,
      selectColumns: "",
      eqFilters: [],
      inFilters: [],
    };
    this.calls.push(call);
    return new FakeBuilder(this, call);
  }
  async rpc(name: string, params: any) {
    const call: FakeCall = {
      op: "rpc",
      table: name,
      selectColumns: "",
      eqFilters: [],
      inFilters: [],
      rpcParams: params,
    };
    this.calls.push(call);
    return this.resolveCall(call);
  }
  async resolveCall(call: FakeCall) {
    const r = this.responses.find((rr) => rr.match(call));
    if (!r) return { data: null, error: null, count: 0 };
    return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? 0 };
  }
  auth = {
    admin: {
      getUserById: async (id: string) => {
        const u = this.usersById.get(id);
        if (!u) return { data: { user: null }, error: null };
        return { data: { user: { id, email: u.email, user_metadata: u.user_metadata } }, error: null };
      },
      inviteUserByEmail: async (email: string, opts: any) => {
        const found = this.inviteResponses.find((r) => r.email === email);
        if (!found) {
          return { data: { user: { id: `new-${email}`, email } }, error: null };
        }
        if (found.error) return { data: { user: null }, error: { message: found.error } };
        return { data: { user: { id: found.user_id!, email } }, error: null };
      },
      listUsers: async (_opts?: any) => {
        return { data: { users: this.listUsersResponse }, error: null };
      },
    },
  };
}

const asClient = (f: FakeSupabaseClient) => f as unknown as SupabaseClient;

// ── Fixtures ────────────────────────────────────────────────────────

const BIZ = "biz_test_035";
const OTHER_BIZ = "biz_other_035";
const USER_A = "00000000-0000-0000-0000-0000000000aa";
const USER_B = "00000000-0000-0000-0000-0000000000bb";
const USER_C = "00000000-0000-0000-0000-0000000000cc";

// ── Tests ────────────────────────────────────────────────────────────

async function T1_clock_in() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "update" && c.table === "user_businesses",
    { data: { on_duty_since: "2026-07-29T10:00:00Z" } },
  );
  const before = Date.now();
  const result = await handleOnDuty(asClient(fake), BIZ, USER_A);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "user_businesses");
  if (!update) failures.push("no UPDATE issued");
  if (update?.payload?.is_on_duty !== true) failures.push(`is_on_duty=${update?.payload?.is_on_duty}`);
  const ts = update?.payload?.on_duty_since;
  if (!ts) failures.push("on_duty_since not set");
  else {
    const parsed = new Date(String(ts)).getTime();
    if (parsed < before - 1000 || parsed > Date.now() + 1000) failures.push("on_duty_since outside expected window");
  }
  if (!update?.eqFilters.some((f) => f.column === "user_id" && f.value === USER_A)) failures.push("missing user_id filter");
  if (!update?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) failures.push("missing business_id filter");
  record("T1 clock in", failures.length === 0, failures.join("; ") || "is_on_duty=true + on_duty_since=NOW() + tenant scoped");
}

async function T2_clock_out() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "update" && c.table === "user_businesses",
    { data: { user_id: USER_A } },
  );
  const result = await handleOffDuty(asClient(fake), BIZ, USER_A);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "user_businesses");
  if (!update) failures.push("no UPDATE issued");
  if (update?.payload?.is_on_duty !== false) failures.push(`is_on_duty=${update?.payload?.is_on_duty}`);
  if (update?.payload?.on_duty_since !== null) failures.push(`on_duty_since=${update?.payload?.on_duty_since} (expected null)`);
  record("T2 clock out", failures.length === 0, failures.join("; ") || "is_on_duty=false + on_duty_since=null");
}

async function T3_list_team() {
  const fake = new FakeSupabaseClient();
  fake.usersById.set(USER_A, { email: "a@example.com", user_metadata: { full_name: "Alice" } });
  fake.usersById.set(USER_B, { email: "b@example.com", user_metadata: { full_name: "Bob" } });
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    {
      data: [
        { user_id: USER_A, role: "owner", is_on_duty: true, on_duty_since: "2026-07-29T09:00:00Z", callback_ring_number: "+15550001111", created_at: "2026-01-01T00:00:00Z" },
        { user_id: USER_B, role: "manager", is_on_duty: false, on_duty_since: null, callback_ring_number: null, created_at: "2026-01-02T00:00:00Z" },
      ],
    },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "staff_topics",
    {
      data: [
        { user_id: USER_A, topic_slug: "payments" },
        { user_id: USER_A, topic_slug: "new_reservation" },
        { user_id: USER_B, topic_slug: "payments" },
      ],
    },
  );

  const result = await handleListTeam(asClient(fake), BIZ);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.members.length !== 2) failures.push(`members.length=${result.members.length}`);
    const alice = result.members.find((m) => m.user_id === USER_A);
    if (!alice) failures.push("Alice missing");
    else {
      if (alice.email !== "a@example.com") failures.push(`email=${alice.email}`);
      if (alice.full_name !== "Alice") failures.push(`full_name=${alice.full_name}`);
      if (alice.is_on_duty !== true) failures.push(`is_on_duty=${alice.is_on_duty}`);
      if (alice.assigned_topics.join(",") !== "new_reservation,payments") failures.push(`topics=${alice.assigned_topics.join(",")}`);
    }
    const bob = result.members.find((m) => m.user_id === USER_B);
    if (bob?.assigned_topics.join(",") !== "payments") failures.push(`bob.topics=${bob?.assigned_topics}`);
  }
  const ubSelect = fake.calls.find((c) => c.op === "select" && c.table === "user_businesses");
  if (!ubSelect?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) failures.push("missing business_id filter on user_businesses");
  const stSelect = fake.calls.find((c) => c.op === "select" && c.table === "staff_topics");
  if (!stSelect?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) failures.push("missing business_id filter on staff_topics");
  record("T3 list team tenant-scoped", failures.length === 0, failures.join("; ") || "2 members + hydrated email/name + topics grouped");
}

async function T4_cross_tenant_404() {
  const fake = new FakeSupabaseClient();
  // Attempting to PATCH a member that belongs to OTHER_BIZ — the owner-
  // check select returns null because our WHERE has business_id=BIZ.
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    { data: null },
  );
  const result = await handlePatchMember(asClient(fake), BIZ, USER_C, "admin" as any, { role: "user" as any });
  const failures: string[] = [];
  if (result.ok) failures.push("unexpectedly ok");
  else if (result.status !== 404) failures.push(`status=${result.status}`);
  // No UPDATE should have been issued.
  const updates = fake.calls.filter((c) => c.op === "update");
  if (updates.length !== 0) failures.push(`unexpected UPDATE calls=${updates.length}`);
  record("T4 cross-tenant PATCH → 404", failures.length === 0, failures.join("; ") || "404 + no UPDATE issued");
}

async function T5_invite_creates_membership_and_topics() {
  const fake = new FakeSupabaseClient();
  fake.inviteResponses.push({ email: "new@example.com", user_id: "new-user-id" });
  // Topic validation reads business_configs.departments.
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs",
    {
      data: {
        departments: [
          { slug: "payments", name: "Payments" },
          { slug: "new_reservation", name: "New reservations" },
        ],
      },
    },
  );
  // Upsert into user_businesses returns success.
  fake.on(
    (c) => c.op === "upsert" && c.table === "user_businesses",
    { data: [{ user_id: "new-user-id" }] },
  );
  fake.on(
    (c) => c.op === "delete" && c.table === "staff_topics",
    { data: null },
  );
  fake.on(
    (c) => c.op === "insert" && c.table === "staff_topics",
    { data: null },
  );

  const result = await handleInviteMember(asClient(fake), BIZ, USER_A, "admin" as any, {
    email: "new@example.com",
    role: "user" as any,
    initial_topics: ["payments", "new_reservation"],
    callback_ring_number: "+14155551234",
    full_name: "Newbie",
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.user_id !== "new-user-id") failures.push(`user_id=${result.user_id}`);
    if (!result.invited) failures.push("expected invited=true for brand-new user");
  }
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "user_businesses");
  if (!upsert) failures.push("no user_businesses upsert");
  if (upsert?.payload?.user_id !== "new-user-id") failures.push(`upsert user_id=${upsert?.payload?.user_id}`);
  if (upsert?.payload?.business_id !== BIZ) failures.push(`upsert business_id=${upsert?.payload?.business_id}`);
  if (upsert?.payload?.role !== "user") failures.push(`upsert role=${upsert?.payload?.role}`);
  if (upsert?.upsertOptions?.onConflict !== "user_id,business_id") failures.push(`onConflict=${upsert?.upsertOptions?.onConflict}`);
  const topicInsert = fake.calls.find((c) => c.op === "insert" && c.table === "staff_topics");
  if (!topicInsert) failures.push("no staff_topics insert");
  const topicRows = topicInsert?.payload as any[] | undefined;
  if (!Array.isArray(topicRows) || topicRows.length !== 2) failures.push(`topic rows=${topicRows?.length}`);
  if (topicRows && topicRows.some((r) => r.business_id !== BIZ)) failures.push("topic rows missing tenant");
  record("T5 invite creates membership + topics", failures.length === 0, failures.join("; ") || "invite + upsert + 2 staff_topics inserted");

  // Sub-case: privilege check — a manager cannot mint an admin.
  const fake2 = new FakeSupabaseClient();
  const badGrant = await handleInviteMember(asClient(fake2), BIZ, USER_A, "manager" as any, {
    email: "escalate@example.com",
    role: "admin" as any,
    initial_topics: [],
    callback_ring_number: null,
    full_name: null,
  });
  if (badGrant.ok) record("T5a manager cannot grant admin", false, "grant unexpectedly allowed");
  else if (badGrant.status !== 403) record("T5a manager cannot grant admin", false, `status=${badGrant.status}`);
  else record("T5a manager cannot grant admin", true, "403 on privilege escalation");

  // Sub-case: unknown topic slug rejected.
  const fake3 = new FakeSupabaseClient();
  fake3.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { departments: [{ slug: "payments", name: "Payments" }] } },
  );
  const unknownTopic = await handleInviteMember(asClient(fake3), BIZ, USER_A, "admin" as any, {
    email: "u@example.com",
    role: "user" as any,
    initial_topics: ["bogus_topic"],
    callback_ring_number: null,
    full_name: null,
  });
  if (unknownTopic.ok) record("T5b unknown topic rejected", false, "should have rejected");
  else if (unknownTopic.status !== 400 || !/bogus_topic/.test(unknownTopic.error)) record("T5b unknown topic rejected", false, `status=${unknownTopic.status} err=${unknownTopic.error}`);
  else record("T5b unknown topic rejected", true, "400 with slug in message");
}

async function T6_patch_topics() {
  // (a) Body validation catches duplicates and non-snake_case.
  const dup = parseTopicsBody({ topics: [{ slug: "payments", name: "P" }, { slug: "payments", name: "P2" }] });
  if (!("error" in dup) || !/duplicate/.test(dup.error)) {
    record("T6a duplicate slug rejected", false, `got ${"error" in dup ? dup.error : "no error"}`);
  } else {
    record("T6a duplicate slug rejected", true, "400 on duplicate");
  }
  const bad = parseTopicsBody({ topics: [{ slug: "NotSnakeCase", name: "Bad" }] });
  if (!("error" in bad) || !/snake_case/.test(bad.error)) {
    record("T6b non-snake_case slug rejected", false, `got ${"error" in bad ? bad.error : "no error"}`);
  } else {
    record("T6b non-snake_case slug rejected", true, "400 on invalid slug");
  }
  const missingName = parseTopicsBody({ topics: [{ slug: "ok" }] });
  if (!("error" in missingName)) {
    record("T6c missing name rejected", false, "should have rejected");
  } else {
    record("T6c missing name rejected", true, "400 on missing name");
  }

  // (b) Handler persists valid list.
  const fake = new FakeSupabaseClient();
  const topics: Topic[] = [
    { slug: "payments", name: "Payments", description: "Bills and refunds", example_utterances: ["I want to pay"] },
    { slug: "new_reservation", name: "New rentals", description: "Bookings", example_utterances: ["I need a car"] },
  ];
  fake.on(
    (c) => c.op === "update" && c.table === "business_configs",
    { data: { departments: topics } },
  );
  const result = await handlePatchTopics(asClient(fake), BIZ, topics);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "business_configs");
  if (!update) failures.push("no UPDATE issued");
  const payloadTopics = update?.payload?.departments as any[] | undefined;
  if (!Array.isArray(payloadTopics) || payloadTopics.length !== 2) failures.push(`payload topics.length=${payloadTopics?.length}`);
  if (!update?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) failures.push("missing business_id filter");
  record("T6d PATCH topics persists list", failures.length === 0, failures.join("; ") || "UPDATE with 2 topics + tenant scoped");
}

async function T7_reset_topics() {
  const fake = new FakeSupabaseClient();
  const industryDefaults = [
    { slug: "payments", name: "Payments", description: "", example_utterances: [] },
    { slug: "new_reservation", name: "New rentals", description: "", example_utterances: [] },
  ];
  // First call reads business_configs.industry.
  let biz_call_count = 0;
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns === "industry",
    { data: { industry: "car_rental" } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "industry_templates",
    { data: { default_topics: industryDefaults } },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "business_configs",
    { data: null },
  );
  const result = await handleResetTopics(asClient(fake), BIZ);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.topics.length !== 2) failures.push(`topics.length=${result.topics.length}`);
    if (result.source !== "industry_defaults") failures.push(`source=${result.source}`);
  }
  const update = fake.calls.find((c) => c.op === "update" && c.table === "business_configs");
  if (!update) failures.push("no UPDATE issued");
  const industryLookup = fake.calls.find((c) => c.op === "select" && c.table === "industry_templates");
  if (!industryLookup?.eqFilters.some((f) => f.column === "industry_id" && f.value === "car_rental")) {
    failures.push("industry_templates lookup missing industry_id=car_rental filter");
  }
  record("T7 reset topics from industry_templates", failures.length === 0, failures.join("; ") || "industry_defaults copied to business_configs.departments");
}

async function T8_get_hours() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "business_hours",
    {
      data: [
        { day_of_week: 1, opens_at: "09:00:00", closes_at: "17:00:00", timezone: "America/New_York", is_closed: false },
        { day_of_week: 2, opens_at: "09:00:00", closes_at: "17:00:00", timezone: "America/New_York", is_closed: false },
        { day_of_week: 3, opens_at: "09:00:00", closes_at: "17:00:00", timezone: "America/New_York", is_closed: false },
        { day_of_week: 0, opens_at: null, closes_at: null, timezone: "America/New_York", is_closed: true },
      ],
    },
  );
  const result = await handleGetHours(asClient(fake), BIZ);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.hours.length !== 4) failures.push(`hours.length=${result.hours.length}`);
    // Times should be normalized to HH:MM (trim seconds).
    const mon = result.hours.find((h) => h.day_of_week === 1);
    if (mon?.opens_at !== "09:00") failures.push(`mon.opens_at=${mon?.opens_at}`);
    const sun = result.hours.find((h) => h.day_of_week === 0);
    if (!sun || !sun.is_closed) failures.push("sun row missing or not closed");
  }
  const select = fake.calls.find((c) => c.op === "select" && c.table === "business_hours");
  if (!select?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) failures.push("missing tenant filter");
  if (select?.orderBy?.column !== "day_of_week") failures.push(`orderBy=${select?.orderBy?.column}`);
  record("T8 GET hours", failures.length === 0, failures.join("; ") || "4 rows + times trimmed + tenant scoped + ordered");
}

async function T9_patch_hours() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "delete" && c.table === "business_hours",
    { data: null },
  );
  fake.on(
    (c) => c.op === "insert" && c.table === "business_hours",
    {
      data: [
        { day_of_week: 1, opens_at: "09:00:00", closes_at: "17:00:00", timezone: "America/New_York", is_closed: false },
        { day_of_week: 2, opens_at: "09:00:00", closes_at: "17:00:00", timezone: "America/New_York", is_closed: false },
      ],
    },
  );
  const rows = [
    { day_of_week: 1, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: false },
    { day_of_week: 2, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: false },
  ];
  const result = await handlePatchHours(asClient(fake), BIZ, rows);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  // Delete-then-insert order.
  const deleteIdx = fake.calls.findIndex((c) => c.op === "delete" && c.table === "business_hours");
  const insertIdx = fake.calls.findIndex((c) => c.op === "insert" && c.table === "business_hours");
  if (deleteIdx < 0) failures.push("no DELETE issued");
  if (insertIdx < 0) failures.push("no INSERT issued");
  if (deleteIdx >= 0 && insertIdx >= 0 && deleteIdx > insertIdx) failures.push("DELETE issued after INSERT (wrong order)");
  const deleteCall = fake.calls[deleteIdx];
  if (!deleteCall?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) failures.push("DELETE missing tenant filter");
  const insertCall = fake.calls[insertIdx];
  const inserted = insertCall?.payload as any[] | undefined;
  if (!Array.isArray(inserted) || inserted.length !== 2) failures.push(`inserted rows=${inserted?.length}`);
  if (inserted?.some((r) => r.business_id !== BIZ)) failures.push("inserted rows missing tenant");

  // Body validation — reject overnight (opens_at >= closes_at).
  const badOvernight = parseHoursBody({
    hours: [{ day_of_week: 1, opens_at: "22:00", closes_at: "06:00", timezone: "America/New_York", is_closed: false }],
  });
  if (!("error" in badOvernight)) failures.push("expected overnight rejection");
  // Body validation — duplicate day_of_week.
  const dupDow = parseHoursBody({
    hours: [
      { day_of_week: 1, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: false },
      { day_of_week: 1, opens_at: "10:00", closes_at: "18:00", timezone: "America/New_York", is_closed: false },
    ],
  });
  if (!("error" in dupDow)) failures.push("expected duplicate DOW rejection");
  // Body validation — invalid tz.
  const badTz = parseHoursBody({
    hours: [{ day_of_week: 1, opens_at: "09:00", closes_at: "17:00", timezone: "Not/A/Zone", is_closed: false }],
  });
  if (!("error" in badTz)) failures.push("expected invalid tz rejection");
  // Body validation — is_closed=true but times set.
  const closedWithTimes = parseHoursBody({
    hours: [{ day_of_week: 1, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: true }],
  });
  if (!("error" in closedWithTimes)) failures.push("expected closed-with-times rejection");

  record("T9 PATCH hours bulk upsert + validation", failures.length === 0, failures.join("; ") || "DELETE→INSERT + tenant + all validations");
}

async function T10_hours_now_table_driven() {
  const failures: string[] = [];
  const tz = "America/New_York";
  const buildSchedule = (openDays: number[]): BusinessHoursRow[] => {
    const rows: BusinessHoursRow[] = [];
    for (let d = 0; d < 7; d++) {
      rows.push({
        day_of_week: d,
        opens_at: openDays.includes(d) ? "09:00" : null,
        closes_at: openDays.includes(d) ? "17:00" : null,
        timezone: tz,
        is_closed: !openDays.includes(d),
      });
    }
    return rows;
  };
  const monFriSchedule = buildSchedule([1, 2, 3, 4, 5]);

  // 1. Weekday-open — Wed 12:00 ET → is_open=true
  const wedNoon = computeIsOpenNow(monFriSchedule, new Date("2026-07-29T16:00:00Z")); // 12:00 EDT
  if (!wedNoon.is_open) failures.push("T10.1 wed noon should be open");
  if (wedNoon.next_opens_at !== null) failures.push("T10.1 next_opens_at should be null when open");

  // 2. Weekend-closed — Sunday
  const sunNoon = computeIsOpenNow(monFriSchedule, new Date("2026-07-26T16:00:00Z"));
  if (sunNoon.is_open) failures.push("T10.2 sun noon should be closed");
  if (!sunNoon.next_opens_at) failures.push("T10.2 sun should have next_opens_at");

  // 3. Exact-open-boundary — Mon at 09:00 ET → is_open=true (inclusive)
  const monOpen = computeIsOpenNow(monFriSchedule, new Date("2026-07-27T13:00:00Z"));
  if (!monOpen.is_open) failures.push("T10.3 mon 09:00 should be open (opens_at inclusive)");

  // 4. Exact-close-boundary — Mon at 17:00 ET → is_open=false (exclusive)
  const monClose = computeIsOpenNow(monFriSchedule, new Date("2026-07-27T21:00:00Z"));
  if (monClose.is_open) failures.push("T10.4 mon 17:00 should be closed (closes_at exclusive)");

  // 5. DST-spring-forward — 2026-03-08 was DST spring forward; test 10:00 EDT that Monday
  const dstDay = computeIsOpenNow(monFriSchedule, new Date("2026-03-09T14:00:00Z")); // Mon post-DST
  if (!dstDay.is_open) failures.push("T10.5 DST monday 10:00 EDT should be open");

  // 6. TZ mismatch — schedule in America/New_York, "now" instant is far away.
  //    Fri 03:00 UTC is Thu 22:00 EST → should be closed (past 17:00)
  const tzDrift = computeIsOpenNow(monFriSchedule, new Date("2026-07-31T03:00:00Z"));
  if (tzDrift.is_open) failures.push("T10.6 fri 03:00 UTC → thu 22:00 EST should be closed");

  // 7. is_closed=true day — schedule where Wed is explicitly closed
  const closedWed = buildSchedule([1, 2, 4, 5]); // no wed
  const wedClosed = computeIsOpenNow(closedWed, new Date("2026-07-29T16:00:00Z"));
  if (wedClosed.is_open) failures.push("T10.7 wed with is_closed=true should be closed even at noon");

  // 8. Empty schedule — no rows at all
  const empty: BusinessHoursRow[] = [];
  const emptyResult = computeIsOpenNow(empty, new Date("2026-07-29T16:00:00Z"));
  if (emptyResult.is_open) failures.push("T10.8 empty schedule should be closed");
  if (emptyResult.next_opens_at !== null) failures.push("T10.8 empty schedule should have null next_opens_at");

  record("T10 hours/now × 8 scenarios", failures.length === 0, failures.join("; ") || "weekday-open, weekend-closed, boundary in/ex, DST, tz-drift, closed-day, empty");
}

async function T11_staff_topics_unique_via_patch() {
  // The DB UNIQUE constraint (user_id, business_id, topic_slug) prevents
  // duplicate rows at storage time. At the API layer, PATCH member with
  // duplicate topic slugs in the body should be caught by validation
  // before hitting the DB.
  const dup = parseMemberPatchBody({ topics: ["payments", "payments"] });
  // Note: parseMemberPatchBody currently allows duplicates in the array
  // — they'd get de-duped by the UNIQUE constraint on INSERT. The
  // handler's bulk-replace pattern (DELETE then INSERT) means duplicates
  // in the request body would cause an INSERT error. Verify the handler
  // reports 500 on the error.
  const failures: string[] = [];
  if ("error" in dup) {
    // parseMemberPatchBody validation is per-slug (snake_case) — duplicates
    // are DB-enforced. This is fine — record what we chose.
    record("T11 UNIQUE enforcement (DB-layer)", true, "parse validates slugs; UNIQUE constraint enforces at storage");
    return;
  }
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    { data: { user_id: USER_B, role: "user" } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { departments: [{ slug: "payments", name: "P" }] } },
  );
  fake.on(
    (c) => c.op === "delete" && c.table === "staff_topics",
    { data: null },
  );
  // Simulate the DB rejecting the INSERT with a unique-violation error.
  fake.on(
    (c) => c.op === "insert" && c.table === "staff_topics",
    { error: { message: "duplicate key value violates unique constraint \"staff_topics_user_id_business_id_topic_slug_key\"" } },
  );
  const result = await handlePatchMember(asClient(fake), BIZ, USER_B, "admin" as any, dup);
  if (result.ok) failures.push("expected UNIQUE violation to fail patch");
  else if (result.status !== 500) failures.push(`status=${result.status} (expected 500)`);
  record("T11 UNIQUE enforcement (DB-layer)", failures.length === 0, failures.join("; ") || "duplicate topic slugs hit UNIQUE constraint");
}

async function T12_hours_now_boundary_next() {
  // is_open=false at Fri 20:00 ET → next_opens_at should be Monday 09:00 ET (week boundary).
  const monFri: BusinessHoursRow[] = [
    { day_of_week: 0, opens_at: null, closes_at: null, timezone: "America/New_York", is_closed: true },
    { day_of_week: 1, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: false },
    { day_of_week: 2, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: false },
    { day_of_week: 3, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: false },
    { day_of_week: 4, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: false },
    { day_of_week: 5, opens_at: "09:00", closes_at: "17:00", timezone: "America/New_York", is_closed: false },
    { day_of_week: 6, opens_at: null, closes_at: null, timezone: "America/New_York", is_closed: true },
  ];
  // Fri 2026-07-31 20:00 ET = 2026-08-01 00:00 UTC
  const friEvening = computeIsOpenNow(monFri, new Date("2026-08-01T00:00:00Z"));
  const failures: string[] = [];
  if (friEvening.is_open) failures.push("Fri 20:00 ET should be closed (past 17:00)");
  if (!friEvening.next_opens_at) failures.push("next_opens_at should be Monday");
  else {
    // Monday 09:00 ET ≈ 13:00 UTC. Check the ISO string is around that time.
    const next = new Date(friEvening.next_opens_at);
    // Should be within +/- a couple of days of the source instant.
    const days = Math.abs(next.getTime() - new Date("2026-08-01T00:00:00Z").getTime()) / 86400000;
    if (days < 2 || days > 4) failures.push(`next_opens_at seems wrong: ${friEvening.next_opens_at} (~${days.toFixed(1)} days away)`);
  }
  // Day boundary — Mon 08:00 ET (before open) → next_opens_at is today 09:00 ET
  // 2026-07-27 12:00 UTC = 08:00 EDT
  const monBeforeOpen = computeIsOpenNow(monFri, new Date("2026-07-27T12:00:00Z"));
  if (monBeforeOpen.is_open) failures.push("Mon 08:00 ET should be closed");
  if (!monBeforeOpen.next_opens_at) failures.push("Mon 08:00 ET should have next_opens_at");
  record("T12 hours/now boundary + week rollover", failures.length === 0, failures.join("; ") || "Fri-evening → Mon; Mon 08:00 → Mon 09:00");
}

async function T13_invite_call_reaches_admin() {
  const fake = new FakeSupabaseClient();
  fake.inviteResponses.push({ email: "t13@example.com", user_id: "t13-user" });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { departments: [] } },
  );
  fake.on(
    (c) => c.op === "upsert" && c.table === "user_businesses",
    { data: [{ user_id: "t13-user" }] },
  );

  // Wrap inviteUserByEmail to capture the call.
  let captured: { email: string; opts: any } | null = null;
  const origInvite = fake.auth.admin.inviteUserByEmail;
  fake.auth.admin.inviteUserByEmail = async (email: string, opts: any) => {
    captured = { email, opts };
    return origInvite(email, opts);
  };

  const result = await handleInviteMember(asClient(fake), BIZ, USER_A, "admin" as any, {
    email: "t13@example.com",
    role: "user" as any,
    initial_topics: [],
    callback_ring_number: null,
    full_name: "T13 User",
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (!captured) failures.push("inviteUserByEmail not called");
  else {
    if ((captured as any).email !== "t13@example.com") failures.push(`captured email=${(captured as any).email}`);
    const meta = (captured as any).opts?.data;
    if (meta?.businessId !== BIZ) failures.push(`captured businessId=${meta?.businessId}`);
    if (meta?.role !== "user") failures.push(`captured role=${meta?.role}`);
    if (meta?.full_name !== "T13 User") failures.push(`captured full_name=${meta?.full_name}`);
  }
  record("T13 invite calls auth.admin.inviteUserByEmail", failures.length === 0, failures.join("; ") || "invite called with email + metadata");
}

async function T14_delete_self_forbidden() {
  const fake = new FakeSupabaseClient();
  const result = await handleDeleteMember(asClient(fake), BIZ, USER_A, USER_A);
  const failures: string[] = [];
  if (result.ok) failures.push("self-delete should be forbidden");
  else if (result.status !== 403) failures.push(`status=${result.status}`);
  // No DELETE issued.
  const deletes = fake.calls.filter((c) => c.op === "delete");
  if (deletes.length !== 0) failures.push(`unexpected DELETE issued (${deletes.length})`);

  // Positive case — deleting someone else works.
  const fake2 = new FakeSupabaseClient();
  fake2.on(
    (c) => c.op === "delete" && c.table === "user_businesses",
    { data: { user_id: USER_B } },
  );
  const other = await handleDeleteMember(asClient(fake2), BIZ, USER_A, USER_B);
  if (!other.ok) failures.push(`deleting other user failed: ${(other as any).error}`);

  // 404 when target doesn't exist.
  const fake3 = new FakeSupabaseClient();
  fake3.on(
    (c) => c.op === "delete" && c.table === "user_businesses",
    { data: null },
  );
  const missing = await handleDeleteMember(asClient(fake3), BIZ, USER_A, USER_C);
  if (missing.ok) failures.push("missing target should 404");
  else if (missing.status !== 404) failures.push(`missing status=${missing.status}`);
  record("T14 DELETE self forbidden + other allowed + 404", failures.length === 0, failures.join("; ") || "self→403, other→200, missing→404");
}

async function T15_parser_real_samples() {
  const cases: Array<{ input: string; wantOpen: number[]; wantWarn: boolean; label: string }> = [
    { input: "Monday-Friday 9AM-5PM", wantOpen: [1, 2, 3, 4, 5], wantWarn: false, label: "canonical" },
    { input: "Tuesday-Saturday 10AM-7PM", wantOpen: [2, 3, 4, 5, 6], wantWarn: false, label: "shifted range" },
    { input: "9-5 Mon-Fri", wantOpen: [1, 2, 3, 4, 5], wantWarn: false, label: "reversed order" },
    { input: "9-5", wantOpen: [1, 2, 3, 4, 5], wantWarn: false, label: "bare 9-5 → Mon-Fri" },
    { input: "Monday-Friday 7AM-7PM, 24/7 Emergency", wantOpen: [1, 2, 3, 4, 5], wantWarn: false, label: "emergency appendix ignored" },
    { input: "Mon-Fri 9:00 AM - 5:00 PM", wantOpen: [1, 2, 3, 4, 5], wantWarn: false, label: "colon+ampm+spaces" },
    { input: "Mon, Tue, Wed, Thu, Fri, Sat 9:00 AM - 4:00 PM", wantOpen: [1, 2, 3, 4, 5, 6], wantWarn: false, label: "EZ Rentals day list" },
    { input: "24/7", wantOpen: [0, 1, 2, 3, 4, 5, 6], wantWarn: false, label: "24/7 shorthand" },
    { input: "24 hours", wantOpen: [0, 1, 2, 3, 4, 5, 6], wantWarn: false, label: "24 hours shorthand" },
    { input: "By appointment", wantOpen: [1, 2, 3, 4, 5], wantWarn: true, label: "unparseable → fallback" },
    { input: "", wantOpen: [1, 2, 3, 4, 5], wantWarn: true, label: "empty → fallback" },
    { input: "Mon-Wed 10AM-2PM", wantOpen: [1, 2, 3], wantWarn: false, label: "short range" },
    { input: "Sat-Sun 12-6", wantOpen: [6, 0], wantWarn: false, label: "weekend wrap" },
    { input: "Sunday 10AM-2PM", wantOpen: [0], wantWarn: false, label: "single day → Sunday only" },
    { input: "Friday-Monday 9-5", wantOpen: [5, 6, 0, 1], wantWarn: false, label: "wrap around week" },
  ];

  const failures: string[] = [];
  for (const c of cases) {
    const r = parseBusinessHours(c.input);
    const openDows = r.rows.filter((row) => !row.is_closed).map((row) => row.day_of_week).sort();
    const wantDows = c.wantOpen.slice().sort();
    if (openDows.join(",") !== wantDows.join(",")) {
      failures.push(`[${c.label}] open=${openDows.join(",")} want=${wantDows.join(",")}`);
    }
    if (r.usedFallback !== c.wantWarn) {
      failures.push(`[${c.label}] usedFallback=${r.usedFallback} want=${c.wantWarn}`);
    }
  }
  record("T15 parser × 15 real samples", failures.length === 0, failures.join(" | ") || "all 15 samples produce expected day set + fallback flag");
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  await T1_clock_in();
  await T2_clock_out();
  await T3_list_team();
  await T4_cross_tenant_404();
  await T5_invite_creates_membership_and_topics();
  await T6_patch_topics();
  await T7_reset_topics();
  await T8_get_hours();
  await T9_patch_hours();
  await T10_hours_now_table_driven();
  await T11_staff_topics_unique_via_patch();
  await T12_hours_now_boundary_next();
  await T13_invite_call_reaches_admin();
  await T14_delete_self_forbidden();
  await T15_parser_real_samples();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
