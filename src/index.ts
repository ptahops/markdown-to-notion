/**
 * GitHub Action entry point.
 *
 * Reads inputs via @actions/core, delegates to the sync engine, and sets
 * outputs for downstream steps.
 */

import * as core from '@actions/core';
import { join, isAbsolute } from 'path';

import type { ActionInputs } from './types.js';
import { runSync } from './sync-docs-to-notion.js';
import { getChangedMdPaths } from './sync-changed-docs.js';

function resolveDocsDir(rawDocsDir: string): string {
  if (isAbsolute(rawDocsDir)) return rawDocsDir;
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  return join(workspace, rawDocsDir);
}

function getDocsPrefix(rawDocsDir: string): string {
  // Normalise to forward-slash, no leading ./ , with trailing /
  const cleaned = rawDocsDir.replace(/\\/g, '/').replace(/^\.\//, '');
  return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

async function run(): Promise<void> {
  /* ---- read inputs ---- */
  const notionToken = core.getInput('notion-token', { required: true });
  const notionParentPageId = core.getInput('notion-parent-page-id', { required: true });
  const rawDocsDir = core.getInput('docs-dir') || 'docs';
  const syncMode = (core.getInput('sync-mode') || 'changed') as 'changed' | 'all';
  const gitBefore = core.getInput('git-before') || '';
  const gitAfter = core.getInput('git-after') || '';
  const concurrency = Math.max(1, parseInt(core.getInput('concurrency') || '3', 10));

  const docsDir = resolveDocsDir(rawDocsDir);

  const inputs: ActionInputs = {
    notionToken,
    notionParentPageId,
    docsDir,
    syncMode,
    gitBefore,
    gitAfter,
    concurrency,
  };

  /* ---- determine which files to sync ---- */
  let changedRelPaths: string[] | undefined;

  if (syncMode === 'changed') {
    const hasPushRefs = Boolean(gitBefore && gitAfter);

    if (!hasPushRefs) {
      core.info('No git-before / git-after refs provided. Syncing all docs.');
    } else {
      const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
      const docsPrefix = getDocsPrefix(rawDocsDir);
      const changed = getChangedMdPaths(repoRoot, docsPrefix, gitBefore, gitAfter);

      if (changed === null) {
        core.info('Falling back to syncing all docs (git diff unavailable).');
      } else if (changed.length === 0) {
        core.info('No .md files changed. Nothing to sync.');
        core.setOutput('synced-files', '[]');
        core.setOutput('synced-count', '0');
        return;
      } else {
        core.info(`Detected ${changed.length} changed .md file(s): ${changed.join(', ')}`);
        changedRelPaths = changed;
      }
    }
  } else {
    core.info('Sync mode "all" — syncing every .md file.');
  }

  /* ---- run sync ---- */
  const results = await runSync(inputs, changedRelPaths);

  /* ---- set outputs ---- */
  const syncedFiles = results.map((r) => r.relPath);
  core.setOutput('synced-files', JSON.stringify(syncedFiles));
  core.setOutput('synced-count', String(syncedFiles.length));
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
