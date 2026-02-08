import type { Client } from '@notionhq/client';

/** Inputs parsed from the GitHub Action configuration. */
export interface ActionInputs {
  notionToken: string;
  notionParentPageId: string;
  docsDir: string;
  syncMode: 'changed' | 'all';
  gitBefore: string;
  gitAfter: string;
  concurrency: number;
}

/** Result of syncing a single document to Notion. */
export interface SyncResult {
  action: 'created' | 'updated';
  title: string;
  relPath: string;
  parent: string;
}

/** Parsed frontmatter + body from a Markdown file. */
export interface ParsedFrontmatter {
  body: string;
  notionPageId: string | null;
  data: Record<string, string>;
}

/** Decomposed relative path into folder and doc metadata. */
export interface ParsedRelPath {
  folderName: string | null;
  folderTitle: string | null;
  docTitle: string;
}

/** Typed alias for the Notion client instance. */
export type NotionClient = Client;
