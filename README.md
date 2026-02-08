# Markdown to Notion Sync

A GitHub Action that syncs Markdown documentation files to Notion pages, preserving your folder hierarchy.

## How it works

- Each `.md` file in your docs directory becomes a Notion page.
- Subdirectories become grouping pages in Notion, with their `.md` files nested underneath.
- On first sync, new Notion pages are created and a `notion_page_id` is written into each file's YAML frontmatter.
- On subsequent syncs, existing pages are detected by that `notion_page_id` and their content is replaced.
- In `changed` mode (the default), only files that changed in the git push are synced. Files that have never been synced (no `notion_page_id`) are always included.

## Prerequisites

1. **Create a Notion integration** at <https://www.notion.so/my-integrations> and copy the token.
2. **Share the parent page** with your integration (open the page in Notion, click "..." > "Connections" > add your integration).
3. Copy the **parent page ID** from the page URL (the 32-character hex string).

## Usage

### Minimal (sync only changed files on push)

```yaml
name: Sync docs to Notion

on:
  push:
    branches: [main]
    paths: ['docs/**/*.md']

permissions:
  contents: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Sync docs to Notion
        uses: ptahops/markdown-to-notion@v1
        with:
          notion-token: ${{ secrets.NOTION_TOKEN }}
          notion-parent-page-id: ${{ vars.NOTION_PARENT_PAGE_ID }}
          git-before: ${{ github.event.before }}
          git-after: ${{ github.event.after }}

      - name: Commit Notion page IDs
        run: |
          git config --local user.email "github-actions[bot]@users.noreply.github.com"
          git config --local user.name  "github-actions[bot]"
          git add docs/
          git diff --staged --quiet || git commit -m "chore(docs): add Notion page IDs to frontmatter"
          git push
```

### Full sync (all files, every run)

```yaml
- name: Sync all docs to Notion
  uses: ptahops/markdown-to-notion@v1
  with:
    notion-token: ${{ secrets.NOTION_TOKEN }}
    notion-parent-page-id: ${{ vars.NOTION_PARENT_PAGE_ID }}
    sync-mode: all
```

### Custom docs directory

```yaml
- uses: ptahops/markdown-to-notion@v1
  with:
    notion-token: ${{ secrets.NOTION_TOKEN }}
    notion-parent-page-id: ${{ vars.NOTION_PARENT_PAGE_ID }}
    docs-dir: documentation/guides
    git-before: ${{ github.event.before }}
    git-after: ${{ github.event.after }}
```

### Using outputs in a later step

```yaml
- name: Sync docs
  id: sync
  uses: ptahops/markdown-to-notion@v1
  with:
    notion-token: ${{ secrets.NOTION_TOKEN }}
    notion-parent-page-id: ${{ vars.NOTION_PARENT_PAGE_ID }}
    git-before: ${{ github.event.before }}
    git-after: ${{ github.event.after }}

- name: Report
  run: echo "Synced ${{ steps.sync.outputs.synced-count }} file(s)"
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `notion-token` | Yes | -- | Notion integration token (store as a secret) |
| `notion-parent-page-id` | Yes | -- | Root Notion page ID to sync docs under |
| `docs-dir` | No | `docs` | Path to the docs directory relative to the repo root |
| `sync-mode` | No | `changed` | `changed` syncs only git-diffed files; `all` syncs every `.md` file |
| `git-before` | No | `""` | Git ref before the push (`github.event.before`). Required for `changed` mode |
| `git-after` | No | `""` | Git ref after the push (`github.event.after`). Required for `changed` mode |
| `concurrency` | No | `3` | Max concurrent Notion API calls (increase with caution) |

## Outputs

| Output | Description |
|---|---|
| `synced-files` | JSON array of synced file paths relative to `docs-dir` |
| `synced-count` | Number of files synced |

## Frontmatter

The action reads and writes YAML frontmatter in your `.md` files. After the first sync, each file will have a `notion_page_id` field:

```markdown
---
title: My Document
notion_page_id: 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d
---

# My Document

Content here...
```

This ID links the file to its Notion page. Do not remove it -- the action uses it to detect whether to create or update a page.

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Build the bundled action
npm run build
```

The build step produces `dist/index.js` via `@vercel/ncc`. This file must be committed to the repository since GitHub Actions runs it directly.

## License

MIT
