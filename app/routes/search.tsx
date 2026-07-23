import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Search as SearchIcon, X } from "lucide-react";
import type { Route } from "./+types/search";
import {
  isPathLocked,
  normalizePath,
  parseTagParam,
  pathInProject,
  projectDisplayName,
  stripProjectPrefix,
  type PageCard,
  type SearchResult,
} from "~/lib/shared";
import { getStore } from "~/lib/store";
import { useAuth } from "~/lib/auth";
import { useProjectMeta } from "~/lib/meta";
import { Shell } from "~/components/wiki/shell";
import { Highlight } from "~/components/wiki/search-box";
import { wikiConfig } from "~/wiki.config";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Search${loaderData?.query ? `: ${loaderData.query}` : ""} · ${wikiConfig.siteName}` }];
}

export async function clientLoader({ request, params }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  const store = getStore();
  const requested = normalizePath(params.project);
  const cards = await store.listPageCards();
  const projectPage = cards.find((p) => pathInProject(p.path, requested));
  const project = projectPage ? projectPage.path.split("/")[0] : requested;
  return {
    project,
    cards: cards.filter((p) => pathInProject(p.path, project)),
    query: (url.searchParams.get("q") ?? "").trim(),
    tags: parseTagParam(url.searchParams.get("tags")),
  };
}

/** A tag button — pressed when it is part of the current filter. */
function TagChip({
  tag,
  count,
  active,
  onToggle,
}: {
  tag: string;
  count?: number;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`tag ${active ? "on" : ""}`}
    >
      {tag}
      {count !== undefined && <span className="ml-1.5 text-text-faint">{count}</span>}
      {active && <X className="ml-1 inline-block size-3 align-[-1px]" />}
    </button>
  );
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { project, cards, query: urlQuery, tags } = loaderData;
  const { privateUnlocked } = useAuth();
  const meta = useProjectMeta(project);
  const [, setSearchParams] = useSearchParams();
  // The text box is local so typing stays instant; the URL follows it after a
  // pause so a search is still shareable. Tags live in the URL alone — there is
  // no fast-typing problem there, and it keeps one source of truth.
  const [query, setQuery] = useState(urlQuery);
  const [hits, setHits] = useState<Map<string, SearchResult> | null>(null);

  const needle = query.trim();

  useEffect(() => {
    if (needle.length < 2) {
      setHits(null);
      return;
    }
    let cancelled = false;
    // Search runs against the page cache in memory, so this is a debounce for
    // rendering cost only — no request is made.
    const timer = setTimeout(async () => {
      const found = await getStore().search(needle);
      if (!cancelled) {
        setHits(new Map(found.map((r) => [r.path.toLowerCase(), r])));
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needle]);

  useEffect(() => {
    if (needle === urlQuery) {
      return;
    }
    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (needle) {
            next.set("q", needle);
          } else {
            next.delete("q");
          }
          return next;
        },
        { replace: true, preventScrollReset: true }
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [needle, urlQuery, setSearchParams]);

  const setTags = (next: string[]) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next.length > 0) {
          params.set("tags", next.join(","));
        } else {
          params.delete("tags");
        }
        return params;
      },
      { replace: true, preventScrollReset: true }
    );
  };

  const toggleTag = (tag: string) => {
    const has = tags.some((t) => t.toLowerCase() === tag.toLowerCase());
    setTags(has ? tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...tags, tag]);
  };

  // Pages the text search and the viewer's access allow — the set the tag rail
  // is built from, so a tag is only offered when it would actually narrow this
  // list rather than empty it.
  const matched = useMemo(
    () =>
      cards
        .filter((c) => privateUnlocked || !isPathLocked(meta, c.path))
        .filter((c) => !hits || hits.has(c.path.toLowerCase())),
    [cards, hits, meta, privateUnlocked]
  );

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of matched) {
      for (const tag of card.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    // A selected tag always stays on screen, even when nothing else carries it,
    // so the filter can be taken off again.
    for (const tag of tags) {
      if (!counts.has(tag)) {
        counts.set(tag, 0);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));
  }, [matched, tags]);

  const visible = useMemo(() => {
    const wanted = tags.map((t) => t.toLowerCase());
    const kept = matched.filter((c) => {
      const own = c.tags.map((t) => t.toLowerCase());
      return wanted.every((t) => own.includes(t));
    });
    if (hits) {
      return [...kept].sort(
        (a, b) => (hits.get(b.path.toLowerCase())?.matches ?? 0) - (hits.get(a.path.toLowerCase())?.matches ?? 0)
      );
    }
    // No query — list the project in its index order, so the page reads like the
    // sidebar rather than an arbitrary dump.
    const rank = (card: PageCard) => {
      const rel = stripProjectPrefix(card.path);
      return rel in meta.order ? meta.order[rel] : Number.MAX_SAFE_INTEGER;
    };
    return [...kept].sort(
      (a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
    );
  }, [matched, tags, hits, meta]);

  const filtering = Boolean(hits) || tags.length > 0;

  return (
    <Shell pages={cards} project={project} currentPath="">
      <header className="page-hero">
        <div className="mx-auto max-w-[1240px] px-6 pb-10 pt-14">
          <div className="eyebrow">{projectDisplayName(project)} · Search</div>
          <h1 className="hero-title mt-4 font-heading">{needle ? <>Results for “{needle}”</> : "All pages"}</h1>
          <p className="hero-lede mt-4">
            {filtering
              ? `${visible.length} of ${cards.length} page${cards.length === 1 ? "" : "s"} in this project.`
              : `Every page in this project — ${cards.length} in total. Search by name or content, or filter by tag.`}
          </p>
          <div className="relative mt-6 max-w-xl">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint" />
            <input
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                }
              }}
              placeholder="Filter these pages…"
              className="h-11 w-full rounded-md border border-border bg-surface pl-10 pr-9 text-[15px] text-foreground outline-none transition-colors placeholder:text-text-faint focus:border-accent-line"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-text-faint hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {tagCounts.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {tagCounts.map(([tag, count]) => (
                <TagChip
                  key={tag}
                  tag={tag}
                  count={count}
                  active={tags.some((t) => t.toLowerCase() === tag.toLowerCase())}
                  onToggle={() => toggleTag(tag)}
                />
              ))}
              {tags.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTags([])}
                  className="font-mono text-[11px] uppercase tracking-wider text-waccent hover:underline"
                >
                  Clear tags
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      <div className="mx-auto max-w-[1240px] px-6 pb-24 pt-8">
        <div className="flex flex-col gap-4">
          {visible.map((card) => {
            const hit = hits?.get(card.path.toLowerCase());
            return (
              <div
                key={card.path}
                className="rounded-lg border border-border bg-surface p-5 shadow-sm transition-colors hover:border-accent-line"
              >
                <Link to={`/${card.path}`} className="block">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-heading text-[17px] font-bold text-waccent">
                      <Highlight text={card.title} query={needle} />
                    </span>
                    <span className="font-mono text-[11.5px] text-text-faint">/{stripProjectPrefix(card.path)}</span>
                  </div>
                  {hit && hit.snippets.length > 0 ? (
                    hit.snippets.map((snippet, i) => (
                      <p key={i} className="mt-2 text-[14px] leading-relaxed text-text-dim">
                        <Highlight text={snippet} query={needle} />
                      </p>
                    ))
                  ) : card.lede ? (
                    <p className="mt-2 line-clamp-2 text-[14px] leading-relaxed text-text-dim">
                      <Highlight text={card.lede} query={needle} />
                    </p>
                  ) : null}
                </Link>
                {card.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {card.tags.map((tag) => (
                      <TagChip
                        key={tag}
                        tag={tag}
                        active={tags.some((t) => t.toLowerCase() === tag.toLowerCase())}
                        onToggle={() => toggleTag(tag)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {visible.length === 0 && (
            <div className="rounded-lg border border-border bg-surface p-8 text-center text-text-dim">
              {needle ? (
                <>
                  Nothing matched <span className="font-mono text-waccent">{needle}</span>
                  {tags.length > 0 && " with those tags"}.
                </>
              ) : tags.length > 0 ? (
                <>No page carries every selected tag.</>
              ) : (
                <>This project has no pages yet.</>
              )}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
