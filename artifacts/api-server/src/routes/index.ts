import { Router, type IRouter } from "express";
import healthRouter from "./health";
import apiRouter from "./api";
import authRouter from "./auth";
import stripeRouter from "./stripe";
import mfaRouter from "./mfa";
import widgetRouter from "./widget";
import enterpriseRouter from "./enterprise";
import adminRouter from "./admin";
import ssoRouter from "./sso";
import dashboardBuilderRouter from "./dashboard-builder";
import webhooksRouter from "./webhooks";
import industryRouter from "./industry-pages";
import industryCategoriesRouter from "./industry-categories";
import chatRouter from "./chat";
import chatTtsRouter from "./chat-tts";
import configRouter from "./config";
import promptRouter from "./prompt";
import voicesRouter from "./voices";
import transferRouter from "./transfer";
import leadsRouter from "./leads";
import leadCallsRouter from "./lead-calls";
import leadOutcomesRouter from "./lead-outcomes";
import publicLeadRouter from "./public-lead";
import twilioCallbacksRouter from "./twilio-callbacks";
import twilioSmsInboundRouter from "./twilio-sms-inbound";
import twilioSmsStatusRouter from "./twilio-sms-status";
import adminBusinessesRouter from "./admin-businesses";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(mfaRouter);
router.use(stripeRouter);
router.use(widgetRouter);
router.use("/enterprise", enterpriseRouter);
// Sprint 5 WorkOS Phase 2: SSO connection-management endpoints. Mounted
// under /sso (so handlers see /connection, /connection/:businessId).
// Importing routes/sso triggers lib/workos's boot-time env-var check by
// design — a deploy missing WORKOS_API_KEY/WORKOS_CLIENT_ID will fail
// fast at api-server boot rather than at the first SSO request.
router.use("/sso", ssoRouter);
// Mount specialised admin sub-routers BEFORE the catch-all admin router
// so their paths take precedence and don't get shadowed.
router.use("/admin/dashboard-builder", dashboardBuilderRouter);
router.use("/admin", webhooksRouter);
router.use("/admin", adminRouter);
// Phase 3h: register the category-navigation router BEFORE industry-pages
// so its specific paths (/industries/categories, /industries/category/:slug,
// /industries/:industry_id/preview) win over industry-pages's generic
// /industries/:industryCode wildcard.
router.use(industryCategoriesRouter);
router.use(industryRouter);
// Sprint 5 Alex Phase 1: AI chat. Mounted before apiRouter (the giant
// catch-all) so the chat handlers are reached first — although their
// /chat/conversation paths don't currently collide with anything in
// apiRouter, the explicit ordering is defensive against future drift.
// Importing routes/chat triggers lib/anthropic's boot-time env-var
// check (ANTHROPIC_API_KEY required) by design.
router.use(chatRouter);
// Sprint 5 Alex Voice Mode (Sunday): POST /api/chat/tts. Same auth
// model as the rest of /api/chat/* (anonymous, visitor-cookie identity
// not enforced for this stateless endpoint — see chat-tts.ts header).
// Mounted before apiRouter for the same defensive ordering as chatRouter.
// Importing routes/chat-tts triggers lib/elevenlabs-tts's boot-time
// ELEVENLABS_API_KEY check — by design.
router.use(chatTtsRouter);
// 2026-05-03 Calendly env-var swap: GET /api/config returns the runtime
// discovery_call_url so frontend pages can pick up a Calendly link
// without a rebuild (consumers fetch on mount). Mounted before
// apiRouter for the same defensive ordering as the other small
// public routes above. AUTH_BYPASS_PATTERNS in app.ts whitelists it.
router.use(configRouter);
// Sprint 3 Stage 4: prompt editing endpoints (/api/business/prompt*,
// /api/admin/business/:id/prompt*). Mounted BEFORE the catch-all
// apiRouter so /api/business/* paths are claimed by this router.
router.use(promptRouter);
// Sprint 3 Stage 5 Session 1 / Phase 2: voice picker endpoints
// (/api/voices/catalog, /api/voices/preview, /api/business/voice).
// Mounted BEFORE the catch-all apiRouter so /api/voices/* and the
// /api/business/voice path are claimed here.
router.use(voicesRouter);
// Operator-transfer endpoints (/api/business/transfer*,
// /api/admin/business/:id/transfer*). Mounted alongside prompt/voices —
// same Stage 6 customer+admin parity pattern. Mounted BEFORE the
// catch-all apiRouter so /api/business/transfer is claimed here.
router.use(transferRouter);
// Leads epic Slice 1: capture (public, Bearer-secret auth) + read
// endpoints (/api/business/leads*, /api/admin/business/:id/leads*).
// Mounted BEFORE the catch-all apiRouter so /api/business/leads is
// claimed here, not by the legacy /lead tool-call handler in api.ts.
router.use(leadsRouter);
// Slice 2A: lead-bridge initiation + status (customer + admin parity).
// Mounted before the catch-all so /api/business/leads/:id/call is
// claimed here, not by the legacy /lead handler in api.ts.
router.use(leadCallsRouter);
// Slice 3A pillar 1: outcome capture per lead-call.
//   POST /api/business/leads/:id/calls/:callSid/outcome
// Mounted alongside leadCallsRouter — both deal with the same
// business/lead/call resource tree.
router.use(leadOutcomesRouter);
// Slice 3A pillar 3: customer trust portal — public, no-auth.
//   GET  /api/public/lead/:token
//   POST /api/public/lead/:token/action
// Bypass-listed in app.ts; token is the credential.
router.use(publicLeadRouter);
// Slice 2A: Twilio-facing webhooks (recording-status, call-status,
// bridge TwiML) + public disclosure audio. All bypass-listed in
// app.ts via signature-verify or public-by-design (disclosure audio).
router.use(twilioCallbacksRouter);
// Slice 3A pillar 2: Twilio inbound SMS webhook for STOP / START /
// HELP handling. Already covered by the /^\/api\/twilio\// AUTH_BYPASS
// pattern; signature verification is enforced inside the handler.
router.use(twilioSmsInboundRouter);
// Slice 3A polish: Twilio SMS delivery-status webhook. Closes the
// async loop between Twilio's synchronous "queued" / "sent" response
// and the actual carrier delivery outcome (delivered / undelivered /
// failed). Without it sms_messages.status was stuck at 'sent' even
// when carriers ultimately rejected. Same AUTH_BYPASS pattern as
// the other twilio handlers; signature verification inside.
router.use(twilioSmsStatusRouter);
// Stage 6 Phase 1: admin override surface — list + drill-in + admin
// voice switch. Declares paths starting with /admin/business(es) at
// root so it doesn't collide with the catch-all adminRouter mounted
// at /admin above. Auth gated via requireStaffPermission("customers",
// ...) per the post-hotfix RBAC pattern (commit aaf14de).
router.use(adminBusinessesRouter);
router.use(apiRouter);

export default router;
