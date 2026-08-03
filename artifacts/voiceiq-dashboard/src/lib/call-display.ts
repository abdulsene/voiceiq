/**
 * Phase 4.4 — shared call-display helpers.
 *
 * Extracted from pages/Phone.tsx so pages/CallDetail.tsx can reuse
 * the same maps without duplicating them. The Phase 4.4 brief said
 * "reuse DISPOSITION_DISPLAY from the Phone page — do not duplicate
 * it" — this is where they now both live.
 *
 * DO NOT re-inline these into components. Rendering call state in
 * two shapes across surfaces was the exact bug the Phase 4.3 audit
 * called out (6 / 10 / 15 fields depending on where you looked).
 */

/**
 * Tone used for badge / icon colouring. Kept as a 3-slot enum so
 * consumers can key a colour map off it without importing the
 * label maps themselves.
 */
export type OutcomeTone = "answered" | "missed" | "neutral";

/**
 * Phase 3.9 — outcome taxonomy. Twilio's DialCallStatus + AMD
 * outcome mapped to a small, aggregation-friendly label set. Any
 * `call.call_outcome` value not in this map falls through to the
 * raw enum in the UI so ops can grep for it.
 *
 * Keep in sync with mapDialOutcome in routes/voice.ts. A mismatch
 * shows the raw enum, not silent silence.
 */
export const OUTCOME_DISPLAY: Record<string, { label: string; tone: OutcomeTone }> = {
  answered_human: { label: "Answered", tone: "answered" },
  voicemail: { label: "Voicemail", tone: "missed" },
  no_answer: { label: "No answer", tone: "missed" },
  busy: { label: "Busy", tone: "missed" },
  failed: { label: "Failed", tone: "missed" },
  canceled: { label: "Canceled", tone: "neutral" },
  caller_hung_up_during_ring: { label: "You hung up", tone: "neutral" },
  // Pre-3.9 rows keep their existing values — don't hide them.
  answered: { label: "Answered", tone: "answered" },
  completed: { label: "Answered", tone: "answered" },
  lead_captured: { label: "Lead captured", tone: "answered" },
  callback_requested: { label: "Callback requested", tone: "neutral" },
};

/**
 * Compute the display outcome for a row. Falls through to the raw
 * enum for unknown values (grep-able); "initiated" gets a friendly
 * "In progress" label.
 */
export function displayOutcome(call: {
  call_outcome?: string | null;
  status?: string | null;
}): { label: string; tone: OutcomeTone } {
  const key = call.call_outcome || call.status || "";
  return (
    OUTCOME_DISPLAY[key] ||
    (key === "initiated"
      ? { label: "In progress", tone: "neutral" }
      : { label: key || "unknown", tone: "neutral" })
  );
}

/**
 * Phase 3.12 — human-readable disposition labels. Keep in sync
 * with the server's whitelist (CALL_DISPOSITIONS in routes/voice.ts).
 * Mismatch falls through to the raw enum, matching OUTCOME_DISPLAY.
 */
export const DISPOSITION_DISPLAY: Record<string, { label: string; tone: OutcomeTone }> = {
  reached_person: { label: "Reached person", tone: "answered" },
  voicemail_left_message: { label: "Voicemail — left message", tone: "missed" },
  voicemail_no_message: { label: "Voicemail — no message", tone: "missed" },
  wrong_number: { label: "Wrong number", tone: "missed" },
  no_answer_bad_line: { label: "No answer / bad line", tone: "missed" },
};

/**
 * Phase 3.12 — is this a call we WOULD have shown the disposition
 * modal for (i.e., an outbound call that connected)? Used to render
 * an "Not dispositioned" hint on undispositioned rows that COULD
 * have been dispositioned — distinct from calls that never
 * connected (no_answer / busy / failed / caller_hung_up_during_ring)
 * which have accurate inferred outcomes and don't need staff input.
 */
export function isDispositionableRow(call: {
  direction?: string | null;
  call_outcome?: string | null;
  status?: string | null;
}): boolean {
  if (call.direction !== "outbound") return false;
  const inferred = call.call_outcome || call.status || "";
  return (
    inferred === "answered_human" ||
    inferred === "answered" ||
    inferred === "completed" ||
    inferred === "voicemail"
  );
}

/**
 * Phase 4.6 — human-readable "why we skipped analysis" labels for
 * the call detail page. Rendered when analysis_skipped_reason is
 * set, INSTEAD of the (empty) analysis block, so a legitimately-
 * skipped row doesn't render as if the analyzer is broken.
 */
export const SKIP_REASON_DISPLAY: Record<string, { headline: string; body: string }> = {
  empty: {
    headline: "No transcript",
    body: "This call has no transcript to analyze — the caller hung up before speaking, or the call never connected.",
  },
  too_short: {
    headline: "Too short to analyze",
    body: "This call was too brief for the analyzer to reason about (fewer than 2 exchanges from the caller). Sentiment, emotion, and satisfaction aren't computed for short calls to avoid fabricated defaults.",
  },
};

/**
 * Phase 4.4 — direction label for the "Other party" line. On
 * outbound softphone calls the caller is the staff member, so
 * calling `caller_number` "Caller" would mislead. "Other party"
 * is neutral in both directions.
 */
export function otherPartyLabel(): string {
  return "Other party";
}
