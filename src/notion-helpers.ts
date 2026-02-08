/**
 * Notion API helper utilities.
 *
 * Extracted from the original sync-docs-to-notion.mjs — folder page cache,
 * page CRUD, title matching, and a bounded-concurrency runner.
 */

import type { NotionClient } from './types.js';

/* ------------------------------------------------------------------ */
/*  Title normalisation                                                */
/* ------------------------------------------------------------------ */

/** Normalise a title for comparison: lowercase, dashes/underscores → space, collapse whitespace. */
export function normalizeTitleForMatch(s: string | null | undefined): string {
  if (s == null || typeof s !== 'string') return '';
  return s
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Robust title comparison (normalised). */
export function titlesMatch(a: string, b: string): boolean {
  const x = normalizeTitleForMatch(a);
  const y = normalizeTitleForMatch(b);
  return x.length > 0 && x === y;
}

/* ------------------------------------------------------------------ */
/*  Block / page helpers                                               */
/* ------------------------------------------------------------------ */

/** Full title of a child_page block (may have multiple rich text segments). */
function getBlockTitle(block: Record<string, unknown>): string {
  const cp = block?.child_page as
    | { title?: Array<{ plain_text?: string }> }
    | undefined;
  const titleArr = cp?.title;
  if (!Array.isArray(titleArr)) return '';
  return titleArr
    .map((t) => t?.plain_text ?? '')
    .join('')
    .trim();
}

/**
 * Lists direct children of a parent and returns the first `child_page`
 * whose title matches (normalised).
 */
export async function findFirstChildPageByTitle(
  notion: NotionClient,
  parentPageId: string,
  title: string,
): Promise<string | null> {
  const normalizedSearch = normalizeTitleForMatch(title);
  if (!normalizedSearch) return null;

  let cursor: string | undefined;
  do {
    const resp = await notion.blocks.children.list({
      block_id: parentPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of resp.results) {
      const b = block as Record<string, unknown>;
      if (b.type !== 'child_page') continue;
      const blockTitle = getBlockTitle(b);
      if (normalizeTitleForMatch(blockTitle) === normalizedSearch)
        return b.id as string;
    }

    cursor = (resp.next_cursor as string | null) ?? undefined;
  } while (cursor);

  return null;
}

/* ------------------------------------------------------------------ */
/*  Folder page cache                                                  */
/* ------------------------------------------------------------------ */

/**
 * Gets or creates a single child page under `parentId` with the given title
 * (used for folder grouping). Returns existing page id if one already exists.
 */
export async function getOrCreateFolderPage(
  notion: NotionClient,
  parentPageId: string,
  folderTitle: string,
): Promise<string> {
  const existingId = await findFirstChildPageByTitle(
    notion,
    parentPageId,
    folderTitle,
  );
  if (existingId) return existingId;

  const page = await notion.pages.create({
    parent: { type: 'page_id', page_id: parentPageId },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: folderTitle } }],
      },
    },
  });
  return page.id;
}

/**
 * Pre-fills a cache of `folderTitle → Notion page id` so each folder
 * is resolved once.
 */
export async function ensureFolderPagesCache(
  notion: NotionClient,
  rootPageId: string,
  folderTitles: Set<string>,
  initialCache: Map<string, string> = new Map(),
): Promise<Map<string, string>> {
  const cache = new Map(initialCache);
  for (const folderTitle of folderTitles) {
    if (cache.has(folderTitle)) continue;
    const pageId = await getOrCreateFolderPage(notion, rootPageId, folderTitle);
    cache.set(folderTitle, pageId);
  }
  return cache;
}

/* ------------------------------------------------------------------ */
/*  Page CRUD                                                          */
/* ------------------------------------------------------------------ */

/** Send a page to Notion's trash (single API call). */
export async function sendPageToTrash(
  notion: NotionClient,
  pageId: string,
): Promise<void> {
  await notion.pages.update({ page_id: pageId, in_trash: true });
}

/** Create a subpage with chunked block children. */
export async function createSubpage(
  notion: NotionClient,
  parentPageId: string,
  title: string,
  blockChunks: unknown[][],
): Promise<string> {
  const [first, ...rest] = blockChunks;

  const page = await notion.pages.create({
    parent: { type: 'page_id', page_id: parentPageId },
    properties: {
      title: { title: [{ type: 'text', text: { content: title } }] },
    },
    children: first as Parameters<
      NotionClient['pages']['create']
    >[0]['children'],
  });

  for (const chunk of rest) {
    await notion.blocks.children.append({
      block_id: page.id,
      children: chunk as Parameters<
        NotionClient['blocks']['children']['append']
      >[0]['children'],
    });
  }

  return page.id;
}

/**
 * Validates that a Notion page with the given id exists.
 * Returns the page object if found, `null` otherwise.
 */
export async function notionRetrievePageIfExists(
  notion: NotionClient,
  pageId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    return page as unknown as Record<string, unknown>;
  } catch (err: unknown) {
    const e = err as { body?: { code?: string }; code?: string; status?: number };
    const code = e?.body?.code ?? e?.code;
    if (code === 'object_not_found' || e?.status === 404) return null;
    throw err;
  }
}

/** Returns the parent page_id of a Notion page, or null. */
export function getParentPageId(
  page: Record<string, unknown> | null,
): string | null {
  const p = page?.parent as
    | { type?: string; page_id?: string }
    | undefined;
  if (p?.type === 'page_id') return p.page_id ?? null;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Concurrency runner                                                 */
/* ------------------------------------------------------------------ */

/**
 * Runs async task functions with a bounded concurrency limit to avoid
 * overwhelming the Notion API.
 */
export async function runWithConcurrency<T>(
  taskFns: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(taskFns.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < taskFns.length) {
      const i = index++;
      results[i] = await taskFns[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, taskFns.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
