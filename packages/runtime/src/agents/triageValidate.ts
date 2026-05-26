/**
 * Hand-rolled semantic validator for the triage tool output.
 *
 * The SDK's input_schema gives us structural validity (right field
 * types, required fields present). This module enforces the rules the
 * schema can't easily express:
 *
 *   - the `kind` discriminator matches a populated branch
 *   - `fileScope` is not the no-scope "everything" pattern
 *   - bullet arrays are within size bounds
 *   - string length minimums (empty strings sneak past `type: string`)
 *
 * Returns the validated TriageProducedSpec or a flat list of error
 * messages — same envelope shape as the dotenv parser's "skip with
 * reason" pattern. Errors get fed back into the retry user prompt so
 * the model can correct course.
 */

import type { FileStateCheck } from '@agent-loop/core';
import {
  VALID_TEST_COMMANDS,
  type TriageProducedSpec,
  type TriageRejectionReason,
  type ValidTestCommand,
} from './triageSchema.js';

const VALID_FILE_STATE_TYPES = new Set<FileStateCheck['type']>([
  'unchanged',
  'deleted',
  'exists',
  'absent',
]);

export type ValidatedTriage =
  | { kind: 'spec'; spec: TriageProducedSpec }
  | {
      kind: 'rejection';
      reason: Exclude<TriageRejectionReason, 'invalid_output' | 'sdk_error'>;
      message: string;
      clarifyingQuestions?: string[];
    };

export interface ValidationFailure {
  errors: string[];
}

const FORBIDDEN_GLOBS = new Set(['**/*', '**', '*', '*.*']);
const MAX_ACCEPTANCE = 12;
const MAX_TEST_COMMANDS = 5;

export function validateTriageOutput(
  raw: unknown,
): ValidatedTriage | ValidationFailure {
  if (!isRecord(raw)) {
    return { errors: ['tool input is not a JSON object'] };
  }

  const kind = raw['kind'];
  if (kind === 'spec') {
    return validateSpecBranch(raw);
  }
  if (kind === 'rejection') {
    return validateRejectionBranch(raw);
  }
  return {
    errors: [
      `field "kind" must be "spec" or "rejection"; got ${JSON.stringify(kind)}`,
    ],
  };
}

function validateSpecBranch(raw: Record<string, unknown>): ValidatedTriage | ValidationFailure {
  const errors: string[] = [];
  const spec = raw['spec'];
  if (!isRecord(spec)) {
    return { errors: ['kind is "spec" but "spec" field is missing or not an object'] };
  }

  const title = nonEmptyString(spec['title'], 'spec.title', errors, 200);
  const description = nonEmptyString(spec['description'], 'spec.description', errors, 5_000);
  const fileScope = nonEmptyStringArray(spec['fileScope'], 'spec.fileScope', errors, 1);
  const acceptance = nonEmptyStringArray(
    spec['acceptanceCriteria'],
    'spec.acceptanceCriteria',
    errors,
    1,
  );
  const testCommands = stringArray(
    spec['testCommands'],
    'spec.testCommands',
    errors,
  );

  if (fileScope && fileScope.some((g) => FORBIDDEN_GLOBS.has(g))) {
    errors.push(
      `spec.fileScope contains a forbidden catch-all glob (${[...FORBIDDEN_GLOBS].join(', ')}); name specific files or use narrower globs like "src/**/*.js"`,
    );
  }
  if (acceptance && acceptance.length > MAX_ACCEPTANCE) {
    errors.push(
      `spec.acceptanceCriteria has ${acceptance.length} entries; max is ${MAX_ACCEPTANCE}`,
    );
  }
  if (testCommands && testCommands.length > MAX_TEST_COMMANDS) {
    errors.push(
      `spec.testCommands has ${testCommands.length} entries; max is ${MAX_TEST_COMMANDS}`,
    );
  }
  if (testCommands) {
    const validSet = new Set<string>(VALID_TEST_COMMANDS);
    const invalid = testCommands.filter((c) => !validSet.has(c));
    if (invalid.length > 0) {
      errors.push(
        `spec.testCommands contains commands outside the allowed vocabulary: ${invalid
          .map((c) => JSON.stringify(c))
          .join(', ')}. Allowed: ${VALID_TEST_COMMANDS.join(', ')}. Move file-state assertions (no-X-remains, don't-touch-Y, file-Z-exists) into acceptanceCriteria as natural language — the semantic verifier will judge them against the diff.`,
      );
    }
  }

  // fileStateChecks: optional; when present, validate each entry.
  let fileStateChecks: FileStateCheck[] | undefined;
  if (spec['fileStateChecks'] !== undefined) {
    const raw = spec['fileStateChecks'];
    if (!Array.isArray(raw)) {
      errors.push('spec.fileStateChecks must be an array when present');
    } else {
      const validated: FileStateCheck[] = [];
      for (let i = 0; i < raw.length; i++) {
        const entry = raw[i];
        if (!isRecord(entry)) {
          errors.push(`spec.fileStateChecks[${i}]: not an object`);
          continue;
        }
        const t = entry['type'];
        const p = entry['path'];
        if (typeof t !== 'string' || !VALID_FILE_STATE_TYPES.has(t as FileStateCheck['type'])) {
          errors.push(
            `spec.fileStateChecks[${i}].type: must be one of ${[...VALID_FILE_STATE_TYPES].join(', ')}; got ${JSON.stringify(t)}`,
          );
          continue;
        }
        if (typeof p !== 'string' || p.length === 0) {
          errors.push(`spec.fileStateChecks[${i}].path: missing or empty string`);
          continue;
        }
        validated.push({ type: t as FileStateCheck['type'], path: p });
      }
      if (raw.length > 0 && errors.length === 0) {
        fileStateChecks = validated;
      } else if (raw.length === 0) {
        // Empty array is permitted; semantically equivalent to absence.
        fileStateChecks = [];
      }
    }
  }

  if (errors.length > 0) return { errors };
  const spec_out: TriageProducedSpec = {
    title: title!,
    description: description!,
    fileScope: fileScope!,
    acceptanceCriteria: acceptance!,
    testCommands: testCommands!,
  };
  if (fileStateChecks !== undefined) spec_out.fileStateChecks = fileStateChecks;
  return { kind: 'spec', spec: spec_out };
}

function validateRejectionBranch(
  raw: Record<string, unknown>,
): ValidatedTriage | ValidationFailure {
  const errors: string[] = [];
  const rejection = raw['rejection'];
  if (!isRecord(rejection)) {
    return {
      errors: ['kind is "rejection" but "rejection" field is missing or not an object'],
    };
  }

  const reason = rejection['reason'];
  const validReasons = ['not_actionable', 'too_vague', 'out_of_scope'] as const;
  if (typeof reason !== 'string' || !validReasons.includes(reason as never)) {
    errors.push(
      `rejection.reason must be one of ${validReasons.join(', ')}; got ${JSON.stringify(reason)}`,
    );
  }
  const message = nonEmptyString(rejection['message'], 'rejection.message', errors, 1_000);

  let clarifyingQuestions: string[] | undefined;
  if (rejection['clarifyingQuestions'] !== undefined) {
    const cq = rejection['clarifyingQuestions'];
    if (!Array.isArray(cq) || !cq.every((s) => typeof s === 'string' && s.length > 0)) {
      errors.push('rejection.clarifyingQuestions must be an array of non-empty strings');
    } else {
      clarifyingQuestions = cq as string[];
    }
  }

  if (errors.length > 0) return { errors };

  const result: Extract<ValidatedTriage, { kind: 'rejection' }> = {
    kind: 'rejection',
    reason: reason as Extract<ValidatedTriage, { kind: 'rejection' }>['reason'],
    message: message!,
  };
  if (clarifyingQuestions !== undefined) {
    result.clarifyingQuestions = clarifyingQuestions;
  }
  return result;
}

// --- low-level helpers ----------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(
  v: unknown,
  field: string,
  errors: string[],
  maxLen: number,
): string | null {
  if (typeof v !== 'string') {
    errors.push(`${field} must be a string`);
    return null;
  }
  const trimmed = v.trim();
  if (trimmed.length === 0) {
    errors.push(`${field} must be non-empty`);
    return null;
  }
  if (v.length > maxLen) {
    errors.push(`${field} exceeds ${maxLen} characters (${v.length})`);
    return null;
  }
  return v;
}

function nonEmptyStringArray(
  v: unknown,
  field: string,
  errors: string[],
  minLen: number,
): string[] | null {
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array`);
    return null;
  }
  if (v.length < minLen) {
    errors.push(`${field} must have at least ${minLen} entr${minLen === 1 ? 'y' : 'ies'}`);
    return null;
  }
  if (!v.every((s) => typeof s === 'string' && s.trim().length > 0)) {
    errors.push(`${field} must contain non-empty strings`);
    return null;
  }
  return v as string[];
}

/**
 * Like nonEmptyStringArray but allows empty arrays. Used for testCommands,
 * which may be empty for tasks verifiable purely via acceptanceCriteria
 * (docs-only changes, README edits, etc.).
 */
function stringArray(
  v: unknown,
  field: string,
  errors: string[],
): string[] | null {
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array`);
    return null;
  }
  if (!v.every((s) => typeof s === 'string' && s.length > 0)) {
    errors.push(`${field} must contain non-empty strings`);
    return null;
  }
  return v as string[];
}
