---
title: "Linear Auth Health Pre-Merge Fixes - Plan"
type: fix
date: 2026-07-06
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Linear Auth Health Pre-Merge Fixes - Plan

## Goal Capsule

- **Objective:** Apply only the pre-merge fixes that preserve user value and Linear webhook hygiene
  without rebuilding the PR's removed notification machinery.
- **Authority hierarchy:** User direction to challenge the findings > maintainer feedback from #864
  that auth failures stay log-only > issue #865 auth-health intent > existing local code patterns.
- **Execution profile:** Small, targeted diff on `packages/linear-bot`; no new subsystem, no broad
  status surface, no excessive new tests.
- **Stop conditions:** Stop if restoring completion fallback would reintroduce auth-failure
  reconnect comments, if stale webhook handling would process stale state changes, or if a
  supposedly dead export has a production caller.
- **Tail ownership:** LFG owns simplification, review, commit, push, PR-body update, and CI watch
  after implementation.

---

## Product Contract

### Summary

This plan keeps PR #866's auth-health core while fixing three merge-blocking edges: completed work
must still reach Linear through the existing completion fallback when OAuth is broken, stale
authenticated auth-health retries must not keep returning retry-triggering 400s, and auth-health
state persistence must not become a new way to drop completed results. It also deletes client helper
wrappers that became internal-only after the PR migrated production callers to
`getLinearAuthContext`.

### Problem Frame

The current branch correctly removed auth-failure comments after #864 feedback, but one callback
path now returns too early: completion results with AgentSession context and broken OAuth no longer
fall through to the pre-existing `LINEAR_API_KEY` result comment fallback. That is not what the
maintainer objected to, because the fallback comment is a result delivery path, not an
auth-reconnect notice.

For webhooks, Linear documents that consumers should respond with HTTP 200 for accepted deliveries,
and non-200 responses are retried and can eventually disable the webhook. The current stale
auth-health timestamp branch returns 400 after signature verification, which is good replay
protection but poor retry behavior for delayed Linear retries.

The wrapper deletion candidate is real only for the null-return compatibility wrappers. Installation
identity and permission-change diagnostic details are not deleted in this plan because they are part
of the auth-health record and are useful if the next PR adds a status read surface.

### Requirements

**Completion delivery**

- R1. Completion callbacks with AgentSession context and failed OAuth keep logging auth health and
  `reconnect_url`.
- R2. When `LINEAR_API_KEY` is configured, the same completion result still falls through to the
  existing completion-results comment fallback.
- R3. The restored fallback must not include a reconnect instruction or auth-failure notification
  body.

**Linear webhook behavior**

- R4. Auth-health webhooks with a valid signature and stale timestamp return HTTP 200 and skip
  processing.
- R5. Stale auth-health webhooks do not delete tokens, write auth state, deduplicate delivery IDs,
  enqueue AgentSession work, or call auth-health handlers.
- R6. Invalid signatures, malformed JSON, missing timestamps, missing delivery IDs, and invalid
  payload shapes keep their existing rejection behavior.

**Simplification**

- R7. Delete compatibility wrappers with no production callers: `getOAuthToken`,
  `getOAuthTokenResult`, `getLinearClient`, `getLinearClientOrThrow`, and `getLinearClientResult`.
- R8. Keep `getOAuthTokenOrThrow` and `getLinearAuthContext` as the active auth-health gateway.
- R9. Do not delete installation identity or permission-change diagnostic state in this PR.
- R10. Auth-health state write failures are logged but do not prevent completion-result fallback.

### Scope Boundaries

- No auth-failure Linear comments. Auth failures stay log-only per #864.
- No `/status` endpoint or web dashboard badge in this PR. That is the useful follow-up for the
  stored auth-health record.
- No OAuth-state redesign. The current signed state is treated as a garbage-callback filter, not
  marketed as full CSRF protection.
- No Slack or GitHub bot parity work.
- No retry/backoff machinery for `transient_failure`; the gateway already re-probes on later
  requests.

---

## Planning Contract

### Key Technical Decisions

- **Restore fall-through, not auth comments.** The completion callback should log the OAuth failure,
  then continue to the existing result fallback. This preserves completed work delivery without
  reintroducing the rejected auth-failure comment path.
- **Stale authenticated auth-health webhooks are acknowledged and skipped.** Linear recommends
  timestamp freshness to prevent replay, but also treats non-200 as failed delivery. Returning 200
  after signature verification avoids retry churn while still refusing to apply stale state changes.
- **Delete wrappers at the boundary, not the underlying gateway.** The dead wrappers are null-return
  compatibility helpers. Keeping the throwing/result/context helpers avoids churn in tests that
  still pin token classification and auth-health persistence.
- **Keep write-only diagnostic fields for now.** Installation identity and permission details are
  not read by product UI today, but they are meaningful auth-health data. Deleting them before
  deciding on a status read surface would create churn rather than value.

### Assumptions

- The current PR body can be updated after code lands to mention restored completion-result fallback
  reachability and stale-webhook 200-skip behavior.
- A single focused regression test per behavior is enough. Existing token/auth-health tests already
  cover lower-level classifications.

### Sources and Research

- Linear webhooks docs: webhook consumers should respond with HTTP 200, while non-200 responses are
  retried after 1 minute, 1 hour, and 6 hours and may lead Linear to disable the webhook.
- Linear webhook security docs: signature verification and timestamp freshness are recommended
  replay protections.
- Linear OAuth docs: `state` is recommended for CSRF prevention, but this PR does not broaden OAuth
  state semantics beyond the existing signed-state guard.
- Linear Agents docs: agent installs use app actor OAuth, workspace admins can change or revoke app
  team access, and `PermissionChange` webhooks are sent when access changes.

---

## Implementation Units

### U1. Restore completion result fallback after OAuth failure

- **Goal:** Preserve result delivery for completed Linear sessions when AgentSession OAuth is
  broken.
- **Requirements:** R1, R2, R3
- **Dependencies:** none
- **Files:** `packages/linear-bot/src/callbacks.ts`, `packages/linear-bot/src/callbacks.test.ts`
- **Approach:** In the completion callback's AgentSession auth failure branch, keep the
  `callback.no_oauth_token` log and durable auth-state behavior, but do not return before the
  existing `LINEAR_API_KEY` completion fallback block. Keep tool-call callbacks log-only because
  they do not carry final results.
- **Patterns to follow:** Existing `formatCompletionComment` and `postIssueComment` fallback path in
  `packages/linear-bot/src/callbacks.ts`; current auth-health tests in
  `packages/linear-bot/src/callbacks.test.ts`.
- **Test scenarios:** Update the existing completion auth-failure test so the OAuth token refresh
  fails, auth state is written, `callback.no_oauth_token` logs `reconnect_url`, and the next fetch
  posts a normal completion comment to Linear GraphQL. Assert the comment body is the standard
  completion result, not an auth reconnect notice.
- **Verification:** Focused callbacks test passes and the full Linear bot suite stays green.

### U2. Acknowledge stale authenticated auth-health webhooks

- **Goal:** Avoid poisoning Linear retry health while still refusing to process stale state-changing
  auth-health deliveries.
- **Requirements:** R4, R5, R6
- **Dependencies:** none
- **Files:** `packages/linear-bot/src/index.ts`, `packages/linear-bot/src/index.test.ts`
- **Approach:** Change only the stale timestamp branch inside the auth-health webhook route after
  signature verification and payload parsing. Log a skip reason and return an OK skipped response.
  Do not call `handleAuthHealthWebhook`, do not call `isDuplicateEvent`, and do not enqueue
  AgentSession work.
- **Patterns to follow:** Existing duplicate and unhandled-event skip responses in
  `packages/linear-bot/src/index.ts`.
- **Test scenarios:** Change the existing stale auth-health webhook test to expect HTTP 200 and
  `{ ok: true, skipped: true, reason: "stale_timestamp" }`, with no auth state write, no token
  deletion, no waitUntil, and no AgentSession handler call.
- **Verification:** Focused index test passes and invalid-signature/missing-header tests remain
  unchanged.

### U3. Delete dead client compatibility wrappers

- **Goal:** Remove test-only helper surface that no production path calls after the PR moved to
  `getLinearAuthContext`.
- **Requirements:** R7, R8, R9
- **Dependencies:** none
- **Files:** `packages/linear-bot/src/utils/linear-client.ts`,
  `packages/linear-bot/src/utils/linear-client.test.ts`
- **Approach:** Delete `getOAuthToken`, `getOAuthTokenResult`, `getLinearClient`,
  `getLinearClientOrThrow`, and `getLinearClientResult`. Let `getLinearAuthContext` call
  `getOAuthTokenOrThrow` directly, map `LinearAuthError` through the auth-failure mapper, and build
  the client object on success.
- **Patterns to follow:** Existing direct `getOAuthTokenOrThrow` rejection tests and
  `getLinearAuthContext` persistence tests in `packages/linear-bot/src/utils/linear-client.test.ts`.
- **Test scenarios:** Move malformed-token shape coverage onto `getOAuthTokenOrThrow` so deleting
  result-wrapper tests does not drop parser coverage.
- **Verification:** `rg` finds no production callers for the deleted wrappers and the Linear client
  tests stay green.

### U4. Make auth-state persistence best-effort in the auth gateway

- **Goal:** Keep auth-health diagnostics from blocking completion-result delivery.
- **Requirements:** R1, R2, R10
- **Dependencies:** U1, U3
- **Files:** `packages/linear-bot/src/utils/linear-client.ts`,
  `packages/linear-bot/src/callbacks.test.ts`
- **Approach:** Wrap auth-state persistence inside the gateway with a warning log. Return the
  computed auth context even when the diagnostic KV write fails, so completion callbacks can still
  fall through to the existing `LINEAR_API_KEY` result fallback.
- **Patterns to follow:** Existing best-effort KV reads in `packages/linear-bot/src/kv-store.ts`.
- **Test scenarios:** Add one completion callback test where OAuth refresh fails, the
  `linear_auth:<orgId>` write throws, and the result comment still posts through Linear GraphQL.
- **Verification:** Focused callback tests pass and the warning log records
  `oauth.auth_state_update_failed`.

### U5. Update PR description after code lands

- **Goal:** Keep reviewer-facing text honest after the behavior changes.
- **Requirements:** R1, R4, R7, R10
- **Dependencies:** U1, U2, U3, U4
- **Files:** GitHub PR #866 body
- **Approach:** Update the PR description to say completion results still fall back through
  `LINEAR_API_KEY` when AgentSession OAuth is unavailable, auth-state writes are best-effort, stale
  authenticated auth-health webhooks are acknowledged and skipped, and dead compatibility wrappers
  were removed. Keep the line that auth failures themselves are log-only.
- **Patterns to follow:** Current compact PR body wording.
- **Test scenarios:** Test expectation: none. This is PR metadata, verified by reading the live PR
  body after update.
- **Verification:** `gh pr view 866 --json body` shows no contradiction with the branch behavior.

---

## Verification Contract

| Gate                                                                                                              | Applies to          | Done signal                               |
| ----------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------- |
| `npm test -w @open-inspect/linear-bot -- src/callbacks.test.ts src/index.test.ts src/utils/linear-client.test.ts` | U1, U2, U3          | Focused regression and cleanup tests pass |
| `npm test -w @open-inspect/linear-bot`                                                                            | All code units      | Linear bot package tests pass             |
| `npm run typecheck -w @open-inspect/linear-bot`                                                                   | All code units      | TypeScript compiles                       |
| `npm run lint -w @open-inspect/linear-bot`                                                                        | All code units      | ESLint passes                             |
| `npm run build -w @open-inspect/linear-bot`                                                                       | All code units      | Worker bundle builds                      |
| `git diff --check`                                                                                                | All tracked changes | No whitespace errors                      |

---

## Definition of Done

- U1 restores completion-result fallback reachability without auth-failure notification comments.
- U2 returns 200-skip for stale authenticated auth-health webhooks and does not process stale state
  changes.
- U3 removes only verified dead wrappers and their wrapper-only tests.
- U4 keeps auth-health state writes from blocking completion-result fallback.
- U5 updates PR #866 body so reviewer-facing text matches the final behavior.
- Focused and package-level verification gates pass after any rebase.
- No untracked planning artifacts are accidentally committed unless this LFG plan itself is
  intentionally part of the commit.
