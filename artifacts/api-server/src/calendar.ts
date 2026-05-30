import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

function getCalendarClient() {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || '';
  if (!refreshToken) console.warn('[Calendar] WARNING: GOOGLE_REFRESH_TOKEN not set');

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken
  });

  oauth2Client.on('tokens', async (tokens) => {
    console.log('[Calendar] Token refreshed automatically');
    if (tokens.refresh_token) {
      try {
        const supabase = createClient(
          process.env.SUPABASE_URL || '',
          process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || ''
        );
        await supabase.from('system_config').upsert({
          key: 'google_refresh_token',
          value: tokens.refresh_token,
          updated_at: new Date().toISOString()
        });
        console.log('[Calendar] New refresh token saved to Supabase');
      } catch (e: any) {
        console.error('[Calendar] Failed to save token:', e.message);
      }
    }
  });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

export async function getAvailableSlots(opts: {
  durationMinutes?: number;
  businessHoursStart?: number;
  businessHoursEnd?: number;
  timezone?: string;
}): Promise<string[]> {
  const { durationMinutes = 30, businessHoursStart = 9, businessHoursEnd = 17, timezone = 'America/New_York' } = opts;

  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const { data } = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: now.toISOString(),
      timeMax: weekFromNow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    const busyTimes = (data.items || []).map(event => ({
      start: new Date(event.start?.dateTime || event.start?.date || ''),
      end: new Date(event.end?.dateTime || event.end?.date || '')
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
      const hasConflict = busyTimes.some(busy =>
        current < busy.end && slotEnd > busy.start
      );

      if (!hasConflict) {
        const options: Intl.DateTimeFormatOptions = {
          weekday: 'long', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZone: timezone
        };
        slots.push(current.toLocaleString('en-US', options));
      }

      current.setMinutes(current.getMinutes() + 30);
    }
    return slots;
  } catch (err: any) {
    if (err.message?.includes('invalid_grant')) {
      console.log('[Calendar] Token expired — needs reauthorization');
      throw new Error('Google Calendar needs reauthorization. Visit /api/auth/google to reconnect.');
    }
    throw err;
  }
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

  const offset = getTimezoneOffsetMinutes('America/New_York', candidate);
  const utcTime = new Date(candidate.getTime() + offset * 60 * 1000);

  return isNaN(utcTime.getTime()) ? null : utcTime;
}

function getTimezoneOffsetMinutes(tz: string, date: Date): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: tz });
  const utcDate = new Date(utcStr);
  const tzDate = new Date(tzStr);
  return (utcDate.getTime() - tzDate.getTime()) / 60000;
}

export async function bookAppointment(opts: {
  callerName: string;
  callerPhone: string;
  callerEmail?: string;
  dateTimeStr: string;
  durationMinutes?: number;
  reason?: string;
  businessName?: string;
}): Promise<{ success: boolean; eventId?: string; eventLink?: string; error?: string }> {
  try {
    const calendar = getCalendarClient();
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
      summary: `${opts.callerName} - ${opts.reason || 'Appointment'}`,
      description: `Booked via Neverr AI Receptionist\nCaller: ${opts.callerName}\nPhone: ${opts.callerPhone}\nEmail: ${opts.callerEmail || 'Not provided'}\nReason: ${opts.reason || 'Not specified'}`,
      start: { dateTime: startTime.toISOString(), timeZone: 'America/New_York' },
      end: { dateTime: endTime.toISOString(), timeZone: 'America/New_York' },
      attendees: opts.callerEmail ? [{ email: opts.callerEmail }] : [],
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 24 * 60 }, { method: 'popup', minutes: 30 }] }
    };
    const { data } = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      requestBody: event,
      sendUpdates: 'all'
    });
    console.log('[Calendar] Appointment booked:', data.id, 'for', opts.callerName);
    return { success: true, eventId: data.id || undefined, eventLink: data.htmlLink || undefined };
  } catch (err: any) {
    console.error('[Calendar] Booking failed:', err.message);
    return { success: false, error: err.message };
  }
}

export default { getAvailableSlots, bookAppointment };
