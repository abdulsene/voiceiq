// @ts-ignore
import fetch from 'isomorphic-fetch';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} environment variable is required but not set`);
  return val;
}

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const REDIRECT_URI = () => requireEnv('MICROSOFT_REDIRECT_URI');

export function getMicrosoftAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: requireEnv('MICROSOFT_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: REDIRECT_URI(),
    scope: 'https://graph.microsoft.com/Calendars.ReadWrite offline_access User.Read',
    response_mode: 'query',
    prompt: 'consent',
    access_type: 'offline'
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}

export async function getMicrosoftTokens(code: string) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('MICROSOFT_CLIENT_ID'),
      client_secret: requireEnv('MICROSOFT_CLIENT_SECRET'),
      code,
      redirect_uri: REDIRECT_URI(),
      grant_type: 'authorization_code',
    })
  });
  return res.json();
}

function getSupabaseClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || ''
  );
}

async function getAccessToken(): Promise<string> {
  let refreshToken = '';

  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'microsoft_refresh_token')
      .single();
    if (data?.value && data.value.length > 50) {
      refreshToken = Buffer.from(data.value, 'base64').toString('utf8');
      console.log('[Outlook] Token loaded from Supabase');
    }
  } catch (e) {
    console.log('[Outlook] Supabase token load failed, trying other sources');
  }

  if (!refreshToken || refreshToken.length < 100) {
    const envToken = process.env.MICROSOFT_REFRESH_TOKEN || '';
    if (envToken.length > 100) {
      refreshToken = envToken;
      console.log('[Outlook] Token loaded from env var');
    }
  }

  if (!refreshToken || refreshToken.length < 100) {
    try {
      const fs = require('fs');
      const encoded = fs.readFileSync('/home/runner/microsoft_refresh_token.txt', 'utf8').trim();
      refreshToken = Buffer.from(encoded, 'base64').toString('utf8');
      console.log('[Outlook] Token loaded from file');
    } catch (e) {
      throw new Error('No Microsoft refresh token available');
    }
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({
      client_id: requireEnv('MICROSOFT_CLIENT_ID'),
      client_secret: requireEnv('MICROSOFT_CLIENT_SECRET'),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Calendars.ReadWrite offline_access'
    }).toString()
  });

  const text = await res.text();
  const data = JSON.parse(text);

  if (!data.access_token) {
    throw new Error(data.error_description || JSON.stringify(data));
  }

  if (data.refresh_token) {
    try {
      const supabase = getSupabaseClient();
      const encoded = Buffer.from(data.refresh_token).toString('base64');
      await supabase.from('system_config').upsert({
        key: 'microsoft_refresh_token',
        value: encoded,
        updated_at: new Date().toISOString()
      });
      console.log('[Outlook] Refreshed token saved to Supabase');
    } catch (e) {}
  }

  console.log('[Outlook] Got access token successfully');
  return data.access_token;
}

export async function getOutlookAvailableSlots(opts: {
  durationMinutes?: number;
  businessHoursStart?: number;
  businessHoursEnd?: number;
  timezone?: string;
}): Promise<string[]> {
  const { durationMinutes = 30, businessHoursStart = 9, businessHoursEnd = 17, timezone = 'America/New_York' } = opts;

  const accessToken = await getAccessToken();
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${weekFromNow.toISOString()}&$select=start,end,subject`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const busyTimes = (data.value || []).map((e: any) => ({
    start: new Date(e.start.dateTime + 'Z'),
    end: new Date(e.end.dateTime + 'Z')
  }));

  const slots: string[] = [];
  const current = new Date(now);
  current.setMinutes(0, 0, 0);
  current.setHours(current.getHours() + 1);

  while (current < weekFromNow && slots.length < 10) {
    const formatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone });
    const localHour = parseInt(formatter.format(current), 10);
    const dayFormatter = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone });
    const dayStr = dayFormatter.format(current);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayStr);

    if (day === 0 || day === 6) {
      current.setHours(current.getHours() + 1);
      continue;
    }

    if (localHour < businessHoursStart || localHour >= businessHoursEnd) {
      current.setMinutes(current.getMinutes() + 30);
      continue;
    }

    const slotEnd = new Date(current.getTime() + durationMinutes * 60 * 1000);
    const hasConflict = busyTimes.some((b: any) => current < b.end && slotEnd > b.start);

    if (!hasConflict) {
      slots.push(current.toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: timezone
      }));
    }

    current.setMinutes(current.getMinutes() + 30);
  }
  return slots;
}

function parseHumanDateTime(str: string): Date | null {
  const cleaned = str.replace(/\b(EDT|EST|CST|CDT|MST|MDT|PST|PDT)\b/gi, '').trim();
  const match = cleaned.match(/(?:\w+,\s*)?(\w+)\s+(\d{1,2})(?:\s+at\s+|\s+)(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;

  const monthNames: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };

  const month = monthNames[match[1].toLowerCase()];
  if (month === undefined) return null;

  const day = parseInt(match[2], 10);
  let hour = parseInt(match[3], 10);
  const minute = parseInt(match[4], 10);
  const ampm = match[5].toUpperCase();

  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month, day, hour, minute, 0, 0);
  if (candidate < now) {
    candidate.setFullYear(year + 1);
  }

  const utcStr = candidate.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = candidate.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const offset = (new Date(utcStr).getTime() - new Date(tzStr).getTime()) / 60000;
  const utcTime = new Date(candidate.getTime() + offset * 60 * 1000);

  return isNaN(utcTime.getTime()) ? null : utcTime;
}

export async function bookOutlookAppointment(opts: {
  callerName: string;
  callerPhone: string;
  callerEmail?: string;
  dateTimeStr: string;
  durationMinutes?: number;
  reason?: string;
  businessName?: string;
}): Promise<{ success: boolean; eventId?: string; error?: string }> {
  try {
    const accessToken = await getAccessToken();
    const duration = opts.durationMinutes || 30;
    let startTime = new Date(opts.dateTimeStr);
    if (isNaN(startTime.getTime())) {
      const parsed = parseHumanDateTime(opts.dateTimeStr);
      if (parsed) {
        startTime = parsed;
      } else {
        return { success: false, error: 'Invalid date/time format' };
      }
    }
    const endTime = new Date(startTime.getTime() + duration * 60 * 1000);

    const event = {
      subject: `${opts.callerName} - ${opts.reason || 'Appointment'}`,
      body: {
        contentType: 'text',
        content: `Booked via Neverr AI Receptionist\nCaller: ${opts.callerName}\nPhone: ${opts.callerPhone}\nEmail: ${opts.callerEmail || 'Not provided'}\nReason: ${opts.reason || 'Not specified'}`
      },
      start: { dateTime: startTime.toISOString().replace('Z', ''), timeZone: 'Eastern Standard Time' },
      end: { dateTime: endTime.toISOString().replace('Z', ''), timeZone: 'Eastern Standard Time' },
      attendees: opts.callerEmail ? [{ emailAddress: { address: opts.callerEmail }, type: 'required' }] : []
    };

    const res = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    const data = await res.json();
    if (data.id) {
      console.log('[Outlook] Appointment booked:', data.id, 'for', opts.callerName);
      return { success: true, eventId: data.id };
    }
    return { success: false, error: JSON.stringify(data) };
  } catch (err: any) {
    console.error('[Outlook] Booking failed:', err.message);
    return { success: false, error: err.message };
  }
}
