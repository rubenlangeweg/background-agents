// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { AutomationRunGroup } from "@open-inspect/shared";
import { RunHistory } from "./run-history";

expect.extend(matchers);

afterEach(cleanup);

describe("RunHistory", () => {
  it("renders skipped zero-child groups as a skipped summary", () => {
    const group: AutomationRunGroup = {
      id: "group-1",
      automationId: "auto-1",
      status: "skipped",
      skipReason: "Skipped because another group is still active",
      failureReason: null,
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalRuns: 0,
      startingRuns: 0,
      runningRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      skippedRuns: 0,
      runs: [],
    };

    render(<RunHistory runs={[]} groups={[group]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("Skipped because another group is still active")).toBeInTheDocument();
    expect(screen.queryByText("0 repositories")).not.toBeInTheDocument();
    expect(screen.queryByText("0 completed")).not.toBeInTheDocument();
  });
});
