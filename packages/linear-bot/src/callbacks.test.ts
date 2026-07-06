import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbacksRouter } from "./callbacks";
import { getLinearAuthState } from "./kv-store";
import {
  createFakeKV,
  makeExecutionContext,
  makeLinearBotEnv,
  signCallbackPayload,
} from "./test-helpers";

describe("callbacksRouter auth health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records auth health when a tool-call callback cannot refresh Linear OAuth", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { kv } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 60 * 1000,
      }),
    });
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "callback-secret" });
    const ctx = makeExecutionContext();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Refresh token has expired.",
            })
          ),
      })
    );
    const payload = await signCallbackPayload(
      {
        sessionId: "session-1",
        tool: "bash",
        args: { command: "npm test" },
        callId: "call-1",
        timestamp: Date.now(),
        context: {
          source: "linear",
          issueId: "issue-1",
          issueIdentifier: "ORI-229",
          issueUrl: "https://linear.app/acme/issue/ORI-229/test",
          repoFullName: "ColeMurray/background-agents",
          model: "anthropic/claude-haiku-4-5",
          agentSessionId: "agent-session-1",
          organizationId: "org-1",
        },
      },
      "callback-secret"
    );

    const res = await callbacksRouter.fetch(
      new Request("http://localhost/tool_call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "reauthorization_required",
      reason: "refresh_invalid_grant",
    });
    const warnEvents = warnSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(warnEvents).toContainEqual(
      expect.objectContaining({
        msg: "callback.tool_call",
        skip_reason: "no_oauth_token",
        auth_failure_reason: "refresh_invalid_grant",
        reconnect_url: "https://linear-bot.example.test/oauth/authorize",
      })
    );
  });

  it("records auth health when completion callback cannot refresh OAuth", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { kv } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 60 * 1000,
      }),
    });
    const controlPlaneFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/events")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  id: "event-1",
                  type: "token",
                  data: { content: "Agent finished." },
                  createdAt: 1,
                },
                {
                  id: "event-2",
                  type: "execution_complete",
                  data: { success: true },
                  createdAt: 2,
                },
              ],
              hasMore: false,
            }),
        };
      }
      if (url.includes("/artifacts")) {
        return {
          ok: true,
          json: () => Promise.resolve({ artifacts: [] }),
        };
      }
      throw new Error(`Unexpected control-plane fetch to ${url}`);
    });
    const env = makeLinearBotEnv(kv, {
      APP_NAME: "Acme Agent",
      CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
      INTERNAL_CALLBACK_SECRET: "callback-secret",
      LINEAR_API_KEY: "linear-api-key",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.linear.app/oauth/token") {
        return {
          ok: false,
          status: 400,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "Refresh token has expired.",
              })
            ),
        };
      }
      if (url === "https://api.linear.app/graphql") {
        return {
          ok: true,
          json: () => Promise.resolve({ data: { commentCreate: { success: true } } }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeExecutionContext();
    const payload = await signCallbackPayload(
      {
        sessionId: "session-1",
        messageId: "message-1",
        success: true,
        timestamp: Date.now(),
        context: {
          source: "linear",
          issueId: "issue-1",
          issueIdentifier: "ORI-229",
          issueUrl: "https://linear.app/acme/issue/ORI-229/test",
          repoFullName: "ColeMurray/background-agents",
          model: "anthropic/claude-haiku-4-5",
          agentSessionId: "agent-session-1",
          organizationId: "org-1",
        },
      },
      "callback-secret"
    );

    const res = await callbacksRouter.fetch(
      new Request("http://localhost/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));
    const authState = await getLinearAuthState(env, "org-1");
    expect(authState).toMatchObject({
      status: "reauthorization_required",
      reason: "refresh_invalid_grant",
    });
    expect(authState).not.toHaveProperty("lastNotification");
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.linear.app/oauth/token");
    const graphQlCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "https://api.linear.app/graphql"
    );
    expect(graphQlCall).toBeDefined();
    const graphQlBody = JSON.parse(String(graphQlCall?.[1]?.body));
    expect(graphQlBody.variables.input).toMatchObject({ issueId: "issue-1" });
    expect(graphQlBody.variables.input.body).toContain("Acme Agent completed");
    expect(graphQlBody.variables.input.body).toContain("Agent finished.");
    expect(graphQlBody.variables.input.body).not.toContain("re-authorize");
    const warnEvents = warnSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(warnEvents).toContainEqual(
      expect.objectContaining({
        msg: "callback.no_oauth_token",
        auth_failure_reason: "refresh_invalid_grant",
        reconnect_url: "https://linear-bot.example.test/oauth/authorize",
      })
    );
  });

  it("posts completion fallback when recording auth health fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { kv, store } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 60 * 1000,
      }),
    });
    const kvPut = kv.put as unknown as ReturnType<typeof vi.fn>;
    kvPut.mockImplementation(
      async (key: string, value: string, options?: { expirationTtl?: number }) => {
        if (key === "linear_auth:org-1") throw new Error("kv write failed");
        store.set(key, value);
        void options;
      }
    );
    const controlPlaneFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/events")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  id: "event-1",
                  type: "token",
                  data: { content: "Agent finished despite KV write failure." },
                  createdAt: 1,
                },
              ],
              hasMore: false,
            }),
        };
      }
      if (url.includes("/artifacts")) {
        return {
          ok: true,
          json: () => Promise.resolve({ artifacts: [] }),
        };
      }
      throw new Error(`Unexpected control-plane fetch to ${url}`);
    });
    const env = makeLinearBotEnv(kv, {
      APP_NAME: "Acme Agent",
      CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
      INTERNAL_CALLBACK_SECRET: "callback-secret",
      LINEAR_API_KEY: "linear-api-key",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.linear.app/oauth/token") {
        return {
          ok: false,
          status: 400,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "Refresh token has expired.",
              })
            ),
        };
      }
      if (url === "https://api.linear.app/graphql") {
        return {
          ok: true,
          json: () => Promise.resolve({ data: { commentCreate: { success: true } } }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeExecutionContext();
    const payload = await signCallbackPayload(
      {
        sessionId: "session-1",
        messageId: "message-1",
        success: true,
        timestamp: Date.now(),
        context: {
          source: "linear",
          issueId: "issue-1",
          issueIdentifier: "ORI-229",
          issueUrl: "https://linear.app/acme/issue/ORI-229/test",
          repoFullName: "ColeMurray/background-agents",
          model: "anthropic/claude-haiku-4-5",
          agentSessionId: "agent-session-1",
          organizationId: "org-1",
        },
      },
      "callback-secret"
    );

    const res = await callbacksRouter.fetch(
      new Request("http://localhost/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));
    const graphQlCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "https://api.linear.app/graphql"
    );
    expect(graphQlCall).toBeDefined();
    const graphQlBody = JSON.parse(String(graphQlCall?.[1]?.body));
    expect(graphQlBody.variables.input).toMatchObject({ issueId: "issue-1" });
    expect(graphQlBody.variables.input.body).toContain("Agent finished despite KV write failure.");
    const warnEvents = warnSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(warnEvents).toContainEqual(
      expect.objectContaining({
        msg: "oauth.auth_state_update_failed",
        org_id: "org-1",
        auth_status: "reauthorization_required",
        reason: "refresh_invalid_grant",
      })
    );
    expect(warnEvents).toContainEqual(
      expect.objectContaining({
        msg: "callback.no_oauth_token",
        auth_failure_reason: "refresh_invalid_grant",
      })
    );
  });
});
