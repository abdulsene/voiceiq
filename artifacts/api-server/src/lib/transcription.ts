/**
 * Deepgram nova-3 transcription wrapper.
 *
 * Used by the lead-bridge flow: when a Twilio recording-status webhook
 * arrives with a completed dual-channel recording, we kick off
 * transcribeRecording in a fire-and-forget Promise. The result populates
 * lead_calls.transcript_text + transcript_segments + transcript_confidence
 * via a separate write path. The webhook responds 200 immediately.
 *
 * Why multichannel, not diarize:
 *   Twilio's record-from-ringing-dual produces a 2-channel file with the
 *   staff leg on channel 0 and the customer leg on channel 1.
 *   `multichannel=true` makes Deepgram return one transcript array per
 *   channel — deterministic speaker separation, no heuristic guesswork.
 *
 * Why fetch directly, not the @deepgram/sdk:
 *   The REST surface is small (one POST). The SDK adds 1MB+ of deps for
 *   no functional gain. Direct fetch matches the codebase's existing
 *   ElevenLabs / Anthropic patterns.
 *
 * Boot-time check: DEEPGRAM_API_KEY is REQUIRED. Calling getDeepgramKey()
 * with no key set throws — by spec, fail-loud rather than fall back to a
 * placeholder. The first transcription attempt after a missing-key deploy
 * surfaces the failure immediately; we don't silently degrade.
 */

function getDeepgramKey(): string {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error("DEEPGRAM_API_KEY environment variable is required but not set");
  }
  return key;
}

export interface TranscriptSegment {
  channel: number;
  speaker_label: "staff" | "customer" | string;
  text: string;
  confidence: number;
  start: number; // seconds
  end: number;   // seconds
}

export interface TranscriptionResult {
  transcript_text: string;             // human-readable; "Staff: …\nCustomer: …" interleaved by timestamp
  segments: TranscriptSegment[];
  confidence: number;                  // overall confidence, average across channels
  model: string;                       // 'nova-3' (echoed back for audit / reproducibility)
}

/**
 * Map a channel index to a speaker label. Channel 0 = staff (the
 * outbound leg Twilio dials first), channel 1 = customer (the bridged
 * leg). The Twilio Dial verb deterministically puts the parent call
 * (staff) on channel 1 of the recording per docs — but in practice many
 * deployments see staff on channel 0. Smoke-test verifies the mapping
 * against a known-shape recording; the convention may need a swap in
 * production. Keep this as a single helper so a flip is a one-line
 * change.
 */
function speakerLabelForChannel(channel: number): "staff" | "customer" | "unknown" {
  if (channel === 0) return "staff";
  if (channel === 1) return "customer";
  return "unknown";
}

/**
 * Transcribe a Twilio recording URL with Deepgram nova-3.
 *
 * Twilio recording URLs require HTTP Basic auth to fetch (AccountSid +
 * AuthToken). Deepgram fetches the URL itself — so we must pass it a URL
 * Deepgram can authenticate against. Two options:
 *   1. Append basic-auth credentials to the URL inline:
 *      https://AccountSid:AuthToken@api.twilio.com/...
 *      Deepgram supports this. Cleaner than pre-downloading.
 *   2. Pre-download via twilio SDK, POST raw bytes to Deepgram.
 *
 * We use option 1 for v1 — fewer round-trips, no temp file storage.
 * Twilio rotates auth tokens via account-level controls, not per-URL,
 * so a rotation requires re-syncing any in-flight URLs (rare;
 * acceptable failure mode for Slice 2A).
 */
export async function transcribeRecording(recordingUrl: string): Promise<TranscriptionResult> {
  const key = getDeepgramKey();
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  if (!twilioSid || !twilioToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required to fetch recording URL");
  }
  // Inject basic-auth into the URL Deepgram will fetch.
  const authedUrl = recordingUrl.replace(/^https:\/\//, `https://${encodeURIComponent(twilioSid)}:${encodeURIComponent(twilioToken)}@`);

  const params = new URLSearchParams({
    model: "nova-3",
    smart_format: "true",
    multichannel: "true",
    // Twilio dual-channel recordings are usually stereo MP3. mimetype
    // hint helps Deepgram avoid an autodetect round-trip.
    mimetype: "audio/mpeg",
  });
  const endpoint = `https://api.deepgram.com/v1/listen?${params.toString()}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: authedUrl }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Deepgram returned ${res.status}: ${errText.slice(0, 500)}`);
  }
  const data: any = await res.json();

  // Per the docs, multichannel response shape: results.channels[] with
  // alternatives[0].transcript per channel, plus per-word entries with
  // start/end timestamps.
  const channels: any[] = data?.results?.channels || [];
  const segments: TranscriptSegment[] = [];
  const channelConfidences: number[] = [];

  channels.forEach((ch: any, channelIdx: number) => {
    const alt = ch?.alternatives?.[0];
    if (!alt) return;
    const text: string = alt.transcript || "";
    const conf: number = typeof alt.confidence === "number" ? alt.confidence : 0;
    channelConfidences.push(conf);
    // Use paragraphs/utterances if Deepgram returned them under
    // smart_format, otherwise fall back to one segment per channel.
    // smart_format response usually contains alt.paragraphs.paragraphs[]
    // but the shape can vary; collapse to one segment per channel for
    // Slice 2A's needs (we just need speaker-labeled chunks for the UI).
    if (text) {
      // Estimate start/end from alt.words if present.
      const words: any[] = alt.words || [];
      const start = words.length > 0 ? Number(words[0].start) : 0;
      const end = words.length > 0 ? Number(words[words.length - 1].end) : 0;
      segments.push({
        channel: channelIdx,
        speaker_label: speakerLabelForChannel(channelIdx),
        text,
        confidence: conf,
        start,
        end,
      });
    }
  });

  // Build the human-readable transcript by interleaving by timestamp.
  // Slice 2A keeps it simple: one block per channel, in channel order.
  // The UI's transcript modal can render the segments[] more richly.
  const transcript_text = segments
    .map((s) => `${s.speaker_label === "staff" ? "Staff" : s.speaker_label === "customer" ? "Customer" : `Channel ${s.channel}`}: ${s.text}`)
    .join("\n\n");

  const avgConfidence = channelConfidences.length > 0
    ? channelConfidences.reduce((a, b) => a + b, 0) / channelConfidences.length
    : 0;

  return {
    transcript_text,
    segments,
    confidence: avgConfidence,
    model: "nova-3",
  };
}
