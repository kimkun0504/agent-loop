/**
 * Tests the factory's input validation and config-pass-through. Does NOT
 * make any real API calls. Reaching into the constructed Anthropic
 * instance for its config (e.g. `.apiKey`) is intentional — we want to
 * fail loudly if the SDK ever reshapes its surface so we can update the
 * tight pin and our usage in lockstep.
 */

import { describe, expect, it } from 'vitest';
import { createAnthropicClient } from '../../src/agents/sdkClient.js';

describe('createAnthropicClient', () => {
  it('throws on empty apiKey', () => {
    expect(() => createAnthropicClient({ apiKey: '' })).toThrow(/non-empty/);
  });

  it('returns an instance with the configured apiKey', () => {
    const client = createAnthropicClient({ apiKey: 'sk-ant-test' });
    // The SDK stores apiKey as a public field; we lock that surface here so
    // a future SDK that hides it surfaces the breakage in this one test.
    expect((client as unknown as { apiKey: string }).apiKey).toBe('sk-ant-test');
  });

  it('passes defaultHeaders through to the SDK', () => {
    const client = createAnthropicClient({
      apiKey: 'sk-ant-test',
      defaultHeaders: { 'X-Anthropic-Beta': 'foo' },
    });
    const sentHeaders = (client as unknown as {
      _options?: { defaultHeaders?: Record<string, string> };
    })._options?.defaultHeaders;
    // The SDK may flatten / merge headers internally — assert ours appears
    // somewhere. If the SDK changes its internal config shape, this test
    // fails and we update both pin and code together.
    expect(sentHeaders?.['X-Anthropic-Beta']).toBe('foo');
  });

  it('passes baseURL through to the SDK', () => {
    const client = createAnthropicClient({
      apiKey: 'sk-ant-test',
      baseURL: 'https://recorder.test/v1',
    });
    expect(
      (client as unknown as { baseURL: string }).baseURL,
    ).toBe('https://recorder.test/v1');
  });
});
