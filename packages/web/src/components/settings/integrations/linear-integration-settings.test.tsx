// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type {
  EnrichedRepository,
  LinearBotSettings,
  LinearGlobalConfig,
} from "@open-inspect/shared";
import { LinearIntegrationSettings } from "./linear-integration-settings";

expect.extend(matchers);

interface RepoSettingsEntry {
  repo: string;
  settings: LinearBotSettings;
}

interface LinearAuthHealth {
  status:
    | "connected"
    | "reauthorization_required"
    | "transient_failure"
    | "unknown"
    | "unavailable";
  reconnectUrl?: string;
  orgId?: string;
  orgName?: string;
  reason?: string;
}

const { useSWRMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn(),
}));

vi.mock("swr", () => ({
  default: useSWRMock,
  mutate: vi.fn(),
}));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({
    enabledModelOptions: [],
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function setupSWR(opts: {
  global?: LinearGlobalConfig | null;
  repos?: RepoSettingsEntry[];
  availableRepos?: EnrichedRepository[];
  authHealth?: LinearAuthHealth;
  authHealthLoading?: boolean;
  authHealthError?: unknown;
  globalLoading?: boolean;
  reposLoading?: boolean;
}) {
  useSWRMock.mockImplementation((key: string) => {
    if (key === "/api/integration-settings/linear") {
      return {
        data: opts.global === undefined ? undefined : { settings: opts.global },
        isLoading: opts.globalLoading ?? false,
      };
    }
    if (key === "/api/integration-settings/linear/repos") {
      return {
        data: { repos: opts.repos ?? [] },
        isLoading: opts.reposLoading ?? false,
      };
    }
    if (key === "/api/integration-settings/linear/auth-health") {
      return {
        data: opts.authHealth,
        isLoading: opts.authHealthLoading ?? false,
        error: opts.authHealthError,
      };
    }
    if (key === "/api/repos") {
      return {
        data: { repos: opts.availableRepos ?? [] },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

beforeEach(() => {
  useSWRMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("LinearIntegrationSettings auth health", () => {
  it("fetches and displays Linear auth health with the backend reconnect URL", () => {
    setupSWR({
      global: null,
      authHealth: {
        status: "reauthorization_required",
        reason: "missing_refresh_token",
        reconnectUrl: "https://linear-bot.example.test/oauth/authorize",
      },
    });

    render(<LinearIntegrationSettings />);

    expect(useSWRMock).toHaveBeenCalledWith("/api/integration-settings/linear/auth-health");
    expect(screen.getByText("Reconnect required")).toBeInTheDocument();
    expect(screen.getByText("Reason: missing refresh token")).toBeInTheDocument();

    const reconnectLink = screen.getByRole("link", { name: /reconnect linear/i });
    expect(reconnectLink).toHaveAttribute(
      "href",
      "https://linear-bot.example.test/oauth/authorize"
    );
    expect(reconnectLink).toHaveAttribute("target", "_blank");
    expect(reconnectLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not render a reconnect link without a backend-provided URL", () => {
    setupSWR({
      global: null,
      authHealth: {
        status: "reauthorization_required",
        reason: "oauth_app_revoked",
      },
    });

    render(<LinearIntegrationSettings />);

    expect(screen.getByText("Reconnect required")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /reconnect linear/i })).not.toBeInTheDocument();
  });

  it("does not render a reconnect link when Linear is already connected", () => {
    setupSWR({
      global: null,
      authHealth: {
        status: "connected",
        reconnectUrl: "https://linear-bot.example.test/oauth/authorize",
      },
    });

    render(<LinearIntegrationSettings />);

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /reconnect linear/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /connect linear/i })).not.toBeInTheDocument();
  });

  it("renders a connect link for unknown Linear auth health", () => {
    setupSWR({
      global: null,
      authHealth: {
        status: "unknown",
        reconnectUrl: "https://linear-bot.example.test/oauth/authorize",
      },
    });

    render(<LinearIntegrationSettings />);

    const connectLink = screen.getByRole("link", { name: /connect linear/i });
    expect(connectLink).toHaveAttribute("href", "https://linear-bot.example.test/oauth/authorize");
    expect(connectLink).toHaveAttribute("target", "_blank");
    expect(connectLink).toHaveAttribute("rel", "noopener noreferrer");
  });
});
