/**
 * Adapter: Markdown -> Notion blocks.
 * Isolates the third-party dependency @tryfabric/martian and Notion URL sanitisation.
 * No Notion API calls; pure conversion + validation of block content.
 */

import { markdownToBlocks } from '@tryfabric/martian';

/* ---------- types for internal block manipulation ---------- */

interface RichTextItem {
  type: string;
  text?: { content: string; link?: { url: string } | null };
  plain_text?: string;
  [key: string]: unknown;
}

interface BlockProperty {
  rich_text?: RichTextItem[];
  children?: NotionBlock[];
  [key: string]: unknown;
}

interface NotionBlock {
  type: string;
  [key: string]: BlockProperty | string | unknown;
}

/* ---------- constants ---------- */

const FALLBACK_BLOCK: NotionBlock = {
  type: 'paragraph',
  paragraph: {
    rich_text: [{ type: 'text', text: { content: '(No content)' } }],
  },
};

/* ---------- helpers ---------- */

function isValidNotionUrl(url: unknown): url is string {
  if (url == null || typeof url !== 'string') return false;
  const u = url.trim();
  return u.startsWith('http://') || u.startsWith('https://');
}

function sanitizeRichText(richText: RichTextItem[]): RichTextItem[] {
  return richText.map((item) => {
    if (item.type !== 'text' || !item.text) return item;
    const { content, link } = item.text;
    const out: RichTextItem = {
      type: 'text',
      text: { content: content ?? '' },
    };
    if (link?.url && isValidNotionUrl(link.url)) {
      out.text!.link = { url: link.url };
    }
    return out;
  });
}

function sanitizeBlocks(blocks: NotionBlock[]): NotionBlock[] {
  const out: NotionBlock[] = [];

  for (const block of blocks) {
    const b: NotionBlock = { ...block };

    for (const key of Object.keys(b)) {
      if (key === 'type' || b[key] == null || typeof b[key] !== 'object')
        continue;
      const prop = b[key] as BlockProperty;

      if (Array.isArray(prop.rich_text)) {
        b[key] = { ...prop, rich_text: sanitizeRichText(prop.rich_text) };
      }
      if (Array.isArray(prop.children)) {
        b[key] = {
          ...(b[key] as BlockProperty),
          children: sanitizeBlocks(prop.children),
        };
      }
    }
    out.push(b);
  }
  return out;
}

function ensureBlocksArray(blocks: NotionBlock[]): NotionBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return [FALLBACK_BLOCK];
  return blocks;
}

/* ---------- public API ---------- */

/**
 * Converts a markdown string to sanitised Notion API block objects.
 */
export function convertMarkdownToNotionBlocks(
  markdownContent: string,
): NotionBlock[] {
  const content = typeof markdownContent === 'string' ? markdownContent : '';
  let blocks: NotionBlock[];

  try {
    blocks = markdownToBlocks(content) as unknown as NotionBlock[];
  } catch {
    blocks = [
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: { content: content.slice(0, 2000) || '(empty)' },
            },
          ],
        },
      },
    ];
  }

  return sanitizeBlocks(ensureBlocksArray(blocks));
}
