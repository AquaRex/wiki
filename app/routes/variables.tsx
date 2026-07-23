import { Link } from "react-router";
import type { Route } from "./+types/variables";
import { isPathLocked, normalizePath, pathInProject, projectDisplayName, stripProjectPrefix } from "~/lib/shared";
import { getStore } from "~/lib/store";
import { useAuth } from "~/lib/auth";
import { useProjectMeta } from "~/lib/meta";
import { Shell } from "~/components/wiki/shell";
import { wikiConfig } from "~/wiki.config";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `All variables · ${params.project} · ${wikiConfig.siteName}` }];
}

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const store = getStore();
  const requested = normalizePath(params.project);
  const [allPages, variableDefs, globalDefs] = await Promise.all([
    store.listPages(),
    store.getVariableDefs(),
    store.getGlobalDefs(),
  ]);
  const projectPage = allPages.find((p) => pathInProject(p.path, requested));
  const project = projectPage ? projectPage.path.split("/")[0] : requested;
  const pages = allPages.filter((p) => pathInProject(p.path, project));
  const scanned = variableDefs.filter((v) => pathInProject(v.page, project));
  // Globals whose defining page is hidden or locked: the registry lists them so
  // the project's vocabulary is complete, without saying where they live.
  const named = new Set(scanned.filter((v) => v.scope === "global").map((v) => v.name));
  const restricted = (globalDefs[project.toLowerCase()]?.variables ?? []).filter((v) => !named.has(v.name));
  const variables = [...scanned, ...restricted].sort(
    (a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)
  );
  return { project, pages, variables };
}

export default function Variables({ loaderData }: Route.ComponentProps) {
  const { project, pages, variables } = loaderData;
  const { privateUnlocked } = useAuth();
  const meta = useProjectMeta(project);
  const visible = variables.filter((v) => privateUnlocked || !isPathLocked(meta, v.page));

  return (
    <Shell pages={pages} project={project} currentPath="">
      <header className="page-hero">
        <div className="mx-auto max-w-[1240px] px-6 pb-10 pt-14">
          <div className="eyebrow">{projectDisplayName(project)} · Registry</div>
          <h1 className="hero-title mt-4 font-heading">All variables</h1>
          <p className="hero-lede mt-4">
            Every variable defined in this project with{" "}
            <code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[13px]">
              {"{{var:name=value|description}}"}
            </code>
            . Reference one from any page by writing its exact name, or{" "}
            <code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[13px]">{"{{name|label}}"}</code>{" "}
            for custom text.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-[1240px] px-6 pb-24 pt-8">
        <div className="wiki">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Value</th>
                  <th>Description</th>
                  <th>Defined in</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={4} className="!text-text-faint">
                      No variables defined yet.
                    </td>
                  </tr>
                )}
                {visible.map((v) => (
                  <tr key={`${v.name}·${v.page}`}>
                    <td>
                      {v.page ? (
                        <Link to={`/${v.page}#var-${v.name}`} className="font-mono text-[13px] font-semibold text-waccent">
                          {v.name}
                        </Link>
                      ) : (
                        <span className="font-mono text-[13px] font-semibold text-waccent">{v.name}</span>
                      )}
                    </td>
                    <td className="font-mono text-[13px]">{v.value}</td>
                    <td className="text-text-dim">{v.description}</td>
                    <td>
                      {v.page ? (
                        <Link to={`/${v.page}`} className="wikilink font-mono text-[12.5px]">
                          /{stripProjectPrefix(v.page)}
                        </Link>
                      ) : (
                        <span className="font-mono text-[12.5px] text-text-faint">a restricted page</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Shell>
  );
}
