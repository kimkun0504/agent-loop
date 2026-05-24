/**
 * Hand-rolled semantic validator for the planner tool output.
 *
 * SDK schema gives structural validity; this enforces the rules the schema
 * can't easily express:
 *   - the kind discriminator matches a populated branch
 *   - filesToTouch entries have valid actions and non-empty paths
 *   - approach / testStrategy non-empty
 *   - max-length and array-bounds beyond the JSON-schema minimums
 *
 * Pattern mirrors triageValidate — same envelope shape (validated | errors).
 */

import type { PlannedFileChange } from '@agent-loop/core';
import type {
  PlannerProducedPlan,
  PlannerRejectionReason,
} from './plannerSchema.js';

export type ValidatedPlanner =
  | { kind: 'plan'; plan: PlannerProducedPlan }
  | {
      kind: 'rejection';
      reason: Exclude<PlannerRejectionReason, 'invalid_output' | 'sdk_error'>;
      message: string;
    };

export interface PlannerValidationFailure {
  errors: string[];
}

const VALID_ACTIONS = new Set<PlannedFileChange['action']>([
  'create',
  'modify',
  'delete',
]);

const MAX_FILES = 30;
const MAX_RISKS = 10;

export function validatePlannerOutput(
  raw: unknown,
): ValidatedPlanner | PlannerValidationFailure {
  if (!isRecord(raw)) {
    return { errors: ['tool input is not a JSON object'] };
  }
  const kind = raw['kind'];
  if (kind === 'plan') return validatePlanBranch(raw);
  if (kind === 'rejection') return validateRejectionBranch(raw);
  return {
    errors: [
      `field "kind" must be "plan" or "rejection"; got ${JSON.stringify(kind)}`,
    ],
  };
}

function validatePlanBranch(
  raw: Record<string, unknown>,
): ValidatedPlanner | PlannerValidationFailure {
  const errors: string[] = [];
  const plan = raw['plan'];
  if (!isRecord(plan)) {
    return { errors: ['kind is "plan" but "plan" field is missing or not an object'] };
  }

  const filesToTouch = validateFiles(plan['filesToTouch'], errors);
  const approach = nonEmptyString(plan['approach'], 'plan.approach', errors, 3_000);
  const testStrategy = nonEmptyString(
    plan['testStrategy'],
    'plan.testStrategy',
    errors,
    1_500,
  );
  const risks = validateRisks(plan['risks'], errors);

  if (errors.length > 0) return { errors };
  return {
    kind: 'plan',
    plan: {
      filesToTouch: filesToTouch!,
      approach: approach!,
      risks: risks!,
      testStrategy: testStrategy!,
    },
  };
}

function validateFiles(
  v: unknown,
  errors: string[],
): PlannedFileChange[] | null {
  if (!Array.isArray(v) || v.length === 0) {
    errors.push('plan.filesToTouch must be a non-empty array');
    return null;
  }
  if (v.length > MAX_FILES) {
    errors.push(`plan.filesToTouch has ${v.length} entries; max is ${MAX_FILES}`);
    return null;
  }
  const out: PlannedFileChange[] = [];
  for (let i = 0; i < v.length; i++) {
    const entry = v[i];
    if (!isRecord(entry)) {
      errors.push(`plan.filesToTouch[${i}] is not an object`);
      continue;
    }
    const path = entry['path'];
    const action = entry['action'];
    const reason = entry['reason'];
    if (typeof path !== 'string' || path.trim().length === 0) {
      errors.push(`plan.filesToTouch[${i}].path must be a non-empty string`);
      continue;
    }
    if (
      typeof action !== 'string' ||
      !VALID_ACTIONS.has(action as PlannedFileChange['action'])
    ) {
      errors.push(
        `plan.filesToTouch[${i}].action must be one of: ${[...VALID_ACTIONS].join(', ')}`,
      );
      continue;
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      errors.push(`plan.filesToTouch[${i}].reason must be a non-empty string`);
      continue;
    }
    out.push({
      path,
      action: action as PlannedFileChange['action'],
      reason,
    });
  }
  return errors.length > 0 ? null : out;
}

function validateRisks(v: unknown, errors: string[]): string[] | null {
  // risks may be empty; required to be an array.
  if (!Array.isArray(v)) {
    errors.push('plan.risks must be an array (use [] for low-risk changes)');
    return null;
  }
  if (v.length > MAX_RISKS) {
    errors.push(`plan.risks has ${v.length} entries; max is ${MAX_RISKS}`);
    return null;
  }
  if (!v.every((s) => typeof s === 'string' && s.trim().length > 0)) {
    errors.push('plan.risks entries must be non-empty strings');
    return null;
  }
  return v as string[];
}

function validateRejectionBranch(
  raw: Record<string, unknown>,
): ValidatedPlanner | PlannerValidationFailure {
  const errors: string[] = [];
  const rejection = raw['rejection'];
  if (!isRecord(rejection)) {
    return {
      errors: ['kind is "rejection" but "rejection" field is missing or not an object'],
    };
  }
  if (rejection['reason'] !== 'unimplementable') {
    errors.push(
      `rejection.reason must be "unimplementable"; got ${JSON.stringify(rejection['reason'])}`,
    );
  }
  const message = nonEmptyString(rejection['message'], 'rejection.message', errors, 1_000);
  if (errors.length > 0) return { errors };
  return {
    kind: 'rejection',
    reason: 'unimplementable',
    message: message!,
  };
}

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
