import { Router, type IRouter, type Request, type Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middlewares/auth";
import {
  ensureWidgetTables,
  getWidgetConfig,
  upsertWidgetConfig,
  recordWidgetEvent,
  getWidgetAnalytics,
  planQualifies,
} from "../widget";
import { sendSMS } from "../sms";

const router: IRouter = Router();

ensureWidgetTables();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function getBusiness(businessId: string) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from("business_configs")
    .select("business_id, business_name, agent_id, agent_name, plan_id, notification_phone")
    .eq("business_id", businessId)
    .single();
  return data;
}

router.get("/widget/config", async (req: Request, res: Response) => {
  const businessId = String(req.query.businessId || "");
  if (!businessId) {
    res.status(400).json({ error: "businessId required" });
    return;
  }

  // Phase 3d: detect ephemeral demo agent IDs and route to preview_demos table
  if (businessId.startsWith("demo_")) {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database unavailable" });
      return;
    }

    const { data: demo, error } = await supabase
      .from("preview_demos")
      .select("demo_business_id, demo_agent_id, business_name, industry, expires_at, deleted_at")
      .eq("demo_business_id", businessId)
      .maybeSingle();

    if (error || !demo) {
      res.status(404).json({ error: "Demo not found" });
      return;
    }

    if (demo.deleted_at) {
      res.status(410).json({ error: "Demo has been deleted" });
      return;
    }

    if (new Date(demo.expires_at).getTime() < Date.now()) {
      res.status(410).json({ error: "Demo has expired" });
      return;
    }

    if (!demo.demo_agent_id) {
      res.status(400).json({ error: "Demo agent not ready" });
      return;
    }

    // Bump call_count for analytics (fire-and-forget — won't block response)
    supabase
      .from("preview_demos")
      .select("call_count")
      .eq("demo_business_id", businessId)
      .single()
      .then(({ data }) => {
        if (data) {
          return supabase
            .from("preview_demos")
            .update({ call_count: (data.call_count || 0) + 1 })
            .eq("demo_business_id", businessId);
        }
      })
      .then(() => {})
      .catch((e: any) => console.warn("[Widget] Demo call_count update failed:", e.message));

    res.json({
      businessId: demo.demo_business_id,
      businessName: demo.business_name,
      agentId: demo.demo_agent_id,
      agentName: "AI Receptionist",
      color: "#2E75B6",
      position: "bottom-right",
      delaySeconds: 0,
      greeting: `Hi! I'm a live preview of your ${demo.industry} AI receptionist for ${demo.business_name}. Ask me anything!`,
      isDemo: true,
    });
    return;
  }

  const [biz, cfg] = await Promise.all([getBusiness(businessId), getWidgetConfig(businessId)]);
  if (!biz) {
    res.status(404).json({ error: "Business not found" });
    return;
  }
  const eligible = planQualifies(biz.plan_id) || cfg?.addon_purchased === true;
  if (!eligible || cfg?.enabled === false) {
    res.status(403).json({ error: "Widget not enabled for this business" });
    return;
  }
  if (!biz.agent_id) {
    res.status(400).json({ error: "Business has no AI agent configured" });
    return;
  }
  res.json({
    businessId,
    businessName: biz.business_name,
    agentId: biz.agent_id,
    agentName: biz.agent_name || "AI Assistant",
    color: cfg?.color || "#2E75B6",
    position: cfg?.position || "bottom-right",
    delaySeconds: cfg?.delay_seconds ?? 3,
    greeting:
      cfg?.greeting ||
      `Hi! I'm ${biz.agent_name || "the AI assistant"} from ${biz.business_name}. How can I help you today?`,
  });
});

router.post("/widget/config", requireAuth, async (req: Request, res: Response) => {
  const businessId = req.businessId || "";
  if (!businessId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { color, greeting, position, enabled, delay_seconds, agent_name } = req.body || {};
  const updated = await upsertWidgetConfig(businessId, {
    color,
    greeting,
    position,
    enabled,
    delay_seconds,
    agent_name,
  });
  res.json({ success: true, config: updated });
});

router.get("/widget/status", requireAuth, async (req: Request, res: Response) => {
  const businessId = req.businessId || "";
  const [biz, cfg] = await Promise.all([getBusiness(businessId), getWidgetConfig(businessId)]);
  const eligibleByPlan = planQualifies(biz?.plan_id);
  const addonPurchased = cfg?.addon_purchased === true;
  res.json({
    eligibleByPlan,
    addonPurchased,
    enabled: cfg?.enabled !== false,
    config: cfg,
    planId: biz?.plan_id || null,
  });
});

router.post("/widget/event", async (req: Request, res: Response) => {
  const {
    business_id,
    event_type,
    page_url,
    conversation_id,
    duration_seconds,
    lead_name,
    lead_phone,
    topic,
    booking_made,
    metadata,
  } = req.body || {};
  if (!business_id || !event_type) {
    res.status(400).json({ error: "business_id and event_type required" });
    return;
  }
  await recordWidgetEvent({
    business_id,
    event_type,
    page_url,
    conversation_id,
    duration_seconds,
    lead_name,
    lead_phone,
    topic,
    booking_made,
    metadata,
  });

  if (event_type === "lead_captured" && lead_phone) {
    const biz = await getBusiness(business_id);
    if (biz?.notification_phone) {
      const summary = topic ? ` They asked about: ${topic}.` : "";
      const msg = `Website visitor just talked to your AI! Name: ${lead_name || "Unknown"}, Phone: ${lead_phone}.${summary} Follow up now! - Neverr`;
      sendSMS(biz.notification_phone, msg).catch((err) =>
        console.error("[Widget] Lead SMS failed:", err.message)
      );
    }
  }

  res.json({ success: true });
});

router.get("/widget/analytics/:businessId", requireAuth, async (req: Request, res: Response) => {
  const businessId = req.businessId || "";
  if (req.params.businessId !== businessId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const days = Number(req.query.days) || 30;
  const stats = await getWidgetAnalytics(businessId, days);
  res.json(stats);
});

export default router;

export function widgetScriptHandler(req: Request, res: Response) {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const apiBase = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`;
  res.send(buildWidgetScript(apiBase));
}

function buildWidgetScript(apiBase: string): string {
  return `(function(){
  var script = document.currentScript || (function(){var s=document.getElementsByTagName('script');return s[s.length-1];})();
  var businessId = script && script.getAttribute('data-business');
  var colorOverride = script && script.getAttribute('data-color');
  if (!businessId) { console.warn('[Neverr Widget] data-business attribute required'); return; }
  var API = ${JSON.stringify(apiBase)};

  function send(event, extra){
    try {
      navigator.sendBeacon
        ? navigator.sendBeacon(API + '/api/widget/event', new Blob([JSON.stringify(Object.assign({business_id:businessId,event_type:event,page_url:location.href},extra||{}))],{type:'application/json'}))
        : fetch(API + '/api/widget/event', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({business_id:businessId,event_type:event,page_url:location.href},extra||{})),keepalive:true});
    } catch(e) {}
  }

  fetch(API + '/api/widget/config?businessId=' + encodeURIComponent(businessId))
    .then(function(r){ if(!r.ok) throw new Error('config'); return r.json(); })
    .then(function(cfg){
      var color = colorOverride || cfg.color || '#2E75B6';
      var position = cfg.position || 'bottom-right';
      var delay = (cfg.delaySeconds || 0) * 1000;

      var style = document.createElement('style');
      style.textContent = [
        '#neverr-widget{position:fixed;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;'+(position==='bottom-left'?'left:24px;':'right:24px;')+'bottom:24px;}',
        '#neverr-trigger{width:64px;height:64px;border-radius:50%;background:#1B2537;color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(27,37,55,.4);position:relative;}',
        '#neverr-trigger::before,#neverr-trigger::after{content:"";position:absolute;inset:0;border-radius:50%;background:'+color+';animation:nvr-pulse 2s cubic-bezier(0,0,.2,1) infinite;z-index:-1;}',
        '#neverr-trigger::after{animation-delay:1s;}',
        '@keyframes nvr-pulse{0%{transform:scale(1);opacity:.6;}80%,100%{transform:scale(1.6);opacity:0;}}',
        '#neverr-panel{width:340px;max-width:calc(100vw - 32px);background:#fff;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;display:flex;flex-direction:column;max-height:80vh;border:1px solid #e5e7eb;animation:nvr-fade .22s ease-out;}',
        '@keyframes nvr-fade{from{opacity:0;transform:translateY(12px) scale(.96);}to{opacity:1;transform:none;}}',
        '.nvr-header{background:linear-gradient(135deg,#1B2537,#0f1825);padding:14px;display:flex;align-items:center;justify-content:space-between;color:#fff;}',
        '.nvr-header b{font-size:14px;display:block;}',
        '.nvr-header span{font-size:11px;color:#cbd5e1;}',
        '.nvr-close{background:transparent;border:none;color:#fff;font-size:22px;cursor:pointer;padding:0 6px;line-height:1;}',
        '.nvr-body{padding:16px;text-align:center;background:linear-gradient(to bottom,#f9fafb,#fff);border-bottom:1px solid #f3f4f6;}',
        '.nvr-avatar{width:72px;height:72px;border-radius:50%;background:radial-gradient(circle at 30% 30%,'+color+',#1B2537);margin:0 auto 10px;box-shadow:0 8px 24px rgba(46,117,182,.3);animation:nvr-blob 6s ease-in-out infinite;}',
        '@keyframes nvr-blob{0%,100%{border-radius:50%;}33%{border-radius:45% 55% 50% 50%;}66%{border-radius:55% 45% 50% 50%;}}',
        '.nvr-status{font-size:12px;color:#6b7280;margin-top:4px;}',
        '.nvr-name{font-size:14px;font-weight:700;color:#1B2537;}',
        '.nvr-slot{padding:10px;}',
        '.nvr-foot{padding:10px;text-align:center;font-size:10px;color:#9ca3af;background:#f9fafb;}',
        '.nvr-lead{padding:14px;background:#fff7ed;border-top:1px solid #fde68a;}',
        '.nvr-lead h4{margin:0 0 8px;font-size:13px;color:#92400e;}',
        '.nvr-lead input{width:100%;padding:8px 10px;border:1px solid #fcd34d;border-radius:8px;font-size:13px;margin-bottom:6px;box-sizing:border-box;}',
        '.nvr-lead button{width:100%;padding:8px;background:#1B2537;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;}'
      ].join('');
      document.head.appendChild(style);

      var root = document.createElement('div');
      root.id = 'neverr-widget';
      root.innerHTML =
        '<button id="neverr-trigger" aria-label="Talk to AI">'+
          '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'+
        '</button>'+
        '<div id="neverr-panel" hidden>'+
          '<div class="nvr-header"><div><b>'+escapeHtml(cfg.agentName)+'</b><span>from '+escapeHtml(cfg.businessName)+'</span></div><button class="nvr-close" aria-label="Close">×</button></div>'+
          '<div class="nvr-body"><div class="nvr-avatar"></div><div class="nvr-name">'+escapeHtml(cfg.agentName)+'</div><div class="nvr-status">'+escapeHtml(cfg.greeting)+'</div></div>'+
          '<div class="nvr-slot" id="nvr-slot"></div>'+
          '<div class="nvr-lead" id="nvr-lead" hidden><h4>Before you go — leave us your details so we can follow up.</h4><input id="nvr-name" placeholder="Your name" /><input id="nvr-phone" placeholder="Phone number" type="tel" /><button id="nvr-send">Send</button></div>'+
          '<div class="nvr-foot">Powered by Neverr AI</div>'+
        '</div>';
      document.body.appendChild(root);

      var trigger = root.querySelector('#neverr-trigger');
      var panel = root.querySelector('#neverr-panel');
      var slot = root.querySelector('#nvr-slot');
      var lead = root.querySelector('#nvr-lead');
      var conversationStart = 0;
      var convId = null;
      var hasBooking = false;
      var hasLead = false;

      function loadConvai(){
        if (window.customElements && window.customElements.get('elevenlabs-convai')) return Promise.resolve();
        return new Promise(function(resolve){
          var s = document.createElement('script'); s.src = 'https://unpkg.com/@elevenlabs/convai-widget-embed'; s.async = true; s.onload = resolve; document.head.appendChild(s);
        });
      }

      function open(){
        panel.hidden = false; trigger.style.display='none';
        send('open');
        loadConvai().then(function(){
          slot.innerHTML='';
          var el = document.createElement('elevenlabs-convai');
          el.setAttribute('agent-id', cfg.agentId);
          slot.appendChild(el);
          conversationStart = Date.now();
          convId = 'wid_' + Math.random().toString(36).slice(2);
          send('conversation_start', {conversation_id: convId});
        });
      }
      function close(){
        var dur = conversationStart ? Math.round((Date.now()-conversationStart)/1000) : 0;
        if (conversationStart) send('conversation_end', {conversation_id: convId, duration_seconds: dur, booking_made: hasBooking});
        if (conversationStart && !hasBooking && !hasLead && dur > 8) {
          lead.hidden = false;
          return;
        }
        panel.hidden = true; trigger.style.display=''; conversationStart=0; hasBooking=false; hasLead=false; lead.hidden=true; slot.innerHTML='';
      }
      function submitLead(){
        var name = root.querySelector('#nvr-name').value.trim();
        var phone = root.querySelector('#nvr-phone').value.trim();
        if (!phone) return;
        hasLead = true;
        send('lead_captured', {conversation_id: convId, lead_name: name, lead_phone: phone});
        lead.innerHTML = '<p style="margin:0;color:#065f46;font-size:13px;">Thanks! We will be in touch shortly.</p>';
        setTimeout(function(){ panel.hidden=true; trigger.style.display=''; conversationStart=0; lead.hidden=true; slot.innerHTML=''; lead.innerHTML=''; }, 1500);
      }

      trigger.addEventListener('click', open);
      root.querySelector('.nvr-close').addEventListener('click', close);
      root.querySelector('#nvr-send').addEventListener('click', submitLead);

      if (delay > 0) {
        // delay only affects the launcher pulse animation kicking in; trigger is already visible
      }

      function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
    })
    .catch(function(err){ console.warn('[Neverr Widget] Could not load config:', err.message); });

  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
})();`;
}
