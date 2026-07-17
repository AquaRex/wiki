import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useRevalidator } from "react-router";
import { FolderOpen, GripVertical, Lock, Moon, Pencil, Plus, Sun, Trash2, Unlock } from "lucide-react";
import { useTheme } from "next-themes";
import type { Route } from "./+types/wiki";
import {
  isPathLocked,
  isProjectPrivate,
  normalizePath,
  pathInProject,
  projectDisplayName,
  projectOf,
  type PageSummary,
  type RootMeta,
  type VariableDef,
  type WikiPage,
} from "~/lib/shared";
import { getStore } from "~/lib/store";
import { useAuth } from "~/lib/auth";
import { useProjectMeta, useRootMeta } from "~/lib/meta";
import { wikiConfig } from "~/wiki.config";
import { Shell } from "~/components/wiki/shell";
import { BlockList } from "~/components/wiki/block-editor";
import { EditableText } from "~/components/wiki/editable";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

interface ProjectCard {
  slug: string;
  title: string;
  lede: string;
  pageCount: number;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (loaderData && "landing" in loaderData && loaderData.landing) {
    return [{ title: `Projects · ${wikiConfig.siteName}` }];
  }
  const title = loaderData?.page?.title ?? loaderData?.requestedPath ?? "Wiki";
  return [{ title: `${title} · ${wikiConfig.siteName}` }];
}

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const store = getStore();
  const splat = normalizePath((params["*"] ?? "").replace(/\/+$/, ""));
  const allPages = await store.listPages();

  if (!splat) {
    const slugs = [...new Set(allPages.map((p) => projectOf(p.path)))];
    const projects: ProjectCard[] = await Promise.all(
      slugs.map(async (slug) => {
        const home = await store.getPage(`${slug}/Home`);
        return {
          slug,
          title: home?.title || projectDisplayName(slug),
          lede: home?.lede ?? "",
          pageCount: allPages.filter((p) => pathInProject(p.path, slug)).length,
        };
      })
    );
    projects.sort((a, b) => a.slug.localeCompare(b.slug, undefined, { sensitivity: "base" }));
    return { landing: true as const, projects, allPages, page: null, requestedPath: "" };
  }

  const pagePath = splat.includes("/") ? splat : `${splat}/Home`;
  const page = await store.getPage(pagePath);
  const project = page ? projectOf(page.path) : projectOf(splat);
  const variables = await store.getVariables();
  const projectVariables: Record<string, VariableDef> = {};
  for (const def of Object.values(variables)) {
    if (pathInProject(def.page, project)) {
      projectVariables[def.name] = def;
    }
  }

  return {
    landing: false as const,
    projects: [] as ProjectCard[],
    allPages,
    page,
    project,
    variables: projectVariables,
    requestedPath: pagePath,
  };
}

/* ------------------------------------------------------------------ */
/* Landing — project selection                                          */
/* ------------------------------------------------------------------ */

function Landing({ projects }: { projects: ProjectCard[] }) {
  const { editUnlocked } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [meta, setMeta] = useRootMeta();
  const [creating, setCreating] = useState(false);
  const [makePrivate, setMakePrivate] = useState(false);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ slug: string; after: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const ordered = useMemo(() => {
    const rank = (p: ProjectCard) => (p.slug in meta.order ? meta.order[p.slug] : Number.MAX_SAFE_INTEGER);
    return [...projects].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.slug.localeCompare(b.slug, undefined, { sensitivity: "base" });
    });
  }, [projects, meta]);

  const persist = async (next: RootMeta, failure: string) => {
    const previous = meta;
    setMeta(next);
    setBusy(true);
    try {
      await getStore().saveRootMeta(next);
    } catch (e) {
      setMeta(previous);
      alert(e instanceof Error ? e.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const createProject = async () => {
    const clean = normalizePath(slug).split("/")[0];
    if (!clean) {
      return;
    }
    try {
      // The project row must exist before its Home page: pages reference it.
      const store = getStore();
      await store.createProject(clean, projectDisplayName(clean), makePrivate);
      const path = await store.createPage(`${clean}/Home`, projectDisplayName(clean));
      revalidator.revalidate();
      navigate(`/${projectOf(path)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the project.");
    }
  };

  const reorder = (dragSlug: string, targetSlug: string, after: boolean) => {
    const slugs = ordered.map((p) => p.slug).filter((s) => s !== dragSlug);
    const index = slugs.indexOf(targetSlug);
    slugs.splice(index === -1 ? slugs.length : after ? index + 1 : index, 0, dragSlug);
    const order: Record<string, number> = {};
    slugs.forEach((s, i) => {
      order[s] = i;
    });
    persist({ ...meta, order }, "Could not reorder the projects.");
  };

  const toggleLock = (project: string, locked: boolean) => {
    persist(
      {
        ...meta,
        private: locked
          ? [...meta.private, project]
          : meta.private.filter((s) => s.toLowerCase() !== project.toLowerCase()),
      },
      "Could not change the lock."
    );
  };

  return (
    <div className="min-h-screen">
      <header className="page-hero">
        <div className="mx-auto flex max-w-[1240px] items-start justify-between px-6 pb-12 pt-16">
          <div>
            <div className="eyebrow">{wikiConfig.siteTagline}</div>
            <h1 className="hero-title mt-4 font-heading">{wikiConfig.siteName}</h1>
            <p className="hero-lede mt-4">Select a project to open its documentation.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
            >
              <Sun className="size-4 dark:hidden" />
              <Moon className="hidden size-4 dark:block" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              render={<Link to="/admin?to=/" />}
              className="gap-1.5 font-mono text-[11px] uppercase tracking-wider text-text-faint"
            >
              <Pencil className="size-3.5" /> Admin
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1240px] px-6 py-12">
        <div className={`grid gap-5 sm:grid-cols-2 lg:grid-cols-3 ${busy ? "pointer-events-none opacity-60" : ""}`}>
          {ordered.map((project) => {
            const locked = isProjectPrivate(meta, project.slug);
            const marker = over?.slug === project.slug ? over.after : null;
            return (
              <div
                key={project.slug}
                draggable={editUnlocked}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", project.slug);
                  setDrag(project.slug);
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  if (!drag || drag === project.slug) {
                    return;
                  }
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const rect = e.currentTarget.getBoundingClientRect();
                  setOver({ slug: project.slug, after: e.clientX - rect.left > rect.width / 2 });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const state = drag;
                  const target = over;
                  setDrag(null);
                  setOver(null);
                  if (state && target && target.slug === project.slug && !busy) {
                    reorder(state, project.slug, target.after);
                  }
                }}
                className={`relative rounded-xl transition-opacity ${drag === project.slug ? "opacity-40" : ""} ${
                  marker === false ? "shadow-[inset_2px_0_0_0_var(--waccent)]" : ""
                } ${marker === true ? "shadow-[inset_-2px_0_0_0_var(--waccent)]" : ""}`}
              >
                <Link
                  to={`/${project.slug}`}
                  className="group block h-full rounded-xl border border-border bg-surface p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent-line hover:shadow-lg"
                >
                  <div className="flex items-center gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-text-faint">
                    <FolderOpen className="size-3.5" />
                    /{project.slug}
                    {locked && <Lock className="size-3 text-waccent" />}
                  </div>
                  <div className="mt-3 font-heading text-[20px] font-bold tracking-tight group-hover:text-waccent">
                    {project.title}
                  </div>
                  {project.lede && (
                    <p className="mt-2 line-clamp-3 text-[14px] leading-relaxed text-text-dim">{project.lede}</p>
                  )}
                  <div className="mt-4 font-mono text-[11px] uppercase tracking-wider text-text-faint">
                    {project.pageCount} page{project.pageCount === 1 ? "" : "s"}
                  </div>
                </Link>
                {editUnlocked && (
                  <div className="absolute right-3 top-3 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => toggleLock(project.slug, !locked)}
                      title={locked ? "Make public" : "Lock behind the edit password"}
                      aria-label={locked ? "Make public" : "Make private"}
                      className="flex size-6 items-center justify-center rounded text-text-faint hover:text-waccent"
                    >
                      {locked ? <Lock className="size-3.5 text-waccent" /> : <Unlock className="size-3.5" />}
                    </button>
                    <GripVertical className="size-3.5 cursor-grab text-text-faint" />
                  </div>
                )}
              </div>
            );
          })}
          {editUnlocked && (
            <div className="flex flex-col justify-center rounded-xl border border-dashed border-border-strong p-6">
              {creating ? (
                <div className="grid gap-2">
                  <Input
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    placeholder="project-name"
                    className="font-mono"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        createProject();
                      }
                      if (e.key === "Escape") {
                        setCreating(false);
                      }
                    }}
                  />
                  <label className="flex cursor-pointer items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-text-faint">
                    <input
                      type="checkbox"
                      checked={makePrivate}
                      onChange={(e) => setMakePrivate(e.target.checked)}
                      className="accent-waccent"
                    />
                    Private
                  </label>
                  {error && <p className="text-sm text-crit">{error}</p>}
                  <Button size="sm" onClick={createProject} disabled={!slug.trim()}>
                    Create project
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex items-center justify-center gap-2 font-mono text-[12px] uppercase tracking-wider text-text-faint hover:text-waccent"
                >
                  <Plus className="size-4" /> New project
                </button>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lock / NotFound                                                      */
/* ------------------------------------------------------------------ */

/**
 * Shown when a private page or project isn't visible to this viewer. The
 * content is already withheld by row level security — this only explains why.
 */
function LockScreen({ requestedPath, what }: { requestedPath: string; what: string }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-8 shadow-lg">
        <div className="eyebrow mb-4 !text-[11px]">Restricted</div>
        <div className="mb-1 flex items-center gap-2 font-heading text-xl font-bold">
          <Lock className="size-4 text-waccent" /> Private {what}
        </div>
        <p className="mb-6 text-sm text-text-dim">
          <span className="font-mono text-[12px]">/{requestedPath}</span> is private. Sign in to view it.
        </p>
        <Button
          className="w-full"
          render={<Link to={`/admin?to=${encodeURIComponent(`/${requestedPath}`)}`} />}
        >
          Sign in
        </Button>
      </div>
    </div>
  );
}

function NotFound({ requestedPath }: { requestedPath: string }) {
  const { editUnlocked } = useAuth();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const path = await getStore().createPage(requestedPath, "");
      revalidator.revalidate();
      navigate(`/${path}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the page.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-xl border border-border-strong bg-surface p-8 shadow-lg">
        <div className="eyebrow mb-4 !text-[11px]">No entry found</div>
        <div className="mb-1 font-heading text-xl font-bold">This page doesn't exist yet</div>
        <p className="mb-6 text-sm text-text-dim">
          Nothing is filed under <span className="font-mono text-[12px] text-waccent">/{requestedPath}</span>.
        </p>
        {editUnlocked ? (
          <>
            <Button className="w-full" onClick={create} disabled={busy}>
              {busy ? "Creating…" : "Create this page now"}
            </Button>
            {error && <p className="mt-3 text-sm text-crit">{error}</p>}
          </>
        ) : (
          <p className="text-sm text-text-faint">
            Unlock editing on the{" "}
            <a href={`/admin?to=/${requestedPath}`} className="text-waccent underline">
              admin page
            </a>{" "}
            to create it.
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page view                                                            */
/* ------------------------------------------------------------------ */

export default function WikiPage({ loaderData }: Route.ComponentProps) {
  const { editUnlocked, privateUnlocked } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const store = getStore();
  const meta = useProjectMeta(loaderData.landing ? "" : (loaderData.project ?? ""));
  const [rootMeta] = useRootMeta();

  useEffect(() => {
    if (location.hash) {
      const el = document.getElementById(location.hash.slice(1));
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("vardef-flash");
        void (el as HTMLElement).offsetWidth;
        el.classList.add("vardef-flash");
      }
    }
  }, [location.hash, location.key]);

  // Built once per page rather than inline: a fresh ctx on every render would
  // remount every image in the preview while typing.
  const renderCtx = useMemo(
    () => ({
      variables: loaderData.variables ?? {},
      pages: loaderData.allPages,
      currentPath: loaderData.page?.path ?? loaderData.requestedPath,
      project: loaderData.landing ? undefined : loaderData.project,
      resolveAsset: (src: string) => store.resolveAsset(src),
    }),
    [loaderData, store]
  );

  if (loaderData.landing) {
    return <Landing projects={loaderData.projects} />;
  }

  const { page, allPages, requestedPath } = loaderData;
  const project = loaderData.project!;
  const variables = loaderData.variables!;
  const projectPages = allPages.filter((p) => pathInProject(p.path, project));
  const currentPath = page?.path ?? requestedPath;
  const lockedProject = isProjectPrivate(rootMeta, project);
  const locked = (lockedProject || isPathLocked(meta, currentPath)) && !privateUnlocked;

  const deletePage = async (target: WikiPage) => {
    if (confirm(`Delete the page "${target.title}" permanently?`)) {
      await store.deletePage(target.path);
      navigate(`/${project}`);
    }
  };

  return (
    <Shell pages={projectPages} project={project} currentPath={currentPath}>
      {locked ? (
        <LockScreen requestedPath={requestedPath} what={lockedProject ? "project" : "page"} />
      ) : !page ? (
        <NotFound requestedPath={requestedPath} />
      ) : (
        <>
          <header className="page-hero">
            <div className="mx-auto max-w-[1240px] px-6 pb-10 pt-14">
              <div className="flex items-start justify-between gap-4">
                <EditableText
                  value={page.eyebrow}
                  field="eyebrow"
                  pagePath={page.path}
                  editUnlocked={editUnlocked}
                  className="eyebrow"
                  placeholder="Category · Subcategory"
                />
                {editUnlocked && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Delete page"
                    className="text-text-faint hover:text-crit"
                    onClick={() => deletePage(page)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
              <EditableText
                value={page.title}
                field="title"
                pagePath={page.path}
                editUnlocked={editUnlocked}
                className="hero-title mt-4 font-heading"
                placeholder="Page title"
                as="h1"
              />
              <EditableText
                value={page.lede}
                field="lede"
                pagePath={page.path}
                editUnlocked={editUnlocked}
                className="hero-lede mt-4"
                placeholder="A one-paragraph summary of this page — what it covers and why it matters."
                multiline
                as="div"
                markdown={renderCtx}
              />
              <div className="mt-6">
                <EditableText
                  value={page.tags.join(", ")}
                  field="tags"
                  pagePath={page.path}
                  editUnlocked={editUnlocked}
                  className="font-mono text-[12.5px] text-text-dim"
                  placeholder="tag-one, tag-two, tag-three"
                  // Tags read as chips and edit as a comma-separated line, so
                  // they look the same signed in or out.
                  renderAs={(value) => (
                    <span className="flex flex-wrap gap-2">
                      {value
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .map((tag) => (
                          <span key={tag} className="tag">
                            {tag}
                          </span>
                        ))}
                    </span>
                  )}
                />
              </div>
            </div>
          </header>
          <div className="mx-auto max-w-[1240px] px-6 pb-24 pt-4">
            <BlockList
              blocks={page.blocks}
              pagePath={page.path}
              ctx={renderCtx}
              editUnlocked={editUnlocked}
            />
            {page.updated && (
              <div className="mt-16 border-t border-border pt-4 font-mono text-[11.5px] text-text-faint">
                Last updated {new Date(page.updated).toLocaleString()} · /{page.path}
              </div>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}
