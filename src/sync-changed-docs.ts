/**
 * Determines which Markdown files changed between two git refs and returns
 * their relative paths (relative to the docs directory).
 *
 * Used when sync-mode is "changed" — only the git-diffed `.md` files (plus any
 * that don't yet have a notion_page_id) are synced.
 */

import { execSync } from 'child_process';
import * as core from '@actions/core';

/**
 * Returns relative paths (to `docsPrefix`) of `.md` files that changed between
 * `baseRef` and `headRef`.
 *
 * Returns `null` if git diff fails (e.g. shallow clone / invalid ref) — the
 * caller should fall back to syncing all docs.
 *
 * @param repoRoot  Absolute path to the repository root.
 * @param docsPrefix  The docs directory prefix, e.g. "docs/" (with trailing slash).
 * @param baseRef  Git ref before the push (e.g. GIT_BEFORE).
 * @param headRef  Git ref after the push (e.g. GIT_AFTER).
 */
export function getChangedMdPaths(
  repoRoot: string,
  docsPrefix: string,
  baseRef: string,
  headRef: string,
): string[] | null {
  const prefix = docsPrefix.endsWith('/') ? docsPrefix : `${docsPrefix}/`;

  try {
    const out = execSync(`git diff --name-only ${baseRef} ${headRef}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    const lines = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const relPaths: string[] = [];
    for (const line of lines) {
      const normalized = line.replace(/\\/g, '/');
      if (!normalized.toLowerCase().endsWith('.md')) continue;
      if (normalized === prefix || normalized === prefix.slice(0, -1)) continue;
      if (normalized.startsWith(prefix)) {
        relPaths.push(normalized.slice(prefix.length));
      }
    }

    return [...new Set(relPaths)];
  } catch (err: unknown) {
    const e = err as { status?: number };
    if (e?.status === 128) {
      core.warning(
        'Git diff failed (maybe shallow clone or invalid ref). Falling back to syncing all docs.',
      );
      return null;
    }
    throw err;
  }
}
