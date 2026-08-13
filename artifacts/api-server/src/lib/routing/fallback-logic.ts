/**
 * Phase 3.2a — pure routing decision function.
 *
 * Given a snapshot of the routing state (on-duty staff for the topic,
 * on-duty staff overall, business-hours status, and whether the topic
 * still exists in this business's departments), produce a single
 * RoutingDecision describing exactly what to do next.
 *
 * Pure, synchronous, no DB, no logging, no Twilio. Callers upstream
 * fetch the state; callers downstream turn the decision into TwiML
 * (dial-builder.ts) and DB writes (routes/routing.ts).
 *
 * Priority order:
 *   1. Topic no longer configured (race: departments cleared after
 *      Alex identified the topic) → any_on_duty fallback with a
 *      distinctive handoffReason so ops can see the race in reporting.
 *   2. On-duty staff for this topic exists → topic_match.
 *   3. Any on-duty staff (regardless of topic) → any_on_duty.
 *   4. Business open + legacy transfer_to_phone configured → legacy_transfer.
 *   5. Business closed → after_hours_callback (AI takes a message).
 *   6. Business open but nobody home and no legacy phone → graceful_hangup.
 *      As of Phase 6.3, this path is NOT terminal for the caller. The
 *      handoff_reason column still writes 'graceful_hangup' for
 *      reporting continuity, but publicStatusFor maps it to
 *      'taking_message' so Alex captures a callback via request_callback
 *      before closing. Pre-6.3, this path returned status
 *      'no_help_available' and Alex hung up — losing the lead.
 */

export interface StaffCandidate {
  /** auth.users.id — what gets written to calls.rung_user_ids / handled_by_user_id. */
  userId: string;
  /**
   * E.164 cell phone to dial via <Number>. Phase 3.3: nullable — a
   * candidate is now valid with EITHER a callback number OR a live
   * <Client> device (or both). The routing candidate query filters out
   * rows that have neither.
   */
  callbackRingNumber: string | null;
  /**
   * Phase 3.3 — Twilio Client identity to dial via <Client>. Non-null
   * whenever the staff member has in_app_calling_enabled=true and a
   * client_identity has been derived. Null → dial-builder emits no
   * <Client> for this candidate.
   *
   * Phase 3.15 — the freshness check was REMOVED from this predicate.
   * Previously a stale heartbeat forced this to null and the whole
   * candidate got dropped when they had no callback. Now: we include
   * the Client leg and let a dead <Client> fail fast; simultaneous
   * ring with other candidates and the dial-status callback handle
   * the "nobody home" outcome cleanly, and the user keeps getting
   * warned via /voice/reachability + the app banner.
   */
  clientIdentity?: string | null;
  /**
   * Phase 3.15 — set when the Client leg is being included despite
   * a stale heartbeat (device may or may not answer). Used by the
   * dial-builder to shorten the Dial timeout when every candidate is
   * stale AND has no callback number — otherwise the caller would
   * ring out for the full 30s window before falling through.
   * Absent / undefined = fresh (or no client leg at all).
   */
  deviceStale?: boolean;
}

export type RoutingPath =
  | "topic_match"
  | "any_on_duty"
  | "legacy_transfer"
  | "after_hours_callback"
  | "graceful_hangup";

/**
 * Conventional values for calls.handoff_reason. Kept in sync with the
 * migration 040 header comment so ops can grep for reasons across DB
 * rows and code.
 *
 * Phase 3.2c lifecycle: routing-time reasons end in `_ringing`. The
 * dial-status webhook (routes/routing.handleDialStatus) promotes the
 * ringing suffix to `_answered` on DialCallStatus=completed, and
 * escalates to `all_staff_no_answer` on DialCallStatus=no-answer.
 * Terminal (no-dial) reasons — after_hours_callback, graceful_hangup,
 * topic_no_longer_configured — have no suffix and are never promoted.
 */
export type HandoffReason =
  // Routing-time (ringing) — set by decideRouting()
  | "topic_match_ringing"
  | "fallback_any_on_duty_ringing"
  | "no_staff_during_hours_ringing"
  // Post-dial (answered) — set by handleDialStatus on completed
  | "topic_match_answered"
  | "fallback_any_on_duty_answered"
  | "no_staff_during_hours_answered"
  // Post-dial escalation — set by handleDialStatus on no-answer
  | "all_staff_no_answer"
  // Terminal (no dial)
  | "after_hours_callback"
  | "graceful_hangup"
  // Race flag — routing time, orthogonal to _ringing/_answered
  | "topic_no_longer_configured";

/**
 * Conventional values for calls.transfer_status. Not exhaustive — the
 * post-dial webhook (Phase 3.2b) will also write "answered" /
 * "no_answer" once Twilio reports the outcome.
 */
export type TransferStatusInitial =
  | "routing_topic_match"
  | "routing_any_on_duty"
  | "legacy_transfer_to_phone"
  | "after_hours_callback"
  | "graceful_hangup";

export interface RoutingDecision {
  path: RoutingPath;
  /**
   * Phase 3.3 — the full ordered list of dial candidates. The dial-
   * builder walks these and emits <Client> and/or <Number> children for
   * each. Each candidate contributes zero, one, or two elements
   * (candidates with only a client identity yield <Client>; candidates
   * with only a callback number yield <Number>; candidates with both
   * yield both, simultaneously ringing browser + cell).
   *
   * staffPhones/staffUserIds below are legacy projections kept for the
   * routing UPSERT + Phase 3.2 tests. staffPhones now reflects the
   * subset of candidates that have a non-null callbackRingNumber.
   */
  staffCandidates: StaffCandidate[];
  /** Phones to dial simultaneously via TwiML `<Dial><Number>...</Number></Dial>`. */
  staffPhones: string[];
  /** auth.users.id parallel to staffCandidates — logged into calls.rung_user_ids. */
  staffUserIds: string[];
  /** Only populated on legacy_transfer path. */
  legacyPhone: string | null;
  handoffReason: HandoffReason;
  transferStatus: TransferStatusInitial;
}

export interface RoutingInputs {
  /** Staff on-duty AND assigned to the requested topic, with callback_ring_number NOT NULL. */
  onDutyForTopic: StaffCandidate[];
  /** All staff on-duty (any topic), with callback_ring_number NOT NULL. */
  onDutyAny: StaffCandidate[];
  /** business_hours.now: is the business open at the moment the tool fires? */
  businessOpen: boolean;
  /** business_configs.transfer_to_phone (may be null). */
  legacyTransferToPhone: string | null;
  /** Whether the topic_slug Alex passed exists in business_configs.departments. */
  topicConfigured: boolean;
}

/**
 * Deduplicate a candidate list while preserving order. Belt-and-braces
 * — the caller SHOULD have deduped at the SQL layer, but if the same
 * user_id shows up twice (e.g. because they're assigned to the same
 * topic twice via a stale row), we don't want to dial their cell
 * twice.
 */
function dedupe(candidates: StaffCandidate[]): StaffCandidate[] {
  const seen = new Set<string>();
  const out: StaffCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.userId)) continue;
    seen.add(c.userId);
    out.push(c);
  }
  return out;
}

export function decideRouting(inputs: RoutingInputs): RoutingDecision {
  // (1) Topic race: Alex identified a topic that's since been removed
  //     from the business's departments. Fall through to any-on-duty
  //     with a distinctive reason.
  if (!inputs.topicConfigured) {
    const any = dedupe(inputs.onDutyAny);
    if (any.length > 0) {
      return {
        path: "any_on_duty",
        staffCandidates: any,
        staffPhones: any.map((s) => s.callbackRingNumber).filter((p): p is string => !!p),
        staffUserIds: any.map((s) => s.userId),
        legacyPhone: null,
        handoffReason: "topic_no_longer_configured",
        transferStatus: "routing_any_on_duty",
      };
    }
    // No on-duty at all → cascade to hours check below with the same
    // race-flavoured reason.
    return fallbackFromNoStaff(inputs, "topic_no_longer_configured");
  }

  // (2) Topic match: ring specialists first.
  const forTopic = dedupe(inputs.onDutyForTopic);
  if (forTopic.length > 0) {
    return {
      path: "topic_match",
      staffCandidates: forTopic,
      staffPhones: forTopic.map((s) => s.callbackRingNumber).filter((p): p is string => !!p),
      staffUserIds: forTopic.map((s) => s.userId),
      legacyPhone: null,
      handoffReason: "topic_match_ringing",
      transferStatus: "routing_topic_match",
    };
  }

  // (3) No topic match: try any-on-duty.
  const any = dedupe(inputs.onDutyAny);
  if (any.length > 0) {
    return {
      path: "any_on_duty",
      staffCandidates: any,
      staffPhones: any.map((s) => s.callbackRingNumber).filter((p): p is string => !!p),
      staffUserIds: any.map((s) => s.userId),
      legacyPhone: null,
      handoffReason: "fallback_any_on_duty_ringing",
      transferStatus: "routing_any_on_duty",
    };
  }

  // (4) / (5) / (6): nobody on-duty — dispatch on business_hours + legacy config.
  return fallbackFromNoStaff(inputs, null);
}

function fallbackFromNoStaff(
  inputs: RoutingInputs,
  raceReason: HandoffReason | null,
): RoutingDecision {
  if (inputs.businessOpen && inputs.legacyTransferToPhone) {
    return {
      path: "legacy_transfer",
      staffCandidates: [],
      staffPhones: [],
      staffUserIds: [],
      legacyPhone: inputs.legacyTransferToPhone,
      handoffReason: raceReason ?? "no_staff_during_hours_ringing",
      transferStatus: "legacy_transfer_to_phone",
    };
  }
  if (!inputs.businessOpen) {
    return {
      path: "after_hours_callback",
      staffCandidates: [],
      staffPhones: [],
      staffUserIds: [],
      legacyPhone: null,
      handoffReason: raceReason ?? "after_hours_callback",
      transferStatus: "after_hours_callback",
    };
  }
  // Business is open but no legacy transfer configured and nobody on-duty.
  return {
    path: "graceful_hangup",
    staffCandidates: [],
    staffPhones: [],
    staffUserIds: [],
    legacyPhone: null,
    handoffReason: raceReason ?? "graceful_hangup",
    transferStatus: "graceful_hangup",
  };
}
