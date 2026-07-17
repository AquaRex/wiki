# Wiki

A fully in-page-editable multi-project wiki. React Router SPA + shadcn/Tailwind. All content lives as flat JSON files under `content/pages/` — the GitHub repository itself is the database, so every edit is a commit with full history.

**Projects**: the landing page at `/` lists projects; each is a top-level folder under `content/pages/` with a `Home.json` (e.g. `ObsidianSpire/`, `Guides/`). URLs are `/<project>/<page-path>`, so with the repo named `wiki` a page lives at `hetland.dev/wiki/ObsidianSpire/Systems/Player-Vitals`. Sidebar, search, and the variable registry are all scoped to the current project; wiki links like `[[Systems/Player-Vitals]]` resolve within the page's own project (use the full `[[OtherProject/Page]]` path to cross projects). Each project's internal section is `<project>/Internal/…`. New projects are created from the landing page while editing is unlocked.

## Two ways to run it

| Mode | Content source | Editing writes to | Use for |
| --- | --- | --- | --- |
| **Local** (`npm run dev`) | `content/` folder on disk | files on disk | development, offline writing |
| **GitHub Pages** (`npm run build:pages`) | this repo via GitHub API | commits via GitHub API | the public site anyone can visit and edit |

```sh
npm run dev          # local mode, http://localhost:5173
npm run build:pages  # static bundle for GitHub Pages → build/client
```

## Hosting on GitHub Pages (one-time setup)

1. **Fill in the repo coordinates** in [app/wiki.config.ts](app/wiki.config.ts) (`github.owner`, `github.repo`, `github.branch`).
2. Push this project to that **public** GitHub repository (`main` branch).
3. In the repo: **Settings → Pages → Source: GitHub Actions**. The included workflow ([.github/workflows/pages.yml](.github/workflows/pages.yml)) builds and deploys automatically on every push.
4. The site appears at `https://<owner>.github.io/<repo>/` — or under your custom domain's `/<repo>/` path if your user site uses one. If you serve it from a different path, adjust `WIKI_BASE` in the workflow (use `/` for a domain root).

Content edits made on the live site are commits to `content/**` and are deliberately excluded from triggering redeploys — the site reads content from the repo at runtime, so edits show up without a rebuild (readers may see up to ~5 minutes of CDN caching; editors see their changes instantly).

## Editing on the live site

- Open `/admin`, enter the password `4120` **plus, the first time, a GitHub token**. The token is how the browser is allowed to commit; it's stored only in that browser's localStorage.
- Creating a token (each editor does this once): GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate: Repository access = *only the wiki repo*, Permissions = **Contents: Read and write**. Send your friend a collaborator invite to the repo so their own token works too.
- Everything else is identical to local mode: double-click blocks, Ctrl+Enter saves (as a commit under your account), new pages via sidebar or by visiting their URL, images upload into `content/uploads/`.
- The internal section (`/Internal/…`) unlocks with `4054`.

> Note: the repo is public, so the passwords and all content (including `/Internal/`) are technically visible to anyone who reads the source. The gates prevent accidents, not attackers — same as agreed for the local version. Actual write access is protected by real GitHub permissions: only collaborators' tokens can commit.

## How editing works

- Unlock editing, then **double-click any block** (or hover → pencil). Live preview renders above the editor while you type. `Ctrl+Enter` saves, `Esc` cancels.
- Hover between blocks for **Add block**; hover a block for move/delete tools.
- Page title, eyebrow, lede, and tags are click-to-edit in the header.
- **New pages**: sidebar → *New page*, or just visit a URL that doesn't exist (e.g. `/Enemies/TheHunter`) and press *Create*. The page is committed immediately, so the URL is instantly shareable.
- Images: *Image* button in the block editor, or paste from clipboard.

## Syntax

Full reference lives on the wiki itself at `/Guides/Writing-Pages`. Highlights:

| Syntax | Result |
| --- | --- |
| `[[Path/To/Page\|label]]` | wiki link (red-dashed if the page doesn't exist yet) |
| `{{def:name=value\|description}}` | canonical variable definition (anchor) |
| `{{name}}` / `{{name\|shown text}}` | variable reference — hover for value, click to jump to definition |
| `## Heading` + `^ kicker` | auto-numbered section with monospace kicker |
| `:::infobox Title … :::` | right-floating quick-info box (`Label: value` rows, `image:` line) |
| `:::callout` `:::note` `:::pitfall` `:::warn` `:::good` | boxed content |
| `:::flow` / `:::steps` | arrowed step strip / numbered timeline |
| ```` ```csharp:File.cs ```` | code card with filename header |

`/variables` lists every variable defined anywhere on the wiki.

## Content model

Each page is one JSON file at `content/pages/<Path>.json`: header fields (`title`, `eyebrow`, `lede`, `tags`) plus an ordered list of markdown `blocks`. Variables are re-scanned from `{{def:…}}` occurrences on every load, so they can never go stale. Back up the wiki by copying `content/` — or just rely on git history, since every edit is a commit.
