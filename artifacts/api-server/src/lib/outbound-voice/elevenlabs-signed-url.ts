/**
 * Phase 0 Commit 0-D — ElevenLabs signed-URL fetcher.
 *
 * The TwilioRestProvider outbound_automated flow connects Twilio's
 * media stream to an ElevenLabs WSS URL. ElevenLabs requires us to
 * fetch a one-shot signed URL per call via:
 *
 *   GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url
 *       ?agent_id=<agent_id>
 *   Headers: xi-api-key: <ELEVENLABS_API_KEY>
 *
 * Response shape:
 *   { signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?token=..." }
 *
 * The URL has a TTL (~15 minutes per ElevenLabs docs); we fetch a
 * fresh one per call placement. No caching here — the cost of a wasted
 * fetch on a never-placed call is negligible compared to the
 * correctness risk of returning a stale URL.
 *
 * Returns null on any failure (missing env, network error, non-2xx,
 * malformed response). Callers fail-closed to a <Hangup/> TwiML; this
 * helper never throws.
 */

const SIGNED_URL_ENDPOINT =
  "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url";

export interface SignedUrlResult {
  url: string;
}

export async function getSignedConversationUrl(
  agentId: string,
): Promise<SignedUrlResult | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  if (!agentId) return null;

  const url = `${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(agentId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "xi-api-key": apiKey },
    });
  } catch (err: any) {
    console.error(
      "[elevenlabs-signed-url] network error fetching signed URL:",
      err?.message || String(err),
    );
    return null;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(
      "[elevenlabs-signed-url] non-2xx from get-signed-url:",
      response.status,
      text.slice(0, 300),
    );
    return null;
  }
  let data: any;
  try {
    data = await response.json();
  } catch (err: any) {
    console.error("[elevenlabs-signed-url] response not JSON:", err?.message);
    return null;
  }
  const signed = typeof data?.signed_url === "string" ? data.signed_url : null;
  if (!signed) {
    console.error(
      "[elevenlabs-signed-url] response missing signed_url field:",
      JSON.stringify(data).slice(0, 200),
    );
    return null;
  }
  return { url: signed };
}
