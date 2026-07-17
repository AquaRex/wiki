import { Link } from "react-router";
import type { Route } from "./+types/search";
import { isPathLocked, normalizePath, pathInProject } from "~/lib/shared";
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
  const query = (url.searchParams.get("q") ?? "").trim();
  const store = getStore();
  const requested = normalizePath(params.project);
  const [results, allPages] = await Promise.all([store.search(query), store.listPages()]);
  const projectPage = allPages.find((p) => pathInProject(p.path, requested));
  const project = projectPage ? projectPage.path.split("/")[0] : requested;
  return {
    query,
    results: results.filter((r) => pathInProject(r.path, project)),
    pages: allPages.filter((p) => pathInProject(p.path, project)),
    project,
  };
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { query, results, pages, project } = loaderData;
  const { privateUnlocked } = useAuth();
  const meta = useProjectMeta(project);
  const visible = results.filter((r) => privateUnlocked || !isPathLocked(meta, r.path));

  return (
    <Shell pages={pages} project={project} currentPath="">
      <header className="page-hero">
        <div className="mx-auto max-w-[1240px] px-6 pb-10 pt-14">
          <div className="eyebrow">Search · Full text</div>
          <h1 className="hero-title mt-4 font-heading">{query ? <>Results for “{query}”</> : "Search"}</h1>
          <p className="hero-lede mt-4">
            {query
              ? `${visible.length} page${visible.length === 1 ? "" : "s"} matched in this project.`
              : "Type in the search bar above or in the sidebar to search every page in this project."}
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-[1240px] px-6 pb-24 pt-8">
        <div className="flex flex-col gap-4">
          {visible.map((result) => (
            <Link
              key={result.path}
              to={`/${result.path}`}
              className="block rounded-lg border border-border bg-surface p-5 shadow-sm transition-colors hover:border-accent-line"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-heading text-[17px] font-bold text-waccent">
                  <Highlight text={result.title} query={query} />
                </span>
                <span className="font-mono text-[11.5px] text-text-faint">/{result.path}</span>
              </div>
              {result.snippets.map((snippet, i) => (
                <p key={i} className="mt-2 text-[14px] leading-relaxed text-text-dim">
                  <Highlight text={snippet} query={query} />
                </p>
              ))}
            </Link>
          ))}
          {query && visible.length === 0 && (
            <div className="rounded-lg border border-border bg-surface p-8 text-center text-text-dim">
              Nothing matched <span className="font-mono text-waccent">{query}</span>.
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
