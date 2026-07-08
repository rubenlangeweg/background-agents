import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { GET } from "./route";

function request() {
  return {} as NextRequest;
}

describe("Linear auth health API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("proxies Linear auth health from the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json(
        {
          status: "reauthorization_required",
          reason: "missing_refresh_token",
          reconnectUrl: "https://linear-bot.example.test/oauth/authorize",
        },
        { status: 200 }
      )
    );

    const response = await GET(request());

    expect(controlPlaneFetch).toHaveBeenCalledWith("/integration-settings/linear/auth-health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "reauthorization_required",
      reason: "missing_refresh_token",
      reconnectUrl: "https://linear-bot.example.test/oauth/authorize",
    });
  });

  it("returns 500 when the control plane request throws", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockRejectedValue(new Error("boom"));

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to fetch Linear auth health",
    });
  });
});
