import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || ""
  );
}

export async function getCallerMemory(opts: {
  businessId: string;
  callerPhone: string;
}): Promise<{
  isReturning: boolean;
  callerName?: string;
  totalCalls?: number;
  lastCallDate?: string;
  lastReason?: string;
  isVip?: boolean;
  greeting?: string;
} | null> {
  try {
    const phone = opts.callerPhone.replace(/[^\d+]/g, "");
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("caller_memory")
      .select("*")
      .eq("business_id", opts.businessId)
      .eq("caller_phone", phone)
      .single();

    if (error || !data) {
      return { isReturning: false };
    }

    const firstName = data.caller_name?.split(" ")[0] || "";
    const daysSinceLastCall = data.last_call_date
      ? Math.floor((Date.now() - new Date(data.last_call_date).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    let greeting = "";
    if (firstName) {
      if (daysSinceLastCall === 0) {
        greeting = `Welcome back ${firstName}! Good to hear from you again today.`;
      } else if (daysSinceLastCall === 1) {
        greeting = `Welcome back ${firstName}! Good to hear from you again.`;
      } else if (daysSinceLastCall <= 7) {
        greeting = `Welcome back ${firstName}! Great to hear from you again this week.`;
      } else if (daysSinceLastCall <= 30) {
        greeting = `Welcome back ${firstName}! It's been a little while — great to hear from you.`;
      } else {
        greeting = `Welcome back ${firstName}! Great to hear from you again.`;
      }

      if (data.last_reason) {
        greeting += ` Last time you called about ${data.last_reason.toLowerCase()}.`;
      }

      if (data.is_vip) {
        greeting = `${firstName}, wonderful to hear from you again!`;
      }
    }

    return {
      isReturning: true,
      callerName: data.caller_name,
      totalCalls: data.total_calls,
      lastCallDate: data.last_call_date,
      lastReason: data.last_reason,
      isVip: data.is_vip,
      greeting,
    };
  } catch (err: any) {
    console.error("[Memory] Lookup error:", err.message);
    return { isReturning: false };
  }
}

export async function updateCallerMemory(opts: {
  businessId: string;
  callerPhone: string;
  callerName?: string;
  reason?: string;
  outcome?: string;
  notes?: string;
}): Promise<void> {
  try {
    const phone = opts.callerPhone.replace(/[^\d+]/g, "");
    const supabase = getSupabase();

    const { data: existing } = await supabase
      .from("caller_memory")
      .select("id, total_calls")
      .eq("business_id", opts.businessId)
      .eq("caller_phone", phone)
      .single();

    if (existing) {
      await supabase
        .from("caller_memory")
        .update({
          caller_name: opts.callerName || undefined,
          last_call_date: new Date().toISOString(),
          last_reason: opts.reason || undefined,
          last_outcome: opts.outcome || undefined,
          total_calls: (existing.total_calls || 1) + 1,
          notes: opts.notes || undefined,
        })
        .eq("business_id", opts.businessId)
        .eq("caller_phone", phone);

      console.log("[Memory] Updated returning caller:", phone, "total calls:", (existing.total_calls || 1) + 1);
    } else {
      await supabase.from("caller_memory").insert({
        business_id: opts.businessId,
        caller_phone: phone,
        caller_name: opts.callerName,
        last_reason: opts.reason,
        last_outcome: opts.outcome,
        total_calls: 1,
        first_call_date: new Date().toISOString(),
        last_call_date: new Date().toISOString(),
      });

      console.log("[Memory] New caller saved:", phone);
    }
  } catch (err: any) {
    console.error("[Memory] Update error:", err.message);
  }
}

export async function setVipStatus(opts: {
  businessId: string;
  callerPhone: string;
  isVip: boolean;
}): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("caller_memory")
    .update({ is_vip: opts.isVip })
    .eq("business_id", opts.businessId)
    .eq("caller_phone", opts.callerPhone.replace(/[^\d+]/g, ""));
}

export default { getCallerMemory, updateCallerMemory, setVipStatus };
