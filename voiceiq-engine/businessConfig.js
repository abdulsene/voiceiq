export const DEFAULT_CONFIG = {
  businessId: 'default',
  businessName: 'Neverr Demo Business',
  aiName: 'Alex',
  industry: 'General business',
  tone: 'Professional and friendly',
  greeting: 'Thank you for calling. How can I help you today?',
  voiceId: 'alloy',
  businessHours: 'Monday to Friday, 9am to 5pm',
  personalityInstructions: 'Be warm, helpful, efficient. Use caller name once learned. Keep responses under 30 words.',
  departments: [
    { name: 'Sales', description: 'New purchases, pricing, and product inquiries', extension: '101' },
    { name: 'Support', description: 'Technical help, troubleshooting, and service issues', extension: '102' },
    { name: 'Billing', description: 'Invoices, payments, and account questions', extension: '103' },
    { name: 'General', description: 'General inquiries and operator assistance', extension: '0' },
  ],
  knowledgeBase: 'Demo business. AI assistant can answer questions and route calls.',
};

export async function loadBusinessConfig(businessId) {
  if (businessId === 'default') {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const { getBusinessConfig } = await import('./db.js');
    const record = await getBusinessConfig(businessId);

    if (!record) {
      console.warn(`No config found for businessId "${businessId}" — using defaults`);
      return { ...DEFAULT_CONFIG, businessId };
    }

    return { ...DEFAULT_CONFIG, ...record };
  } catch (err) {
    console.error('Failed to load business config:', err);
    return { ...DEFAULT_CONFIG };
  }
}

export async function loadObjectionHandlers(businessId) {
  try {
    let apiBase;
    if (process.env.API_BASE_URL) {
      apiBase = process.env.API_BASE_URL;
    } else if (process.env.REPLIT_DEV_DOMAIN) {
      apiBase = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    } else {
      apiBase = 'http://localhost:8080';
    }
    const headers = {};
    if (process.env.INTERNAL_API_TOKEN) {
      headers['x-internal-token'] = process.env.INTERNAL_API_TOKEN;
    }
    const res = await fetch(`${apiBase}/api/internal/objections/${businessId}`, { headers });
    if (res.ok) {
      const data = await res.json();
      return data.handlers || [];
    }
    console.warn(`[Objections] Non-OK response: ${res.status} from ${apiBase}`);
  } catch (err) {
    console.error('[Objections] Failed to load handlers:', err.message);
  }
  return [];
}

export async function loadCompetitorConfigs(businessId) {
  try {
    let apiBase;
    if (process.env.API_BASE_URL) {
      apiBase = process.env.API_BASE_URL;
    } else if (process.env.REPLIT_DEV_DOMAIN) {
      apiBase = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    } else {
      apiBase = 'http://localhost:8080';
    }
    const headers = {};
    if (process.env.INTERNAL_API_TOKEN) {
      headers['x-internal-token'] = process.env.INTERNAL_API_TOKEN;
    }
    const res = await fetch(`${apiBase}/api/internal/competitors/${businessId}`, { headers });
    if (res.ok) {
      const data = await res.json();
      return data.competitors || [];
    }
    console.warn(`[Competitors] Non-OK response: ${res.status} from ${apiBase}`);
  } catch (err) {
    console.error('[Competitors] Failed to load configs:', err.message);
  }
  return [];
}

export async function loadCallerProfile(phone, businessId) {
  if (!phone || phone === 'unknown') return null;
  try {
    let apiBase;
    if (process.env.API_BASE_URL) {
      apiBase = process.env.API_BASE_URL;
    } else if (process.env.REPLIT_DEV_DOMAIN) {
      apiBase = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    } else {
      apiBase = 'http://localhost:8080';
    }
    const headers = {};
    if (process.env.INTERNAL_API_TOKEN) {
      headers['x-internal-token'] = process.env.INTERNAL_API_TOKEN;
    }
    const res = await fetch(`${apiBase}/api/internal/profiles/${businessId}/${encodeURIComponent(phone)}`, { headers });
    if (res.ok) {
      const data = await res.json();
      return data.profile || null;
    }
  } catch (err) {
    console.error('[Profiles] Failed to load caller profile:', err.message);
  }
  return null;
}

export async function updateCallerProfileAfterCall(callData) {
  try {
    let apiBase;
    if (process.env.API_BASE_URL) {
      apiBase = process.env.API_BASE_URL;
    } else if (process.env.REPLIT_DEV_DOMAIN) {
      apiBase = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    } else {
      apiBase = 'http://localhost:8080';
    }
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.INTERNAL_API_TOKEN) {
      headers['x-internal-token'] = process.env.INTERNAL_API_TOKEN;
    }
    await fetch(`${apiBase}/api/internal/profiles/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify(callData),
    });
  } catch (err) {
    console.error('[Profiles] Failed to update caller profile:', err.message);
  }
}

export function getCallerPersonalization(profile) {
  if (!profile || profile.total_calls === 0) return '';

  let personalization = `
RETURNING CALLER INTELLIGENCE:
- Name: ${profile.name || 'Unknown'}
- Call history: ${profile.total_calls} previous calls
- Communication style: ${profile.communication_style}
- VIP status: ${profile.is_vip ? 'YES - treat with extra care' : 'No'}
${profile.avg_satisfaction_rating ? `- Average satisfaction: ${profile.avg_satisfaction_rating}/5` : ''}
${profile.common_topics?.length > 0 ? `- Common topics they call about: ${profile.common_topics.join(', ')}` : ''}
`;

  if (profile.is_vip) {
    personalization += `
VIP CALLER: Greet by name immediately. Offer priority service. Do not put on hold.
Example: "Welcome back, ${profile.name}! Great to hear from you again."
`;
  }

  if (profile.communication_style === 'rushed') {
    personalization += `
This caller prefers BRIEF responses. Get to the point immediately. Skip pleasantries unless they initiate them.
`;
  }

  if (profile.communication_style === 'chatty') {
    personalization += `
This caller enjoys conversation. Match their energy. Build rapport before moving to the main purpose of the call.
`;
  }

  if (profile.communication_style === 'formal') {
    personalization += `
This caller prefers formal communication. Use professional language and be thorough in your responses.
`;
  }

  if (profile.is_at_risk) {
    personalization += `
AT-RISK CALLER: This caller has shown declining satisfaction. Be extra attentive, apologize proactively if any issues come up, and offer to connect them with a manager.
`;
  }

  if (profile.common_objections?.length > 0) {
    personalization += `
Past objections from this caller: ${profile.common_objections.join(', ')}
Be prepared to address these proactively.
`;
  }

  if (profile.cultural_profile) {
    personalization += `
KNOWN CULTURAL PROFILE: ${profile.cultural_profile}
Detected language: ${profile.detected_language || 'unknown'}
Immediately use culturally appropriate communication for this caller from the first word.
`;
  }

  return personalization;
}

export function buildSystemPrompt(config) {
  const departmentList = (config.departments || [])
    .map((d) => `  - ${d.name} (ext ${d.extension}): ${d.description}`)
    .join('\n');

  return `You are ${config.aiName || 'an AI assistant'}, a voice AI assistant for ${config.businessName || 'our business'}.

Business Information:
- Business Name: ${config.businessName || 'N/A'}
- Industry: ${config.industry || 'N/A'}
- Tone: ${config.tone || 'Professional'}
- Business Hours: ${config.businessHours || 'N/A'}
- Location: ${config.location || 'Not specified'}

Departments:
${departmentList || '  - No departments configured'}

Knowledge Base:
${config.knowledgeBase || 'No additional knowledge base provided.'}

Personality:
${config.personalityInstructions || ''}

Instructions:
- Greet the caller warmly and introduce yourself by name
- Identify the caller's need within the first exchange
- Capture the caller's name and phone number before transferring to a department
- Use the transfer_call tool to route callers to the appropriate department by extension
- Use the leave_voicemail tool if the caller wants to leave a message or no one is available
- Use the capture_callback tool if the caller requests a callback
- Keep responses concise and conversational — this is a phone call, not a chat
- Always reflect the business tone: ${config.tone || 'professional and friendly'}
- Never make up information — if you don't know something, offer to transfer or take a message

Call Transfer Rules:
- If the caller says "speak to a human", "talk to a person", "real person", "transfer me", "operator", "manager", "representative", or "press 0", use transfer_call with destination "human" and explain you are connecting them
- If the caller mentions an emergency, urgent situation, or life-threatening situation, use transfer_call with destination "human" and reason "emergency"
- Before transferring, always say "Of course, let me connect you with our team right away. Please hold for just a moment."
- If you cannot help with a request or your confidence is low, offer to transfer the caller to a team member

${config.objectionHandlers && config.objectionHandlers.length > 0 ? `
Objection Handling Rules:
When a caller expresses hesitation or an objection, use these trained responses:
${config.objectionHandlers.map(h => `- If the caller says something like "${h.objection_phrase}" (category: ${h.objection_category}), respond with: "${h.ai_response}"${h.follow_up_action ? ` Then ${h.follow_up_action.replace(/_/g, ' ')}.` : ''}`).join('\n')}
Always empathize first, then address the concern directly. Never be pushy or dismissive of objections.` : ''}

${config.competitorConfigs && config.competitorConfigs.length > 0 ? `
Competitive Intelligence Rules:
When a caller mentions any of these competitors, use your trained competitive response:
${config.competitorConfigs.map(c => `- If the caller mentions "${c.competitor_name}", respond with: "${c.competitor_response}"`).join('\n')}
Be confident but never disparage competitors. Focus on your unique strengths and value.` : ''}`;
}
