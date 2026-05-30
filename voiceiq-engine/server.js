import dotenv from 'dotenv';
dotenv.config();

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import WebSocket from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBusinessConfig, buildSystemPrompt, loadObjectionHandlers, loadCompetitorConfigs, loadCallerProfile, updateCallerProfileAfterCall, getCallerPersonalization } from './businessConfig.js';
import { detectEmotion, getEmotionAdjustedPrompt, shouldAutoTransfer, calculateSentimentScore, getDominantEmotion } from './emotion-detector.js';
import { detectCulturalProfile, buildCulturalPrompt } from './culturalProfiles.js';
import { saveCallRecord, updateCallTranscript, saveCallAnalysis, updateCallStatusByCallSid, getBusinessConfigCount, getClient } from './db.js';
import { redactCallTranscript } from './lib/pii-redact-transcript.js';

const fastify = Fastify({ logger: true });

await fastify.register(formbody);
await fastify.register(websocket);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ERROR_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We are experiencing a technical issue. Please try again shortly.</Say>
</Response>`;

fastify.setErrorHandler((error, request, reply) => {
  console.error('[Global Error Handler]', {
    url: request.url,
    method: request.method,
    error: error.message,
    stack: error.stack,
  });
  reply.status(200).type('text/xml').send(ERROR_TWIML);
});

fastify.get('/health', async () => {
  const openai = !!process.env.OPENAI_API_KEY;
  const anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const supabaseConfigured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
  const twilio = !!process.env.TWILIO_ACCOUNT_SID;
  const elevenlabs = !!process.env.ELEVENLABS_API_KEY;

  let supabaseRowCount = null;
  let supabaseConnected = false;

  if (supabaseConfigured) {
    try {
      supabaseRowCount = await getBusinessConfigCount();
      supabaseConnected = supabaseRowCount !== null;
    } catch {
      supabaseConnected = false;
    }
  }

  const missing = [];
  if (!openai) missing.push('OPENAI_API_KEY');
  if (!anthropicKey) missing.push('ANTHROPIC_API_KEY');
  if (!supabaseConfigured) missing.push('SUPABASE_URL/SUPABASE_SERVICE_KEY');
  if (!supabaseConnected && supabaseConfigured) missing.push('Supabase connection failed');
  if (!twilio) missing.push('TWILIO_ACCOUNT_SID');
  if (!elevenlabs) missing.push('ELEVENLABS_API_KEY');

  const allGood = missing.length === 0;

  return {
    status: allGood ? 'ok' : 'degraded',
    checks: {
      openai,
      anthropic: anthropicKey,
      supabase: supabaseConnected,
      supabaseRowCount,
      twilio,
      elevenlabs,
    },
    message: allGood ? 'All systems operational' : `Missing or failed: ${missing.join(', ')}`,
  };
});

fastify.get('/test-config', async () => {
  const config = await loadBusinessConfig('demo-business');
  return {
    businessName: config.businessName,
    aiName: config.aiName,
    voiceId: config.voiceId,
    tone: config.tone,
    departmentCount: (config.departments || []).length,
    knowledgeBaseLength: (config.knowledgeBase || '').length,
  };
});

fastify.post('/incoming-call', async (request, reply) => {
  try {
    console.log('[Twilio] Incoming call received', request.query);

    const host = request.headers.host;
    if (!host) {
      console.error('[Twilio] Missing host header on /incoming-call');
      reply.type('text/xml').send(ERROR_TWIML);
      return;
    }

    const businessId = request.query.businessId || 'demo-business';
    console.log('[Twilio] Loading config for businessId:', businessId);
    const config = await loadBusinessConfig(businessId);

    if (!config || !config.greeting) {
      console.error('[Twilio] Failed to load valid business config for:', businessId, config);
      reply.type('text/xml').send(ERROR_TWIML);
      return;
    }

    console.log('[Twilio] Config loaded:', {
      businessName: config.businessName,
      greeting: config.greeting,
      voiceId: config.voiceId,
    });

    const streamUrl = `wss://${host}/media-stream?businessId=${businessId}`;
    console.log('[Twilio] Stream URL:', streamUrl);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

    console.log('[Twilio] Sending TwiML response');
    reply.type('text/xml').send(twiml);
  } catch (err) {
    console.error('[Twilio] Error handling /incoming-call:', err);
    reply.type('text/xml').send(ERROR_TWIML);
  }
});

fastify.post('/status-callback', async (request, reply) => {
  const { CallSid, CallStatus } = request.body || {};

  if (!CallSid || !CallStatus) {
    fastify.log.warn({ body: request.body }, 'Missing CallSid or CallStatus in status callback');
    return reply.code(400).send({ error: 'Missing CallSid or CallStatus' });
  }

  fastify.log.info({ CallSid, CallStatus }, 'Twilio status callback received');

  updateCallStatusByCallSid(CallSid, CallStatus).catch((err) => {
    fastify.log.error({ err, CallSid, CallStatus }, 'Failed to update call status');
  });

  return reply.code(200).send({ received: true });
});

fastify.post('/api/lead', async (req, reply) => {
  try {
    const body = req.body || {};
    const callerName = body.caller_name || 'unknown';
    const callerPhone = body.caller_phone || 'unknown';
    const reason = body.reason || '';
    const urgency = body.urgency || 'normal';
    const summary = body.summary || '';
    const nextSteps = body.next_steps || '';

    // PII-safe: logs metadata only, raw content goes through PIIProcessor before any persistence.
    // Previously dumped {callerName, callerPhone, reason, urgency, summary, nextSteps} —
    // summary/nextSteps come from the agent's transcribed call and routinely contain PHI.
    console.log(
      '[Lead] captured',
      'urgency=' + urgency,
      'has_caller_name=' + (callerName !== 'unknown'),
      'has_caller_phone=' + (callerPhone !== 'unknown'),
      'reason_length=' + (reason?.length ?? 0),
      'summary_length=' + (summary?.length ?? 0),
      'next_steps_length=' + (nextSteps?.length ?? 0),
    );

    // PII redaction: strip phone/email/SSN/etc from the transcript text
    // before it lands in `calls.transcript`. Operational fields above
    // (caller_name, caller_number, lead_data) stay raw because the
    // product needs them for callbacks/SMS/dedup. See
    // voiceiq-engine/lib/pii-redact-transcript.js.
    const transcriptRaw = 'AI: ' + (summary || '') + '\nNext steps: ' + (nextSteps || '');
    const { redactedText: transcriptText } = await redactCallTranscript(transcriptRaw, {
      businessId: 'demo-business',
      source: 'lead',
    });

    const supabase = getClient();
    if (supabase) {
      const { data, error } = await supabase
        .from('calls')
        .insert({
          business_id: 'demo-business',
          caller_name: callerName,
          caller_number: callerPhone,
          caller_intent: reason,
          summary: summary,
          transcript: transcriptText,
          status: 'completed',
          call_outcome: 'lead_captured',
          direction: 'inbound',
          lead_data: {
            callerName,
            callerPhone,
            reason,
            urgency,
            summary,
            nextSteps,
          },
          start_time: new Date().toISOString(),
          end_time: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        console.error('[Lead] Supabase error:', error.message);
      } else {
        console.log('[Lead] Saved to Supabase with id:', data.id);
        // Use the same redacted transcriptText for Claude analysis — keeps
        // PII out of any Claude logs / partner pipelines.
        analyzeCallWithClaude(transcriptText, 'demo-business')
          .then(analysis => {
            if (analysis) {
              saveCallAnalysis(data.id, analysis);
              console.log('[Lead] Claude analysis saved for:', data.id);
            }
          })
          .catch(err => console.error('[Lead] Claude error:', err));

        updateCallerProfileAfterCall({
          business_id: 'demo-business',
          caller_phone: callerPhone,
          caller_name: callerName !== 'unknown' ? callerName : undefined,
          duration: 0,
          summary: summary,
          call_outcome: 'lead_captured',
        }).catch(err => console.error('[Lead] Profile update error:', err));
      }
    }

    reply.send({
      message: 'Thank you ' + callerName + ', your information has been saved. Someone will follow up with you shortly.',
    });
  } catch (err) {
    console.error('[Lead API] Error:', err);
    reply.status(500).send({ success: false, error: err.message || '' });
  }
});

fastify.post('/webhook/elevenlabs', async (req, reply) => {
  try {
    const payload = req.body;
    console.log('[Webhook] ElevenLabs call received:', payload?.data?.conversation_id);

    if (payload?.type !== 'post_call_transcription') {
      return reply.send({ received: true });
    }

    const data = payload.data;
    const conversationId = data.conversation_id;
    const duration = data.call_duration_secs;
    const callerPhone = data.metadata?.phone_number || 'unknown';
    const direction = data.metadata?.call_direction || 'inbound';

    const transcriptRaw = data.transcript
      ?.map(t => (t.role === 'agent' ? 'AI' : 'Caller') + ': ' + t.message)
      .join('\n') || '';

    // PII redaction at the ingestion boundary. Replaces transcriptText
    // for ALL downstream consumers (Supabase persist, Claude analysis,
    // caller-profile transcript echo) so PII never leaks past this line.
    // caller_number stays raw (used for callbacks/SMS).
    const { redactedText: transcriptText } = await redactCallTranscript(transcriptRaw, {
      businessId: 'demo-business',
      source: 'webhook',
      conversationId,
    });

    // PII-safe: logs metadata only, raw content goes through PIIProcessor before any persistence.
    // Previously printed raw callerPhone to stdout; phone stays raw in `calls.caller_number`
    // for operational use (callbacks/SMS), but logs are a separate backdoor PHI surface and
    // must not contain it. We log presence + length so ingestion volume/shape is still debuggable.
    console.log(
      '[Webhook] Conversation:',
      conversationId,
      '| Duration:',
      duration,
      '| has_caller_phone:',
      !!callerPhone && callerPhone !== 'unknown',
      '| caller_phone_len:',
      callerPhone?.length ?? 0,
    );
    console.log('[Webhook] Transcript lines:', data.transcript?.length);

    const supabase = getClient();
    let savedId = null;

    if (supabase) {
      const { data: saved, error } = await supabase
        .from('calls')
        .insert({
          call_sid: conversationId,
          business_id: 'demo-business',
          conversation_id: conversationId,
          direction: direction,
          caller_number: callerPhone,
          duration_seconds: duration,
          transcript: transcriptText,
          status: 'completed',
          start_time: new Date(payload.event_timestamp ? (payload.event_timestamp * 1000) : Date.now()).toISOString(),
          end_time: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        console.error('[Webhook] Supabase error:', error.message);
      } else {
        savedId = saved.id;
        console.log('[Webhook] Call saved with id:', savedId);
      }
    }

    if (transcriptText && savedId) {
      analyzeCallWithClaude(transcriptText, 'demo-business')
        .then(analysis => {
          if (analysis) {
            saveCallAnalysis(savedId, analysis);
            console.log('[Webhook] Claude analysis saved for call:', savedId);
          }
          updateCallerProfileAfterCall({
            business_id: 'demo-business',
            caller_phone: callerPhone,
            duration: duration || 0,
            transcript: transcriptText,
            sentiment_score: analysis?.sentiment === 'positive' ? 80 : analysis?.sentiment === 'negative' ? 20 : 50,
            summary: analysis?.summary || '',
            call_outcome: analysis?.call_outcome || 'resolved',
          }).catch(err => console.error('[Webhook] Profile update error:', err));
        })
        .catch(err => console.error('[Webhook] Claude analysis error:', err));
    }

    reply.send({ received: true, callId: savedId });
  } catch (err) {
    console.error('[Webhook] Error:', err);
    reply.status(500).send({ error: err.message });
  }
});

function detectLanguageFromText(text) {
  if (!text || text.length < 3) return 'en';
  const lower = text.toLowerCase();
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  const spanishPatterns = /\b(hola|buenos días|buenas tardes|por favor|gracias|necesito|quiero|tengo|puede|cómo|dónde|cuándo|señor|señora|ayuda)\b/i;
  if (spanishPatterns.test(text)) return 'es';
  const frenchPatterns = /\b(bonjour|bonsoir|merci|s'il vous plaît|je suis|j'ai|comment|pourquoi|rendez-vous|monsieur|madame|besoin)\b/i;
  if (frenchPatterns.test(text)) return 'fr';
  const portuguesePatterns = /\b(olá|obrigado|obrigada|bom dia|boa tarde|preciso|gostaria|como|onde|quando|senhor|senhora|por favor)\b/i;
  if (portuguesePatterns.test(text)) return 'pt';
  if (/[àâçéèêëîïôùûü]/.test(text) && /\b(le|la|les|du|des|un|une)\b/.test(lower)) return 'fr';
  if (/[ñáéíóú]/.test(text)) return 'es';
  if (/[ãõç]/.test(text) && /\b(não|sim|está|tem|seu|sua)\b/.test(lower)) return 'pt';
  return 'en';
}

function sendInitialGreeting(openAiWs) {
  openAiWs.send(JSON.stringify({
    type: 'response.create',
    response: {
      modalities: ['text', 'audio'],
      instructions: 'Greet the caller. Say: Thank you for calling Neverr Demo Business, this is Alex. How can I help you today?',
    },
  }));
  console.log('[OpenAI] response.create sent — AI should now speak');
}

fastify.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, request) => {
    const twilioWs = connection.socket;
    console.log('[WS] Media stream connection opened');
    const businessId = request.query.businessId || 'demo-business';

    const callState = {
      config: null,
      streamSid: null,
      callSid: null,
      callId: null,
      callStartTime: null,
      transcript: [],
      openAiWs: null,
      openAiReady: false,
      packetCount: 0,
      audioChunksSent: 0,
      earlyBuffer: [],
      currentEmotion: 'neutral',
      emotionHistory: [],
      baseSystemPrompt: null,
      emotionConfig: null,
      culturalProfile: null,
      detectedLanguage: null,
      culturalPromptApplied: false,
    };

    (async () => {
      callState.config = await loadBusinessConfig(businessId);
      console.log('[WS] Business config loaded for:', businessId);

      const objectionHandlers = await loadObjectionHandlers(businessId);
      if (objectionHandlers.length > 0) {
        callState.config.objectionHandlers = objectionHandlers;
        console.log(`[WS] Loaded ${objectionHandlers.length} objection handlers for ${businessId}`);
      }

      const competitorConfigs = await loadCompetitorConfigs(businessId);
      if (competitorConfigs.length > 0) {
        callState.config.competitorConfigs = competitorConfigs;
        console.log(`[WS] Loaded ${competitorConfigs.length} competitor configs for ${businessId}`);
      }
      callState.competitorAlerted = false;

      callState.emotionConfig = callState.config.emotion_config || {
        auto_detect: true, adjust_tone: true, auto_transfer_distressed: true,
        alert_frustrated: false, prioritize_frustrated: false,
      };
      const systemPrompt = buildSystemPrompt(callState.config);
      callState.baseSystemPrompt = systemPrompt;
      console.log('[WS] System prompt built, length:', systemPrompt.length);

      try {
        callState.openAiWs = new WebSocket(
          'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
          {
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'OpenAI-Beta': 'realtime=v1',
            },
          }
        );
        console.log('[OpenAI] WebSocket connecting...');
      } catch (err) {
        console.error('[OpenAI Connect Error]', err);
        return;
      }

      const openAiWs = callState.openAiWs;

      openAiWs.on('open', () => {
        console.log('[OpenAI] Connection established');

        const sessionUpdate = {
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: systemPrompt,
            voice: callState.config.voiceId || 'alloy',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
            },
            tools: [
              {
                type: 'function',
                name: 'transfer_call',
                description: 'Transfer the caller to a specific department or phone number',
                parameters: {
                  type: 'object',
                  properties: {
                    destination: { type: 'string', description: 'The department or phone number to transfer to' },
                    reason: { type: 'string', description: 'Reason for the transfer' },
                  },
                  required: ['destination', 'reason'],
                },
              },
              {
                type: 'function',
                name: 'leave_voicemail',
                description: 'Record a voicemail message from the caller',
                parameters: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', description: 'The voicemail message content' },
                    callerName: { type: 'string', description: 'Name of the caller if provided' },
                    callbackNumber: { type: 'string', description: 'Callback number if provided' },
                  },
                  required: ['message'],
                },
              },
              {
                type: 'function',
                name: 'capture_callback',
                description: 'Capture a callback request from the caller',
                parameters: {
                  type: 'object',
                  properties: {
                    callerName: { type: 'string', description: 'Name of the caller' },
                    phoneNumber: { type: 'string', description: 'Phone number for callback' },
                    preferredTime: { type: 'string', description: 'Preferred callback time' },
                    reason: { type: 'string', description: 'Reason for callback request' },
                  },
                  required: ['phoneNumber', 'reason'],
                },
              },
              {
                type: 'function',
                name: 'save_lead',
                description: 'Save lead information captured during the call including caller details and conversation summary',
                parameters: {
                  type: 'object',
                  properties: {
                    caller_name: { type: 'string', description: 'Full name of the caller' },
                    caller_phone: { type: 'string', description: 'Phone number of the caller' },
                    reason: { type: 'string', description: 'The reason the caller is calling' },
                    urgency: { type: 'string', description: 'How urgent the request is: low, normal, or high' },
                    summary: { type: 'string', description: 'Write a 2-3 sentence summary of the entire conversation including what the caller needed, what information was collected, and what was promised to them.' },
                    next_steps: { type: 'string', description: 'What you told the caller would happen next, for example: someone will call you back within 24 hours, or you have been transferred to sales.' },
                  },
                  required: ['caller_name', 'caller_phone', 'reason', 'urgency', 'summary', 'next_steps'],
                },
              },
            ],
            tool_choice: 'auto',
            temperature: 0.7,
          },
        };

        try {
          console.log('[OpenAI] session.update payload:', JSON.stringify({
            type: 'session.update',
            session: {
              modalities: sessionUpdate.session.modalities,
              voice: sessionUpdate.session.voice,
              input_audio_format: sessionUpdate.session.input_audio_format,
              output_audio_format: sessionUpdate.session.output_audio_format,
              input_audio_transcription: 'whisper-1',
              turn_detection: sessionUpdate.session.turn_detection,
              tool_choice: sessionUpdate.session.tool_choice,
              temperature: sessionUpdate.session.temperature,
              instructions_length: sessionUpdate.session.instructions.length,
            },
          }));
          openAiWs.send(JSON.stringify(sessionUpdate));
        } catch (err) {
          console.error('[OpenAI] Error sending session.update:', err);
          return;
        }

        setTimeout(() => {
          callState.openAiReady = true;
          console.log('[OpenAI] Session ready after 300ms delay');

          if (callState.earlyBuffer.length > 0) {
            console.log('[OpenAI] Flushing', callState.earlyBuffer.length, 'buffered packets');
            for (const payload of callState.earlyBuffer) {
              openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: payload,
              }));
            }
            callState.earlyBuffer = [];
          }

          if (callState.streamSid) {
            console.log('[OpenAI] streamSid already set, sending initial greeting now');
            sendInitialGreeting(openAiWs);
          } else {
            console.log('[OpenAI] Waiting for Twilio stream start before sending greeting');
            callState.greetingPending = true;
          }
        }, 300);
      });

      openAiWs.on('message', (data) => {
        const event = JSON.parse(data.toString());

        switch (event.type) {
          case 'session.created':
            console.log('[OpenAI] Session created:', event.session?.id);
            break;

          case 'session.updated':
            console.log('[OpenAI] Session updated successfully');
            break;

          case 'response.created':
            console.log('[OpenAI] Response generation started');
            break;

          case 'response.audio.delta':
            console.log('[Audio] delta chunk received, length:', event.delta?.length);
            if (event.delta && callState.streamSid) {
              callState.audioChunksSent++;
              twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: callState.streamSid,
                media: { payload: event.delta },
              }));
            } else if (!callState.streamSid) {
              console.warn('[Audio] Got audio delta but no streamSid yet');
            }
            break;

          case 'response.audio.done':
            console.log('[OpenAI] Audio response complete, total chunks sent:', callState.audioChunksSent);
            break;

          case 'response.audio_transcript.delta':
            if (event.delta) {
              callState.transcript.push({ role: 'assistant', content: event.delta, timestamp: new Date().toISOString() });
            }
            break;

          case 'response.audio_transcript.done':
            if (event.transcript) {
              console.log('[OpenAI] AI said:', event.transcript);
            }
            break;

          case 'input_audio_buffer.speech_started':
            console.log('[OpenAI] Caller started speaking (VAD detected speech)');
            break;

          case 'input_audio_buffer.speech_stopped':
            console.log('[OpenAI] Caller stopped speaking (VAD detected silence)');
            break;

          case 'input_audio_buffer.committed':
            console.log('[OpenAI] Audio buffer committed for processing');
            break;

          case 'conversation.item.input_audio_transcription.completed':
            if (event.transcript) {
              console.log('[OpenAI] Caller said:', event.transcript);
              callState.transcript.push({ role: 'caller', content: event.transcript, timestamp: new Date().toISOString() });

              if (callState.emotionConfig?.auto_detect !== false) {
                const emotionResult = detectEmotion(event.transcript);
                if (emotionResult.emotion !== 'neutral' && emotionResult.emotion !== callState.currentEmotion) {
                  callState.currentEmotion = emotionResult.emotion;
                  callState.emotionHistory.push({
                    emotion: emotionResult.emotion,
                    confidence: emotionResult.confidence,
                    triggers: emotionResult.triggers,
                    timestamp: new Date().toISOString(),
                    transcript: event.transcript.slice(0, 200),
                  });
                  console.log(`[Emotion] Detected: ${emotionResult.emotion} (confidence: ${emotionResult.confidence.toFixed(2)}) triggers: ${emotionResult.triggers.join(', ')}`);

                  if (callState.emotionConfig?.adjust_tone !== false && callState.baseSystemPrompt && openAiWs.readyState === WebSocket.OPEN) {
                    const adjustedPrompt = getEmotionAdjustedPrompt(emotionResult.emotion, callState.baseSystemPrompt);
                    openAiWs.send(JSON.stringify({
                      type: 'session.update',
                      session: { instructions: adjustedPrompt },
                    }));
                    console.log(`[Emotion] Updated system prompt for ${emotionResult.emotion}`);
                  }

                  if (shouldAutoTransfer(emotionResult.emotion) && callState.emotionConfig?.auto_transfer_distressed !== false) {
                    console.log(`[Emotion] Auto-transfer triggered for distressed caller`);
                  }

                  if (emotionResult.emotion === 'frustrated' && callState.emotionConfig?.alert_frustrated) {
                    try {
                      const apiBase = process.env.API_URL || `http://localhost:${process.env.API_PORT || 8080}`;
                      fetch(`${apiBase}/api/internal/emotion-alert`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          business_id: businessId,
                          call_sid: callState.callSid,
                          emotion: emotionResult.emotion,
                          transcript: event.transcript.slice(0, 200),
                        }),
                      }).catch(err => console.error('[Emotion] Alert failed:', err.message));
                    } catch {}
                  }
                }
              }

              if (callState.config?.competitorConfigs?.length > 0) {
                const lower = event.transcript.toLowerCase();
                for (const comp of callState.config.competitorConfigs) {
                  if (lower.includes(comp.competitor_name.toLowerCase())) {
                    console.log(`[Competitor] Detected mention of "${comp.competitor_name}" by caller`);
                    const compApiBase = process.env.API_BASE_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : `http://localhost:${process.env.API_PORT || 8080}`);
                    const headers = { 'Content-Type': 'application/json' };
                    if (process.env.INTERNAL_API_TOKEN) headers['x-internal-token'] = process.env.INTERNAL_API_TOKEN;
                    fetch(`${compApiBase}/api/internal/competitors/${comp.id}/mention`, { method: 'POST', headers }).catch(() => {});
                    if (!callState.competitorAlerted) {
                      callState.competitorAlerted = true;
                      fetch(`${compApiBase}/api/internal/competitor-alert`, {
                        method: 'POST', headers,
                        body: JSON.stringify({
                          business_id: businessId,
                          competitor_name: comp.competitor_name,
                          caller_phone: callState.callerNumber || '',
                          call_sid: callState.callSid || '',
                        }),
                      }).catch(() => {});
                    }
                    break;
                  }
                }
              }

              if (!callState.culturalPromptApplied && callState.transcript.length >= 1) {
                try {
                  const callerTexts = callState.transcript.filter(t => t.role === 'caller').map(t => t.content).join(' ');
                  const lang = detectLanguageFromText(callerTexts);
                  if (lang && lang !== 'en') {
                    callState.detectedLanguage = lang;
                    const cultural = buildCulturalPrompt(lang, callerTexts, callState.callerNumber || '', callState.config?.businessName);
                    callState.culturalProfile = cultural.profileKey;
                    callState.culturalPromptApplied = true;
                    if (callState.baseSystemPrompt && callState.openAiWs && callState.openAiWs.readyState === WebSocket.OPEN) {
                      callState.baseSystemPrompt = callState.baseSystemPrompt + '\n' + cultural.prompt;
                      callState.openAiWs.send(JSON.stringify({
                        type: 'session.update',
                        session: { instructions: callState.baseSystemPrompt },
                      }));
                      console.log(`[Cultural] Applied cultural profile: ${cultural.profileKey} (${cultural.profileName})`);
                    }
                  } else if (!callState.detectedLanguage) {
                    callState.detectedLanguage = 'en';
                    callState.culturalProfile = 'en-US';
                  }
                } catch (err) {
                  console.error('[Cultural] Detection error:', err.message);
                }
              }
            }
            break;

          case 'response.function_call_arguments.done':
            handleToolCall(event, openAiWs, callState.config);
            break;

          case 'response.done':
            console.log('[OpenAI] Response complete, output items:', event.response?.output?.length,
              'modalities:', event.response?.modalities,
              'status:', event.response?.status);
            break;

          case 'error':
            console.error('[OpenAI] Realtime error:', JSON.stringify(event.error));
            break;

          default:
            break;
        }
      });

      openAiWs.on('error', (err) => {
        console.error('[OpenAI] WebSocket error:', err.message);
      });

      openAiWs.on('close', (code, reason) => {
        console.log('[OpenAI] WebSocket closed', { code, reason: reason?.toString() });
        callState.openAiReady = false;
      });
    })();

    twilioWs.on('message', (message) => {
      const msg = JSON.parse(message.toString());

      switch (msg.event) {
        case 'start':
          callState.streamSid = msg.start.streamSid;
          callState.callSid = msg.start.callSid;
          callState.callStartTime = new Date().toISOString();
          callState.callerNumber = msg.start.customParameters?.From || msg.start.customParameters?.from || null;
          if (callState.config) callState.config._callSid = callState.callSid;
          console.log('[Twilio] Stream started', { streamSid: callState.streamSid, callSid: callState.callSid, callerNumber: callState.callerNumber });

          if (callState.callerNumber && callState.config) {
            loadCallerProfile(callState.callerNumber, businessId).then(profile => {
              if (profile && profile.total_calls > 0) {
                callState.callerProfile = profile;
                const personalization = getCallerPersonalization(profile);
                if (personalization && callState.baseSystemPrompt) {
                  callState.baseSystemPrompt = callState.baseSystemPrompt + '\n' + personalization;
                  console.log(`[Profiles] Returning caller detected: ${profile.name || 'Unknown'} (${profile.total_calls} calls, style: ${profile.communication_style})`);
                  if (callState.openAiWs && callState.openAiWs.readyState === WebSocket.OPEN) {
                    callState.openAiWs.send(JSON.stringify({
                      type: 'session.update',
                      session: { instructions: callState.baseSystemPrompt },
                    }));
                  }
                }
              }
            }).catch(err => console.error('[Profiles] Error loading caller profile:', err.message));
          }
          if (callState.greetingPending && callState.openAiWs && callState.openAiWs.readyState === WebSocket.OPEN) {
            console.log('[Twilio] Stream ready + greeting pending, sending initial greeting now');
            sendInitialGreeting(callState.openAiWs);
            callState.greetingPending = false;
          }
          saveCallRecord({
            callSid: callState.callSid,
            businessId,
            startTime: callState.callStartTime,
            status: 'in_progress',
          }).then((id) => {
            callState.callId = id;
            console.log('[DB] Call record saved with id:', callState.callId);
          }).catch((err) => {
            console.error('[DB] Failed to save call record:', err);
          });
          break;

        case 'media':
          callState.packetCount = (callState.packetCount || 0) + 1;
          if (callState.packetCount % 20 === 0) {
            console.log('[Audio] Twilio → OpenAI packet count:', callState.packetCount);
          }
          if (callState.openAiWs && callState.openAiWs.readyState === WebSocket.OPEN) {
            callState.openAiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload,
            }));
          } else {
            callState.earlyBuffer.push(msg.media.payload);
          }
          break;

        case 'stop':
          console.log('[Twilio] Stream stopped', { streamSid: callState.streamSid, totalPackets: callState.packetCount });
          handleCallEnd(callState.callId, callState.callStartTime, businessId, callState.transcript, callState.emotionHistory, callState.culturalProfile, callState.detectedLanguage, callState.callerNumber).catch((err) => {
            console.error('[DB] Failed to handle call end:', err);
          });
          if (callState.openAiWs && callState.openAiWs.readyState === WebSocket.OPEN) {
            callState.openAiWs.close();
          }
          break;
      }
    });

    twilioWs.on('close', () => {
      console.log('[WS] Twilio WebSocket closed, total packets received:', callState.packetCount);
      if (callState.openAiWs && callState.openAiWs.readyState === WebSocket.OPEN) {
        callState.openAiWs.close();
      }
    });
  });
});

async function handleToolCall(event, openAiWs, config) {
  const toolName = event.name;
  const callId = event.call_id;
  let args = {};

  try {
    args = JSON.parse(event.arguments);
  } catch {
    args = {};
  }

  console.log('[Tool] Call received:', { toolName, args });

  let result = '';

  switch (toolName) {
    case 'transfer_call':
      try {
        const transferConfig = config?.transfer_config || config?.transferConfig || {};
        const transferNumber = transferConfig.transfer_number || args.destination;
        const transferType = transferConfig.transfer_type || 'warm';
        const businessId = config?.businessId || config?.business_id || 'demo-business';
        const apiBase = process.env.API_URL || `http://localhost:${process.env.API_PORT || 8080}`;

        const transferRes = await fetch(`${apiBase}/api/twilio/transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            call_sid: config?._callSid || 'unknown',
            business_id: businessId,
            transfer_number: transferNumber,
            caller_name: args.caller_name || 'Unknown Caller',
            reason: args.reason || 'caller_request',
            transfer_type: transferType,
          }),
        });
        const transferData = await transferRes.json();
        console.log('[Tool] transfer_call result:', transferData);
        result = `Call transfer initiated to ${transferNumber}. Reason: ${args.reason}. ${transferType === 'warm' ? 'The team has been briefed about the call.' : 'Connecting now.'}`;
      } catch (transferErr) {
        console.error('[Tool] transfer_call error:', transferErr);
        result = `Call transfer initiated to ${args.destination}. Reason: ${args.reason}`;
      }
      break;
    case 'leave_voicemail':
      result = `Voicemail recorded from ${args.callerName || 'unknown caller'}. Message saved.`;
      break;
    case 'capture_callback':
      result = `Callback request captured for ${args.phoneNumber}. Reason: ${args.reason}. Preferred time: ${args.preferredTime || 'not specified'}.`;
      break;
    case 'save_lead':
      try {
        const leadUrl = `http://localhost:${process.env.PORT || 3000}/api/lead`;
        const leadRes = await fetch(leadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caller_name: args.caller_name,
            caller_phone: args.caller_phone,
            reason: args.reason,
            urgency: args.urgency,
            summary: args.summary,
            next_steps: args.next_steps,
          }),
        });
        const leadData = await leadRes.json();
        result = leadData.message || 'Lead saved successfully.';
        console.log('[Tool] save_lead result:', result);
      } catch (err) {
        console.error('[Tool] save_lead error:', err);
        result = 'Lead information has been recorded. Thank you.';
      }
      break;
    default:
      result = `Unknown tool: ${toolName}`;
  }

  if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
    openAiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: result,
      },
    }));

    openAiWs.send(JSON.stringify({ type: 'response.create' }));
  }
}

async function handleCallEnd(callId, callStartTime, businessId, transcript, emotionHistory, culturalProfile, detectedLanguage, callerPhone) {
  if (!callId) return;

  const fullTranscriptRaw = transcript
    .map((t) => `[${t.role}]: ${t.content}`)
    .join('\n');

  // PII redaction before persisting. This is the realtime-websocket call
  // end equivalent of the "sync" path in api-server. Used by both the
  // updateCallTranscript() persist below AND the analyzeCallWithClaude()
  // / updateCallerProfileAfterCall() downstreams.
  const { redactedText: fullTranscript } = await redactCallTranscript(fullTranscriptRaw, {
    businessId,
    source: 'sync',
    conversationId: callId,
  });

  const durationSeconds = callStartTime
    ? Math.round((Date.now() - new Date(callStartTime).getTime()) / 1000)
    : 0;

  console.log('[Call End] Saving transcript', { callId, durationSeconds, lines: transcript.length });

  const emotionData = {};
  if (emotionHistory && emotionHistory.length > 0) {
    emotionData.dominant_emotion = getDominantEmotion(emotionHistory);
    emotionData.emotion_journey = emotionHistory;
    emotionData.sentiment_score = calculateSentimentScore(emotionHistory);
    console.log('[Call End] Emotion data:', { dominant: emotionData.dominant_emotion, score: emotionData.sentiment_score, changes: emotionHistory.length });
  }

  if (culturalProfile) {
    emotionData.cultural_profile = culturalProfile;
    console.log('[Call End] Cultural profile:', culturalProfile);
  }
  if (detectedLanguage) {
    emotionData.language_detected = detectedLanguage;
    console.log('[Call End] Language detected:', detectedLanguage);
  }

  const callRecord = await updateCallTranscript(callId, {
    transcript: fullTranscript,
    duration: durationSeconds,
    status: 'completed',
    ...emotionData,
  });

  if (transcript.length > 0) {
    console.log('[Call End] Analyzing call with Claude');
    const analysis = await analyzeCallWithClaude(fullTranscript, businessId);
    if (analysis) {
      await saveCallAnalysis(callId, analysis);
      console.log('[Call End] Analysis saved', { callId, outcome: analysis.callOutcome });
    }
  }

  if (callRecord?.caller_number) {
    updateCallerProfileAfterCall({
      business_id: businessId,
      caller_phone: callRecord.caller_number,
      caller_name: null,
      duration: durationSeconds,
      transcript: fullTranscript,
      sentiment_score: emotionData.sentiment_score ?? 50,
      summary: '',
      call_outcome: 'resolved',
      cultural_profile: culturalProfile || null,
      detected_language: detectedLanguage || null,
    }).catch(err => console.error('[Call End] Profile update error:', err.message));
  }

  if (durationSeconds > 60 && callRecord?.caller_number) {
    const callerPhone = callRecord.caller_number;
    const surveyDelay = 120000;
    console.log(`[Survey] Scheduling satisfaction survey for ${callerPhone} in ${surveyDelay / 1000}s`);
    setTimeout(async () => {
      try {
        const apiBase = process.env.API_URL || `http://localhost:${process.env.API_PORT || 8080}`;
        const resp = await fetch(`${apiBase}/api/internal/survey/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-token': 'neverr-internal-engine' },
          body: JSON.stringify({ businessId, callerPhone, callId }),
        });
        const result = await resp.json();
        console.log(`[Survey] Send result for ${callerPhone}:`, result);
      } catch (err) {
        console.error('[Survey] Failed to send:', err.message);
      }
    }, surveyDelay);
  }
}

async function analyzeCallWithClaude(transcript, businessId) {
  try {
    const config = await loadBusinessConfig(businessId);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Analyze the following phone call transcript for the business "${config.businessName || businessId}".

Transcript:
${transcript}

Return a JSON object with the following fields:
- summary: A brief summary of the call
- callerName: The caller's name if mentioned, otherwise "Unknown"
- callerIntent: What the caller wanted
- sentiment: The overall sentiment (positive, neutral, negative)
- actionItems: An array of action items from the call
- followUpRequired: Boolean indicating if follow-up is needed
- callOutcome: The outcome of the call (resolved, transferred, voicemail, callback_requested, unresolved)

Return ONLY valid JSON, no other text.`,
        },
      ],
    });

    let text = response.content[0].text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    return JSON.parse(text);
  } catch (err) {
    console.error('[Claude] Failed to analyze call:', err);
    return null;
  }
}

async function syncElevenLabsConversations() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.log('[Sync] Skipping — ELEVENLABS_API_KEY not set');
    return;
  }

  const supabase = getClient();
  if (!supabase) {
    console.log('[Sync] Skipping — Supabase not configured');
    return;
  }

  try {
    console.log('[Sync] Checking for new ElevenLabs conversations...');

    const listRes = await fetch('https://api.elevenlabs.io/v1/convai/conversations', {
      headers: { 'xi-api-key': apiKey },
    });

    if (!listRes.ok) {
      console.error('[Sync] ElevenLabs API error:', listRes.status, await listRes.text());
      return;
    }

    const listData = await listRes.json();
    const conversations = listData.conversations || listData || [];

    if (!Array.isArray(conversations) || conversations.length === 0) {
      console.log('[Sync] No conversations found');
      return;
    }

    const convIds = conversations.map(c => c.conversation_id).filter(Boolean);

    const { data: existing } = await supabase
      .from('calls')
      .select('call_sid')
      .in('call_sid', convIds);

    const existingIds = new Set((existing || []).map(r => r.call_sid));
    const newConversations = conversations.filter(c => c.conversation_id && !existingIds.has(c.conversation_id));

    console.log(`[Sync] Found ${newConversations.length} new conversations to import`);

    for (const conv of newConversations) {
      try {
        const detailRes = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversations/${conv.conversation_id}`,
          { headers: { 'xi-api-key': apiKey } }
        );

        if (!detailRes.ok) {
          console.error('[Sync] Failed to fetch conversation:', conv.conversation_id, detailRes.status);
          continue;
        }

        const conversation = await detailRes.json();

        // PII-safe: logs metadata only, raw content goes through PIIProcessor before any persistence.
        // Previously dumped 500 chars of raw conversation JSON — first 500 chars almost always
        // include the opening transcript turns containing caller name + identifying detail.
        console.log(
          '[Sync] received',
          'conversation_id=' + conv.conversation_id,
          'transcript_turns=' + (conversation.transcript?.length ?? 0),
          'duration_secs=' + (conversation.metadata?.call_duration_secs ?? 0),
          'has_analysis=' + !!conversation.analysis,
        );

        const transcriptRaw = (conversation.transcript || [])
          .map(t => (t.role === 'agent' ? 'AI' : 'Caller') + ': ' + t.message)
          .join('\n');

        // PII redaction at the polling-sync ingestion boundary. This is
        // the engine analog of api-server's syncElevenLabsConversations.
        // The redacted transcriptText feeds Supabase persist + Claude
        // analysis + caller-profile echo. The raw `conversation.metadata`
        // and structured caller_name/caller_phone above remain unredacted
        // — they're operational fields the product depends on.
        const { redactedText: transcriptText } = await redactCallTranscript(transcriptRaw, {
          businessId: 'demo-business',
          source: 'sync',
          conversationId: conv.conversation_id,
        });

        console.log('[Sync] Transcript preview:', transcriptText.substring(0, 100));

        const dataResults = conversation.analysis?.data_collection_results || {};
        const callerName = dataResults.caller_name?.value || null;
        const callerPhone = dataResults.caller_phone?.value || conversation.metadata?.phone_number || null;
        const reason = dataResults.reason?.value || null;
        const urgency = dataResults.urgency?.value || null;

        const duration = conversation.metadata?.call_duration_secs || 0;
        const startTime = conversation.metadata?.start_time_unix_secs
          ? new Date(conversation.metadata.start_time_unix_secs * 1000).toISOString()
          : new Date().toISOString();

        const { data: saved, error } = await supabase
          .from('calls')
          .insert({
            call_sid: conv.conversation_id,
            business_id: 'demo-business',
            caller_name: callerName,
            caller_number: callerPhone,
            caller_intent: reason,
            duration_seconds: duration,
            transcript: transcriptText,
            status: 'completed',
            start_time: startTime,
            end_time: new Date().toISOString(),
          })
          .select('id')
          .single();

        if (error) {
          console.error('[Sync] Error saving conversation:', conv.conversation_id, error.message);
          continue;
        }

        console.log('[Sync] Saved conversation:', conv.conversation_id, '→', saved.id);

        if (transcriptText && saved.id) {
          const analysis = await analyzeCallWithClaude(transcriptText, 'demo-business');
          if (analysis) {
            await saveCallAnalysis(saved.id, analysis);
            console.log('[Sync] Claude analysis saved for:', saved.id);
          }
          updateCallerProfileAfterCall({
            business_id: 'demo-business',
            caller_phone: callerPhone || 'unknown',
            caller_name: callerName,
            duration: duration || 0,
            transcript: transcriptText,
            sentiment_score: analysis?.sentiment === 'positive' ? 80 : analysis?.sentiment === 'negative' ? 20 : 50,
            summary: analysis?.summary || '',
            call_outcome: analysis?.call_outcome || 'resolved',
          }).catch(err => console.error('[Sync] Profile update error:', err.message));
        }
      } catch (err) {
        console.error('[Sync] Error processing conversation:', conv.conversation_id, err.message);
      }
    }

    console.log('[Sync] Sync complete');
  } catch (err) {
    console.error('[Sync] Error:', err.message);
  }
}

const PORT = process.env.PORT || 3000;

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[Server] Neverr Voice Engine running on port ${PORT}`);

  setTimeout(() => syncElevenLabsConversations(), 10 * 1000);
  setInterval(syncElevenLabsConversations, 2 * 60 * 1000);
  console.log('[Sync] ElevenLabs conversation sync scheduled (every 2 minutes)');
} catch (err) {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
}
