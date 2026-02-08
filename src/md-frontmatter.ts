/**
 * Read/write notion_page_id in Markdown frontmatter.
 * No external libs: plain string parsing. The Notion page id is obtained from
 * the Notion API (e.g. when creating a page); we only persist it here in the .md.
 */

import type { ParsedFrontmatter } from './types.js';

const NOTION_PAGE_ID_KEY = 'notion_page_id';

const FRONTMATTER_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Simple YAML-like line parser: "key: value" or "key: 'value'" or 'key: "value"'.
 */
function parseFrontmatterBlock(block: string): {
  data: Record<string, string>;
  rawLines: string[];
} {
  const data: Record<string, string> = {};
  const rawLines: string[] = [];
  const lines = block.split(/\r?\n/);

  for (const line of lines) {
    rawLines.push(line);
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
    }
    data[key] = value;
  }
  return { data, rawLines };
}

/**
 * Parses markdown with optional YAML frontmatter and extracts
 * body + notion_page_id + rest of data.
 */
export function parseMdWithNotionId(rawContent: string): ParsedFrontmatter {
  const str = typeof rawContent === 'string' ? rawContent : '';
  const match = str.match(FRONTMATTER_RE);

  if (!match) {
    return { body: str, notionPageId: null, data: {} };
  }

  const [, frontBlock, body] = match;
  const { data } = parseFrontmatterBlock(frontBlock);
  const id = data[NOTION_PAGE_ID_KEY];
  const notionPageId =
    id != null && typeof id === 'string' && id.trim().length > 0
      ? id.trim()
      : null;

  return {
    body: body || '',
    notionPageId,
    data: { ...data },
  };
}

/** Escapes a string for use as a YAML value (quoted if needed). */
function escapeYamlValue(v: unknown): string {
  const s = String(v);
  if (/[\n"\\:]/.test(s))
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return s;
}

/**
 * Returns markdown string with frontmatter containing notion_page_id
 * (and any existing keys).
 */
export function stringifyMdWithNotionId(
  body: string,
  existingData: Record<string, unknown>,
  notionPageId: string,
): string {
  const data: Record<string, unknown> = {
    ...existingData,
    [NOTION_PAGE_ID_KEY]: notionPageId,
  };
  const pairs = Object.entries(data).filter(
    ([, v]) => v != null && v !== '',
  );
  const frontLines = pairs.map(([k, v]) => `${k}: ${escapeYamlValue(v)}`);
  const front = frontLines.length
    ? `---\n${frontLines.join('\n')}\n---\n`
    : '';
  return front + (body || '');
}
