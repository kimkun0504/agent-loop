/**
 * Per-MTok prices for the models the runtime calls directly. Hardcoded
 * for now; if the model list grows past 3-4 entries this is the place
 * to graduate to a price table keyed by model id (or pulled from the
 * SDK if that ever exposes pricing). The dollar number is for the audit
 * trail / cost reports — getting it within 10% is good enough.
 *
 * Triage uses Haiku. Planner and the semantic verifier (verifier/semantic.ts)
 * both use Sonnet. Costs match the public per-MTok rates as of January 2026.
 */

export interface ModelPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

export const HAIKU_PRICING: ModelPricing = {
  input: 1.0,
  output: 5.0,
  cacheRead: 0.10,
  cacheCreate: 1.25,
};

export const SONNET_PRICING: ModelPricing = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.30,
  cacheCreate: 3.75,
};
