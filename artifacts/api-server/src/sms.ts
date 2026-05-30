import twilio from 'twilio';

let _client: ReturnType<typeof twilio> | null = null;

export function getTwilioClient(): ReturnType<typeof twilio> {
  return getClient();
}

function getClient(): ReturnType<typeof twilio> {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables are required but not set');
    _client = twilio(sid, token);
  }
  return _client;
}

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';

export async function sendSMS(to: string, message: string): Promise<boolean> {
  try {
    if (!to || !FROM_NUMBER) {
      console.log('[SMS] Missing to or from number, skipping');
      return false;
    }
    const cleanTo = to.replace(/[^\d+]/g, '');
    if (cleanTo.length < 10) {
      console.log('[SMS] Invalid phone number:', to);
      return false;
    }
    const client = getClient();
    const result = await client.messages.create({
      body: message,
      from: FROM_NUMBER,
      to: cleanTo
    });
    console.log('[SMS] Sent successfully to', cleanTo, '| SID:', result.sid);
    return true;
  } catch (err: any) {
    console.error('[SMS] Failed to send:', err.message);
    return false;
  }
}

export function buildPostCallSMS(opts: {
  callerName?: string;
  businessName: string;
  outcome: string;
  reason?: string;
  nextSteps?: string;
  phoneNumber: string;
}): string {
  const name = opts.callerName ? opts.callerName.split(' ')[0] : 'there';
  const biz = opts.businessName;
  const phone = opts.phoneNumber;

  switch (opts.outcome) {
    case 'appointment_booked':
      return `Hi ${name}! Your appointment at ${biz} is confirmed. We'll send a reminder before your visit. Questions? Call ${phone} or reply here.`;

    case 'lead_captured':
      return `Hi ${name}! Thanks for calling ${biz}. We've got your info and will follow up with you shortly. Can't wait? Call us at ${phone}.`;

    case 'callback_requested':
      return `Hi ${name}! You requested a callback from ${biz}. We'll call you back as soon as possible. Or reach us at ${phone}.`;

    case 'after_hours':
      return `Hi ${name}! Thanks for calling ${biz}. We're currently closed but will reach out first thing when we open. Or call ${phone} during business hours.`;

    case 'transferred':
      return `Hi ${name}! Thanks for calling ${biz}. Hope we got you sorted! Any other questions? Call ${phone} or reply here.`;

    case 'resolved':
      return `Hi ${name}! Thanks for calling ${biz}. Glad we could help! Feel free to reach out anytime at ${phone}.`;

    case 'voicemail':
      return `Hi ${name}! You called ${biz} — we missed you! We'll get back to you soon, or call us at ${phone}.`;

    default:
      return `Hi ${name}! Thanks for calling ${biz}. If you need anything else, reach us at ${phone} anytime.`;
  }
}

export function buildMissedCallSMS(opts: {
  businessName: string;
  phoneNumber: string;
}): string {
  return `Hi! We missed your call at ${opts.businessName}. How can we help? Reply here or call us back at ${opts.phoneNumber}.`;
}

export function buildReminderSMS(opts: {
  callerName?: string;
  businessName: string;
  appointmentTime: string;
  phoneNumber: string;
}): string {
  const name = opts.callerName ? opts.callerName.split(' ')[0] : 'there';
  return `Hi ${name}! Reminder: your appointment at ${opts.businessName} is tomorrow at ${opts.appointmentTime}. Reply CONFIRM to confirm or call ${opts.phoneNumber} to reschedule.`;
}

export default { sendSMS, buildPostCallSMS, buildMissedCallSMS, buildReminderSMS };
