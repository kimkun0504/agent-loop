/**
 * NoopPrOpener — eval-only PR opener that does NOT push or hit GitHub.
 *
 * Eval target repos are throwaway tmpdirs with no remote and no
 * authentication. Running GhPrOpener against them would fail at
 * `git push -u origin`. Skipping the opening_pr phase entirely would
 * keep the state machine in a non-terminal state, which breaks the
 * "did the run reach done?" pass criterion.
 *
 * NoopPrOpener returns { ok: true, url: 'eval://local/<runId>' } so the
 * state machine advances to `done` normally. The fake URL appears in
 * Run.prUrl and meta.json — it's clearly an eval artifact, not a real PR.
 */

import type { PrOpener, PrOpenInput, PrOpenResult } from '@agent-loop/runtime';

export class NoopPrOpener implements PrOpener {
  async openPullRequest(input: PrOpenInput): Promise<PrOpenResult> {
    input.logger?.info('pr: noop (eval mode)', { runId: input.run.id });
    return { ok: true, url: `eval://local/${input.run.id}` };
  }
}
