export interface WikiBlock {
  id: string;
  text: string;
}

export interface WikiPage {
  path: string;
  title: string;
  eyebrow: string;
  lede: string;
  tags: string[];
  blocks: WikiBlock[];
  updated: string;
}

export interface PageSummary {
  path: string;
  title: string;
}

export interface VariableDef {
  name: string;
  value: string;
  description: string;
  page: string;
  blockId: string;
}

export interface SearchResult {
  path: string;
  title: string;
  eyebrow: string;
  snippets: string[];
  matches: number;
}

/**
 * Sidebar ordering, locks and folders for one project, projected from the
 * pages and folders tables. Keys and entries are project-relative paths of both
 * pages and folders ("Systems", "Systems/Player-Vitals").
 *
 * order   — the sort_order column, per sibling.
 * private — rows whose is_private is set. A folder lock is stamped onto its
 *           descendants at write time, so each row carries its own truth and
 *           the RLS policy stays a plain boolean check.
 * folders — folders created explicitly. Most folders are implicit (derived from
 *           page paths), but an empty one has no page to derive it from.
 */
export interface ProjectMeta {
  order: Record<string, number>;
  private: string[];
  folders: string[];
}

export function emptyProjectMeta(): ProjectMeta {
  return { order: {}, private: [], folders: [] };
}

/**
 * Landing-page ordering and privacy for the project list, projected from the
 * projects table. Order keys and `private` entries are project slugs.
 */
export interface RootMeta {
  order: Record<string, number>;
  private: string[];
}

export function isProjectPrivate(meta: RootMeta, slug: string): boolean {
  return meta.private.some((s) => s.toLowerCase() === slug.toLowerCase());
}

export interface PageMove {
  from: string;
  to: string;
}

/** Files starting with "_" are metadata, not pages. */
export function isMetaFile(fileName: string): boolean {
  return fileName.startsWith("_");
}

export function parentOfRel(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash);
}

export function lastSegment(path: string): string {
  return path.split("/").pop() ?? path;
}

const WIKI_LINK_RE = /\[\[([^\]|]+)(\|[^\]]*)?\]\]/g;

/**
 * Repoints [[wiki links]] in `page` from a moved page's old path to its new one.
 * Handles both the absolute form ([[Project/Systems/X]]) and the project-relative
 * form ([[Systems/X]]) — the latter only within the same project, since the same
 * relative path can mean a different page elsewhere. Returns true if anything changed.
 */
export function rewriteLinksInPage(page: WikiPage, from: string, to: string): boolean {
  const sameProject = projectOf(page.path).toLowerCase() === projectOf(from).toLowerCase();
  const fromRel = stripProjectPrefix(from).toLowerCase();
  const toRel = stripProjectPrefix(to);
  let changed = false;

  for (const block of page.blocks) {
    const next = block.text.replace(WIKI_LINK_RE, (whole, target: string, label = "") => {
      const clean = target.trim().replace(/^\/+/, "").toLowerCase();
      if (clean === from.toLowerCase()) {
        return `[[${to}${label}]]`;
      }
      if (sameProject && clean === fromRel) {
        return `[[${toRel}${label}]]`;
      }
      return whole;
    });
    if (next !== block.text) {
      block.text = next;
      changed = true;
    }
  }
  return changed;
}

export function newBlockId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizePath(raw: string): string {
  return raw
    .split("/")
    .map((seg) => seg.trim().replace(/[^A-Za-z0-9 _.-]/g, "").replace(/\s+/g, "-"))
    .filter(Boolean)
    .join("/");
}

export function projectOf(pagePath: string): string {
  return pagePath.split("/")[0] ?? "";
}

export function pathInProject(pagePath: string, project: string): boolean {
  return pagePath.toLowerCase() === project.toLowerCase() || pagePath.toLowerCase().startsWith(project.toLowerCase() + "/");
}

/** True for `rel` itself and anything beneath it. */
function relCovers(locked: string, rel: string): boolean {
  const low = locked.toLowerCase();
  const target = rel.toLowerCase();
  return target === low || target.startsWith(low + "/");
}

/** A page/folder is locked if it, or any folder above it, is in the private list. */
export function isRelLocked(meta: ProjectMeta, rel: string): boolean {
  return meta.private.some((locked) => relCovers(locked, rel));
}

/** As isRelLocked, but for a full path including the project segment. */
export function isPathLocked(meta: ProjectMeta, pagePath: string): boolean {
  return isRelLocked(meta, stripProjectPrefix(pagePath));
}

/** The outermost locked folder covering `rel` — what the lock screen names. */
export function lockRootFor(meta: ProjectMeta, rel: string): string | null {
  return meta.private.find((locked) => relCovers(locked, rel)) ?? null;
}

export function projectDisplayName(slug: string): string {
  return slug.replace(/-/g, " ");
}

export function stripProjectPrefix(pagePath: string): string {
  const slash = pagePath.indexOf("/");
  return slash === -1 ? pagePath : pagePath.slice(slash + 1);
}

export function blankPage(rawPath: string, title?: string): WikiPage {
  const pagePath = normalizePath(rawPath);
  return {
    path: pagePath,
    title: title?.trim() || pagePath.split("/").pop()!.replace(/-/g, " "),
    eyebrow: pagePath.split("/").slice(0, -1).join(" · "),
    lede: "",
    tags: [],
    blocks: [{ id: newBlockId(), text: "Write something…" }],
    updated: "",
  };
}

export const DEF_RE = /\{\{def:([A-Za-z0-9_.-]+)\s*=\s*([^|}]*?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function extractVariables(pages: WikiPage[]): Record<string, VariableDef> {
  const vars: Record<string, VariableDef> = {};
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const match of block.text.matchAll(DEF_RE)) {
        vars[match[1]] = {
          name: match[1],
          value: match[2],
          description: match[3] ?? "",
          page: page.path,
          blockId: block.id,
        };
      }
    }
  }
  return vars;
}

function plainText(markup: string): string {
  return markup
    .replace(/^```.*$/gm, " ")
    .replace(/^:::.*$/gm, " ")
    .replace(/\{\{def:([^=}]+)=([^|}]*?)\s*(?:\|([^}]*))?\}\}/g, "$1 = $2 $3")
    .replace(/\{\{(-?\d[^|}]*)\|([^}]*)\}\}/g, "$1 $2")
    .replace(/\{\{([^|}]+)\|([^}]*)\}\}/g, "$2")
    .replace(/\{\{([^}]+)\}\}/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*|==|`/g, "")
    .replace(/^[#^>]+\s*/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectSnippets(text: string, query: string, max: number): { snippets: string[]; matches: number } {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const snippets: string[] = [];
  let matches = 0;
  let from = 0;
  while (true) {
    const index = lower.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    matches++;
    if (snippets.length < max) {
      const start = Math.max(0, index - 60);
      const end = Math.min(text.length, index + needle.length + 90);
      snippets.push((start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : ""));
    }
    from = index + needle.length;
  }
  return { snippets, matches };
}

export function searchInPages(pages: WikiPage[], query: string): SearchResult[] {
  const needle = query.trim();
  if (needle.length < 2) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const page of pages) {
    const body = plainText([page.lede, ...page.blocks.map((b) => b.text)].join("\n"));
    const { snippets, matches } = collectSnippets(body, needle, 3);
    const titleHit =
      page.title.toLowerCase().includes(needle.toLowerCase()) ||
      page.path.toLowerCase().includes(needle.toLowerCase()) ||
      page.tags.some((t) => t.toLowerCase().includes(needle.toLowerCase()));
    if (matches > 0 || titleHit) {
      results.push({
        path: page.path,
        title: page.title,
        eyebrow: page.eyebrow,
        snippets,
        matches: matches + (titleHit ? 10 : 0),
      });
    }
  }
  results.sort((a, b) => b.matches - a.matches);
  return results.slice(0, 30);
}
