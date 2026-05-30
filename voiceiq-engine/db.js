import { createClient } from '@supabase/supabase-js';

let cachedClient = null;

export function getClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.warn('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — database operations will be skipped');
    return null;
  }

  cachedClient = createClient(url, key);
  return cachedClient;
}

export async function getBusinessConfigCount() {
  const client = getClient();
  if (!client) return null;

  try {
    const { count, error } = await client
      .from('business_configs')
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error('Error counting business configs:', error);
      return null;
    }

    return count;
  } catch (err) {
    console.error('Error counting business configs:', err);
    return null;
  }
}

export async function getBusinessConfig(businessId) {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('business_configs')
      .select('*')
      .eq('business_id', businessId)
      .single();

    if (error || !data) return null;

    try {
      const apiBase = process.env.API_URL || `http://localhost:${process.env.API_PORT || 8080}`;
      const tcRes = await fetch(`${apiBase}/api/internal/transfer-config/${encodeURIComponent(businessId)}`);
      if (tcRes.ok) {
        const tcData = await tcRes.json();
        if (tcData.transfer_config) {
          data.transfer_config = tcData.transfer_config;
        }
      }
    } catch {}

    return data;
  } catch (err) {
    console.error('Error fetching business config:', err);
    return null;
  }
}

export async function saveCallRecord({ callSid, businessId, startTime, status, callerNumber, duration, transcript }) {
  const client = getClient();
  if (!client) return null;

  try {
    const row = {
      call_sid: callSid,
      business_id: businessId,
      start_time: startTime,
      status,
    };
    if (callerNumber) row.caller_number = callerNumber;
    if (duration != null) row.duration_seconds = duration;
    if (transcript) row.transcript = transcript;

    const { data, error } = await client
      .from('calls')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      console.error('Error saving call record:', error);
      return null;
    }

    return data.id;
  } catch (err) {
    console.error('Error saving call record:', err);
    return null;
  }
}

export async function updateCallTranscript(callId, { transcript, duration, status, dominant_emotion, emotion_journey, sentiment_score, cultural_profile, language_detected }) {
  const client = getClient();
  if (!client) return null;

  try {
    const updateData = {
      transcript,
      duration_seconds: duration,
      status,
      end_time: new Date().toISOString(),
    };
    if (dominant_emotion) updateData.dominant_emotion = dominant_emotion;
    if (emotion_journey) updateData.emotion_journey = emotion_journey;
    if (sentiment_score !== undefined) updateData.sentiment_score = sentiment_score;
    if (cultural_profile) updateData.cultural_profile = cultural_profile;
    if (language_detected) updateData.language_detected = language_detected;

    const { data, error } = await client
      .from('calls')
      .update(updateData)
      .eq('id', callId)
      .select()
      .single();

    if (error) {
      console.error('Error updating call transcript:', error);
      return null;
    }

    return data;
  } catch (err) {
    console.error('Error updating call transcript:', err);
    return null;
  }
}

export async function saveCallAnalysis(callId, analysis) {
  const client = getClient();
  if (!client) return null;

  try {
    const { error: updateError } = await client
      .from('calls')
      .update({
        summary: analysis.summary,
        caller_name: analysis.callerName,
        caller_intent: analysis.callerIntent,
        sentiment: analysis.sentiment,
        call_outcome: analysis.callOutcome,
        follow_up_required: analysis.followUpRequired,
      })
      .eq('id', callId);

    if (updateError) {
      console.error('Error saving call analysis:', updateError);
      return null;
    }

    if (analysis.actionItems && analysis.actionItems.length > 0) {
      const rows = analysis.actionItems
        .filter((item) => item && (item.task || item.description))
        .map((item) => ({
          call_id: callId,
          task: item.task || item.description || 'Follow up required',
          priority: item.priority || 'medium',
          assign_to: item.assignTo || item.assign_to || null,
          status: 'open',
        }));

      if (rows.length === 0) return true;

      const { error: insertError } = await client
        .from('action_items')
        .insert(rows);

      if (insertError) {
        console.error('Error saving action items:', insertError);
      }
    }

    return true;
  } catch (err) {
    console.error('Error saving call analysis:', err);
    return null;
  }
}

export async function getRecentCalls(businessId, limit = 20) {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('calls')
      .select('*')
      .eq('business_id', businessId)
      .order('start_time', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching recent calls:', error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('Error fetching recent calls:', err);
    return [];
  }
}

export async function updateCallStatusByCallSid(callSid, status) {
  const client = getClient();
  if (!client) return null;

  try {
    const updates = { status };
    if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
      updates.end_time = new Date().toISOString();
    }

    const { data, error } = await client
      .from('calls')
      .update(updates)
      .eq('call_sid', callSid)
      .select()
      .single();

    if (error) {
      console.error('Error updating call status by callSid:', error);
      return null;
    }

    return data;
  } catch (err) {
    console.error('Error updating call status by callSid:', err);
    return null;
  }
}

export async function getOpenActionItems(businessId) {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('action_items')
      .select('*, calls!inner(business_id)')
      .eq('calls.business_id', businessId)
      .eq('status', 'open');

    if (error) {
      console.error('Error fetching open action items:', error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('Error fetching open action items:', err);
    return [];
  }
}
