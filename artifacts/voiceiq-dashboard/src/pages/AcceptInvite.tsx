/**
 * Phase 3.17 — /invite/:token acceptance page.
 *
 * Replaces the Supabase magic-link flow. See migration 047 header
 * and api-server/src/routes/team.ts Phase 3.17 header for context.
 *
 * Contract:
 *   1. On mount, GET /api/invites/lookup/:token — this endpoint is
 *      SIDE-EFFECT FREE. Scanners (Microsoft Defender Safe Links,
 *      Google URL scanners) can hit it a hundred times on prefetch
 *      and no state changes. That is why Phase 3.17 exists.
 *   2. Render one of five states: form / expired / revoked /
 *      already_accepted / not_found / error. Each has a specific
 *      copy + affordance.
 *   3. On submit (POST /api/invites/accept), the auth user is
 *      created with the human's password + the user_businesses row
 *      is inserted atomically. That is when state actually changes.
 *
 * We deliberately do NOT auto-sign-in the user after acceptance —
 * we redirect to /login with a success flash so their first sign-in
 * exercises the same code path everyone else uses. Reduces the "why
 * is my session weird" bugs.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const API = window.location.origin + "/api";

const NAME_RE = /^[\p{L}'\-\s]+$/u;

type LookupState = "not_found" | "expired" | "revoked" | "already_accepted" | "ok";

type PageState =
  | { kind: "loading" }
  | { kind: "form"; invite: InviteDisplay }
  | { kind: "submitting"; invite: InviteDisplay }
  | { kind: "success" }
  | { kind: "unusable"; state: LookupState; message: string }
  | { kind: "error"; message: string };

interface InviteDisplay {
  email: string;
  role: string;
  business_name: string;
  inviter_name: string | null;
  expires_at: string;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  team_lead: "Team lead",
  agent_manager: "Agent manager",
  analyst: "Analyst",
  user: "Team member",
  readonly: "Read-only",
};

export default function AcceptInvite() {
  const [, navigate] = useLocation();
  const [, params] = useRoute<{ token: string }>("/invite/:token");
  const rawToken = params?.token || "";

  const [page, setPage] = useState<PageState>({ kind: "loading" });
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  // Frozen at mount: guard against re-renders re-firing the lookup.
  const lookupFiredRef = useRef(false);

  // GET is side-effect free. Scanner prefetch hits this too and
  // (correctly) mutates nothing.
  useEffect(() => {
    if (lookupFiredRef.current) return;
    lookupFiredRef.current = true;
    if (!rawToken) {
      setPage({ kind: "unusable", state: "not_found", message: "This invite link is missing a token." });
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${API}/invites/lookup/${encodeURIComponent(rawToken)}`);
        if (!res.ok) {
          setPage({ kind: "error", message: `Server error (HTTP ${res.status}). Please try again.` });
          return;
        }
        const data = (await res.json()) as {
          state: LookupState;
          invite: InviteDisplay | null;
        };
        if (data.state === "ok" && data.invite) {
          setPage({ kind: "form", invite: data.invite });
        } else {
          setPage({
            kind: "unusable",
            state: data.state,
            message: messageForUnusable(data.state),
          });
        }
      } catch (e) {
        setPage({ kind: "error", message: (e as Error).message || "Network error" });
      }
    })();
  }, [rawToken]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (page.kind !== "form") return;
    setFieldError(null);

    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    if (!trimmedFirst || trimmedFirst.length > 50 || !NAME_RE.test(trimmedFirst)) {
      setFieldError("First name is required (letters, hyphens, apostrophes, spaces; max 50 chars).");
      return;
    }
    if (!trimmedLast || trimmedLast.length > 50 || !NAME_RE.test(trimmedLast)) {
      setFieldError("Last name is required (letters, hyphens, apostrophes, spaces; max 50 chars).");
      return;
    }
    if (password.length < 8) {
      setFieldError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setFieldError("Passwords don't match.");
      return;
    }

    const invite = page.invite;
    setPage({ kind: "submitting", invite });
    try {
      const res = await fetch(`${API}/invites/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: rawToken,
          password,
          full_name: `${trimmedFirst} ${trimmedLast}`,
        }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        // The server may include a `state` field for the same
        // discriminator the lookup returns. If it flipped between
        // lookup and accept (e.g. someone else consumed the token,
        // or the owner revoked in the meantime), render the
        // appropriate unusable screen.
        if (body?.state && typeof body.state === "string") {
          setPage({
            kind: "unusable",
            state: body.state as LookupState,
            message: messageForUnusable(body.state as LookupState),
          });
          return;
        }
        setPage({ kind: "form", invite });
        setFieldError(body?.error || `Could not accept invite (HTTP ${res.status}).`);
        return;
      }
      setPage({ kind: "success" });
      // Short pause so the success screen registers, then send to
      // /login. We don't auto-sign-in — see the file header for why.
      setTimeout(() => navigate("/login?invited=1"), 1400);
    } catch (e) {
      setPage({ kind: "form", invite });
      setFieldError((e as Error).message || "Network error");
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
      <LandingNav />
      <div className="flex-1 flex items-center justify-center p-4">
        {page.kind === "loading" ? (
          <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md text-center">
            <Loader2 className="w-8 h-8 text-slate-400 animate-spin mx-auto mb-3" />
            <p className="text-sm text-slate-600">Loading your invite…</p>
          </div>
        ) : page.kind === "success" ? (
          <SuccessCard />
        ) : page.kind === "unusable" ? (
          <UnusableCard state={page.state} message={page.message} />
        ) : page.kind === "error" ? (
          <ErrorCard
            message={page.message}
            onRetry={() => {
              lookupFiredRef.current = false;
              setPage({ kind: "loading" });
            }}
          />
        ) : (
          <FormCard
            invite={page.invite}
            firstName={firstName}
            lastName={lastName}
            password={password}
            confirmPassword={confirmPassword}
            fieldError={fieldError}
            submitting={page.kind === "submitting"}
            onFirstName={setFirstName}
            onLastName={setLastName}
            onPassword={setPassword}
            onConfirmPassword={setConfirmPassword}
            onSubmit={handleSubmit}
          />
        )}
      </div>
      <LandingFooter />
    </div>
  );
}

function messageForUnusable(state: LookupState): string {
  switch (state) {
    case "expired":
      return "This invite has expired. Invites are valid for 7 days — ask whoever invited you to send a new one.";
    case "revoked":
      return "This invite was revoked. Ask whoever invited you to send a new one.";
    case "already_accepted":
      return "This invite has already been accepted. Try signing in — if you don't remember your password, use \"Forgot password\" on the login page.";
    case "not_found":
    default:
      return "This invite link is not valid. Double-check the URL, or ask whoever invited you to send a new one.";
  }
}

function FormCard(props: {
  invite: InviteDisplay;
  firstName: string;
  lastName: string;
  password: string;
  confirmPassword: string;
  fieldError: string | null;
  submitting: boolean;
  onFirstName: (v: string) => void;
  onLastName: (v: string) => void;
  onPassword: (v: string) => void;
  onConfirmPassword: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const {
    invite,
    firstName,
    lastName,
    password,
    confirmPassword,
    fieldError,
    submitting,
    onFirstName,
    onLastName,
    onPassword,
    onConfirmPassword,
    onSubmit,
  } = props;
  const roleLabel = ROLE_LABEL[invite.role] || invite.role;
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md w-full">
      <h1 className="text-xl font-bold text-slate-900 mb-2">Join {invite.business_name}</h1>
      <p className="text-sm text-slate-600 mb-6">
        {invite.inviter_name ? `${invite.inviter_name} invited you` : "You were invited"} to
        join <strong className="text-slate-900">{invite.business_name}</strong> on Neverr as{" "}
        <strong className="text-slate-900">{roleLabel}</strong>. Set a password to get started.
      </p>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="text-xs font-medium text-slate-700 mb-1 block">Email</label>
          <input
            type="email"
            value={invite.email}
            readOnly
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-700"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-700 mb-1 block">First name</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => onFirstName(e.target.value)}
              autoComplete="given-name"
              disabled={submitting}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-700 mb-1 block">Last name</label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => onLastName(e.target.value)}
              autoComplete="family-name"
              disabled={submitting}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
            />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-700 mb-1 block">Password (min 8 chars)</label>
          <input
            type="password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-slate-700 mb-1 block">Confirm password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => onConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
          />
        </div>

        {fieldError ? (
          <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-md p-2">
            {fieldError}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="w-full px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg text-sm font-semibold hover:bg-[#1e5a8f] disabled:opacity-60 inline-flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitting ? "Setting up…" : "Accept invite & set password"}
        </button>
      </form>
    </div>
  );
}

function SuccessCard() {
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md text-center">
      <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
        <CheckCircle2 className="w-8 h-8 text-emerald-600" />
      </div>
      <h1 className="text-xl font-bold text-slate-900 mb-2">Account created</h1>
      <p className="text-sm text-slate-600">Redirecting you to sign in…</p>
    </div>
  );
}

function UnusableCard({ state, message }: { state: LookupState; message: string }) {
  const isNotFound = state === "not_found";
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md text-center">
      <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3">
        <AlertTriangle className="w-8 h-8 text-amber-600" />
      </div>
      <h1 className="text-xl font-bold text-slate-900 mb-2">
        {state === "expired" && "Invite expired"}
        {state === "revoked" && "Invite revoked"}
        {state === "already_accepted" && "Already accepted"}
        {isNotFound && "Invite not found"}
      </h1>
      <p className="text-sm text-slate-600 mb-4">{message}</p>
      <a
        href="/login"
        className="inline-block px-4 py-2 bg-[#2E75B6] text-white rounded-lg text-sm font-semibold hover:bg-[#1e5a8f]"
      >
        Go to sign in
      </a>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md text-center">
      <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
        <AlertTriangle className="w-8 h-8 text-red-600" />
      </div>
      <h1 className="text-xl font-bold text-slate-900 mb-2">Couldn't load invite</h1>
      <p className="text-sm text-slate-600 mb-4">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-block px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-semibold hover:bg-slate-700"
      >
        Try again
      </button>
    </div>
  );
}
