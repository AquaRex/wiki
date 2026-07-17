import { supabase } from "./supabase";
import { wikiConfig } from "~/wiki.config";
import {
  blankPage,
  emptyProjectMeta,
  extractVariables,
  isRelLocked,
  normalizePath,
  projectOf,
  rewriteLinksInPage,
  searchInPages,
  stripProjectPrefix,
  type PageMove,
  type PageSummary,
  type ProjectMeta,
  type RootMeta,
  type SearchResult,
  type VariableDef,
  type WikiPage,
} from "./shared";

export interface WikiStore {
  listPages(): Promise<PageSummary[]>;
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
  search(query: string): Promise<SearchResult[]>;
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
  is_private: boolean;
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
        const { data, error } = await supabase.from("pages").select("*");
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
      .map((p) => ({ path: p.path, title: p.title }))
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

    // A new page inherits its project's lock, and any locked folder above it.
    const meta = await this.getMeta(project);
    const rootMeta = await this.getRootMeta();
    const isPrivate =
      rootMeta.private.some((s) => s.toLowerCase() === project.toLowerCase()) ||
      isRelLocked(meta, rel);

    const { error } = await supabase.from("pages").insert({
      project_slug: project,
      rel,
      title: page.title,
      eyebrow: page.eyebrow,
      lede: page.lede,
      tags: page.tags,
      blocks: page.blocks,
      is_private: isPrivate,
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
      supabase.from("folders").select("rel,is_private,sort_order").eq("project_slug", project),
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

  async search(query: string) {
    const pages = await this.pages();
    return searchInPages(Array.from(pages.values()), query);
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
