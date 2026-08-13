/**
 * Phase 6.0 — qualification-gate smoke.
 *
 * Pure unit checks against the exported building blocks:
 *   - routes/topics.ts       (parseTopicsBody with qualification)
 *   - lib/prompt-renderer.ts (renderPromptFromHelpers gating)
 *   - agents.ts              (build*Tool schema shape)
 *
 * No network I/O. No Supabase. No ElevenLabs. Run with:
 *   pnpm --filter @workspace/api-server exec tsx ./src/tests/053-qualification-gate-smoke.ts
 *
 * Coverage matches Phase 6.0 acceptance:
 *   T1 — renderer emits QUALIFICATION block only when enabled + content
 *   T2 — rendered prompt contains requirements_text verbatim
 *   T3 — rendered prompt references request_callback (not route_to_topic) on the unqualified path
 *   T4 — parser accepts a well-formed qualification block
 *   T5 — parser rejects enabled=true without requirements
 *   T6 — parser rejects duplicate disqualifier ids
 *   T7 — request_callback tool omits disqualifier_id when no gate exists
 *   T8 — request_callback tool includes disqualifier_id enum when gates exist
 *   T9 — route_to_topic tool includes qualification_confirmed only when gate is active
 */

import { renderPromptFromHelpers } from "../lib/prompt-renderer";
import { parseTopicsBody } from "../routes/topics";
import { buildRequestCallbackTool, buildRouteToTopicTool } from "../agents";

interface TestResult {
  name: string;
  pass: boolean;
  details: string;
}
const results: TestResult[] = [];

function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${details}`);
}

const EZ_RENTALS_REQUIREMENTS =
  "Valid Maryland driver's license, not expired — no learner's or provisional. 25 or older. Vehicle stays in Maryland — cannot enter DC, PA, or Virginia. Two-day minimum for new contracts. $70 security deposit. $95 daily rate. Payment by 3pm same day; we accept cash, Zelle, debit, credit, Cash App, Klarna, or AfterPay.";

const NEW_RESERVATION_TOPIC = {
  slug: "new_reservation",
  name: "New reservations",
  description: "Callers who want to rent a car.",
  example_utterances: ["I need to rent a car", "book me a rental"],
  qualification: {
    enabled: true,
    requirements_text: EZ_RENTALS_REQUIREMENTS,
    disqualifiers: [
      { id: "no_md_license",       label: "No valid Maryland license",  kind: "permanent" as const },
      { id: "under_25",            label: "Under 25",                    kind: "permanent" as const },
      { id: "leaving_md",          label: "Needs to leave Maryland",     kind: "permanent" as const },
      { id: "restricted_state",    label: "Needs DC / PA / VA",          kind: "permanent" as const },
      { id: "one_day_only",        label: "Wants a 1-day rental",        kind: "temporary" as const },
      { id: "cannot_pay_by_3pm",   label: "Cannot pay by 3pm today",     kind: "temporary" as const },
      { id: "unsupported_payment", label: "No accepted payment method",  kind: "temporary" as const },
    ],
    permanent_close:
      "Thanks for calling EZ Rentals. Unfortunately we won't be able to help with a rental. Wishing you the best.",
    temporary_close:
      "Thanks for calling EZ Rentals. Please give us a call back when that changes and we'd be happy to get you set up.",
  },
};

const ROADSIDE_TOPIC = {
  slug: "roadside",
  name: "Roadside assistance",
  description: "Existing renters who need roadside help.",
  example_utterances: ["I've broken down"],
};

function baseRenderOpts(topics: any[]) {
  return {
    business_name: "EZ Rentals",
    industry: "car_rental",
    business_hours: "Mon–Sat 9am–6pm",
    timezone: "America/New_York",
    topics,
  };
}

// ── T1 & T2 & T3 ─────────────────────────────────────────────────────

function testRendererWithGate() {
  const prompt = renderPromptFromHelpers(baseRenderOpts([NEW_RESERVATION_TOPIC, ROADSIDE_TOPIC]));

  const containsHeading = prompt.includes("QUALIFICATION REQUIREMENTS");
  const containsRequirementsVerbatim = prompt.includes(EZ_RENTALS_REQUIREMENTS);
  const containsRoutePermanentClose = prompt.includes(NEW_RESERVATION_TOPIC.qualification.permanent_close);
  const containsRouteTemporaryClose = prompt.includes(NEW_RESERVATION_TOPIC.qualification.temporary_close);
  const containsHardRulesHeading = prompt.includes("QUALIFICATION RULES");
  const containsNonNegotiation = prompt.includes("do NOT have authority to grant exceptions");
  const containsRequestCallbackForUnqualified = prompt.includes(
    "Instead invoke request_callback with disqualifier_id set to the id of the requirement they failed",
  );
  const forbidsRouteToTopicWhenUnqualified = prompt.includes("do NOT invoke route_to_topic");
  const roadsideAppearsInBlock = prompt.includes('topic_slug: "roadside"');

  record(
    "T1a renderer emits QUALIFICATION heading when block enabled",
    containsHeading,
    "found 'QUALIFICATION REQUIREMENTS'",
  );
  record(
    "T1b renderer emits QUALIFICATION RULES paragraph exactly once",
    containsHardRulesHeading && (prompt.match(/QUALIFICATION RULES/g) || []).length === 1,
    `hard-rules occurrences=${(prompt.match(/QUALIFICATION RULES/g) || []).length}`,
  );
  record(
    "T2 requirements_text emitted verbatim",
    containsRequirementsVerbatim,
    containsRequirementsVerbatim ? "verbatim match" : "requirements_text NOT found verbatim",
  );
  record(
    "T3a rendered prompt references request_callback on unqualified path",
    containsRequestCallbackForUnqualified,
    "unqualified guidance references request_callback",
  );
  record(
    "T3b rendered prompt forbids route_to_topic when unqualified",
    forbidsRouteToTopicWhenUnqualified,
    "found 'do NOT invoke route_to_topic'",
  );
  record(
    "T3c both closing messages emitted",
    containsRoutePermanentClose && containsRouteTemporaryClose,
    "permanent + temporary close strings present",
  );
  record(
    "T3d non-gated topic (roadside) still renders in DEPARTMENTS block",
    roadsideAppearsInBlock,
    "found roadside topic_slug",
  );
  record(
    "T3e non-negotiation clause present",
    containsNonNegotiation,
    "found 'do NOT have authority to grant exceptions'",
  );
}

function testRendererWithoutGate() {
  const disabled = {
    ...NEW_RESERVATION_TOPIC,
    qualification: { ...NEW_RESERVATION_TOPIC.qualification, enabled: false },
  };
  const promptDisabled = renderPromptFromHelpers(baseRenderOpts([disabled, ROADSIDE_TOPIC]));
  const noQualificationBlock = !promptDisabled.includes("QUALIFICATION REQUIREMENTS");
  const noHardRules = !promptDisabled.includes("QUALIFICATION RULES");
  record(
    "T1c renderer skips QUALIFICATION block when enabled=false",
    noQualificationBlock && noHardRules,
    "no qualification heading, no hard-rules paragraph",
  );

  const noQualAtAll = renderPromptFromHelpers(baseRenderOpts([ROADSIDE_TOPIC]));
  const noBlockNoTopics = !noQualAtAll.includes("QUALIFICATION REQUIREMENTS") && !noQualAtAll.includes("QUALIFICATION RULES");
  record(
    "T1d renderer skips QUALIFICATION block when no topic has qualification",
    noBlockNoTopics,
    "topics without qualification → no block emitted",
  );
}

// ── T4-T6 parser ─────────────────────────────────────────────────────

function testParserAccepts() {
  const parsed = parseTopicsBody({ topics: [NEW_RESERVATION_TOPIC] });
  const ok = "topics" in parsed && !!parsed.topics[0].qualification;
  const disqCount = "topics" in parsed ? parsed.topics[0].qualification?.disqualifiers.length ?? 0 : 0;
  record(
    "T4 parser accepts well-formed qualification block",
    ok && disqCount === 7,
    `disqualifiers=${disqCount}`,
  );
}

function testParserRejectsEnabledWithoutRequirements() {
  const bad = {
    topics: [
      {
        ...NEW_RESERVATION_TOPIC,
        qualification: { ...NEW_RESERVATION_TOPIC.qualification, requirements_text: "" },
      },
    ],
  };
  const parsed = parseTopicsBody(bad);
  const rejected = "error" in parsed && parsed.error.includes("requirements_text is required");
  record(
    "T5 parser rejects enabled=true without requirements_text",
    rejected,
    "error" in parsed ? parsed.error : "unexpected accept",
  );
}

function testParserRejectsDuplicateIds() {
  const bad = {
    topics: [
      {
        ...NEW_RESERVATION_TOPIC,
        qualification: {
          ...NEW_RESERVATION_TOPIC.qualification,
          disqualifiers: [
            { id: "under_25", label: "Under 25", kind: "permanent" },
            { id: "under_25", label: "Under 25 again", kind: "temporary" },
          ],
        },
      },
    ],
  };
  const parsed = parseTopicsBody(bad);
  const rejected = "error" in parsed && parsed.error.includes("duplicate disqualifier");
  record(
    "T6a parser rejects duplicate disqualifier ids",
    rejected,
    "error" in parsed ? parsed.error : "unexpected accept",
  );
}

function testParserRejectsBadIdFormat() {
  const bad = {
    topics: [
      {
        ...NEW_RESERVATION_TOPIC,
        qualification: {
          ...NEW_RESERVATION_TOPIC.qualification,
          disqualifiers: [
            { id: "Under 25!", label: "Under 25", kind: "permanent" },
          ],
        },
      },
    ],
  };
  const parsed = parseTopicsBody(bad);
  const rejected = "error" in parsed && parsed.error.includes("snake_case");
  record(
    "T6b parser rejects non-snake_case disqualifier id",
    rejected,
    "error" in parsed ? parsed.error : "unexpected accept",
  );
}

function testParserRejectsMissingCloseMessage() {
  const bad = {
    topics: [
      {
        ...NEW_RESERVATION_TOPIC,
        qualification: {
          ...NEW_RESERVATION_TOPIC.qualification,
          temporary_close: "",
        },
      },
    ],
  };
  const parsed = parseTopicsBody(bad);
  const rejected = "error" in parsed && parsed.error.includes("temporary_close");
  record(
    "T6c parser rejects missing temporary_close when temporary disqualifier present",
    rejected,
    "error" in parsed ? parsed.error : "unexpected accept",
  );
}

// ── T7-T9 tool schemas ───────────────────────────────────────────────

function tolerantGet(obj: any, path: string[]): any {
  let cur = obj;
  for (const p of path) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function testRequestCallbackToolWithoutGate() {
  const tool = buildRequestCallbackTool({
    businessId: "biz_x",
    captureUrl: "https://example.com/leads/capture",
    toolSecret: "s",
  }) as any;
  const props = tolerantGet(tool, ["api_schema", "request_body_schema", "properties"]);
  const hasDisq = props && "disqualifier_id" in props;
  record(
    "T7 request_callback omits disqualifier_id when no gates exist",
    props && !hasDisq,
    hasDisq ? "unexpected disqualifier_id present" : "field correctly omitted",
  );
}

function testRequestCallbackToolWithGate() {
  const tool = buildRequestCallbackTool({
    businessId: "biz_x",
    captureUrl: "https://example.com/leads/capture",
    toolSecret: "s",
    disqualifierIds: ["under_25", "leaving_md"],
  }) as any;
  const props = tolerantGet(tool, ["api_schema", "request_body_schema", "properties"]);
  const enumVals: string[] | undefined = tolerantGet(props, ["disqualifier_id", "enum"]);
  const ok = Array.isArray(enumVals) && enumVals.includes("under_25") && enumVals.includes("leaving_md");
  record(
    "T8 request_callback includes disqualifier_id enum when gates exist",
    ok,
    `enum=${JSON.stringify(enumVals)}`,
  );
}

function testRouteToTopicToolFlag() {
  const off = buildRouteToTopicTool({
    businessId: "biz_x",
    routeToTopicUrl: "https://example.com/routing/route-to-topic",
    toolSecret: "s",
    topics: [{ slug: "new_reservation", name: "New reservations" }],
  }) as any;
  const on = buildRouteToTopicTool({
    businessId: "biz_x",
    routeToTopicUrl: "https://example.com/routing/route-to-topic",
    toolSecret: "s",
    topics: [{ slug: "new_reservation", name: "New reservations" }],
    qualificationGateActive: true,
  }) as any;
  const offProps = tolerantGet(off, ["api_schema", "request_body_schema", "properties"]);
  const onProps = tolerantGet(on, ["api_schema", "request_body_schema", "properties"]);
  const offAbsent = offProps && !("qualification_confirmed" in offProps);
  const onPresent = onProps && onProps.qualification_confirmed?.type === "boolean";
  record(
    "T9a route_to_topic omits qualification_confirmed by default",
    offAbsent,
    offAbsent ? "field correctly omitted" : "unexpected field present",
  );
  record(
    "T9b route_to_topic includes qualification_confirmed boolean when gate active",
    onPresent,
    onPresent ? "field present as boolean" : `unexpected shape: ${JSON.stringify(onProps?.qualification_confirmed)}`,
  );
}

// ── Runner ───────────────────────────────────────────────────────────

function main() {
  testRendererWithGate();
  testRendererWithoutGate();
  testParserAccepts();
  testParserRejectsEnabledWithoutRequirements();
  testParserRejectsDuplicateIds();
  testParserRejectsBadIdFormat();
  testParserRejectsMissingCloseMessage();
  testRequestCallbackToolWithoutGate();
  testRequestCallbackToolWithGate();
  testRouteToTopicToolFlag();

  const failed = results.filter((r) => !r.pass);
  console.log("");
  console.log(`Total: ${results.length}  Pass: ${results.length - failed.length}  Fail: ${failed.length}`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
