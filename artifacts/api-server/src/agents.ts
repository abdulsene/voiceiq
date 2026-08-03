import { renderFirstMessage } from './lib/first-message-renderer';
import * as Sentry from '@sentry/node';
import type { SupabaseClient } from '@supabase/supabase-js';

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY environment variable is required but not set');
  return key;
}

/**
 * Operator-transfer config for the ElevenLabs `transfer_to_number` system
 * tool. Schema mirrors the OpenAPI types we read from api.elevenlabs.io
 * (TransferToNumberToolConfig-Input → PhoneNumberTransfer →
 * PhoneNumberTransferDestination). See agents.ts:buildTransferTool for
 * the JSON shape we ship.
 *
 * `waitMessageTemplate` and `warmMessageTemplate` are NOT static config
 * fields on the ElevenLabs side — `client_message` and `agent_message`
 * are runtime args the LLM produces when invoking the tool. We surface
 * them to the LLM via the tool's `description` so it generates the
 * runtime values from the customer's template. The route handler does
 * any {business_name} interpolation before passing them in.
 */
export type TransferConfig = {
  phoneNumber: string;        // E.164, validated at the route layer
  condition: string;          // natural-language WHEN-to-transfer text
  waitMessageTemplate?: string;
  warmMessageTemplate?: string;
};

const TRANSFER_TOOL_NAME = 'transfer_to_number';
const REQUEST_CALLBACK_TOOL_NAME = 'request_callback';
// Phase 2.2.5 — record_appointment tool name + URL.
const RECORD_APPOINTMENT_TOOL_NAME = 'record_appointment';
// Phase 3.2b — route_to_topic tool name + URL.
const ROUTE_TO_TOPIC_TOOL_NAME = 'route_to_topic';
// Default capture URL. Override per environment via LEADS_CAPTURE_URL.
// Baked into the ElevenLabs agent config at PATCH time, so changing this
// requires re-running updateAgentTools for every agent — a one-shot
// resync script is cheap.
const DEFAULT_LEADS_CAPTURE_URL = 'https://voice-i-q.replit.app/api/leads/capture';
const DEFAULT_RECORD_APPOINTMENT_URL = 'https://voice-i-q.replit.app/api/leads/record-appointment';
const DEFAULT_ROUTE_TO_TOPIC_URL = 'https://voice-i-q.replit.app/api/routing/route-to-topic';
// Phase 5.1 — mid-call opt-out. Registered UNCONDITIONALLY on every
// agent (no per-tenant toggle) — non-honoring of a stated opt-out is
// the fastest path to a TCPA action.
const DEFAULT_RECORD_OPT_OUT_URL = 'https://voice-i-q.replit.app/api/routing/opt-out';
const RECORD_OPT_OUT_TOOL_NAME = 'record_opt_out';
const RECORD_OPT_OUT_DESCRIPTION =
  "Record that the caller has asked to be removed from future calls (\"take me off your list\", \"stop calling me\", \"do not call\", \"unsubscribe\"). ALWAYS call this tool BEFORE the caller hangs up if they say any variation of stop-calling. Do NOT try to talk them out of it. Do NOT ask why. Confirm briefly, then end the call.";

// Phase 3.2b — description shown to the LLM. Tells it WHEN to invoke
// route_to_topic and what to say before the tool fires. The tool takes
// over the call via Twilio REST after a 2.5s delay so Alex gets to
// finish speaking the acknowledgement before the stream is torn down.
const ROUTE_TO_TOPIC_DESCRIPTION = `Use this tool to route the caller to an on-duty team member who specializes in the topic they need. Invoke this tool when:

- The caller has a specific request that matches one of the departments listed in DEPARTMENTS & TOPIC EXPERTISE (e.g. roadside breakdown, billing, new reservation)
- The caller explicitly asks to speak to someone in a specific department ("I need the billing team", "can I talk to a manager")
- The issue requires real-time human problem-solving that you cannot handle yourself (e.g. active emergency, complex negotiation)

Do NOT use this tool for simple questions you can answer yourself. Do NOT use it if the caller only wants an appointment (use record_appointment) or only wants a callback later (use request_callback).

Pick the topic_slug that BEST matches the caller's request from the enum. If nothing matches, pick the closest one and let the routing engine handle it — the engine will fall back to any-on-duty staff when there's no topic match.

Before invoking the tool, say ONE sentence telling the caller you're connecting them. Example: "Let me connect you with our roadside team right now." Then invoke the tool. The tool responds quickly with a short acknowledgement; after a brief pause, the caller will hear the team member's phone ring.

If the tool returns status="taking_message", the team is closed or nobody is available — apologize and use request_callback instead. If status="no_help_available", apologize and offer to take a message via request_callback.`;

// NL description shown to the LLM. Tells it WHEN to invoke and what to
// confirm with the caller before invoking. Kept as a module constant so
// resync scripts produce byte-identical tool configs across agents (no
// per-call interpolation aside from the URL + business_id + secret).
const REQUEST_CALLBACK_DESCRIPTION = `Use this tool to capture a callback request for the customer's team. Invoke this tool when:

- The caller asks something you cannot answer AND warm transfer is not appropriate or has failed (e.g. after hours, team is busy, the caller specifically asks for a callback)
- The business is closed and the caller wants follow-up
- The caller explicitly asks for a callback, text, or email
- A follow-up is needed but does not have to be immediate

Before invoking this tool, confirm with the caller:
1. Their full name
2. Their phone number (in case caller-ID is different from what they want followed up at)
3. The reason for the callback, in their own words
4. Their preferred contact channel — ask: "Would you prefer a text, a call, or an email?"
5. Whether it is urgent — if they sound stressed, mention an emergency, or use phrases like "right away" / "as soon as possible," set urgency to 'high' or 'emergency'

Do not invoke this tool silently. Tell the caller you are capturing their request and that someone from the team will follow up shortly. After the tool returns success, confirm: "I've passed that on to the team. Someone will get back to you via {preferred_channel}."

If the tool returns an error, apologize and offer to take a message verbally for the team to call back manually.`;

// Phase 2.2.5 — record_appointment tool description.
// Heavy on the "confirm back to caller" instruction because appointment-
// booking failures are high-cost (missed appointment, customer trust).
// The LLM should over-confirm date/time/reason before firing the tool.
const RECORD_APPOINTMENT_DESCRIPTION = `Use this tool to record an appointment when the caller wants to book one. Invoke this tool when:

- The caller wants to schedule an appointment, booking, or visit
- The caller has agreed to a specific date and time you proposed
- The caller wants to reschedule an existing appointment to a new date and time

Before invoking this tool, you MUST confirm out loud with the caller:
1. The date AND time of the appointment ("So that's Tuesday, March twentieth, at two thirty in the afternoon — is that right?")
2. The reason for the appointment ("And this is for a haircut — correct?")
3. The duration if relevant ("It should take about thirty minutes — does that work?")
4. The caller's phone number if you don't already have it, so we can call back if anything changes

Pass appointment_datetime in ISO 8601 format with timezone (e.g. 2026-06-20T14:30:00-04:00 for 2:30pm Eastern). Pass reason as a 1-2 sentence summary in plain English. Pass duration_minutes if you know it; otherwise omit. Pass notes for anything additional the staff or AI should know (preferences, accommodations).

Do not invoke this tool silently. Tell the caller you are recording their appointment. After the tool returns success, confirm: "I've got that down — your appointment is confirmed for {date} at {time}." If the tool returns an error, apologize, do NOT promise the appointment is booked, and offer to take a message for the team to call back.`;

/**
 * Build the tools-array entry for the transfer_to_number system tool.
 * Shape per ElevenLabs OpenAPI components.schemas.TransferToNumberToolConfig-Input
 * and PhoneNumberTransfer:
 *   {
 *     type: 'system',
 *     name: 'transfer_to_number',
 *     description: <hint to the LLM, includes the customer's wait/warm
 *                  message templates so the runtime client_message /
 *                  agent_message arguments respect their wording>,
 *     params: {
 *       system_tool_type: 'transfer_to_number',
 *       transfers: [{
 *         transfer_destination: { type: 'phone', phone_number: '+1...' },
 *         condition: '<when to transfer>',
 *         transfer_type: 'conference',
 *       }],
 *       enable_client_message: true,
 *     },
 *   }
 *
 * transfer_type: 'conference' is the warm-handoff default per
 * TransferTypeEnum (values: 'blind' | 'conference' | 'sip_refer'). Note:
 * the user spec mentioned 'conference_call' but the API enum is
 * 'conference' — using the canonical value.
 */
export function buildTransferTool(cfg: TransferConfig): unknown {
  const wait = (cfg.waitMessageTemplate || '').trim();
  const warm = (cfg.warmMessageTemplate || '').trim();
  // The runtime client_message / agent_message values are generated by
  // the LLM. Hint it via the tool description so the customer's
  // templates shape what gets said. Without these hints the LLM would
  // improvise generic phrasing.
  const descParts = ['Transfer the caller to a human operator when the condition is met.'];
  if (wait) descParts.push(`When transferring, use this as the message read to the CALLER (client_message): "${wait}"`);
  if (warm) descParts.push(`When transferring, use this as the message read to the OPERATOR who picks up (agent_message): "${warm}"`);
  return {
    type: 'system',
    name: TRANSFER_TOOL_NAME,
    description: descParts.join(' '),
    params: {
      system_tool_type: 'transfer_to_number',
      transfers: [
        {
          transfer_destination: {
            type: 'phone',
            phone_number: cfg.phoneNumber,
          },
          condition: cfg.condition,
          transfer_type: 'conference',
        },
      ],
      enable_client_message: true,
    },
  };
}

/**
 * Build the tools-array entry for the request_callback webhook tool.
 * Shape per ElevenLabs OpenAPI components.schemas.WebhookToolConfig-Input
 * + WebhookToolApiSchemaConfig-Input + LiteralJsonSchemaProperty.
 *
 * Sits in prompt.tools[] alongside (independent of) the transfer_to_number
 * system tool. ElevenLabs picks based on the LLM's tool-call decision per
 * turn; there's no interaction between them.
 *
 * The `business_id` parameter uses `constant_value` so it's baked at PATCH
 * time and the LLM never sees it as a field to fill — avoids the
 * roundtrip-of-reverse-lookup-via-agent_id we'd otherwise need on the
 * capture endpoint.
 *
 * The Authorization header carries the shared secret as a plain Bearer
 * string. Rotation = update env var on our side + re-run updateAgentTools
 * for every agent (a one-shot resync script). Secret store / env-var
 * locator variants exist in the schema but require workspace bootstrap
 * we're not paying for in Slice 1.
 */
export function buildRequestCallbackTool(opts: {
  businessId: string;
  captureUrl: string;
  toolSecret: string;
}): unknown {
  return {
    type: 'webhook',
    name: REQUEST_CALLBACK_TOOL_NAME,
    description: REQUEST_CALLBACK_DESCRIPTION,
    response_timeout_secs: 30,
    disable_interruptions: false,
    // Force speech BEFORE the tool fires — the LLM says e.g. "Let me get
    // that down for you" so the caller hears a natural acknowledgment
    // during the HTTP round-trip rather than silence.
    pre_tool_speech: 'force',
    // Summarized errors keep the LLM able to apologize gracefully on 5xx
    // without leaking raw HTTP details into the caller's conversation.
    tool_error_handling_mode: 'summarized',
    execution_mode: 'immediate',
    api_schema: {
      url: opts.captureUrl,
      method: 'POST',
      content_type: 'application/json',
      request_headers: {
        Authorization: `Bearer ${opts.toolSecret}`,
        'Content-Type': 'application/json',
      },
      request_body_schema: {
        type: 'object',
        required: [
          'business_id',
          'conversation_id',
          'contact_name',
          'contact_phone',
          'reason',
          'urgency',
          'preferred_channel',
        ],
        properties: {
          business_id: {
            type: 'string',
            constant_value: opts.businessId,
          },
          conversation_id: {
            type: 'string',
            description: 'The current ElevenLabs conversation ID. Use the value provided to you in this conversation; do not invent one.',
          },
          contact_name: {
            type: 'string',
            description: "The caller's full name as they stated it during the call. Do not guess; if the caller hasn't given a name yet, ask them first.",
          },
          contact_phone: {
            type: 'string',
            description: "The caller's callback phone number in E.164 format (e.g. +14105551234). If the caller said a 10-digit US number, prepend +1. Confirm the number back to the caller before submitting.",
          },
          contact_email: {
            type: 'string',
            description: "Optional. The caller's email address if they provided one for follow-up. Leave blank if not provided.",
          },
          reason: {
            type: 'string',
            description: "A concise summary of what the caller needs, in their own words. Two or three sentences. Do not embellish; capture only what they said they needed.",
          },
          urgency: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'emergency'],
            description: "How urgent the follow-up is. 'emergency' = something happening RIGHT NOW that requires immediate human attention (safety issue, urgent business problem, customer in distress). 'high' = same-day, time-sensitive. 'medium' = default for normal callbacks. 'low' = non-urgent informational follow-up. Pick based on the caller's tone and explicit words, not on assumption.",
          },
          preferred_channel: {
            type: 'string',
            enum: ['text', 'call', 'email', 'voice_callback'],
            description: "How the caller wants to be reached. 'text' = SMS. 'call' = phone call from the team. 'email' = email. 'voice_callback' = an AI-initiated automated callback. Ask the caller explicitly: \"Would you prefer a text, a call, or an email?\"",
          },
        },
      },
    },
  };
}

/**
 * Phase 2.2.5 — build the tools-array entry for the record_appointment
 * webhook tool. Same shape as buildRequestCallbackTool (above): webhook
 * type, Bearer-token auth via shared secret, business_id baked via
 * constant_value at PATCH time.
 *
 * Conditionally registered by updateAgentTools when
 * business_configs.record_appointment_enabled = TRUE. Default FALSE
 * gates rollout per-tenant.
 *
 * Description-heavy on the "confirm date/time/reason out loud BEFORE
 * firing the tool" instruction because the cost of an incorrect
 * appointment row (missed booking, customer trust breach) is high. The
 * LLM over-confirms by design.
 *
 * Required params: business_id (constant), conversation_id (the
 * ElevenLabs session ID for lead lookup), appointment_datetime (ISO
 * 8601 with timezone), reason.
 * Optional params: duration_minutes, notes, contact_phone (used to
 * resolve the lead if the conversation_id → calls.call_sid lookup
 * hasn't sync'd yet).
 */
export function buildRecordAppointmentTool(opts: {
  businessId: string;
  recordAppointmentUrl: string;
  toolSecret: string;
}): unknown {
  return {
    type: 'webhook',
    name: RECORD_APPOINTMENT_TOOL_NAME,
    description: RECORD_APPOINTMENT_DESCRIPTION,
    response_timeout_secs: 30,
    disable_interruptions: false,
    pre_tool_speech: 'force',
    tool_error_handling_mode: 'summarized',
    execution_mode: 'immediate',
    api_schema: {
      url: opts.recordAppointmentUrl,
      method: 'POST',
      content_type: 'application/json',
      request_headers: {
        Authorization: `Bearer ${opts.toolSecret}`,
        'Content-Type': 'application/json',
      },
      request_body_schema: {
        type: 'object',
        required: [
          'business_id',
          'conversation_id',
          'appointment_datetime',
          'reason',
        ],
        properties: {
          business_id: {
            type: 'string',
            constant_value: opts.businessId,
          },
          conversation_id: {
            type: 'string',
            description: 'The current ElevenLabs conversation ID. Use the value provided to you in this conversation; do not invent one.',
          },
          appointment_datetime: {
            type: 'string',
            description: "The appointment date AND time in ISO 8601 format with timezone offset (e.g. 2026-06-20T14:30:00-04:00 for 2:30pm Eastern). Confirm the date and time back to the caller out loud before submitting. Must be in the future.",
          },
          duration_minutes: {
            type: 'number',
            description: 'Optional. Appointment duration in minutes. Default is 30 if you omit. Ask the caller if you don\'t know and the appointment type clearly needs a specific duration.',
          },
          reason: {
            type: 'string',
            description: 'A 1-2 sentence summary of what the appointment is for, in plain English (e.g. "Haircut and beard trim", "Annual physical exam", "Follow-up consultation"). Capture only what the caller said they wanted.',
          },
          notes: {
            type: 'string',
            description: 'Optional. Any context the staff or AI should know going in (e.g. "Customer prefers afternoon slots", "Allergic to fragrance", "First-time visitor"). Leave blank if not provided.',
          },
          contact_phone: {
            type: 'string',
            description: "Optional. The caller's phone in E.164 format (e.g. +14105551234). Provide if this is the caller's first interaction with the AI in this session AND they have not previously asked for a callback. If they previously asked for a callback in this conversation, you may omit and the system will use the captured phone.",
          },
        },
      },
    },
  };
}

/**
 * Phase 3.2b — build the tools-array entry for the route_to_topic
 * webhook tool.
 *
 * Two load-bearing decisions in this shape:
 *
 *   1. `topic_slug` is an ENUM built from the business's configured
 *      departments at PATCH time (NOT free-form). LLM adherence to a
 *      free-form string was flagged as unreliable in Phase A. If
 *      departments is empty the caller MUST skip registration entirely
 *      — this builder trusts that guard and does not defensively
 *      accept an empty topics list.
 *
 *   2. `call_sid` uses `dynamic_variable: 'system__call_sid'` so
 *      ElevenLabs auto-injects the Twilio CallSid from SIP metadata.
 *      The LLM never sees this field. The routing handler needs the
 *      CallSid to redirect the live call via Twilio REST.
 *
 * `business_id` is `constant_value` (baked per-agent), matching the
 * pattern from buildRequestCallbackTool + buildRecordAppointmentTool.
 *
 * `response_timeout_secs: 45` — deliberately generous to accommodate
 * the DB reads (business_configs + staff_topics + user_businesses +
 * business_hours) that fire before the response returns.
 */
export function buildRouteToTopicTool(opts: {
  businessId: string;
  routeToTopicUrl: string;
  toolSecret: string;
  topics: Array<{ slug: string; name: string; description?: string | null }>;
}): unknown {
  if (opts.topics.length === 0) {
    // Defensive — callers MUST guard on this, but throwing here catches
    // any future accidental empty-topics registration before we ship a
    // broken enum to ElevenLabs.
    throw new Error('buildRouteToTopicTool: topics must not be empty; guard in updateAgentTools instead');
  }
  const slugs = opts.topics.map((t) => t.slug);
  return {
    type: 'webhook',
    name: ROUTE_TO_TOPIC_TOOL_NAME,
    description: ROUTE_TO_TOPIC_DESCRIPTION,
    response_timeout_secs: 45,
    disable_interruptions: false,
    // Force speech BEFORE the tool fires so the caller hears "let me
    // connect you…" during the HTTP round-trip. Critical for perceived
    // latency — the actual Twilio REST redirect happens 2.5s AFTER the
    // response returns, so the caller must hear the acknowledgement to
    // avoid dead air.
    pre_tool_speech: 'force',
    tool_error_handling_mode: 'summarized',
    execution_mode: 'immediate',
    api_schema: {
      url: opts.routeToTopicUrl,
      method: 'POST',
      content_type: 'application/json',
      request_headers: {
        Authorization: `Bearer ${opts.toolSecret}`,
        'Content-Type': 'application/json',
      },
      request_body_schema: {
        type: 'object',
        required: ['business_id', 'conversation_id', 'topic_slug', 'reason', 'call_sid'],
        properties: {
          business_id: {
            type: 'string',
            constant_value: opts.businessId,
          },
          conversation_id: {
            type: 'string',
            // Auto-injected by ElevenLabs from the system dynamic
            // variable. LLM never touches this.
            dynamic_variable: 'system__conversation_id',
          },
          call_sid: {
            type: 'string',
            // Auto-injected by ElevenLabs. This is the Twilio CallSid
            // (NOT the ElevenLabs conversation_id) — populated from
            // SIP call metadata on inbound Twilio→ElevenLabs bridge.
            dynamic_variable: 'system__call_sid',
          },
          topic_slug: {
            type: 'string',
            enum: slugs,
            description: `Which department best handles this caller's request. Must be one of the values in the enum. Pick the closest match; if nothing matches perfectly, still pick the closest — the routing engine will handle fallbacks.`,
          },
          reason: {
            type: 'string',
            description: 'A short (1 sentence) natural-language reason for the handoff — what the caller needs and why a human should take it. Used for reporting and for the handoff whisper to the answering staff member.',
          },
        },
      },
    },
  };
}

/**
 * Phase 5.1 — record_opt_out tool.
 *
 * ALWAYS registered on every agent (no per-tenant toggle). TCPA
 * §64.1200(d) requires that a company maintain a do-not-call list
 * and honor requests to be added to it. Not honoring is the fastest
 * path to a class-action suit; the tool exists to make honoring
 * mechanical in the moment.
 *
 * Similar plumbing to route_to_topic:
 *   - Bearer auth via ELEVENLABS_TOOL_SECRET (single shared secret).
 *   - `phone` uses `system__caller_id` dynamic variable so the LLM
 *     never has to remember or repeat the phone (avoids "which
 *     number should I opt out?" branch).
 *   - `conversation_id` dynamic variable ties the opt-out row to
 *     the specific call — the endpoint resolves it via calls.call_sid
 *     for the evidence_call_id column.
 *   - `pre_tool_speech: 'force'` so Alex acknowledges BEFORE the
 *     round-trip. Prevents dead air; caller hears "of course, I'll
 *     take you off the list right away" while the write happens.
 *   - `tool_error_handling_mode: 'summarized'` so if the endpoint
 *     500s (shouldn't — we do 200-always) Alex says "I've recorded
 *     that but there may be a delay" rather than repeating the tool.
 *   - `execution_mode: 'immediate'` so the tool fires as soon as Alex
 *     recognizes the intent, without waiting for the caller to finish
 *     unrelated speech.
 *
 * NO business-id enum, NO topic_slug — this is a universal action.
 * business_id is baked as constant_value per-agent.
 */
export function buildRecordOptOutTool(opts: {
  businessId: string;
  recordOptOutUrl: string;
  toolSecret: string;
}): unknown {
  return {
    type: 'webhook',
    name: RECORD_OPT_OUT_TOOL_NAME,
    description: RECORD_OPT_OUT_DESCRIPTION,
    response_timeout_secs: 10,
    disable_interruptions: false,
    pre_tool_speech: 'force',
    tool_error_handling_mode: 'summarized',
    execution_mode: 'immediate',
    api_schema: {
      url: opts.recordOptOutUrl,
      method: 'POST',
      content_type: 'application/json',
      request_headers: {
        Authorization: `Bearer ${opts.toolSecret}`,
        'Content-Type': 'application/json',
      },
      request_body_schema: {
        type: 'object',
        required: ['business_id', 'phone', 'conversation_id'],
        properties: {
          business_id: {
            type: 'string',
            constant_value: opts.businessId,
          },
          phone: {
            type: 'string',
            // Auto-injected from SIP caller-ID. LLM never touches this.
            dynamic_variable: 'system__caller_id',
          },
          conversation_id: {
            type: 'string',
            dynamic_variable: 'system__conversation_id',
          },
          reason_verbatim: {
            type: 'string',
            description:
              "The caller's exact words asking to opt out, in one short quote. Used as evidence for the compliance record. Do NOT paraphrase; use the caller's words. If the caller didn't give words (rare), use \"caller requested removal\".",
          },
        },
      },
    },
  };
}

export async function createAgentForBusiness(opts: {
  businessId: string;
  businessName: string;
  systemPrompt: string;
  firstMessage?: string;
  language?: string;            // Phase 3l: ISO 639-1 code (en, es, fr, pt, zh, ar, …)
  languageDetection?: boolean;  // Phase 3l: enable for non-English so caller code-switching works
  transferConfig?: TransferConfig; // operator-transfer system tool
}): Promise<{ success: boolean; agentId?: string; error?: string }> {
  try {
    console.log('[Agents] Creating agent for:', opts.businessName, 'language:', opts.language || 'en');

    const agentConfig: any = {
      prompt: {
        prompt: opts.systemPrompt
      },
      // Defensive fallback: every production caller now passes a
      // disclosure-compliant firstMessage built via renderFirstMessage.
      // If a future caller forgets, we still emit a compliant greeting
      // instead of the legacy "Hello, thank you for calling…" template
      // that lacked the recording disclosure.
      first_message: opts.firstMessage || renderFirstMessage({ business_name: opts.businessName }),
      language: opts.language || 'en',
    };
    if (opts.languageDetection) {
      agentConfig.language_detection = true;
    }
    if (opts.transferConfig) {
      // Tools live under prompt.tools per the OpenAPI shape (the schema's
      // PromptAgentInputToolsItem_System variant). Stays alongside `prompt`
      // and `language_detection` on the agent.prompt object.
      agentConfig.prompt.tools = [buildTransferTool(opts.transferConfig)];
    }

    const response = await fetch('https://api.elevenlabs.io/v1/convai/agents/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': getApiKey()
      },
      body: JSON.stringify({
        name: `Neverr - ${opts.businessName}`,
        conversation_config: {
          agent: agentConfig,
          tts: {
            voice_id: 'EXAVITQu4vr4xnSDxMaL'
          }
        }
      })
    });

    const data: any = await response.json();
    console.log('[Agents] ElevenLabs response:', JSON.stringify(data).substring(0, 200));

    if (data.agent_id) {
      console.log('[Agents] Agent created:', data.agent_id, 'for', opts.businessName);
      return { success: true, agentId: data.agent_id };
    }

    return { success: false, error: JSON.stringify(data) };
  } catch (err: any) {
    console.error('[Agents] Error creating agent:', err.message);
    return { success: false, error: err.message };
  }
}

export async function updateAgentPrompt(opts: {
  agentId: string;
  systemPrompt: string;
  firstMessage?: string;
  businessName?: string;
  languageDetection?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const agentConfig: any = {
      prompt: {
        prompt: opts.systemPrompt
      },
      first_message: opts.firstMessage
    };
    if (opts.languageDetection) {
      agentConfig.language_detection = true;
    }
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${opts.agentId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': getApiKey()
      },
      body: JSON.stringify({
        name: opts.businessName ? `Neverr - ${opts.businessName}` : undefined,
        conversation_config: {
          agent: agentConfig
        }
      })
    });

    const data = await response.json();
    if (response.ok) {
      console.log('[Agents] Agent updated:', opts.agentId);
      return { success: true };
    }
    return { success: false, error: JSON.stringify(data) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getAgent(agentId: string) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    headers: { 'xi-api-key': getApiKey() }
  });
  return response.json();
}

export async function deleteAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      method: 'DELETE',
      headers: {
        'xi-api-key': getApiKey()
      }
    });

    if (response.ok || response.status === 404) {
      console.log('[Agents] Deleted agent:', agentId);
      return { success: true };
    }

    const errText = await response.text().catch(() => '');
    console.warn('[Agents] Delete failed:', response.status, errText.substring(0, 200));
    return { success: false, error: `HTTP ${response.status}` };
  } catch (err: any) {
    console.error('[Agents] Delete error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Idempotent sync of a business's full tools array to its ElevenLabs
 * agent. Replaces the older updateAgentTransferConfig — same shape, same
 * try/catch + Sentry posture, but now manages multiple tools end-to-end:
 *
 *   transfer_to_number  → included when transfer_enabled is true AND
 *                         transfer_to_phone + transfer_conditions are set.
 *                         Stripped otherwise.
 *   request_callback    → ALWAYS included. There's no per-business toggle
 *                         in Slice 1; we'll add a callback_enabled column
 *                         in a later slice if customers want to opt out.
 *                         If ELEVENLABS_TOOL_SECRET is not set in the
 *                         environment, the callback tool is SKIPPED with
 *                         a Sentry breadcrumb — transfer still works,
 *                         callback simply isn't registered for that
 *                         deploy. Avoids hardcoding a fallback secret.
 *
 * Tools we don't recognize (by name) are preserved across the PATCH —
 * defensive against future tools we might register out-of-band, or other
 * code paths sharing the same agent.
 *
 * The PATCH body echoes prompt.prompt back alongside prompt.tools
 * (belt-and-suspenders against a non-merging PATCH semantic wiping the
 * system prompt). See agents.ts:buildTransferTool comments.
 *
 * Safe to call repeatedly. Failures are captured to Sentry and logged
 * but do NOT throw — the route handler that triggered this can still
 * respond 200 on its own DB write.
 */
export async function updateAgentTools(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: biz, error: readErr } = await supabase
      .from('business_configs')
      .select('agent_id, business_name, transfer_enabled, transfer_to_phone, transfer_conditions, transfer_wait_message, transfer_warm_message, record_appointment_enabled, departments')
      .eq('business_id', businessId)
      .maybeSingle();
    if (readErr) {
      Sentry.captureMessage('update_agent_tools_read_failed', {
        level: 'error',
        extra: { businessId, error: readErr.message },
      });
      return { success: false, error: readErr.message };
    }
    if (!biz) {
      return { success: false, error: 'business_not_found' };
    }
    const row = biz as {
      agent_id: string | null;
      business_name: string | null;
      transfer_enabled: boolean | null;
      transfer_to_phone: string | null;
      transfer_conditions: string | null;
      transfer_wait_message: string | null;
      transfer_warm_message: string | null;
      record_appointment_enabled: boolean | null;
      departments: unknown;
    };
    if (!row.agent_id) {
      // No ElevenLabs agent yet (business hasn't completed onboarding).
      // Nothing to sync — settings are persisted in business_configs and
      // will be picked up when the agent is created.
      return { success: true };
    }

    // GET the agent so we can preserve any tools we don't manage
    // (defensive against out-of-band registrations). The ElevenLabs
    // PATCH semantic on prompt.tools replaces the array wholesale.
    const getRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${row.agent_id}`, {
      headers: { 'xi-api-key': getApiKey() },
    });
    if (!getRes.ok) {
      const errText = await getRes.text().catch(() => '');
      Sentry.captureMessage('update_agent_tools_get_failed', {
        level: 'error',
        extra: { businessId, agentId: row.agent_id, status: getRes.status, body: errText.slice(0, 500) },
      });
      return { success: false, error: `agent_get_http_${getRes.status}` };
    }
    const agent: any = await getRes.json();
    const existingTools: any[] = Array.isArray(agent?.conversation_config?.agent?.prompt?.tools)
      ? agent.conversation_config.agent.prompt.tools
      : [];
    // Belt-and-suspenders against a non-merging PATCH semantic wiping
    // the system prompt — see agents.ts:buildTransferTool comments and
    // commit ecaa687's review notes.
    const currentPromptText: string | undefined =
      typeof agent?.conversation_config?.agent?.prompt?.prompt === 'string'
        ? agent.conversation_config.agent.prompt.prompt
        : undefined;

    // Strip the tools we manage (by name OR system_tool_type). Anything
    // else we preserve.
    const remainingTools = existingTools.filter((t: any) => {
      if (t?.name === TRANSFER_TOOL_NAME || t?.params?.system_tool_type === 'transfer_to_number') return false;
      if (t?.name === REQUEST_CALLBACK_TOOL_NAME) return false;
      if (t?.name === RECORD_APPOINTMENT_TOOL_NAME) return false;
      if (t?.name === ROUTE_TO_TOPIC_TOOL_NAME) return false;
      return true;
    });

    const nextTools: any[] = [...remainingTools];

    // Conditionally append transfer_to_number.
    if (row.transfer_enabled && row.transfer_to_phone && row.transfer_conditions) {
      const businessName = row.business_name || 'our team';
      const interpolate = (tpl: string | null) =>
        (tpl || '').replace(/\{business_name\}/g, businessName);
      nextTools.push(
        buildTransferTool({
          phoneNumber: row.transfer_to_phone,
          condition: row.transfer_conditions,
          waitMessageTemplate: interpolate(row.transfer_wait_message),
          warmMessageTemplate: interpolate(row.transfer_warm_message),
        }),
      );
    }

    // Always append request_callback. As of the Slice 1 leads-capture
    // repair, missing ELEVENLABS_TOOL_SECRET is a HARD ERROR — silent
    // skip was the original Slice 1 bug (agents shipped without the
    // capture tool and ops had no signal). Production deploys must
    // have the secret set or onboarding fails loudly.
    const toolSecret = process.env.ELEVENLABS_TOOL_SECRET;
    const captureUrl = process.env.LEADS_CAPTURE_URL || DEFAULT_LEADS_CAPTURE_URL;
    if (!toolSecret) {
      const msg = 'ELEVENLABS_TOOL_SECRET not set — request_callback cannot be registered. Refusing to PATCH a partial tool set that would silently drop callback capture.';
      Sentry.captureException(new Error(msg), {
        level: 'error',
        extra: { businessId, agentId: row.agent_id, route: 'updateAgentTools' },
      });
      console.error('[Agents]', msg, businessId);
      return { success: false, error: 'tool_secret_missing' };
    }
    nextTools.push(
      buildRequestCallbackTool({
        businessId,
        captureUrl,
        toolSecret,
      }),
    );

    // Phase 2.2.5 — record_appointment tool. Conditionally registered
    // when business_configs.record_appointment_enabled = TRUE. Default
    // FALSE gates rollout per-tenant. Reuses ELEVENLABS_TOOL_SECRET
    // (single shared secret for all webhook tools — one rotation path).
    if (row.record_appointment_enabled) {
      const recordAppointmentUrl =
        process.env.RECORD_APPOINTMENT_URL || DEFAULT_RECORD_APPOINTMENT_URL;
      nextTools.push(
        buildRecordAppointmentTool({
          businessId,
          recordAppointmentUrl,
          toolSecret,
        }),
      );
    }

    // Phase 3.2b — route_to_topic tool. Conditionally registered when
    // business_configs.departments is a non-empty array. Empty departments
    // → SKIP entirely (no empty enum sent to ElevenLabs; the tool would
    // fail validation on their side). Log the skip so ops can see when a
    // business is missing topic config.
    const topics = Array.isArray(row.departments)
      ? (row.departments as any[]).filter(
          (t) => t && typeof t === 'object' && typeof t.slug === 'string' && typeof t.name === 'string',
        ).map((t) => ({
          slug: t.slug as string,
          name: t.name as string,
          description: typeof t.description === 'string' ? t.description : null,
        }))
      : [];
    if (topics.length > 0) {
      const routeToTopicUrl = process.env.ROUTE_TO_TOPIC_URL || DEFAULT_ROUTE_TO_TOPIC_URL;
      nextTools.push(
        buildRouteToTopicTool({
          businessId,
          routeToTopicUrl,
          toolSecret,
          topics,
        }),
      );
    } else {
      console.warn(
        '[Agents] route_to_topic tool NOT registered for',
        businessId,
        '— business_configs.departments is empty. Set topics via Settings → Topics to enable smart routing.',
      );
    }

    // Phase 5.1 — record_opt_out tool. UNCONDITIONALLY registered on
    // every agent. NOT per-tenant configurable. TCPA §64.1200(d)
    // requires honoring opt-outs; making this a config option would
    // mean an ops mistake becomes a class-action suit. If a tenant
    // needs to disable it, they need to file a support ticket and
    // we edit their agent by hand — but we don't want the UI making
    // that trivial.
    const recordOptOutUrl = process.env.RECORD_OPT_OUT_URL || DEFAULT_RECORD_OPT_OUT_URL;
    nextTools.push(
      buildRecordOptOutTool({
        businessId,
        recordOptOutUrl,
        toolSecret,
      }),
    );

    const promptBody: any = { tools: nextTools };
    if (typeof currentPromptText === 'string') {
      promptBody.prompt = currentPromptText;
    }
    const patchRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${row.agent_id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': getApiKey(),
      },
      body: JSON.stringify({
        conversation_config: {
          agent: {
            prompt: promptBody,
          },
        },
      }),
    });
    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => '');
      Sentry.captureMessage('update_agent_tools_patch_failed', {
        level: 'error',
        extra: {
          businessId,
          agentId: row.agent_id,
          status: patchRes.status,
          body: errText.slice(0, 500),
          transfer_enabled: row.transfer_enabled,
          callback_registered: !!toolSecret,
          tool_count: nextTools.length,
        },
      });
      return { success: false, error: `agent_patch_http_${patchRes.status}` };
    }
    console.log(
      '[Agents] Tools synced:',
      businessId,
      'transfer_enabled=', row.transfer_enabled,
      'callback_registered=', !!toolSecret,
      'agent=', row.agent_id,
    );
    return { success: true };
  } catch (err: any) {
    Sentry.captureException(err, { extra: { route: 'updateAgentTools', businessId } });
    return { success: false, error: err?.message || String(err) };
  }
}

export default {
  createAgentForBusiness,
  updateAgentPrompt,
  getAgent,
  deleteAgent,
  updateAgentTools,
  buildTransferTool,
  buildRequestCallbackTool,
  buildRouteToTopicTool,
  buildRecordOptOutTool,
};
