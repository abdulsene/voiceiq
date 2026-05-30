import { createClient } from "@supabase/supabase-js";
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const start = new Date(Date.now()-86400000).toISOString();
const end = new Date().toISOString();
const { data, error, count } = await supa
  .from("calls")
  .select("id, business_id, created_at, duration_seconds, sentiment, call_outcome, follow_up_required, start_time", { count: 'exact' })
  .eq("business_id", "demo-business")
  .gte("created_at", start)
  .lte("created_at", end)
  .limit(5);
console.log("count:", count, "rows:", data?.length, "err:", error?.message);
console.log("sample:", JSON.stringify(data?.[0], null, 2));
