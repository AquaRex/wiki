import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ChevronRight, FilePlus2, Pencil, ShieldCheck } from "lucide-react";
import { Avatar } from "~/components/wiki/avatar";
import { collapseUnchanged, diffLines } from "~/lib/diff";
import { getStore, type UserEdit } from "~/lib/store";
import { wikiConfig } from "~/wiki.config";

export function meta() {
  return [{ title: `Activity · ${wikiConfig.siteName}` }];
}

/** The +/- body of one save, fetched only when the row is opened. */
function Diff({ id }: { id: number }) {
  const [lines, setLines] = useState<ReturnType<typeof collapseUnchanged> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getStore()
      .revisionDiff(id)
      .then(({ before, after }) => {
        if (!cancelled) {
          setLines(collapseUnchanged(diffLines(before, after)));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the change."));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return <p className="px-4 py-3 text-[12.5px] text-crit">{error}</p>;
  }
  if (!lines) {
    return <p className="px-4 py-3 font-mono text-[12px] text-text-faint">Loading…</p>;
  }
  if (lines.length === 0) {
    return <p className="px-4 py-3 font-mono text-[12px] text-text-faint">No text changed.</p>;
  }

  return (
    <div className="diff">
      {lines.map((line, i) =>
        line === null ? (
          <div key={i} className="diff-gap">
            ⋯
          </div>
        ) : (
          <div key={i} className={`diff-line diff-${line.kind}`}>
            <span className="diff-mark">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
            <span className="diff-text">{line.text || " "}</span>
          </div>
        )
      )}
    </div>
  );
}

export default function UserProfile() {
  const params = useParams();
  const email = decodeURIComponent(params.email ?? "");
  const [edits, setEdits] = useState<UserEdit[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    try {
      setEdits(await getStore().userActivity(email));
    } catch {
      setDenied(true);
      setEdits([]);
    }
  }, [email]);

  useEffect(() => {
    void load();
  }, [load]);

  const created = edits?.filter((e) => e.isCreate) ?? [];

  if (denied) {
    return (
      <div className="mx-auto min-h-screen w-full max-w-[1000px] px-6 py-14">
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-text-dim">
          <ShieldCheck className="mx-auto mb-3 size-8 text-text-faint" />
          Only the wiki owner can see someone's activity.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-[1000px] px-6 py-14">
      <div className="eyebrow !text-[11px]">
        <Link to="/admin/users" className="hover:text-waccent">
          Users
        </Link>{" "}
        · Activity
      </div>

      <div className="mt-6 flex items-center gap-4">
        <Avatar name={email} size={56} />
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-bold">{email.split("@")[0]}</h1>
          <div className="mt-1 font-mono text-[12px] text-text-faint">{email}</div>
        </div>
      </div>

      <p className="hero-lede mt-6 max-w-2xl">
        {edits === null
          ? "Loading…"
          : `${created.length} page${created.length === 1 ? "" : "s"} started, ${edits.length} save${
              edits.length === 1 ? "" : "s"
            } in total. History begins when revisions were switched on — earlier work shows as a single starting point.`}
      </p>

      <div className="mt-8 flex flex-col gap-2">
        {edits?.length === 0 && (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-text-dim">
            Nothing recorded for this account yet.
          </div>
        )}
        {edits?.map((edit) => (
          <div key={edit.id} className="overflow-hidden rounded-lg border border-border bg-surface">
            <button
              type="button"
              onClick={() => setOpen(open === edit.id ? null : edit.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
            >
              <ChevronRight
                className={`size-3.5 shrink-0 text-text-faint transition-transform ${open === edit.id ? "rotate-90" : ""}`}
              />
              {edit.isCreate ? (
                <FilePlus2 className="size-3.5 shrink-0 text-waccent" />
              ) : (
                <Pencil className="size-3.5 shrink-0 text-text-faint" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{edit.title || edit.path}</span>
                <span className="block truncate font-mono text-[11px] text-text-faint">/{edit.path}</span>
              </span>
              <span className="shrink-0 font-mono text-[11.5px]">
                {edit.added > 0 && <span className="text-good">+{edit.added}</span>}{" "}
                {edit.removed > 0 && <span className="text-crit">−{edit.removed}</span>}
              </span>
              <span className="hidden shrink-0 font-mono text-[11px] text-text-faint sm:block">
                {new Date(edit.editedAt).toLocaleString()}
              </span>
            </button>
            {open === edit.id && (
              <div className="border-t border-border">
                <Diff id={edit.id} />
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="mt-10">
        <Link
          to="/admin/users"
          className="font-mono text-[11.5px] uppercase tracking-wider text-text-faint hover:text-waccent"
        >
          ← All users
        </Link>
      </p>
    </div>
  );
}
