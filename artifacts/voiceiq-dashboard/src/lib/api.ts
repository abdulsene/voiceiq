const API_BASE = "/api";

// Exported so non-JSON consumers (e.g. AiSettingsPage's audio-blob
// preview fetch) can build the same Authorization + X-Active-Business
// headers without re-implementing the localStorage lookup. fetchApi
// below still wraps this transparently for JSON callers.
export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("neverr_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  // Phase 3e multi-business: tell the API which tenant the caller is
  // currently viewing. Backend middleware validates membership before
  // honoring this header — falls back to the user's oldest business if
  // it's missing or points to a tenant the caller doesn't belong to.
  const activeBiz = localStorage.getItem("neverr_active_business_id");
  if (activeBiz) headers["X-Active-Business"] = activeBiz;
  return headers;
}

// Exported so tenant-scoped pages/components can drop their hand-rolled
// fetch() calls and pick up Authorization + X-Active-Business headers
// automatically. Path is relative to /api (leading slash required).
export async function fetchApi(path: string, opts?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...getAuthHeaders(), ...opts?.headers },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function getRecentCalls(limit = 50, locationId?: string) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (locationId) params.set("location_id", locationId);
  return fetchApi(`/calls/recent?${params}`);
}

export async function getCallStats(locationId?: string) {
  const params = locationId ? `?location_id=${locationId}` : "";
  return fetchApi(`/calls/stats${params}`);
}

export async function getActionItems() {
  return fetchApi("/action-items");
}

export async function getAppointments(locationId?: string) {
  const params = locationId ? `?location_id=${locationId}` : "";
  return fetchApi(`/appointments${params}`);
}

export async function getContacts(opts?: { search?: string; filter?: string; page?: number; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.search) params.set("search", opts.search);
  if (opts?.filter) params.set("filter", opts.filter);
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.limit) params.set("limit", String(opts.limit));
  const q = params.toString();
  return fetchApi(`/contacts${q ? `?${q}` : ""}`);
}

export async function getCallerHistory(phone: string) {
  return fetchApi(`/memory/history?caller_phone=${encodeURIComponent(phone)}`);
}

export async function getCampaigns() {
  return fetchApi("/sms/campaigns");
}

export async function getSmsTemplates() {
  return fetchApi("/sms/templates");
}

export async function getSmsRecipients(audience: string) {
  return fetchApi(`/sms/recipients?audience=${audience}`);
}

export async function getSmsUsageCheck(count: number, segments: number = 1) {
  return fetchApi(`/sms/usage-check?count=${count * segments}`);
}

export async function getSmsOptOuts() {
  return fetchApi("/sms/opt-outs");
}

export async function getSmsReplies() {
  return fetchApi("/sms/replies");
}

export async function getBusinessConfig() {
  return fetchApi("/business/configure");
}

export async function saveBusinessConfig(config: any) {
  return fetchApi("/business/configure", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export async function sendSms(to: string, message: string) {
  return fetchApi("/sms/test", {
    method: "POST",
    body: JSON.stringify({ to, message }),
  });
}

export async function sendCampaign(data: any) {
  return fetchApi("/sms/campaign", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function saveSmsTemplate(data: any) {
  return fetchApi("/sms/template", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function setVipStatus(phone: string, isVip: boolean) {
  return fetchApi("/memory/vip", {
    method: "POST",
    body: JSON.stringify({ caller_phone: phone, is_vip: isVip }),
  });
}

export async function callOutbound(phone: string) {
  return fetchApi("/call/outbound", {
    method: "POST",
    body: JSON.stringify({ phone_number: phone }),
  });
}

export async function updateContactNotes(phone: string, notes: string) {
  return fetchApi("/memory/update", {
    method: "POST",
    body: JSON.stringify({ caller_phone: phone, notes }),
  });
}

export async function getCalendarAvailability(provider: string = "google") {
  return fetchApi(`/calendar/availability?provider=${provider}`);
}

export async function bookAppointment(data: {
  caller_name: string;
  caller_phone: string;
  appointment_datetime: string;
  reason: string;
  calendar_provider: string;
}) {
  return fetchApi("/calendar/book", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getUsage(businessId: string) {
  return fetchApi(`/usage/${businessId}`);
}

export async function getIndustries() {
  return fetchApi("/onboard/industries");
}

export async function getIndustryTemplate(industryId: string) {
  return fetchApi(`/onboard/template/${industryId}`);
}

export async function launchOnboard(data: any) {
  return fetchApi("/onboard", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getAnalytics(start: string, end: string, locationId?: string) {
  const params = new URLSearchParams({ start, end });
  if (locationId) params.set("location_id", locationId);
  return fetchApi(`/analytics?${params}`);
}

export async function getSmsConversations() {
  return fetchApi("/sms/conversations");
}

export async function getSmsThread(phone: string) {
  return fetchApi(`/sms/conversations/${encodeURIComponent(phone)}`);
}

export async function getSmsUnreadCount() {
  return fetchApi("/sms/unread-count");
}

export async function sendSmsReply(to: string, message: string) {
  return fetchApi("/sms/send", {
    method: "POST",
    body: JSON.stringify({ to, message }),
  });
}

export async function getSmsSequences() {
  return fetchApi("/sms/sequences");
}

export async function createSmsSequence(data: any) {
  return fetchApi("/sms/sequences", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateSmsSequence(id: string, data: any) {
  return fetchApi(`/sms/sequences/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteSmsSequence(id: string) {
  return fetchApi(`/sms/sequences/${id}`, {
    method: "DELETE",
  });
}

export async function getLocations() {
  return fetchApi("/locations");
}

export async function createLocation(data: any) {
  return fetchApi("/locations", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateLocation(id: string, data: any) {
  return fetchApi(`/locations/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteLocation(id: string) {
  return fetchApi(`/locations/${id}`, {
    method: "DELETE",
  });
}

export async function getLocationStats() {
  return fetchApi("/locations/stats");
}

export async function getSurveyFollowups(businessId: string) {
  return fetchApi(`/surveys/${businessId}/needs-followup`);
}

export async function getCompetitors() {
  return fetchApi("/competitors");
}

export async function createCompetitor(data: { competitor_name: string; competitor_response: string }) {
  return fetchApi("/competitors", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateCompetitor(id: string, data: { competitor_name?: string; competitor_response?: string }) {
  return fetchApi(`/competitors/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteCompetitor(id: string) {
  return fetchApi(`/competitors/${id}`, {
    method: "DELETE",
  });
}

export async function getProfiles(opts?: { filter?: string; sort?: string; page?: number; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.filter) params.set("filter", opts.filter);
  if (opts?.sort) params.set("sort", opts.sort);
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.limit) params.set("limit", String(opts.limit));
  const q = params.toString();
  return fetchApi(`/profiles${q ? `?${q}` : ""}`);
}

export async function getProfile(phone: string) {
  return fetchApi(`/profiles/${encodeURIComponent(phone)}`);
}

export async function updateProfile(phone: string, data: { ai_notes?: string; is_vip?: boolean; do_not_contact?: boolean }) {
  return fetchApi(`/profiles/${encodeURIComponent(phone)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function getRecoveryCampaigns() {
  return fetchApi("/recovery/campaigns");
}

export async function createRecoveryCampaign(data: { name: string; message_template: string; dormant_days: number; target_segment: string; send_time: string; max_per_day: number }) {
  return fetchApi("/recovery/campaigns", { method: "POST", body: JSON.stringify(data) });
}

export async function updateRecoveryCampaign(id: string, data: Record<string, any>) {
  return fetchApi(`/recovery/campaigns/${id}`, { method: "PUT", body: JSON.stringify(data) });
}

export async function deleteRecoveryCampaign(id: string) {
  return fetchApi(`/recovery/campaigns/${id}`, { method: "DELETE" });
}

export async function launchRecoveryCampaign(id: string) {
  return fetchApi(`/recovery/campaigns/${id}/launch`, { method: "POST" });
}

export async function getRecoveryContacts(campaignId: string) {
  return fetchApi(`/recovery/campaigns/${campaignId}/contacts`);
}

export async function getRecoveryEstimate(dormant_days: number, segment: string) {
  return fetchApi(`/recovery/estimate?dormant_days=${dormant_days}&segment=${segment}`);
}

export async function getBenchmarkReport(period?: string) {
  const params = period ? `?period=${period}` : "";
  return fetchApi(`/benchmarks${params}`);
}

export async function getBenchmarkHistory() {
  return fetchApi("/benchmarks/history");
}

export async function generateBenchmarks(period?: string) {
  return fetchApi("/benchmarks/generate", { method: "POST", body: JSON.stringify({ period }) });
}

export async function getCoachingForCall(callSid: string) {
  return fetchApi(`/coaching/call/${encodeURIComponent(callSid)}`);
}

export async function getCoachingSessions() {
  return fetchApi("/coaching/sessions");
}

export async function getCulturalStats() {
  return fetchApi("/cultural/stats");
}

export async function getCulturalProfiles() {
  return fetchApi("/cultural/profiles");
}
