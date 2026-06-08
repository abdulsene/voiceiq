/**
 * Unit tests for src/lib/elevenlabs-agent.ts.
 *
 * Covers:
 *   - Input validation (agentId regex, language enum, prompt length).
 *   - Mocked PATCH success → returns { ok: true, charsWritten }.
 *   - Mocked PATCH 404 → returns { ok: false, error includes 'not found' }.
 *   - Mocked PATCH 200 + verify-after-write mismatch → returns
 *     { ok: false, stage: 'verify' } with both expected/actual lengths.
 *
 * All network calls are stubbed via vi.stubGlobal('fetch', mock).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// TODO(2026): updateAgentVoice/fetchAgentVoice (Session 1) lack direct
// unit tests — they're covered only indirectly via routes/voices.test.ts
// mocking the helpers. Add direct coverage when next touching this file.

import {
  updateAgentPrompt,
  fetchAgentPrompt,
  updateAgentFirstMessage,
  fetchAgentFirstMessage,
} from "./elevenlabs-agent";

// ───────────────────────────────────────────────────────────────────────
// Shared setup

beforeEach(() => {
  // ELEVENLABS_API_KEY must be present for the lib's getApiKey() to
  // not throw at request time. Stub value doesn't get checked beyond
  // truthiness in any test below.
  vi.stubEnv("ELEVENLABS_API_KEY", "stub_api_key_for_tests");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────
// Input validation

describe("Input validation", () => {
  test("agentId regex rejects malformed id (hyphen separator)", async () => {
    const result = await updateAgentPrompt("agent-bad-format", "en", "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid agentId/);
      expect(result.httpStatus).toBeNull();
      expect(result.stage).toBe("patch");
    }
  });

  test("agentId regex rejects empty suffix (agent_ alone)", async () => {
    const result = await updateAgentPrompt("agent_", "en", "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid agentId/);
    }
  });

  test("agentId regex rejects non-string", async () => {
    // Force a non-string at runtime to exercise the typeof check.
    const result = await updateAgentPrompt(123 as unknown as string, "en", "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid agentId/);
    }
  });

  test("language validation rejects 'de'", async () => {
    const result = await updateAgentPrompt("agent_abc123def456", "de", "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid language/);
    }
  });

  test("language validation rejects 'jp'", async () => {
    const result = await updateAgentPrompt("agent_abc123def456", "jp", "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid language/);
    }
  });

  test("prompt validation rejects empty string", async () => {
    const result = await updateAgentPrompt("agent_abc123def456", "en", "");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid prompt/);
    }
  });

  test("prompt validation rejects oversized (> 50000 chars)", async () => {
    const oversized = "x".repeat(50_001);
    const result = await updateAgentPrompt("agent_abc123def456", "en", oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/exceeds maximum length/);
      expect(result.error).toContain("50001");
    }
  });

  test("fetchAgentPrompt rejects bad language symmetrically", async () => {
    const result = await fetchAgentPrompt("agent_abc123def456", "zh");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid language/);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// Mocked PATCH path

describe("Mocked PATCH path", () => {
  test("happy path returns { ok: true, charsWritten: N }", async () => {
    const promptText = "You are a helpful AI receptionist for EZ Rentals.";

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // GET (verify): return the same prompt we sent at the EN path.
      return new Response(
        JSON.stringify({
          name: "Neverr - EZ Rentals",
          conversation_config: { agent: { prompt: { prompt: promptText } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateAgentPrompt("agent_abc123def456", "en", promptText);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentId).toBe("agent_abc123def456");
      expect(result.language).toBe("en");
      expect(result.charsWritten).toBe(promptText.length);
      expect(result.verifiedAt).toBeInstanceOf(Date);
    }
    // PATCH + GET = 2 fetch calls
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("FR language path writes to language_presets.fr", async () => {
    const promptText = "Vous êtes une réceptionniste IA pour EZ Rentals.";
    let patchedBody: unknown = null;

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchedBody = init.body ? JSON.parse(String(init.body)) : null;
        return new Response("{}", { status: 200 });
      }
      // GET (verify): return the prompt at the FR path.
      return new Response(
        JSON.stringify({
          name: "Neverr - EZ Rentals",
          conversation_config: {
            language_presets: {
              fr: { overrides: { agent: { prompt: { prompt: promptText } } } },
            },
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateAgentPrompt("agent_abc123def456", "fr", promptText);

    expect(result.ok).toBe(true);
    expect(patchedBody).toEqual({
      conversation_config: {
        language_presets: {
          fr: {
            overrides: {
              agent: { prompt: { prompt: promptText } },
            },
          },
        },
      },
    });
  });

  test("PATCH 404 returns { ok: false, error includes 'not found' }", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Agent not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateAgentPrompt("agent_abc123def456", "en", "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
      expect(result.httpStatus).toBe(404);
      expect(result.stage).toBe("patch");
    }
    // 404 short-circuits without retry — exactly 1 fetch call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("PATCH 200 + verify mismatch returns { ok: false, stage: 'verify' }", async () => {
    const sent = "We sent THIS prompt with specific wording.";
    const actuallyReturned = "But ElevenLabs persisted something subtly different.";

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "Neverr - test",
          conversation_config: { agent: { prompt: { prompt: actuallyReturned } } },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateAgentPrompt("agent_abc123def456", "en", sent);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("verify");
      expect(result.error).toMatch(/mismatch/i);
      expect(result.error).toContain(`sent ${sent.length}`);
      expect(result.error).toContain(`returned ${actuallyReturned.length}`);
      expect(result.httpStatus).toBeNull();
    }
  });

  test("PATCH 401 returns { ok: false, httpStatus: 401 } with auth-specific message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateAgentPrompt("agent_abc123def456", "en", "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ELEVENLABS_API_KEY/);
      expect(result.httpStatus).toBe(401);
      expect(result.stage).toBe("patch");
    }
  });

  test("PATCH 429 retries once after 2s, then fails if still rate-limited", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Too many", { status: 429 }))
      .mockResolvedValueOnce(new Response("Still too many", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = updateAgentPrompt("agent_abc123def456", "en", "hello");
    // Advance through the 2s retry delay so the second attempt fires.
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await pending;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/after retry/);
      expect(result.httpStatus).toBe(429);
      expect(result.stage).toBe("patch");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Mocked GET (fetchAgentPrompt)

describe("Mocked fetchAgentPrompt", () => {
  test("returns prompt for EN agent", async () => {
    const promptText = "EN system prompt.";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: "Test",
            conversation_config: { agent: { prompt: { prompt: promptText } } },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await fetchAgentPrompt("agent_abc123def456", "en");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toBe(promptText);
      expect(result.agentName).toBe("Test");
    }
  });

  test("returns prompt: null when FR path is missing on the agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: "EN-only agent",
            conversation_config: { agent: { prompt: { prompt: "EN content" } } },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await fetchAgentPrompt("agent_abc123def456", "fr");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toBeNull();
      expect(result.agentName).toBe("EN-only agent");
    }
  });

  test("404 returns { ok: false, httpStatus: 404 }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    );

    const result = await fetchAgentPrompt("agent_abc123def456", "en");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(404);
      expect(result.error).toMatch(/not found/i);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// First-message helpers (Sprint 4)

describe("updateAgentFirstMessage — input validation", () => {
  test("rejects malformed agentId", async () => {
    const result = await updateAgentFirstMessage("agent-bad", "hi");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid agentId/);
      expect(result.httpStatus).toBeNull();
      expect(result.stage).toBe("patch");
    }
  });

  test("rejects empty firstMessage", async () => {
    const result = await updateAgentFirstMessage("agent_abc123def456", "");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid firstMessage/);
    }
  });

  test("rejects oversized firstMessage (> 2000 chars)", async () => {
    const oversized = "x".repeat(2_001);
    const result = await updateAgentFirstMessage("agent_abc123def456", oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/exceeds maximum length/);
      expect(result.error).toContain("2001");
    }
  });
});

describe("updateAgentFirstMessage — mocked PATCH path", () => {
  test("happy path returns { ok: true, firstMessage } and PATCHes the agent.first_message field", async () => {
    const greeting =
      "Thank you for calling EZ Rentals. This call may be recorded for quality and training purposes. How can I help you today?";
    let patchedBody: unknown = null;

    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchedBody = init.body ? JSON.parse(String(init.body)) : null;
          return new Response("{}", { status: 200 });
        }
        // GET (verify): return the same first_message we sent.
        return new Response(
          JSON.stringify({
            name: "Neverr - EZ Rentals",
            conversation_config: { agent: { first_message: greeting } },
          }),
          { status: 200 },
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateAgentFirstMessage(
      "agent_abc123def456",
      greeting,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentId).toBe("agent_abc123def456");
      expect(result.firstMessage).toBe(greeting);
      expect(result.verifiedAt).toBeInstanceOf(Date);
    }
    expect(patchedBody).toEqual({
      conversation_config: { agent: { first_message: greeting } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("PATCH 404 returns { ok: false, stage: 'patch', httpStatus: 404 }", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Agent not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateAgentFirstMessage(
      "agent_abc123def456",
      "Hello.",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
      expect(result.httpStatus).toBe(404);
      expect(result.stage).toBe("patch");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("PATCH 200 + verify mismatch returns { ok: false, stage: 'verify' }", async () => {
    const sent = "What we sent — exact wording.";
    const actuallyReturned = "What ElevenLabs persisted — slightly different.";

    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return new Response("{}", { status: 200 });
        }
        return new Response(
          JSON.stringify({
            name: "Test",
            conversation_config: {
              agent: { first_message: actuallyReturned },
            },
          }),
          { status: 200 },
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateAgentFirstMessage(
      "agent_abc123def456",
      sent,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("verify");
      expect(result.error).toMatch(/mismatch/i);
      expect(result.error).toContain(`sent ${sent.length}`);
      expect(result.error).toContain(`returned ${actuallyReturned.length}`);
      expect(result.httpStatus).toBeNull();
    }
  });

  test("PATCH 429 retries once after 2s, then fails if still rate-limited", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Too many", { status: 429 }))
      .mockResolvedValueOnce(new Response("Still too many", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = updateAgentFirstMessage(
      "agent_abc123def456",
      "Hello.",
    );
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await pending;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/after retry/);
      expect(result.httpStatus).toBe(429);
      expect(result.stage).toBe("patch");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("PATCH 500 retries once after 2s, then succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const greeting = "Recovered greeting.";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Server error", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "Test",
            conversation_config: { agent: { first_message: greeting } },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = updateAgentFirstMessage("agent_abc123def456", greeting);
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await pending;
    vi.useRealTimers();

    expect(result.ok).toBe(true);
    // 1 failed PATCH + 1 successful PATCH + 1 verify GET = 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("fetchAgentFirstMessage", () => {
  test("returns the first_message string when the agent has one set", async () => {
    const greeting = "Thank you for calling Acme. ...";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: "Neverr - Acme",
            conversation_config: { agent: { first_message: greeting } },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await fetchAgentFirstMessage("agent_abc123def456");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.firstMessage).toBe(greeting);
      expect(result.agentName).toBe("Neverr - Acme");
    }
  });

  test("returns firstMessage: null when the agent has no first_message set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: "Bare agent",
            conversation_config: { agent: {} },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await fetchAgentFirstMessage("agent_abc123def456");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.firstMessage).toBeNull();
      expect(result.agentName).toBe("Bare agent");
    }
  });

  test("404 returns { ok: false, httpStatus: 404 }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    );

    const result = await fetchAgentFirstMessage("agent_abc123def456");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(404);
      expect(result.error).toMatch(/not found/i);
    }
  });

  test("network error returns { ok: false, error: 'Network error: …' }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    const result = await fetchAgentFirstMessage("agent_abc123def456");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Network error/);
      expect(result.httpStatus).toBeNull();
    }
  });

  test("rejects malformed agentId without making a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAgentFirstMessage("bogus");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid agentId/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
