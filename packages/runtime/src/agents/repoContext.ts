/**
 * Collect a bounded view of the target repo for inclusion in agent prompts.
 *
 * Triage (Phase D) and planner (Phase E) both need to "see" the repo to
 * produce useful specs/plans. Without bounds, a large repo blows up the
 * prompt cost; without selection, we'd send irrelevant noise. This module
 * gives us a small, predictable context block:
 *
 *   - file tree (depth-limited, deny-listed) — capped at TREE_CAP bytes
 *   - README.md head — capped at README_CAP bytes
 *   - package.json head — capped at PACKAGE_JSON_CAP bytes
 *   - CLAUDE.md head — capped at CLAUDE_MD_CAP bytes
 *
 * Total target: ~10 KB. Real repos will exceed some caps; the snippets
 * get truncated with a `... [truncated]` marker so the model knows.
 *
 * Pure I/O: synchronous fs reads against a path. No network.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface RepoContextSnapshot {
  tree: string;
  readme: string;
  packageJson: string;
  claudeMd: string;
  /** Total byte size of all four blocks. */
  totalBytes: number;
  /** Per-block byte usage; helpful when iterating on prompt sizing. */
  capsUsed: {
    tree: number;
    readme: number;
    packageJson: number;
    claudeMd: number;
  };
}

export const DEFAULT_CAPS = {
  tree: 5_000,
  readme: 2_000,
  packageJson: 1_000,
  claudeMd: 1_000,
} as const;

const DENY_LIST = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vscode',
  '.idea',
  '.DS_Store',
]);

const DEFAULT_MAX_DEPTH = 3;

export interface CollectOptions {
  caps?: Partial<typeof DEFAULT_CAPS>;
  maxDepth?: number;
}

export function collectRepoContext(
  target: string,
  opts: CollectOptions = {},
): RepoContextSnapshot {
  const caps = { ...DEFAULT_CAPS, ...(opts.caps ?? {}) };
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const tree = truncate(buildTree(target, maxDepth), caps.tree);
  const readme = readFileHead(join(target, 'README.md'), caps.readme);
  const packageJson = readFileHead(join(target, 'package.json'), caps.packageJson);
  const claudeMd = readFileHead(join(target, 'CLAUDE.md'), caps.claudeMd);

  const capsUsed = {
    tree: tree.length,
    readme: readme.length,
    packageJson: packageJson.length,
    claudeMd: claudeMd.length,
  };
  const totalBytes =
    capsUsed.tree + capsUsed.readme + capsUsed.packageJson + capsUsed.claudeMd;

  return { tree, readme, packageJson, claudeMd, totalBytes, capsUsed };
}

// --- Helpers ---------------------------------------------------------------

/**
 * Build a tree-style listing of the repo, depth-limited and deny-listed.
 * Output looks like:
 *   src/
 *     index.js
 *     math.js
 *   test/
 *     math.test.js
 *   package.json
 */
function buildTree(root: string, maxDepth: number): string {
  if (!existsSync(root)) return '';
  const lines: string[] = [];
  walk(root, root, 0, maxDepth, lines);
  return lines.join('\n');
}

function walk(
  root: string,
  current: string,
  depth: number,
  maxDepth: number,
  out: string[],
): void {
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(current).sort();
  } catch {
    return;
  }
  // Directories first, then files; both sorted alphabetically.
  const dirs: string[] = [];
  const files: string[] = [];
  for (const name of entries) {
    if (DENY_LIST.has(name)) continue;
    const p = join(current, name);
    try {
      const s = statSync(p);
      if (s.isDirectory()) dirs.push(name);
      else if (s.isFile()) files.push(name);
    } catch {
      // unreadable entry — skip
    }
  }
  for (const name of dirs) {
    const relPath = relative(root, join(current, name));
    out.push(`${'  '.repeat(depth)}${formatPath(relPath)}/`);
    walk(root, join(current, name), depth + 1, maxDepth, out);
  }
  for (const name of files) {
    const relPath = relative(root, join(current, name));
    out.push(`${'  '.repeat(depth)}${formatPath(relPath)}`);
  }
}

function formatPath(p: string): string {
  // Tree shows just the last segment at each depth — the indent already
  // conveys the hierarchy.
  const parts = p.split(sep);
  return parts[parts.length - 1] ?? p;
}

function readFileHead(path: string, cap: number): string {
  if (!existsSync(path)) return '';
  try {
    const content = readFileSync(path, 'utf8');
    return truncate(content, cap);
  } catch {
    return '';
  }
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + '\n... [truncated]';
}

// --- File contents (planner-only) -----------------------------------------

/**
 * The planner needs to see actual code, not just the tree. This helper
 * reads file contents up to a total byte cap.
 *
 * Path resolution:
 *   - Literal paths (no `*`) are read directly.
 *   - Globs are matched against the repo tree via a small built-in matcher
 *     (`**` for any-depth, `*` for one segment). No `picomatch` dep.
 *
 * Files are added in order — literals first, then glob matches sorted by
 * path — and we stop once `totalCap` bytes are reached. Later files
 * appear with `omitted: true` so the model knows context was truncated.
 *
 * Kept separate from `collectRepoContext` because triage stays light (no
 * file contents) — see `gap-triage-thin-context` in BACKLOG for the
 * design tension.
 */

export interface FileContentSnapshot {
  path: string;
  content: string;
  lines: number;
  /** True when the file matched but was dropped (cap reached before its turn). */
  omitted: boolean;
  /** True when the file was read but truncated by the per-file cap. */
  truncated: boolean;
}

const PER_FILE_CAP = 8_000;
const DEFAULT_TOTAL_CAP = 30_000;

export function collectFileContents(
  target: string,
  paths: ReadonlyArray<string>,
  totalCap: number = DEFAULT_TOTAL_CAP,
): FileContentSnapshot[] {
  if (!existsSync(target)) return [];

  const { literals, globs } = partition(paths);
  const literalEntries = literals
    .map((p) => ({ rel: p, abs: join(target, p) }))
    .filter((p) => existsSync(p.abs));

  const allFiles = globs.length > 0 ? walkFiles(target, target, 0) : [];
  const matched = allFiles
    .filter((p) => globs.some((g) => globMatches(g, p)))
    .filter((p) => !literalEntries.some((l) => l.rel === p))
    .sort();

  const out: FileContentSnapshot[] = [];
  let used = 0;
  const reading = [...literalEntries.map((l) => l.rel), ...matched];

  for (const rel of reading) {
    const snapshot = readOneFile(join(target, rel), rel, used, totalCap);
    out.push(snapshot);
    used += snapshot.content.length;
  }
  return out;
}

function readOneFile(
  abs: string,
  rel: string,
  used: number,
  totalCap: number,
): FileContentSnapshot {
  if (used >= totalCap) {
    return { path: rel, content: '', lines: 0, omitted: true, truncated: false };
  }
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    return { path: rel, content: '', lines: 0, omitted: true, truncated: false };
  }
  const headroom = totalCap - used;
  const cap = Math.min(PER_FILE_CAP, headroom);
  const truncated = raw.length > cap;
  const content = truncated ? raw.slice(0, cap) + '\n... [truncated]' : raw;
  return {
    path: rel,
    content,
    lines: raw.split('\n').length,
    omitted: false,
    truncated,
  };
}

function partition(paths: ReadonlyArray<string>): {
  literals: string[];
  globs: string[];
} {
  const literals: string[] = [];
  const globs: string[] = [];
  for (const p of paths) {
    if (p.includes('*')) globs.push(p);
    else literals.push(p);
  }
  return { literals, globs };
}

function walkFiles(root: string, current: string, depth: number): string[] {
  if (depth > DEFAULT_MAX_DEPTH + 1) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(current).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    if (DENY_LIST.has(name)) continue;
    const abs = join(current, name);
    try {
      const s = statSync(abs);
      if (s.isFile()) {
        out.push(relative(root, abs));
      } else if (s.isDirectory()) {
        out.push(...walkFiles(root, abs, depth + 1));
      }
    } catch {
      // unreadable
    }
  }
  return out;
}

/**
 * Tiny glob matcher. `**` matches any chars including `/`; `*` matches any
 * chars except `/`. Anchored at both ends. Exported for tests.
 */
export function globMatches(glob: string, path: string): boolean {
  const re = new RegExp(`^${globToRegex(glob)}$`);
  return re.test(path);
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '/' || /[a-zA-Z0-9_\-.]/.test(ch)) {
      out += ch;
    } else {
      out += '\\' + ch;
    }
  }
  return out;
}
