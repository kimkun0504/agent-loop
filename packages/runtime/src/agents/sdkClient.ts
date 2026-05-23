/**
 * Anthropic SDK client factory.
 *
 * One job: take an API key string, return a configured Anthropic client.
 * Agents (triage in Phase D, planner in Phase E) accept a client by
 * dependency injection so tests can pass a fake — they never call the
 * factory themselves.
 *
 * Per CLAUDE.md (Week 3 addition pending): SDK calls go through the agent
 * modules in `packages/runtime/src/agents/`. Do NOT import from
 * `@anthropic-ai/sdk` anywhere else in the project.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface CreateAnthropicClientOptions {
  apiKey: string;
  /** Optional Anthropic-Beta header(s) — passed through. */
  defaultHeaders?: Record<string, string>;
  /** Override the base URL (testing against a recorder, staging, etc.). */
  baseURL?: string;
}

/**
 * Type alias for the SDK client we hand around. Using a type alias keeps the
 * downstream code free of a hard import on the concrete class — tests pass
 * stubs typed against this alias, and a future SDK migration is one type
 * change instead of a project-wide search.
 */
export type AnthropicClient = Anthropic;

export function createAnthropicClient(
  opts: CreateAnthropicClientOptions,
): AnthropicClient {
  if (opts.apiKey.length === 0) {
    throw new Error('createAnthropicClient: apiKey must be non-empty');
  }
  const config: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: opts.apiKey,
  };
  if (opts.defaultHeaders !== undefined) {
    config.defaultHeaders = opts.defaultHeaders;
  }
  if (opts.baseURL !== undefined) {
    config.baseURL = opts.baseURL;
  }
  return new Anthropic(config);
}
