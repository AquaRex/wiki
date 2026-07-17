import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useRevalidator } from "react-router";
import { Eye, EyeOff, FolderOpen, GripVertical, Lock, LogOut, Moon, Pencil, Plus, ShieldCheck, Sun, Trash2, Unlock } from "lucide-react";
import { useTheme } from "next-themes";
import type { Route } from "./+types/wiki";
import {
  normalizePath,
  pathInProject,
  projectDisplayName,
  projectOf,
  type AccessLevel,
  type PageSummary,
  type RootMeta,
  type VariableDef,
  type WikiPage,
} from "~/lib/shared";
import { getStore } from "~/lib/store";
import { renderMarkdown, type RenderContext } from "~/lib/markdown";
import { useAuth } from "~/lib/auth";
import { useProjectMeta, useRootMeta } from "~/lib/meta";
import { wikiConfig } from "~/wiki.config";
import { Shell } from "~/components/wiki/shell";
import { BlockList } from "~/components/wiki/block-editor";
import { EditableText } from "~/components/wiki/editable";
import { AccessControl } from "~/components/wiki/access-control";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

interface ProjectCard {
  slug: string;
  title: string;
  lede: string;
  pageCount: number;
  access: AccessLevel;
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
    const projectAccess = await store.getProjectAccess();
    const projects: ProjectCard[] = await Promise.all(
      slugs.map(async (slug) => {
        const home = await store.getPage(`${slug}/Home`);
        return {
          slug,
          title: home?.title || projectDisplayName(slug),
          lede: home?.lede ?? "",
          pageCount: allPages.filter((p) => pathInProject(p.path, slug)).length,
          access: projectAccess[slug.toLowerCase()] ?? "public",
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
  const { editUnlocked, signedIn, editMode, setEditMode, signOut } = useAuth();
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
            {signedIn ? (
              <>
                <Button
                  variant={editMode ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEditMode(!editMode)}
                  className="gap-1.5 font-mono text-[11px] uppercase tracking-wider"
                  title={editMode ? "Switch to preview (read-only)" : "Turn editing on"}
                >
                  {editMode ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
                  {editMode ? "Preview" : "Edit"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => signOut()}
                  title="Sign out"
                  aria-label="Sign out"
                  className="text-text-faint hover:text-foreground"
                >
                  <LogOut className="size-4" />
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                render={<Link to="/admin?to=/" />}
                className="gap-1.5 font-mono text-[11px] uppercase tracking-wider text-text-faint"
              >
                <Pencil className="size-3.5" /> Admin
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1240px] px-6 py-12">
        <div className={`grid gap-5 sm:grid-cols-2 lg:grid-cols-3 ${busy ? "pointer-events-none opacity-60" : ""}`}>
          {ordered.map((project) => {
            const locked = project.access !== "public";
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
                    {project.access === "locked" && <Lock className="size-3 text-waccent" />}
                    {project.access === "hidden" && <EyeOff className="size-3 text-waccent" />}
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
                  <div className="absolute right-3 top-3 flex items-center gap-1.5">
                    <AccessControl
                      scope="project"
                      itemKey={project.slug}
                      name={project.title}
                      current={project.access}
                    />
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
 * The password prompt for a locked (visible-but-gated) page. Styled like the
 * sign-in card but centred on the item being unlocked: a large verified shield,
 * the item's name below it, then the password field. On success the unlocked
 * page replaces the blank one and the caller re-renders it.
 */
function AccessPrompt({
  page,
  onUnlocked,
}: {
  page: WikiPage;
  onUnlocked: (unlocked: WikiPage, password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !password) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const unlocked = await getStore().unlockPage(page.path, password);
      onUnlocked(unlocked, password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wrong password.");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-8 text-center shadow-lg">
        <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-accent-soft">
          <ShieldCheck className="size-9 text-waccent" />
        </div>
        <div className="eyebrow mb-1 !text-[11px]">Locked</div>
        <div className="mb-6 font-heading text-xl font-bold">{page.title}</div>
        <div className="grid gap-3 text-left">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                submit();
              }
            }}
            placeholder="Access password"
            className="font-mono"
            autoFocus
          />
          {error && <p className="text-sm text-crit">{error}</p>}
          <Button onClick={submit} className="w-full" disabled={busy || !password}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </div>
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
/* Page header                                                          */
/* ------------------------------------------------------------------ */

/**
 * The big H1. Renders the page's `header` markdown (text or an image); when the
 * header is empty it falls back to the page name, so the page always reads as
 * finished — no placeholder chrome, even in edit mode. Signed in, clicking it
 * opens an inline editor for the header markdown.
 */
function PageHeader({
  page,
  editUnlocked,
  ctx,
}: {
  page: WikiPage;
  editUnlocked: boolean;
  ctx: RenderContext;
}) {
  const revalidator = useRevalidator();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(page.header);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(page.header);
  }, [page.header]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = async () => {
    setEditing(false);
    if (draft !== page.header) {
      try {
        await getStore().updatePage(page.path, (p) => {
          p.header = draft;
        });
        revalidator.revalidate();
      } catch (e) {
        alert(e instanceof Error ? e.message : "Saving failed.");
        setDraft(page.header);
      }
    }
  };

  const display = page.header ? (
    <div className="wiki">{renderMarkdown(page.header, ctx)}</div>
  ) : (
    <h1>{page.title}</h1>
  );

  if (!editUnlocked) {
    return <div className="hero-title mt-4 font-heading">{display}</div>;
  }

  if (editing) {
    return (
      <textarea
        ref={inputRef}
        rows={2}
        value={draft}
        placeholder={`Header — text or ![](image). Empty shows “${page.title}”.`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            setDraft(page.header);
            setEditing(false);
          }
        }}
        className="hero-title mt-4 font-heading w-full bg-transparent outline-none ring-1 ring-accent-line rounded-md px-2 -mx-2"
      />
    );
  }

  return (
    <div
      className="hero-title mt-4 font-heading cursor-text rounded-md decoration-dotted hover:ring-1 hover:ring-accent-line"
      onClick={() => setEditing(true)}
      title="Click to edit the header"
    >
      {display}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page view                                                            */
/* ------------------------------------------------------------------ */

/**
 * Passwords entered this session that unlocked a project's lock, kept in memory
 * (not storage) so any page inheriting the project lock opens without a second
 * prompt — and a refresh clears them, re-prompting as intended. Keyed by lower-
 * cased project slug.
 */
const unlockedProjects = new Map<string, string>();

export default function WikiPage({ loaderData }: Route.ComponentProps) {
  const { editUnlocked } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const store = getStore();
  // A locked page unlocked this session — keyed by path so navigating away and
  // back keeps it open without re-entering the password.
  const [unlocked, setUnlocked] = useState<Record<string, WikiPage>>({});
  // Set when the current locked page couldn't be opened with the project's
  // remembered password (it has its own), so we must show the prompt.
  const [autoTried, setAutoTried] = useState<string | null>(null);

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

  // When a locked page loads and its project was already unlocked this session,
  // open it with the remembered project password — no second prompt. If that
  // password doesn't fit (the page has its own), fall through to the prompt.
  const lp = loaderData.landing ? null : loaderData.page;
  const lproject = loaderData.landing ? "" : (loaderData.project ?? "");
  useEffect(() => {
    if (!lp || !lp.locked) {
      return;
    }
    const key = lp.path.toLowerCase();
    if (unlocked[key]) {
      return;
    }
    const projectPw = unlockedProjects.get(lproject.toLowerCase());
    if (!projectPw) {
      return;
    }
    let cancelled = false;
    store
      .unlockPage(lp.path, projectPw)
      .then((u) => {
        if (!cancelled) {
          setUnlocked((prev) => ({ ...prev, [u.path.toLowerCase()]: u }));
        }
      })
      .catch(() => {
        // The project password doesn't open this page — it has its own. Show the
        // prompt (autoTried marks that we already tried, so we don't loop).
        if (!cancelled) {
          setAutoTried(key);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lp?.path, lp?.locked, lproject]);

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

  const { allPages, requestedPath } = loaderData;
  // Prefer a copy unlocked this session over the blank locked one from the loader.
  const page = (loaderData.page && unlocked[loaderData.page.path.toLowerCase()]) || loaderData.page;
  const project = loaderData.project!;
  const variables = loaderData.variables!;
  const projectPages = allPages.filter((p) => pathInProject(p.path, project));
  const currentPath = page?.path ?? requestedPath;
  // A page whose body the server withheld behind a password (access = locked).
  // Hidden items are already filtered out by the database, so there is no client
  // gate for them — they simply don't load. While an auto-unlock (from a
  // remembered project password) is still pending, don't flash the prompt.
  const pageKey = page?.path.toLowerCase() ?? "";
  const autoPending =
    Boolean(page?.locked) &&
    unlockedProjects.has(project.toLowerCase()) &&
    autoTried !== pageKey &&
    !unlocked[pageKey];
  const needsPassword = Boolean(page?.locked) && !autoPending;

  const deletePage = async (target: WikiPage) => {
    if (confirm(`Delete the page "${target.title}" permanently?`)) {
      await store.deletePage(target.path);
      navigate(`/${project}`);
    }
  };

  return (
    <Shell pages={projectPages} project={project} currentPath={currentPath}>
      {!page ? (
        <NotFound requestedPath={requestedPath} />
      ) : autoPending ? (
        <div className="flex min-h-[70vh] items-center justify-center">
          <div className="eyebrow">Unlocking…</div>
        </div>
      ) : needsPassword ? (
        <AccessPrompt
          page={page}
          onUnlocked={(u, pw) => {
            setUnlocked((prev) => ({ ...prev, [u.path.toLowerCase()]: u }));
            // Remember this password for the project so sibling pages that share
            // the project lock open without another prompt this session.
            unlockedProjects.set(project.toLowerCase(), pw);
          }}
        />
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
                  <div className="flex items-center gap-2">
                    <AccessControl
                      scope="page"
                      itemKey={page.path}
                      name={page.title}
                      current={page.access}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Delete page"
                      className="text-text-faint hover:text-crit"
                      onClick={() => deletePage(page)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
              {/* The page name — drives the URL, sidebar and index. Only surfaced
                  when editing; the header below is what readers see. */}
              {editUnlocked && (
                <EditableText
                  value={page.title}
                  field="title"
                  pagePath={page.path}
                  editUnlocked={editUnlocked}
                  className="mt-4 font-mono text-[12.5px] text-text-dim"
                  placeholder="Page name (used in the URL and index)"
                />
              )}
              {/* The big header. Falls back to the page name when empty, so it
                  always reads as a finished page — no placeholder chrome, even
                  in edit mode. Click it to edit the header markdown. */}
              <PageHeader page={page} editUnlocked={editUnlocked} ctx={renderCtx} />
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
