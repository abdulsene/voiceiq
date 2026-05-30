function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY environment variable is required but not set');
  return key;
}

export async function createAgentForBusiness(opts: {
  businessId: string;
  businessName: string;
  systemPrompt: string;
  firstMessage?: string;
  language?: string;            // Phase 3l: ISO 639-1 code (en, es, fr, pt, zh, ar, …)
  languageDetection?: boolean;  // Phase 3l: enable for non-English so caller code-switching works
}): Promise<{ success: boolean; agentId?: string; error?: string }> {
  try {
    console.log('[Agents] Creating agent for:', opts.businessName, 'language:', opts.language || 'en');

    const agentConfig: any = {
      prompt: {
        prompt: opts.systemPrompt
      },
      first_message: opts.firstMessage || `Hello, thank you for calling ${opts.businessName}. How can I help you today?`,
      language: opts.language || 'en',
    };
    if (opts.languageDetection) {
      agentConfig.language_detection = true;
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

export default { createAgentForBusiness, updateAgentPrompt, getAgent, deleteAgent };
