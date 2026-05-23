/**
 * Spec registry. The CLI's `--spec <name>` flag looks up here.
 *
 * Adding a new spec for week 4 evals = one more entry. Registering by name
 * (instead of dynamic file imports) keeps the CLI's runtime simple — no
 * tsx loader gymnastics for arbitrary user-supplied paths.
 */

import type { RunId, Spec } from '@agent-loop/core';
import { buildHardcodedSpec } from './hardcoded.js';

export type SpecBuilder = (runId: RunId, now: string) => Spec;

export const SPECS: Record<string, SpecBuilder> = {
  hardcoded: buildHardcodedSpec,
};

export const SPEC_NAMES: ReadonlyArray<string> = Object.freeze(
  Object.keys(SPECS),
);
