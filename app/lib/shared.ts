export interface WikiBlock {
  id: string;
  text: string;
}

/** How an item may be seen: open to all, visible-but-password-gated, or hidden. */
export type AccessLevel = "public" | "locked" | "hidden";

export interface WikiPage {
  path: string;
  /** The page name — drives the URL, sidebar and index. */
  title: string;
  /**
   * The big H1 shown on the page. May be plain text or image markdown
   * ("![](logo.png)"). Empty means fall back to the title.
   */
  header: string;
  eyebrow: string;
  lede: string;
  tags: string[];
  blocks: WikiBlock[];
  updated: string;
  /** The page's own access level (before project inheritance). */
  access: AccessLevel;
  /**
   * True when this page is effectively locked and its body was withheld by the
   * server — header/lede/blocks are blank until unlockPage() succeeds.
   */
  locked: boolean;
}

export interface PageSummary {
  path: string;
  title: string;
  /** The page's own access level, for showing the right icon in the index. */
  access: AccessLevel;
}

export interface VariableDef {
  name: string;
  value: string;
  description: string;
  page: string;
  blockId: string;
  /**
   * "global" when defined with `def:global:Name` (project-wide, define once);
   * "local" otherwise (a plain def, scoped to its own page — an override if a
   * global of the same name exists, else just a page-local variable).
   */
  scope: "global" | "local";
  /**
   * The shadowed global def, attached to a local def that overrides a global of
   * the same name: the local chip hovers/links this global, while refs on the
   * page use the local def.
   */
  global?: VariableDef;
}

/**
 * A term definition — a named concept with no value, unlike a variable. Created
 * with {{TypeDef(Name)}} (a bare anchor) or {{TypeDef(Name|explanation)}} (with
 * a hover explanation). {{TypeRef(Name)}} links to it.
 */
export interface TermDef {
  name: string;
  /** Hover text, from a {{TypeDef(Name|explanation)}}; empty for a bare anchor. */
  explanation: string;
  page: string;
  blockId: string;
  /** "global" when defined with `term:global:Name`; "local" otherwise. */
  scope: "global" | "local";
  /** The shadowed global term, attached when a local def overrides a global. */
  global?: TermDef;
}

/* ------------------------------------------------------------------ */
/* Roadmap boards (the :::roadmap directive)                            */
/* ------------------------------------------------------------------ */

/** A card on a roadmap board. All three text fields are wiki markdown. */
export interface BoardCard {
  id: string;
  /** Card heading, shown large on the card. */
  title: string;
  /** One-line-ish summary shown under the title on the card face. */
  desc: string;
  /** Full detail, shown in the card's fullscreen view. */
  body: string;
}

/** A column ("New Tasks", "Ready", …) holding an ordered list of cards. */
export interface BoardColumn {
  id: string;
  title: string;
  cards: BoardCard[];
}

/** The whole board, stored as jsonb in the boards table. */
export interface BoardData {
  columns: BoardColumn[];
}

let boardIdCounter = 0;
/** A short unique id for a card/column, stable within a session. */
export function newBoardId(prefix: string): string {
  boardIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${boardIdCounter.toString(36)}`;
}

/** The starter board used when a :::roadmap has no saved data yet. */
export function defaultBoard(): BoardData {
  return {
    columns: ["New Tasks", "Ready", "Active", "Review", "Done"].map((title) => ({
      id: newBoardId("col"),
      title,
      cards: [],
    })),
  };
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

/**
 * Every folder in a project, as project-relative paths, sorted. Combines the
 * implicit folders (derived from page paths) with the explicitly created ones,
 * so callers don't have to know that folders come from two places. The project
 * root is the leading "" entry.
 */
export function folderList(pages: PageSummary[], project: string, meta: ProjectMeta): string[] {
  const folders = new Set<string>([""]);
  for (const page of pages) {
    if (!pathInProject(page.path, project)) {
      continue;
    }
    const segments = stripProjectPrefix(page.path).split("/");
    // The last segment is the page itself, not a folder.
    for (let i = 1; i < segments.length; i++) {
      folders.add(segments.slice(0, i).join("/"));
    }
  }
  for (const rel of meta.folders) {
    const segments = rel.split("/");
    for (let i = 1; i <= segments.length; i++) {
      folders.add(segments.slice(0, i).join("/"));
    }
  }
  return [...folders].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
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

/** A single path segment — slashes are stripped, so it can never nest. */
export function normalizeSegment(raw: string): string {
  return normalizePath(raw.replace(/\//g, " "));
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
    header: "",
    eyebrow: pagePath.split("/").slice(0, -1).join(" · "),
    lede: "",
    tags: [],
    blocks: [{ id: newBlockId(), text: "Write something…" }],
    updated: "",
    access: "public",
    locked: false,
  };
}

/**
 * {{var:name=value|description|custom display}}
 *   - a plain def is page-local: it overrides a global of the same name here, or
 *     is just a page-local variable if no global exists
 *   - a `global:` prefix ({{var:global:name=value|desc}}) defines the project-wide
 *     variable that other pages may override locally
 *   - the value may be omitted (a name-only global template)
 *   - the optional 4th field overrides how the chip is displayed (inline markup)
 * Refs ({{name}}) resolve by name.
 */
export const DEF_RE = /\{\{var:(global:)?([A-Za-z0-9_.-]+)\s*(?:=\s*([^|}]*?)\s*)?(?:\|\s*([^|}]*?)\s*)?(?:\|\s*([^}]*?)\s*)?\}\}/g;

/** Every variable def across the given pages, in document order. */
export function collectVariableDefs(pages: WikiPage[]): VariableDef[] {
  const defs: VariableDef[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const match of block.text.matchAll(DEF_RE)) {
        defs.push({
          name: match[2],
          value: match[3] ?? "",
          description: match[4] ?? "",
          page: page.path,
          blockId: block.id,
          scope: match[1] ? "global" : "local",
        });
      }
    }
  }
  return defs;
}

/**
 * Resolves the variable map as seen from `currentPath`:
 *   - a `def:global:` def is visible everywhere in the project;
 *   - a plain `def:` def is scoped to its own page — it OVERRIDES a global of the
 *     same name for this page (the shadowed global is kept on `.global` so the
 *     local chip can still hover/link it), or, with no global, is a page-local.
 * Passing "" (no page) yields the global-only map.
 */
export function resolveVariablesForPage(
  defs: VariableDef[],
  currentPath: string
): Record<string, VariableDef> {
  const globals: Record<string, VariableDef> = {};
  const locals: Record<string, VariableDef> = {};
  const here = currentPath.toLowerCase();
  for (const def of defs) {
    if (def.scope === "global") {
      globals[def.name] = def;
    } else if (def.page.toLowerCase() === here) {
      locals[def.name] = def;
    }
  }
  const out: Record<string, VariableDef> = { ...globals };
  for (const [name, local] of Object.entries(locals)) {
    out[name] = globals[name] ? { ...local, global: globals[name] } : local;
  }
  return out;
}

/** Back-compat: the plain global-only map keyed by name (no page resolution). */
export function extractVariables(pages: WikiPage[]): Record<string, VariableDef> {
  return resolveVariablesForPage(collectVariableDefs(pages), "");
}

/**
 * {{term:Name}}                — a bare term anchor (jump target)
 * {{term:Name|explanation}}    — a term with a hover explanation
 * {{term:global:Name|expl}}    — the project-wide term other pages override
 * A reference is just {{Name}} (resolved to a term when it isn't a variable).
 */
export const TYPEDEF_RE = /\{\{term:(global:)?([A-Za-z0-9_.\- ]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export interface RawTermDef {
  name: string;
  explanation: string;
  page: string;
  blockId: string;
  scope: "global" | "local";
}

/** Every term def across the given pages, in document order. */
export function collectTermDefs(pages: WikiPage[]): RawTermDef[] {
  const defs: RawTermDef[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const match of block.text.matchAll(TYPEDEF_RE)) {
        defs.push({
          name: match[2],
          explanation: (match[3] ?? "").trim(),
          page: page.path,
          blockId: block.id,
          scope: match[1] ? "global" : "local",
        });
      }
    }
  }
  return defs;
}

/**
 * Merges term defs of one scope by name. A BARE def is the canonical anchor (its
 * page/block is the jump target); an explanation from any def of the same name
 * is kept for the hover — so a term can be anchored in one place and explained
 * elsewhere, and refs still resolve.
 */
function mergeTerms(defs: RawTermDef[]): Record<string, TermDef> {
  const terms: Record<string, TermDef> = {};
  for (const def of defs) {
    const isBare = !def.explanation;
    const existing = terms[def.name];
    if (!existing) {
      terms[def.name] = { name: def.name, explanation: def.explanation, page: def.page, blockId: def.blockId, scope: def.scope };
      continue;
    }
    terms[def.name] = {
      name: def.name,
      explanation: def.explanation || existing.explanation,
      page: isBare ? def.page : existing.page,
      blockId: isBare ? def.blockId : existing.blockId,
      scope: def.scope,
    };
  }
  return terms;
}

/**
 * Resolves the term map as seen from `currentPath`: a `global:` term is visible
 * project-wide; a plain term is scoped to its page and overrides a global of the
 * same name there (shadowed global attached as `.global`). "" yields globals only.
 */
export function resolveTermsForPage(defs: RawTermDef[], currentPath: string): Record<string, TermDef> {
  const here = currentPath.toLowerCase();
  const globals = mergeTerms(defs.filter((d) => d.scope === "global"));
  const locals = mergeTerms(defs.filter((d) => d.scope === "local" && d.page.toLowerCase() === here));
  const out: Record<string, TermDef> = { ...globals };
  for (const [name, local] of Object.entries(locals)) {
    out[name] = globals[name] ? { ...local, global: globals[name] } : local;
  }
  return out;
}

/** Back-compat: the plain global-only term map keyed by name. */
export function extractTerms(pages: WikiPage[]): Record<string, TermDef> {
  return resolveTermsForPage(collectTermDefs(pages), "");
}

function plainText(markup: string): string {
  return markup
    .replace(/^```.*$/gm, " ")
    .replace(/^:::.*$/gm, " ")
    .replace(/\{\{term:(?:global:)?([^|}]+?)\s*(?:\|[^}]*)?\}\}/g, "$1")
    .replace(/\{\{var:(?:global:)?([^=|}]+?)\s*(?:=\s*([^|}]*?))?\s*(?:\|([^}]*))?\}\}/g, "$1 $2 $3")
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
