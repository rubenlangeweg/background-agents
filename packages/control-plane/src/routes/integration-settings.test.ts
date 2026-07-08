import { describe, expect, it, vi } from "vitest";
import { verifyInternalToken } from "@open-inspect/shared";
import { integrationSettingsRoutes } from "./integration-settings";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const INTERNAL_CALLBACK_SECRET = "test-callback-secret";

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function getHandler(method: string, path: string) {
  for (const route of integrationSettingsRoutes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return { handler: route.handler, match };
  }
  throw new Error(`No route found for ${method} ${path}`);
}

async function callRoute(path: string, env: Env): Promise<Response> {
  const { handler, match } = getHandler("GET", path);
  return handler(new Request(`https://test.local${path}`), env, match, createCtx());
}

describe("integration settings routes", () => {
  describe("GET /integration-settings/linear/auth-health", () => {
    it("proxies to the Linear bot with signed internal auth", async () => {
      let forwardedUrl = "";
      let forwardedHeaders = new Headers();
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        forwardedUrl = input.toString();
        forwardedHeaders = new Headers(init?.headers);
        return Response.json({
          status: "connected",
          reconnectUrl: "https://linear-bot.test/oauth/authorize",
        });
      });

      const response = await callRoute("/integration-settings/linear/auth-health", {
        INTERNAL_CALLBACK_SECRET,
        LINEAR_BOT: { fetch } as unknown as Fetcher,
      } as Env);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "connected",
        reconnectUrl: "https://linear-bot.test/oauth/authorize",
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(new URL(forwardedUrl).pathname).toBe("/config/auth-health");
      expect(forwardedHeaders.get("accept")).toBe("application/json");
      expect(forwardedHeaders.get("x-trace-id")).toBe("trace-1");
      await expect(
        verifyInternalToken(forwardedHeaders.get("authorization"), INTERNAL_CALLBACK_SECRET)
      ).resolves.toBe(true);
    });

    it("returns 503 when the Linear bot binding is unavailable", async () => {
      const response = await callRoute("/integration-settings/linear/auth-health", {
        INTERNAL_CALLBACK_SECRET,
      } as Env);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Linear bot service binding is not configured",
      });
    });

    it("returns 500 when internal auth is not configured", async () => {
      const response = await callRoute("/integration-settings/linear/auth-health", {
        LINEAR_BOT: { fetch: vi.fn() } as unknown as Fetcher,
      } as Env);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Internal authentication not configured",
      });
    });
  });
});
