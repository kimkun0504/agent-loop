import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectRepoContext,
  DEFAULT_CAPS,
} from '../../src/agents/repoContext.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-loop-ctx-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeFile(path: string, content = 'x'): void {
  const full = join(root, path);
  const dir = full.split('/').slice(0, -1).join('/');
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

describe('collectRepoContext: tree', () => {
  it('lists files at the root', () => {
    makeFile('package.json', '{}');
    makeFile('README.md', '# x');
    const ctx = collectRepoContext(root);
    expect(ctx.tree).toContain('package.json');
    expect(ctx.tree).toContain('README.md');
  });

  it('descends into subdirectories with indent', () => {
    makeFile('src/index.js');
    makeFile('src/math.js');
    makeFile('test/math.test.js');
    const ctx = collectRepoContext(root);
    expect(ctx.tree).toContain('src/');
    expect(ctx.tree).toContain('test/');
    expect(ctx.tree).toMatch(/  index\.js/);
    expect(ctx.tree).toMatch(/  math\.test\.js/);
  });

  it('skips deny-listed directories (node_modules, .git, dist, etc.)', () => {
    makeFile('src/index.js');
    makeFile('node_modules/foo/package.json');
    makeFile('.git/HEAD', 'ref: refs/heads/main');
    makeFile('dist/bundle.js');
    makeFile('.next/cache.bin');
    const ctx = collectRepoContext(root);
    expect(ctx.tree).toContain('index.js');
    expect(ctx.tree).not.toContain('node_modules');
    expect(ctx.tree).not.toContain('.git');
    expect(ctx.tree).not.toContain('dist');
    expect(ctx.tree).not.toContain('.next');
  });

  it('respects maxDepth', () => {
    makeFile('a/b/c/d/e.js');
    const ctx = collectRepoContext(root, { maxDepth: 2 });
    expect(ctx.tree).toContain('a/');
    expect(ctx.tree).toContain('b/');
    expect(ctx.tree).toContain('c/');
    // d/ and e.js are below depth 2
    expect(ctx.tree).not.toContain('d');
    expect(ctx.tree).not.toContain('e.js');
  });

  it('returns empty tree when the target does not exist', () => {
    const ctx = collectRepoContext(join(root, 'does-not-exist'));
    expect(ctx.tree).toBe('');
  });
});

describe('collectRepoContext: file heads', () => {
  it('reads README.md / package.json / CLAUDE.md when present', () => {
    makeFile('README.md', '# project');
    makeFile('package.json', '{"name": "x"}');
    makeFile('CLAUDE.md', '## rules');
    const ctx = collectRepoContext(root);
    expect(ctx.readme).toBe('# project');
    expect(ctx.packageJson).toBe('{"name": "x"}');
    expect(ctx.claudeMd).toBe('## rules');
  });

  it('returns empty string when an optional file is absent', () => {
    const ctx = collectRepoContext(root);
    expect(ctx.readme).toBe('');
    expect(ctx.packageJson).toBe('');
    expect(ctx.claudeMd).toBe('');
  });
});

describe('collectRepoContext: byte caps', () => {
  it('truncates README.md beyond the cap with a marker', () => {
    makeFile('README.md', 'a'.repeat(5_000));
    const ctx = collectRepoContext(root, { caps: { readme: 200 } });
    expect(ctx.readme.length).toBeLessThanOrEqual(200 + 20); // + marker
    expect(ctx.readme).toContain('[truncated]');
  });

  it('truncates the tree beyond the cap with a marker', () => {
    // Make a big-ish tree.
    for (let i = 0; i < 300; i++) {
      makeFile(`src/file-${i}.js`);
    }
    const ctx = collectRepoContext(root, { caps: { tree: 500 } });
    expect(ctx.tree.length).toBeLessThanOrEqual(500 + 20);
    expect(ctx.tree).toContain('[truncated]');
  });

  it('reports per-block usage via capsUsed', () => {
    makeFile('README.md', '# hi');
    makeFile('package.json', '{}');
    makeFile('src/a.js');
    const ctx = collectRepoContext(root);
    expect(ctx.capsUsed.readme).toBe(4);
    expect(ctx.capsUsed.packageJson).toBe(2);
    expect(ctx.capsUsed.tree).toBeGreaterThan(0);
    expect(ctx.totalBytes).toBe(
      ctx.capsUsed.tree +
        ctx.capsUsed.readme +
        ctx.capsUsed.packageJson +
        ctx.capsUsed.claudeMd,
    );
  });

  it('uses default caps when none provided', () => {
    expect(DEFAULT_CAPS.tree).toBe(5_000);
    expect(DEFAULT_CAPS.readme).toBe(2_000);
    expect(DEFAULT_CAPS.packageJson).toBe(1_000);
    expect(DEFAULT_CAPS.claudeMd).toBe(1_000);
  });
});
