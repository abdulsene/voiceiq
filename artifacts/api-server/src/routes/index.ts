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
router.use(apiRouter);

export default router;
