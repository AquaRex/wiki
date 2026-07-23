import { supabase } from "./supabase";
import { wikiConfig } from "~/wiki.config";
import {
  blankPage,
  collectTermDefs,
  collectVariableDefs,
  emptyProjectMeta,
  type BoardData,
  type SheetData,
  extractTerms,
  extractVariables,
  isRelLocked,
  normalizePath,
  parseGlobalDefRows,
  projectOf,
  type GlobalDefRow,
  type GlobalDefs,
  rewriteLinksInPage,
  searchInPages,
  stripProjectPrefix,
  type PageCard,
  type PageMove,
  type PageSummary,
  type ProjectMeta,
  type RawTermDef,
  type RootMeta,
  type SearchResult,
  type VariableDef,
  type TermDef,
  type WikiPage,
  type AccessLevel,
} from "./shared";

/**
 * What an access level or a grant can be attached to. A folder is a real scope
 * now: its level and its allow-list cover everything inside it, resolved by the
 * database rather than stamped onto each page.
 */
export type AccessScope = "project" | "folder" | "page";

export interface WikiStore {
  listPages(): Promise<PageSummary[]>;
  /** listPages plus each page's lede and tags, for the search listing. */
  listPageCards(): Promise<PageCard[]>;
  getPage(rawPath: string): Promise<WikiPage | null>;
  /** Fetches the freshest copy of a page, applies `mutate`, and persists it. */
  updatePage(rawPath: string, mutate: (page: WikiPage) => void): Promise<void>;
  createPage(rawPath: string, title?: string): Promise<string>;
  deletePage(rawPath: string): Promise<void>;
  /** Sidebar ordering, locks and explicit folders for a project. */
  getMeta(project: string): Promise<ProjectMeta>;
  saveMeta(project: string, meta: ProjectMeta): Promise<void>;
  /** Ordering and locks for the project list on the landing page. */
  getRootMeta(): Promise<RootMeta>;
  saveRootMeta(meta: RootMeta): Promise<void>;
  /** Moves pages and repoints wiki links that pointed at them. */
  movePages(moves: PageMove[]): Promise<void>;
  getVariables(): Promise<Record<string, VariableDef>>;
  getTerms(): Promise<Record<string, TermDef>>;
  /** Raw def lists (globals and locals) for per-page scope resolution. */
  getVariableDefs(): Promise<VariableDef[]>;
  getTermDefs(): Promise<RawTermDef[]>;
  /**
   * Global defs from every page — including the hidden and locked ones whose
   * bodies this viewer never receives — keyed by lowercased project slug.
   */
  getGlobalDefs(): Promise<Record<string, GlobalDefs>>;
  /** A :::roadmap board's saved data, or null if it has never been saved. */
  getBoard(pagePath: string, boardKey: string): Promise<BoardData | null>;
  /** Saves a roadmap board (signed-in only, refused on a locked/withheld page). */
  saveBoard(pagePath: string, boardKey: string, data: BoardData): Promise<void>;
  /** A :::cells sheet's saved data, or null if it has never been saved. */
  getSheet(pagePath: string, sheetKey: string): Promise<SheetData | null>;
  /** Saves a sheet (signed-in only, refused on a locked/withheld page). */
  saveSheet(pagePath: string, sheetKey: string, data: SheetData): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
  /**
   * Verifies a locked page's password server-side and, on success, returns the
   * withheld body (header/lede/blocks) merged into the page. Throws on a wrong
   * password. The unlocked copy replaces the blank one in the cache.
   */
  unlockPage(rawPath: string, password: string): Promise<WikiPage>;
  /** Each project's access level, keyed by slug (lowercased). */
  getProjectAccess(): Promise<Record<string, AccessLevel>>;
  /** Sets a scope's access level. Locking also needs a password. */
  setAccess(scope: AccessScope, key: string, level: AccessLevel): Promise<void>;
  /** Sets (or clears, with "") the lock password for a scope. */
  setLockPassword(scope: AccessScope, key: string, password: string): Promise<void>;
  /** The emails granted to see a hidden project/folder/page. */
  listGrants(scope: AccessScope, key: string): Promise<string[]>;
  /** Grants a user (by email) access to a hidden project/folder/page. */
  addGrant(scope: AccessScope, key: string, email: string): Promise<void>;
  /** Revokes a user's grant. */
  removeGrant(scope: AccessScope, key: string, email: string): Promise<void>;
  uploadImage(file: File, pagePath: string): Promise<string>;
  /**
   * Maps a stored asset src to a fetchable URL. Private images live in a
   * non-public bucket, so this signs on demand and is therefore async.
   */
  resolveAsset(src: string): Promise<string>;
  invalidate(): void;
}

const PUBLIC_BUCKET = "wiki-public";
const PRIVATE_BUCKET = "wiki-private";
const SIGNED_URL_TTL = 3600;

interface PageRow {
  project_slug: string;
  rel: string;
  title: string;
  header: string;
  eyebrow: string;
  lede: string;
  tags: string[];
  blocks: { id: string; text: string }[];
  access: AccessLevel;
  own_access: AccessLevel;
  is_locked: boolean;
  sort_order: number;
  updated_at: string;
}

function rowToPage(row: PageRow): WikiPage {
  return {
    path: `${row.project_slug}/${row.rel}`,
    title: row.title,
    header: row.header ?? "",
    eyebrow: row.eyebrow,
    lede: row.lede,
    tags: row.tags ?? [],
    blocks: row.blocks ?? [],
    updated: row.updated_at ?? "",
    access: row.access ?? "public",
    ownAccess: row.own_access ?? row.access ?? "public",
    locked: Boolean(row.is_locked),
  };
}

/** Splits a full path into its project and project-relative parts. */
function splitPath(pagePath: string): { project: string; rel: string } {
  return { project: projectOf(pagePath), rel: stripProjectPrefix(pagePath) };
}

function fail(context: string, error: { message: string } | null): void {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

/**
 * Reads and writes the wiki through Supabase. Privacy is enforced by row level
 * security: a query run by an anonymous visitor simply does not return private
 * rows, so nothing is filtered client-side and nothing private is ever sent.
 */
class SupabaseStore implements WikiStore {
  private pagesCache: Map<string, WikiPage> | null = null;
  private loading: Promise<Map<string, WikiPage>> | null = null;
  private globalDefs: Promise<Record<string, GlobalDefs>> | null = null;

  /**
   * Pages are cached because search and the variables index need every page,
   * and the tree needs them on each navigation. RLS has already filtered the
   * rows, so the cache can only ever hold what this viewer may see.
   */
  private pages(): Promise<Map<string, WikiPage>> {
    if (this.pagesCache) {
      return Promise.resolve(this.pagesCache);
    }
    if (!this.loading) {
      this.loading = (async () => {
        // pages_public withholds the body of locked pages (blank until unlocked)
        // and, via its security_invoker RLS, hides pages the viewer may not see.
        const { data, error } = await supabase.from("pages_public").select("*");
        fail("Could not load pages", error);
        const cache = new Map<string, WikiPage>();
        for (const row of (data ?? []) as PageRow[]) {
          const page = rowToPage(row);
          cache.set(page.path.toLowerCase(), page);
        }
        this.pagesCache = cache;
        return cache;
      })();
      this.loading.catch(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async listPages() {
    const pages = await this.pages();
    return Array.from(pages.values())
      .map((p) => ({ path: p.path, title: p.title, access: p.access, ownAccess: p.ownAccess }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  }

  /** listPages plus the lede and tags the search page lists pages by. */
  async listPageCards(): Promise<PageCard[]> {
    const pages = await this.pages();
    return Array.from(pages.values())
      .map((p) => ({
        path: p.path,
        title: p.title,
        access: p.access,
        ownAccess: p.ownAccess,
        lede: p.lede,
        tags: p.tags,
      }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  }

  async getPage(rawPath: string) {
    const pages = await this.pages();
    return pages.get(normalizePath(rawPath).toLowerCase()) ?? null;
  }

  async updatePage(rawPath: string, mutate: (page: WikiPage) => void) {
    const page = await this.getPage(rawPath);
    if (!page) {
      throw new Error(`Page not found: ${rawPath}`);
    }
    // A locked page's body was withheld by the server (blank header/lede/blocks).
    // Saving that would overwrite the real content with blanks — so refuse until
    // it has been unlocked, which fills the body back in.
    if (page.locked) {
      throw new Error("This page is locked — unlock it before editing.");
    }
    const copy: WikiPage = JSON.parse(JSON.stringify(page));
    mutate(copy);
    await this.writePage(copy);
  }

  private async writePage(page: WikiPage) {
    const { project, rel } = splitPath(page.path);
    const updated = new Date().toISOString();
    const { error } = await supabase
      .from("pages")
      .update({
        title: page.title,
        header: page.header,
        eyebrow: page.eyebrow,
        lede: page.lede,
        tags: page.tags,
        blocks: page.blocks,
        updated_at: updated,
      })
      .eq("project_slug", project)
      .eq("rel", rel);
    fail(`Could not save ${page.path}`, error);
    (await this.pages()).set(page.path.toLowerCase(), { ...page, updated });
    // An edit may have added or changed a global def; the page cache is patched
    // in place above, but the view has to be read again.
    this.globalDefs = null;
  }

  async createPage(rawPath: string, title?: string) {
    const existing = await this.getPage(rawPath);
    if (existing) {
      return existing.path;
    }
    const page = blankPage(rawPath, title);
    if (!page.path || !page.path.includes("/")) {
      throw new Error("A page must live inside a project.");
    }
    const { project, rel } = splitPath(page.path);

    const { error } = await supabase.from("pages").insert({
      project_slug: project,
      rel,
      title: page.title,
      header: page.header,
      eyebrow: page.eyebrow,
      lede: page.lede,
      tags: page.tags,
      blocks: page.blocks,
      // A new page starts public; it inherits its project's access at read time
      // via page_effective_access, so no per-row stamping is needed here.
      access: "public",
      sort_order: 0,
    });
    fail(`Could not create ${page.path}`, error);
    this.invalidate();
    return page.path;
  }

  async deletePage(rawPath: string) {
    const page = await this.getPage(rawPath);
    if (!page) {
      return;
    }
    const { project, rel } = splitPath(page.path);
    const { error } = await supabase.from("pages").delete().eq("project_slug", project).eq("rel", rel);
    fail(`Could not delete ${page.path}`, error);
    (await this.pages()).delete(page.path.toLowerCase());
  }

  async createProject(slug: string, title: string, isPrivate: boolean) {
    const { error } = await supabase
      .from("projects")
      .insert({ slug, title, lede: "", is_private: isPrivate, sort_order: 0 });
    fail(`Could not create project ${slug}`, error);
  }

  async getMeta(project: string): Promise<ProjectMeta> {
    if (!project) {
      return emptyProjectMeta();
    }
    const [pages, folders] = await Promise.all([
      supabase.from("pages").select("rel,is_private,sort_order").eq("project_slug", project),
      supabase.from("folders").select("rel,is_private,sort_order,access").eq("project_slug", project),
    ]);
    fail("Could not load the project index", pages.error ?? folders.error);

    const meta = emptyProjectMeta();
    for (const row of [...(pages.data ?? []), ...(folders.data ?? [])]) {
      meta.order[row.rel] = row.sort_order;
      if (row.is_private) {
        meta.private.push(row.rel);
      }
    }
    meta.folders = (folders.data ?? []).map((f) => f.rel);
    for (const folder of (folders.data ?? []) as { rel: string; access?: AccessLevel }[]) {
      if (folder.access && folder.access !== "public") {
        meta.folderAccess[folder.rel] = folder.access;
      }
    }
    return meta;
  }

  /**
   * Writes back an edited index. Locks are resolved here rather than in a
   * policy: a locked folder stamps is_private onto every row beneath it, so
   * each row carries its own truth.
   */
  async saveMeta(project: string, meta: ProjectMeta) {
    const [pages, folders] = await Promise.all([
      supabase.from("pages").select("rel").eq("project_slug", project),
      supabase.from("folders").select("rel").eq("project_slug", project),
    ]);
    fail("Could not load the project index", pages.error ?? folders.error);

    const rootMeta = await this.getRootMeta();
    const projectLocked = rootMeta.private.some((s) => s.toLowerCase() === project.toLowerCase());
    const lockOf = (rel: string) => projectLocked || isRelLocked(meta, rel);

    const pageUpdates = (pages.data ?? []).map((row) =>
      supabase
        .from("pages")
        .update({ is_private: lockOf(row.rel), sort_order: meta.order[row.rel] ?? 0 })
        .eq("project_slug", project)
        .eq("rel", row.rel)
    );

    const existingFolders = new Set((folders.data ?? []).map((f) => f.rel));
    const folderUpserts = meta.folders.map((rel) =>
      supabase.from("folders").upsert(
        {
          project_slug: project,
          rel,
          is_private: lockOf(rel),
          sort_order: meta.order[rel] ?? 0,
        },
        { onConflict: "project_slug,rel" }
      )
    );
    const removed = [...existingFolders].filter((rel) => !meta.folders.includes(rel));
    const folderDeletes = removed.map((rel) =>
      supabase.from("folders").delete().eq("project_slug", project).eq("rel", rel)
    );

    const results = await Promise.all([...pageUpdates, ...folderUpserts, ...folderDeletes]);
    for (const result of results) {
      fail("Could not save the project index", result.error);
    }
    this.invalidate();
  }

  async getRootMeta(): Promise<RootMeta> {
    const { data, error } = await supabase.from("projects").select("slug,is_private,sort_order");
    fail("Could not load the project list", error);
    const meta: RootMeta = { order: {}, private: [] };
    for (const row of data ?? []) {
      meta.order[row.slug] = row.sort_order;
      if (row.is_private) {
        meta.private.push(row.slug);
      }
    }
    return meta;
  }

  /**
   * Writes back the project list. Locking a project cascades onto its pages and
   * folders so a private project cannot leak a public page.
   */
  async saveRootMeta(meta: RootMeta) {
    const { data, error } = await supabase.from("projects").select("slug");
    fail("Could not load the project list", error);

    const locked = (slug: string) => meta.private.some((s) => s.toLowerCase() === slug.toLowerCase());
    const updates = (data ?? []).map((row) =>
      supabase
        .from("projects")
        .update({ is_private: locked(row.slug), sort_order: meta.order[row.slug] ?? 0 })
        .eq("slug", row.slug)
    );
    for (const result of await Promise.all(updates)) {
      fail("Could not save the project list", result.error);
    }

    // Cascade a project-level lock down; unlocking restores each row's own lock.
    for (const row of data ?? []) {
      if (locked(row.slug)) {
        const { error: cascadeError } = await supabase
          .from("pages")
          .update({ is_private: true })
          .eq("project_slug", row.slug);
        fail("Could not lock the project's pages", cascadeError);
        const { error: folderError } = await supabase
          .from("folders")
          .update({ is_private: true })
          .eq("project_slug", row.slug);
        fail("Could not lock the project's folders", folderError);
      } else {
        const projectMeta = await this.getMeta(row.slug);
        await this.saveMeta(row.slug, projectMeta);
      }
    }
    this.invalidate();
  }

  async movePages(moves: PageMove[]) {
    const real = moves.filter((m) => m.from !== m.to);
    if (real.length === 0) {
      return;
    }
    const cache = await this.pages();

    for (const move of real) {
      const page = cache.get(move.from.toLowerCase());
      if (!page) {
        continue;
      }
      const from = splitPath(move.from);
      const to = splitPath(move.to);
      const { error } = await supabase
        .from("pages")
        .update({ project_slug: to.project, rel: to.rel })
        .eq("project_slug", from.project)
        .eq("rel", from.rel);
      fail(`Could not move ${move.from}`, error);
      cache.delete(move.from.toLowerCase());
      cache.set(move.to.toLowerCase(), { ...page, path: move.to });
    }

    // Repoint links that pointed at the old paths — only pages that actually
    // changed are written.
    for (const page of Array.from(cache.values())) {
      const copy: WikiPage = JSON.parse(JSON.stringify(page));
      let changed = false;
      for (const move of real) {
        changed = rewriteLinksInPage(copy, move.from, move.to) || changed;
      }
      if (changed) {
        await this.writePage(copy);
      }
    }
  }

  async getVariables() {
    const pages = await this.pages();
    return extractVariables(Array.from(pages.values()));
  }

  async getTerms() {
    const pages = await this.pages();
    return extractTerms(Array.from(pages.values()));
  }

  async getVariableDefs() {
    const pages = await this.pages();
    return collectVariableDefs(Array.from(pages.values()));
  }

  async getTermDefs() {
    const pages = await this.pages();
    return collectTermDefs(Array.from(pages.values()));
  }

  /**
   * The project-wide vocabulary, read from a view that exposes only `global:`
   * definition tokens. It deliberately sees past the page RLS: a global defined
   * on a hidden or locked page must still resolve everywhere else in the
   * project, and a bare token says nothing about the page it came from.
   */
  async getGlobalDefs() {
    if (!this.globalDefs) {
      this.globalDefs = (async () => {
        const { data, error } = await supabase.from("global_defs").select("project_slug,token");
        fail("Could not read global_defs — run supabase/schema.sql in the SQL editor", error);
        return parseGlobalDefRows((data ?? []) as GlobalDefRow[]);
      })();
      this.globalDefs.catch(() => {
        this.globalDefs = null;
      });
    }
    return this.globalDefs;
  }

  async getBoard(pagePath: string, boardKey: string): Promise<BoardData | null> {
    const { project, rel } = splitPath(normalizePath(pagePath));
    const { data, error } = await supabase
      .from("boards")
      .select("data")
      .eq("project_slug", project)
      .eq("rel", rel)
      .eq("board_key", boardKey)
      .maybeSingle();
    fail("Could not load board", error);
    return (data?.data as BoardData) ?? null;
  }

  async saveBoard(pagePath: string, boardKey: string, board: BoardData): Promise<void> {
    const page = await this.getPage(pagePath);
    if (!page) {
      throw new Error(`Page not found: ${pagePath}`);
    }
    // A locked page's body was withheld; block board writes until it's unlocked,
    // matching updatePage — otherwise a board could be saved against blanked content.
    if (page.locked) {
      throw new Error("This page is locked — unlock it before editing its board.");
    }
    const { project, rel } = splitPath(normalizePath(pagePath));
    const { error } = await supabase.from("boards").upsert(
      {
        project_slug: project,
        rel,
        board_key: boardKey,
        data: board,
        // Mirror the page's privacy so a private page's board isn't sent to anons.
        is_private: page.access !== "public",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_slug,rel,board_key" }
    );
    fail("Could not save board", error);
  }

  async getSheet(pagePath: string, sheetKey: string): Promise<SheetData | null> {
    const { project, rel } = splitPath(normalizePath(pagePath));
    const { data, error } = await supabase
      .from("sheets")
      .select("data")
      .eq("project_slug", project)
      .eq("rel", rel)
      .eq("sheet_key", sheetKey)
      .maybeSingle();
    fail("Could not load sheet", error);
    return (data?.data as SheetData) ?? null;
  }

  async saveSheet(pagePath: string, sheetKey: string, sheet: SheetData): Promise<void> {
    const page = await this.getPage(pagePath);
    if (!page) {
      throw new Error(`Page not found: ${pagePath}`);
    }
    if (page.locked) {
      throw new Error("This page is locked — unlock it before editing its sheet.");
    }
    const { project, rel } = splitPath(normalizePath(pagePath));
    const { error } = await supabase.from("sheets").upsert(
      {
        project_slug: project,
        rel,
        sheet_key: sheetKey,
        data: sheet,
        is_private: page.access !== "public",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_slug,rel,sheet_key" }
    );
    fail("Could not save sheet", error);
  }

  async search(query: string) {
    const pages = await this.pages();
    return searchInPages(Array.from(pages.values()), query);
  }

  async unlockPage(rawPath: string, password: string): Promise<WikiPage> {
    const page = await this.getPage(rawPath);
    if (!page) {
      throw new Error(`Page not found: ${rawPath}`);
    }
    const { project, rel } = splitPath(page.path);
    const { data, error } = await supabase.rpc("unlock_page", {
      p_slug: project,
      p_rel: rel,
      p_password: password,
    });
    if (error) {
      // 28000 is the "wrong password" our function raises; surface a clean message.
      throw new Error(/28000|wrong password/i.test(error.message) ? "Wrong password." : error.message);
    }
    const body = Array.isArray(data) ? data[0] : data;
    if (!body) {
      throw new Error("Wrong password.");
    }
    const unlocked: WikiPage = {
      ...page,
      header: body.header ?? "",
      lede: body.lede ?? "",
      blocks: body.blocks ?? [],
      locked: false,
    };
    (await this.pages()).set(page.path.toLowerCase(), unlocked);
    return unlocked;
  }

  async getProjectAccess(): Promise<Record<string, AccessLevel>> {
    const { data, error } = await supabase.from("projects").select("slug,access");
    fail("Could not load project access", error);
    const out: Record<string, AccessLevel> = {};
    for (const row of (data ?? []) as { slug: string; access: AccessLevel }[]) {
      out[row.slug.toLowerCase()] = row.access ?? "public";
    }
    return out;
  }

  async setAccess(scope: AccessScope, key: string, level: AccessLevel) {
    if (scope === "folder") {
      const { project, rel } = splitPath(key);
      // A folder that only ever existed implicitly (derived from page paths)
      // needs a row before it can carry an access level.
      const { error } = await supabase
        .from("folders")
        .upsert({ project_slug: project, rel, access: level }, { onConflict: "project_slug,rel" });
      fail("Could not change folder access", error);
    } else if (scope === "project") {
      const { error } = await supabase.from("projects").update({ access: level }).eq("slug", key);
      fail("Could not change project access", error);
      // Making a project public must actually open it: pages can carry their own
      // access (e.g. stamped 'hidden' by the launch migration), which overrides
      // the project. Clear those so "public project" means public.
      if (level === "public") {
        const { error: pagesError } = await supabase
          .from("pages")
          .update({ access: "public" })
          .eq("project_slug", key)
          .neq("access", "public");
        fail("Could not open the project's pages", pagesError);
      }
    } else {
      const { project, rel } = splitPath(key);
      const { error } = await supabase
        .from("pages")
        .update({ access: level })
        .eq("project_slug", project)
        .eq("rel", rel);
      fail("Could not change page access", error);
    }
    this.invalidate();
  }

  async setLockPassword(scope: AccessScope, key: string, password: string) {
    const { error } = await supabase.rpc("set_access_password", {
      p_scope: scope,
      p_key: key,
      p_password: password,
    });
    fail("Could not set the password", error);
  }

  async listGrants(scope: AccessScope, key: string): Promise<string[]> {
    const { data, error } = await supabase.rpc("list_grants", { p_scope: scope, p_key: key });
    fail("Could not load the access list", error);
    return (data ?? []) as string[];
  }

  async addGrant(scope: AccessScope, key: string, email: string) {
    const { error } = await supabase.rpc("grant_access", { p_scope: scope, p_key: key, p_email: email });
    if (error) {
      throw new Error(/no such user|not found/i.test(error.message) ? `No user with email ${email}.` : error.message);
    }
    this.invalidate();
  }

  async removeGrant(scope: AccessScope, key: string, email: string) {
    const { error } = await supabase.rpc("revoke_access", { p_scope: scope, p_key: key, p_email: email });
    fail("Could not revoke access", error);
    this.invalidate();
  }

  /**
   * Uploads into the bucket matching the page's privacy, so a private page's
   * images are never reachable without a signed URL.
   */
  async uploadImage(file: File, pagePath: string) {
    const { project, rel } = splitPath(pagePath);
    const { data, error } = await supabase
      .from("pages")
      .select("is_private")
      .eq("project_slug", project)
      .eq("rel", rel)
      .maybeSingle();
    fail("Could not check the page's privacy", error);

    const bucket = data?.is_private ? PRIVATE_BUCKET : PUBLIC_BUCKET;
    const name = uploadName(file.name);
    const { error: uploadError } = await supabase.storage.from(bucket).upload(name, file);
    fail("Image upload failed", uploadError);
    return `/uploads/${name}`;
  }

  /**
   * Public objects get a plain URL; private ones get a signed URL that expires.
   * The bucket is unknown from the src alone, so the public URL is probed first.
   */
  async resolveAsset(src: string): Promise<string> {
    if (!src.startsWith("/uploads/")) {
      return src;
    }
    const name = src.slice("/uploads/".length);
    const publicUrl = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(name).data.publicUrl;

    const head = await fetch(publicUrl, { method: "HEAD" }).catch(() => null);
    if (head?.ok) {
      return publicUrl;
    }
    const { data } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(name, SIGNED_URL_TTL);
    return data?.signedUrl ?? publicUrl;
  }

  invalidate() {
    this.pagesCache = null;
    this.loading = null;
    this.globalDefs = null;
  }
}

function uploadName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = (dot === -1 ? ".png" : fileName.slice(dot)).toLowerCase();
  const base = (dot === -1 ? fileName : fileName.slice(0, dot)).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return `${Date.now().toString(36)}-${base || "image"}${ext}`;
}

let store: SupabaseStore | null = null;

export function getStore(): SupabaseStore {
  if (!store) {
    store = new SupabaseStore();
  }
  return store;
}

export { wikiConfig };
