# GhTaskSource — GitHub Issues as the inbound work surface

Status: proposed (Phase F design doc). Resolves BACKLOG#`gap-no-task-source` and turns CHECKPOINT 4 into a demonstrable end-to-end loop. The TaskSource port already exists at `packages/runtime/src/sources/types.ts` (Week 2 carve-out — interface only, no implementation); this doc proposes the first concrete impl plus the CLI plumbing that makes it usable.

The four-property gate definition refined for CHECKPOINT 3 stays; the CHECKPOINT 4 gate adds its own properties on top — defined below in §10.

## Why

Through Week 3, runs are kicked off two ways:

- `agent-loop start --spec <name>` — pulls a Spec from a hardcoded TypeScript registry in `examples/specs/`. The Spec is fully-formed; triage and planner are not exercised in this path. Used for demos and integration tests, not for real work.
- `agent-loop eval --with-triage` — pulls a task.md from `evals/tasks/<name>/task.md`, hands it to triage, lets the full triage+planner+executor+verifier loop run against an isolated fixture. Used for measurement, not for shipping work.

Neither flow accepts work from outside the repo. Real use looks different: a human writes a GitHub Issue, labels it for the agent, and a long-running process picks it up, drives the full loop, opens a PR, and labels the issue done. Phase F closes that gap.

GhTaskSource is also the first concrete implementation of the existing `TaskSource` port. The interface was designed in Week 2 with this implementation in mind — `markStarted`, `markDone`, `markFailed`, `markNeedsInfo` are how an external work-tracking surface (GitHub Issues, Linear, etc.) gets state-machine feedback from the orchestrator. The interface won't change; the question is what each method does for the GitHub case.

## The existing port (for reference)

From `packages/runtime/src/sources/types.ts`:

```ts
export interface TaskSource {
  readonly id: string;
  fetchNew(opts?: { limit?: number }): Promise<Task[]>;
  fetchById(taskId: TaskId): Promise<Task | null>;
  markStarted(taskId: TaskId, runId: RunId): Promise<void>;
  markDone(taskId: TaskId, runId: RunId, prUrl: string): Promise<void>;
  markFailed(taskId: TaskId, runId: RunId, reason: string): Promise<void>;
  markNeedsInfo(taskId: TaskId, runId: RunId, questions: string[]): Promise<void>;
}
```

What's shared across all implementations (including future Linear, file-based, etc.):
- Two-way contract: fetch work + report state. Implementations do both; the orchestrator depends on the interface.
- `Task` is the canonical inbound shape (`id`, `title`, `body`, `source`, `createdAt`, optional `url`, optional `sourceMetadata`). Sources produce `Task`; downstream produces `Spec` via triage.
- The orchestrator does NOT own the polling cadence; the CLI (or a future daemon) calls `fetchNew` in a loop and creates `Task` rows from results.

What's specific to GhTaskSource:
- Authentication via GitHub PAT.
- Label-based filtering (`fetchNew` returns issues with the `agent-ready` label and no `agent-working`/`agent-done`/`agent-failed`/`agent-needs-info` labels).
- `mark*` methods translate to label transitions and (where appropriate) comments.
- `Task.url` populated with the issue URL; `Task.sourceMetadata` carries the labels + assignees snapshot at fetch time.
- `id` shape: `github:<owner>/<repo>#<issueNumber>`.

## Issue → Task → Spec flow

GitHub Issue (markdown body) →
GhTaskSource.fetchNew →
`Task` row in DB (body = issue body, title = issue title) →
orchestrator picks it up →
triage reads `Task.body` as task.md and produces a Spec →
planner produces a Plan →
executor runs →
verifier judges →
PR opener creates the PR →
GhTaskSource.markDone posts the PR URL back to the issue (comment + label flip).

The conversion at the source boundary is trivial — the issue body IS the task.md. No transformation, no parsing of headers, no extraction of code blocks. Triage already handles markdown text. Pass-through preserves whatever the human typed verbatim.

Why no Spec construction in the source: separation of concerns. The source's job is "get the human's request into the loop." Triage's job is "decide what's actionable and produce a structured Spec." Folding those together would mean GhTaskSource needs to know about acceptanceCriteria, testCommands, fileScope — and would re-invent triage in a less-tested place.

## Labels as the state machine

| Label | Meaning | Set by | Cleared by |
|---|---|---|---|
| `agent-ready` | Human says "agent, take this" | Human | Agent on pickup (replaced with `agent-working`) |
| `agent-working` | A run is in flight for this issue | Agent (markStarted) | Agent on terminal phase |
| `agent-done` | Run reached `done`; PR is open | Agent (markDone) | Human (when the PR is merged or closed; agent doesn't touch) |
| `agent-failed` | Run reached `failed`; failure reason in comment | Agent (markFailed) | Human (when triaging the failure) |
| `agent-needs-info` | Triage rejected with clarifying questions | Agent (markNeedsInfo) | Human (when answering — flips back to `agent-ready`) |

The five labels are mutually exclusive at any point in time; the agent enforces by removing the prior label when adding the new one. Multiple labels in this set on the same issue would be a bug; the doc proposes a startup check that logs (but doesn't fix) such states, so the human can see drift.

The `agent-ready` → `agent-needs-info` → `agent-ready` cycle handles the clarification loop without any extra mechanism. Human answers in the comment thread; flips the label. Agent on next poll picks it up fresh — a NEW run, not a resumed one. Triage may produce a different spec on the second pass given the clarified context. (See §12 for "what about partial state from the failed prior attempt" — short answer: a `needs-info` rejection terminates the run before any worktree work happens, so there's no partial state to clean up.)

PR linkage: when `markDone` runs, GhTaskSource posts a comment on the issue with `Closes #<issue> via <prUrl>`. The PR body itself includes `Closes #<issueNumber>` so a human merge auto-closes the issue. GhTaskSource does NOT auto-merge.

## Polling vs. webhook (proposed: polling for v1)

Polling, not webhooks. v1 is a single long-running CLI process (`agent-loop watch --source github --repo X`) that calls `fetchNew` every N seconds. Defaults proposed: poll every 60s; jitter ±15s to avoid hammering on a fixed cadence.

Why polling is right for v1:
- No infrastructure surface beyond what the human already has (a terminal, a PAT, a clone of the target). Webhooks require a publicly-reachable endpoint, a webhook secret, TLS — none of which fit "single-user CLI."
- GitHub's REST rate limit (5000/hour authenticated) is far more than we need at one poll/minute. Even with 4 endpoints touched per poll (list issues, get labels, post comment, set label), that's 240/hour = 4.8% of budget.
- Latency from issue-labeled to agent-pickup is on the order of one poll interval (60s ± jitter). Acceptable for a developer-tool surface where the human just labeled the issue and is about to switch tabs anyway.
- Polling state is implicit (`fetchNew` is idempotent — it returns issues matching the label filter; if an issue is already in our DB, we don't pick it up again). No "missed event" failure mode.

Webhook deferred conditions (when to revisit):
- The polling cadence becomes a bottleneck (e.g., a team wants ≤10s pickup latency).
- The agent runs in a hosted/multi-user mode where one polling process per user doesn't scale.
- A specific real-time event is required (e.g., human says "stop this run NOW" via an issue comment, and 60s is too slow).

None of these is plausibly in scope before Phase G+ work. The doc commits to polling for now; the webhook switch is a future migration with a clean interface boundary (the source still implements `fetchNew` — the polling implementation just gets replaced with an event-driven one).

## CLI surface

Two commands cover Phase F:

**`agent-loop watch --source github --repo <owner/repo> --target <path> [--quiet]`**

The new daemon command. Long-running. Polls GitHub for `agent-ready` issues, creates Tasks in the DB, drives one run at a time to completion. Honors STOP file the same way `runLoop` does (Week 2 polish).

```
--source github      Required. Today only "github" is valid. (Future: linear, file.)
--repo owner/repo    The GitHub repo to poll. Required for --source github.
--target <path>      Local clone of the target repo. Same semantics as start --target.
--quiet              Don't post intermediate comments on issues (only label changes
                     + final PR-link comment). Useful for noisy real-time work.
--poll-interval <s>  Override the 60s default poll cadence. Mostly for tests.
```

Exit codes: 0 on STOP file (clean shutdown); 1 on unrecoverable error (e.g., auth failed, repo not found). SIGINT applies abandon to the active run, then exits 130.

**`agent-loop start --task <id> --target <path>`**

A new flag on the existing `start` command. Pulls a Task already in the DB (typically inserted by a prior `watch` poll, or hand-inserted via a future `agent-loop inbox add` command), drives that ONE task to terminal, and exits. The existing `start --spec <name>` path stays for hardcoded-spec demos; `--task` and `--spec` are mutually exclusive.

The `--target` flag is required in both commands (same semantics as Week 2: a clean local git clone of the target repo where worktrees branch from).

## Authentication

GitHub PAT in `~/.agent-loop/.env`, key `GITHUB_TOKEN`. Same shape as `ANTHROPIC_API_KEY`, loaded by the existing `loadDotenvFile` in `packages/runtime/src/config/dotenv.ts`. Token scopes required: `repo` (read/write issues + comments + labels; create PRs). Fine-grained PATs are preferred (scope to the demo repo only) but classic PATs work.

The PAT is never logged. The dotenv loader already redacts known keys in the log preview (`ANTHROPIC_API_KEY`); add `GITHUB_TOKEN` to the redaction list.

When `--source github` is specified and `GITHUB_TOKEN` is missing, the command fails fast with a one-line error pointing at `~/.agent-loop/.env`. No fallback to interactive prompt (no terminal prompt is needed for a daemon).

## Demo repo for CHECKPOINT 4

A throwaway repo named `agent-loop-target-demo` under the user's GitHub account. The local equivalent of `/Users/kkim/projects/agent-loop-target` (already exists as a clean clone of a small JS project with realistic-shaped code). The demo repo is:
- Public (so PRs and issues are visible without auth-juggling for screenshots).
- Initialized with the same content as the local target — package.json, a small handful of files, npm test that works.
- Used ONLY for Phase F demos. Not a fixture; not in the eval suite. Throwaway in the sense that issues + PRs may be deleted/reset between demos.

Setup is a one-time operation by the human, not part of the agent's workflow. Doc'd in a follow-up `docs/phase-f-demo-setup.md` (out of scope for this design doc).

## CHECKPOINT 4 definition

**Pass criteria** (all must hold for a single demo run):

1. A human creates an issue on `agent-loop-target-demo` with the `agent-ready` label.
2. Within 2 poll intervals (~2 min), the agent picks up the issue and the labels transition to `agent-working`.
3. The agent runs triage → planner → executor → verifier without infrastructure errors.
4. If the run reaches `done`: a PR is opened, the issue is labeled `agent-done`, a comment links the PR.
5. If triage rejects with `too_vague`: the issue is labeled `agent-needs-info`, a comment with the clarifying questions is posted, and a follow-up human response (flipping the label back to `agent-ready` after adding context) is picked up on the next poll and re-triages successfully.
6. If verification fails: the issue is labeled `agent-failed` with a comment containing the failure category + summary.
7. No labels in a corrupted state (e.g., both `agent-working` and `agent-done`) after the run.

**Out of scope for CHECKPOINT 4** (each is a follow-up Phase or BACKLOG entry):
- Multi-repo polling. v1 polls one repo per `watch` invocation.
- Concurrent runs on multiple issues. v1 is one-at-a-time, same as Week 2 `runLoop`.
- Comment-thread conversation beyond the label state. The agent doesn't read free-form human comments on the issue; only labels drive state.
- Merge-conflict resolution. The PR is opened; if merge conflicts exist, the human resolves them (agent doesn't push fixups).
- Mid-edit updates to the issue body. The Task is created from the body at pickup time; subsequent body edits are ignored until the next `agent-ready` cycle.
- Cross-issue dependencies (e.g., "this issue depends on #42"). Treated as independent tasks; ordering is the human's responsibility.
- Authentication beyond a single PAT. No GitHub App, no installation token rotation, no fine-grained scope enforcement.

## Failure modes new to Phase F

Each gets a proposed handling. Default posture for new failure modes in Phase F: **fail visibly, log loudly, don't retry silently.**

| Failure | Handling |
|---|---|
| GitHub rate limit hit | Log the `X-RateLimit-Remaining` value on every API call; on 429/secondary rate limit, sleep for the indicated reset interval and resume polling. Never silently drop a poll. |
| Network error during `fetchNew` | Log warn; skip this poll iteration; resume next. Don't crash the daemon. |
| Network error during `markX` | Retry once with exponential backoff (1s, 4s, 16s). If still failing, log error and apply `abandon` to the run with reason "github mark* failed after retries"; the worktree stays for human inspection. |
| Issue label state pre-pickup is inconsistent (e.g., both `agent-ready` and `agent-working`) | Don't pick up; log warn naming the issue; continue polling other issues. The human resolves the label state. |
| Issue body is empty or whitespace-only | `fetchNew` filters it out at the source boundary; logs info "skipped empty-body issue #N." Doesn't reach triage. |
| Race: human flips a label while the run is in flight | The run continues to completion; the label change is logged but ignored mid-run. Final `markX` will overwrite. (Future: a mid-run `agent-cancel` label could be respected — out of scope for v1.) |
| Daemon crash mid-run | The run row in SQLite is in a non-terminal phase. On daemon restart, the human resolves it (`agent-loop inspect <runId>` to see state; `agent-loop abandon <runId>` to clean up). The issue stays labeled `agent-working` — visible to the human as stale. v1 does NOT auto-resume. |
| Triage produces `spec_invalid` (out-of-scope or not-actionable rejections without questions) | `markFailed` with the rejection reason in the comment. Labeled `agent-failed`, not `agent-needs-info` (the latter is reserved for `too_vague` with clarifying questions). |
| PR creation fails (e.g., the branch already exists from a prior aborted run) | Caught by `GhPrOpener` already (Week 2). The run goes to `failed` with category `pr_failed`. GhTaskSource translates to `markFailed`. |
| Auth token expired mid-daemon | Next API call returns 401; log error, exit with code 1 ("auth check failed; refresh GITHUB_TOKEN in ~/.agent-loop/.env"). The active run completes if it doesn't need GitHub API for its remaining steps. |

## Implementation order

1. **GhTaskSource module** (`packages/runtime/src/sources/github.ts` + `github.test.ts`): implements `TaskSource`. SDK choice: `@octokit/rest` (most batteries-included; ~1MB; standard JS surface). Constructor takes `{ token, owner, repo, logger }`. Methods are thin shells over Octokit; the test stubs Octokit and asserts request shape + parameter passing.
2. **Dotenv redaction update**: add `GITHUB_TOKEN` to the redacted-keys list in `loadDotenvFile`.
3. **CLI `watch` command** (`packages/cli/src/commands/watch.ts`): the long-running command; opens DB; loops `await source.fetchNew()` → `for (task of new) { createRun, driveToTerminal }`. Inherits the SIGINT/STOP-file pattern from `start`.
4. **CLI `start --task <id>` path**: the one-shot variant. Reads the Task from DB; creates the Run; drives to terminal. Uses the same `driveToExecuting` + tick loop as the existing `--spec` path, but the Task's body becomes the triage input (instead of skipping triage entirely as `--spec` does).
5. **Triage integration with `Task.body`**: today's `driveToExecuting` calls triage with the task description; needs to take the Task as input, not just the spec name. This is a small refactor — mostly just plumbing the body string through.
6. **PR body integration**: when GhPrOpener constructs the PR body, include `Closes #<issueNumber>` based on the Task's id parsing. Need a small helper in GhTaskSource to extract the issue number from a `github:owner/repo#N` id.
7. **markX implementations**: each is an Octokit call sequence (remove old label, add new label, post comment). Idempotent on retry (Octokit's add-label is idempotent; remove-label fails-silently if the label isn't present).
8. **Live integration test (gated)**: `AGENT_LOOP_LIVE_GH=1` flag enables a test that hits a real test repo. Same pattern as the existing `AGENT_LOOP_LIVE_PR=1` gate for GhPrOpener.
9. **CHECKPOINT 4 demo**: run on `agent-loop-target-demo`. Document the steps in `docs/phase-f-demo-setup.md`. Validate against the §10 pass criteria.

## What this does NOT touch

- The state machine in `packages/core/src/state/transition.ts`. The orchestrator's phase transitions are unchanged; GhTaskSource fires `markX` at the existing terminal-phase boundaries.
- The triage prompt or schema. The Task.body is just task.md by another name; triage doesn't need to know whether it came from GitHub or a local file.
- The verifier (exit-code or semantic). Same Verdict, same gates.
- The eval harness. Eval mode continues to bypass TaskSource entirely. (See open question 1 below.)
- The DB schema for Task. Already in place from Week 2.

## Open questions / signoffs requested

1. **Retrofit EvalTaskSource to the `TaskSource` port?** Today the eval driver bypasses the port — it pulls task.md from `evals/tasks/<name>/task.md` and feeds it directly to triage. Retrofitting EvalTaskSource to implement the port (returning `Task` rows with `source = "eval:<name>"`, `markStarted` writes to a fixture log, etc.) would unify the inbox model across eval and prod. **Recommendation**: defer to a follow-up — the eval driver works, and bringing it under the port adds rework risk without obvious user-visible benefit. File as `polish-eval-task-source-port-retrofit` (P2) if the user agrees.

2. **Polling cadence default — 60s vs 30s vs 120s?** 60s is the proposed default (fast enough for a developer feedback loop, slow enough to be well under rate limits). 30s would mean ~120 API calls/hour (still trivial); 120s would mean perceived latency. The flag exists either way (`--poll-interval`); the question is just what the unset default does. Recommend 60s.

3. **Should `markDone` post a comment or only flip the label?** The proposal is BOTH: a comment with `PR opened: <url>` plus the label flip. The comment is courteous (a human reading the issue thread sees what happened); the label drives state. If `--quiet`, suppress the comment, keep the label. Confirm this is right.

4. **Resume semantics on daemon restart.** Proposal: v1 doesn't auto-resume. A run in non-terminal phase at daemon start stays where it is; the human resolves it via `agent-loop inspect` + `agent-loop abandon`. Alternative: auto-abandon on startup for any run not in a terminal phase, with a startup-log warning. The auto-abandon is more aggressive but cleaner. **Lean toward "don't auto-resolve" for v1** — surprises in daemon restart are worse than stale state visible to the human.

5. **Cross-repo demo isolation — do we let the demo repo's PRs trigger CI?** If `agent-loop-target-demo` has GitHub Actions on `pull_request`, every demo run triggers them — fine for visibility, potentially noisy for free-tier minutes. Proposal: include a `.github/workflows/` with one simple `npm test` workflow; the agent's PRs will run it; failed CI ≠ failed agent run (the agent already runs npm test internally before opening the PR). Worth being explicit so the CHECKPOINT 4 demo doesn't get confounded by CI flakes.

6. **State machine ownership: orchestrator-driven or source-driven mark* calls?** The current TaskSource port has the orchestrator call `markX` at phase boundaries (orchestrator-driven). An alternative would be source-driven: the source polls run states and updates labels independently. **Orchestrator-driven is already baked into the port shape** (`markStarted(taskId, runId)` is invoked by the tick loop, not the source's poll loop), so this is signed off by Week 2's interface decision. Recording the question because it's worth being explicit: if the source-driven model is preferable for some future implementation, that's a port redesign, not a Phase F decision.

After signoff on these, proceed to code per §11 implementation order.
