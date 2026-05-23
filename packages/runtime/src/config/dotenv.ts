/**
 * Hand-rolled .env loader.
 *
 * Parses files of the form:
 *
 *   # comment lines and blank lines are skipped
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   QUOTED="value with = inside"
 *   SINGLE_QUOTED='another value'
 *
 * Pure function — does NOT mutate `process.env`. Callers read the value
 * and decide what to do with it (typically: pass to an SDK client
 * factory). Per CLAUDE.md "no logging framework" disposition, this is
 * the same logic the `dotenv` package provides minus the features we
 * don't need (variable expansion, multi-line, .env.local cascade).
 *
 * Returns an empty map if the file doesn't exist or can't be read.
 * Malformed lines (no `=`, key starts with a digit, etc.) are skipped
 * silently — same behavior as the `dotenv` package, with the same
 * tradeoff (errors don't surface, but neither does the loader explode
 * on a stray comment-ish line).
 */

import { existsSync, readFileSync } from 'node:fs';

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadDotenvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  return parseDotenv(content);
}

/**
 * Exported for tests. Parses a string in the .env format and returns a
 * plain map. Strips surrounding quotes ('…' or "…") and ignores
 * comments / blank lines / malformed entries.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!VALID_KEY.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // Strip a single layer of surrounding matching quotes.
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}
