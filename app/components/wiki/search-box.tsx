import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Search } from "lucide-react";
import { isPathLocked, pathInProject, searchHref, type SearchResult } from "~/lib/shared";
import { getStore } from "~/lib/store";
import { useAuth } from "~/lib/auth";
import { useProjectMeta } from "~/lib/meta";

export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) {
    return <>{text}</>;
  }
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  while (true) {
    const index = lower.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    if (index > from) {
      parts.push(text.slice(from, index));
    }
    parts.push(<mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    from = index + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

export function SearchBox({
  compact = false,
  project = "",
  className = "",
}: {
  compact?: boolean;
  project?: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const { privateUnlocked } = useAuth();
  const meta = useProjectMeta(project);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await getStore().search(trimmed);
        if (!cancelled) {
          setResults(
            found
              .filter((r) => !project || pathInProject(r.path, project))
              .filter((r) => privateUnlocked || !isPathLocked(meta, r.path))
          );
          setOpen(true);
        }
      } finally {
        if (!cancelled) {
          setSearching(false);
        }
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, privateUnlocked, project, meta]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    setQuery("");
    navigate(path);
  };

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-faint" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          if (query.trim().length >= 2) {
            setOpen(true);
          }
        }}
        // Enter on an empty box, or a double-click, opens the search page with
        // no filter — which lists every page in the project.
        onDoubleClick={() => {
          if (project) {
            go(searchHref(project, { query: query.trim() }));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && project) {
            go(searchHref(project, { query: query.trim() }));
          }
          if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={compact ? "Search…" : "Search the wiki…"}
        className={`w-full rounded-md border border-border bg-surface-2 pl-8 pr-3 text-foreground outline-none transition-colors placeholder:text-text-faint focus:border-accent-line focus:bg-surface ${
          compact ? "h-8 text-[13px]" : "h-9 text-[13.5px]"
        }`}
      />
      {open && (
        <div className="absolute inset-x-0 top-full z-50 mt-1.5 max-h-[420px] overflow-y-auto rounded-lg border border-border-strong bg-popover shadow-xl">
          {results.length === 0 && (
            <div className="px-3 py-3 text-[13px] text-text-faint">{searching ? "Searching…" : "No matches."}</div>
          )}
          {results.slice(0, 8).map((result) => (
            <button
              key={result.path}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                go(`/${result.path}`);
              }}
              className="block w-full border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13.5px] font-semibold text-waccent">
                  <Highlight text={result.title} query={query.trim()} />
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-text-faint">/{result.path}</span>
              </div>
              {result.snippets[0] && (
                <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-text-dim">
                  <Highlight text={result.snippets[0]} query={query.trim()} />
                </div>
              )}
            </button>
          ))}
          {results.length > 0 && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                go(searchHref(project, { query: query.trim() }));
              }}
              className="block w-full px-3 py-2 text-left font-mono text-[11px] uppercase tracking-wider text-waccent hover:bg-surface-2"
            >
              All {results.length} result{results.length === 1 ? "" : "s"} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
