/**
 * Core sync logic: reads Markdown files from disk, converts them to Notion
 * blocks, and creates/updates the corresponding Notion pages while preserving
 * the folder hierarchy.
 *
 * Fully parameterised — no direct process.env reads; receives a typed config
 * object from the caller.
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { Client } from '@notionhq/client';
import * as core from '@actions/core';

import type { ActionInputs, NotionClient, ParsedRelPath, SyncResult } from './types.js';
import { parseMdWithNotionId, stringifyMdWithNotionId } from './md-frontmatter.js';
import { convertMarkdownToNotionBlocks } from './markdown-to-blocks.js';
import {
  createSubpage,
  ensureFolderPagesCache,
  getParentPageId,
  notionRetrievePageIfExists,
  runWithConcurrency,
  sendPageToTrash,
} from './notion-helpers.js';

const NOTION_BLOCK_CHUNK_SIZE = 100;

/* ------------------------------------------------------------------ */
/*  File collection                                                    */
/* ------------------------------------------------------------------ */

/** Recursively collects all `.md` files under `dir`, returning paths relative to `base`. */
export function collectMdFiles(dir: string, base: string = dir): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...collectMdFiles(full, base));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      files.push(relative(base, full).replace(/\\/g, '/'));
    }
  }
  return files.sort();
}

/* ------------------------------------------------------------------ */
/*  Path / title helpers                                               */
/* ------------------------------------------------------------------ */

function normalizeTitle(s: string): string {
  return (s ?? '').trim();
}

/** "foo/bar.md" → "Bar", "README.md" at root → "README", "folder/README.md" → folder name */
function pathToDisplayTitle(relativePath: string): string {
  const withoutExt = relativePath.replace(/\.md$/i, '');
  const parts = withoutExt.split('/');
  const last = parts[parts.length - 1];

  if (last.toUpperCase() === 'README') {
    const folder = parts[parts.length - 2];
    return folder
      ? folder.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'README';
  }
  return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function parseRelPath(relativePath: string): ParsedRelPath {
  const docTitle = pathToDisplayTitle(relativePath);
  const parts = relativePath.replace(/\.md$/i, '').split('/');

  if (parts.length <= 1) {
    return { folderName: null, folderTitle: null, docTitle: normalizeTitle(docTitle) };
  }

  const folderName = parts[0];
  const folderTitle = folderName
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    folderName,
    folderTitle: normalizeTitle(folderTitle),
    docTitle: normalizeTitle(docTitle),
  };
}

/** Returns the set of unique folder titles from a list of relative doc paths. */
function getUniqueFolderTitles(relPaths: string[]): Set<string> {
  const set = new Set<string>();
  for (const relPath of relPaths) {
    const { folderTitle } = parseRelPath(relPath);
    if (folderTitle != null) set.add(folderTitle);
  }
  return set;
}

/* ------------------------------------------------------------------ */
/*  Block chunking                                                     */
/* ------------------------------------------------------------------ */

function chunkBlocks<T>(blocks: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < blocks.length; i += size) {
    chunks.push(blocks.slice(i, i + size));
  }
  return chunks;
}

/* ------------------------------------------------------------------ */
/*  Notion parent resolution                                           */
/* ------------------------------------------------------------------ */

function resolveNotionParentId(
  rootPageId: string,
  folderTitle: string | null,
  folderPageCache: Map<string, string>,
): string {
  if (folderTitle == null) return rootPageId;
  return folderPageCache.get(folderTitle) ?? rootPageId;
}

async function resolveExistingDocPageId(
  notion: NotionClient,
  notionPageIdFromFrontmatter: string | null,
  validatedPageIds: Set<string>,
): Promise<string | null> {
  const id = notionPageIdFromFrontmatter != null ? notionPageIdFromFrontmatter.trim() : '';
  if (!id) return null;
  if (validatedPageIds.has(id)) return id;

  const page = await notionRetrievePageIfExists(notion, id);
  if (page != null) {
    validatedPageIds.add(id);
    return id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Single-doc sync                                                    */
/* ------------------------------------------------------------------ */

async function syncOneDoc(
  notion: NotionClient,
  rootPageId: string,
  docsDir: string,
  folderPageCache: Map<string, string>,
  validatedPageIds: Set<string>,
  relPath: string,
): Promise<SyncResult> {
  const fullPath = join(docsDir, relPath);
  const rawContent = readFileSync(fullPath, 'utf-8');
  const { body, notionPageId, data } = parseMdWithNotionId(rawContent);
  const { folderTitle, docTitle } = parseRelPath(relPath);
  const blocks = convertMarkdownToNotionBlocks(body);
  const blockChunks = chunkBlocks(blocks, NOTION_BLOCK_CHUNK_SIZE);
  const parentPageId = resolveNotionParentId(rootPageId, folderTitle, folderPageCache);

  const existingPageId = await resolveExistingDocPageId(notion, notionPageId, validatedPageIds);

  if (existingPageId != null) {
    await sendPageToTrash(notion, existingPageId);
    const newPageId = await createSubpage(notion, parentPageId, docTitle, blockChunks);
    const newContent = stringifyMdWithNotionId(body, data, newPageId);
    writeFileSync(fullPath, newContent, 'utf-8');
    return { action: 'updated', title: docTitle, relPath, parent: folderTitle ?? '(root)' };
  }

  const newPageId = await createSubpage(notion, parentPageId, docTitle, blockChunks);
  const newContent = stringifyMdWithNotionId(body, data, newPageId);
  writeFileSync(fullPath, newContent, 'utf-8');
  return { action: 'created', title: docTitle, relPath, parent: folderTitle ?? '(root)' };
}

/* ------------------------------------------------------------------ */
/*  Docs without a page id (first upload)                              */
/* ------------------------------------------------------------------ */

function addDocsWithoutPageId(docsDir: string, relPathsSet: Set<string>): void {
  const allMd = collectMdFiles(docsDir, docsDir);
  for (const relPath of allMd) {
    const raw = readFileSync(join(docsDir, relPath), 'utf-8');
    const { notionPageId } = parseMdWithNotionId(raw);
    const id = notionPageId != null ? notionPageId.trim() : '';
    if (!id) relPathsSet.add(relPath);
  }
}

/* ------------------------------------------------------------------ */
/*  Public entry point                                                 */
/* ------------------------------------------------------------------ */

/**
 * Runs the full Notion sync.
 *
 * @param inputs  Typed action configuration (no process.env reads inside).
 * @param optionalRelPaths  If provided, only these .md files (plus any missing
 *   notion_page_id) are synced. Pass `undefined` to sync every .md in docsDir.
 * @returns Array of sync results (one per document).
 */
export async function runSync(
  inputs: ActionInputs,
  optionalRelPaths?: string[],
): Promise<SyncResult[]> {
  const { notionToken, notionParentPageId: rootPageId, docsDir, concurrency } = inputs;

  const notion: NotionClient = new Client({ auth: notionToken });

  let mdFiles: string[];
  if (optionalRelPaths != null) {
    const set = new Set(optionalRelPaths);
    addDocsWithoutPageId(docsDir, set);
    mdFiles = [...set].sort();
  } else {
    mdFiles = collectMdFiles(docsDir, docsDir);
  }

  if (mdFiles.length === 0) {
    core.info('No .md files to sync.');
    return [];
  }

  core.info(`Syncing ${mdFiles.length} doc(s)…`);

  /* -- pre-pass: validate existing page ids & warm folder cache -- */
  const initialFolderCache = new Map<string, string>();
  const validatedPageIds = new Set<string>();

  const prePassTasks = mdFiles.map((relPath) => async () => {
    const fullPath = join(docsDir, relPath);
    const rawContent = readFileSync(fullPath, 'utf-8');
    const { notionPageId } = parseMdWithNotionId(rawContent);
    const { folderTitle } = parseRelPath(relPath);

    if (notionPageId == null) return;
    const page = await notionRetrievePageIfExists(notion, notionPageId);
    if (page == null) return;
    validatedPageIds.add(notionPageId);

    if (folderTitle != null) {
      const parentId = getParentPageId(page);
      if (parentId) initialFolderCache.set(folderTitle, parentId);
    }
  });
  await runWithConcurrency(prePassTasks, concurrency);

  /* -- ensure folder pages -- */
  const folderTitles = getUniqueFolderTitles(mdFiles);
  const folderPageCache = await ensureFolderPagesCache(
    notion,
    rootPageId,
    folderTitles,
    initialFolderCache,
  );

  /* -- sync each doc -- */
  const taskFns = mdFiles.map(
    (relPath) => () =>
      syncOneDoc(notion, rootPageId, docsDir, folderPageCache, validatedPageIds, relPath),
  );
  const results = await runWithConcurrency(taskFns, concurrency);

  for (const result of results) {
    core.info(
      `${result.action === 'updated' ? 'Updated' : 'Created'}: ${result.title} (${result.relPath}) [under ${result.parent}]`,
    );
  }
  core.info(`Done. Synced ${mdFiles.length} doc(s).`);
  return results;
}
