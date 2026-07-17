import { useEffect, useMemo, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getStore } from "~/lib/store";
import { folderList, normalizeSegment, stripProjectPrefix, type PageSummary, type ProjectMeta } from "~/lib/shared";

type Kind = "page" | "folder";

export function NewPageDialog({
  open,
  onOpenChange,
  currentPath,
  project,
  pages,
  meta,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: string;
  project: string;
  pages: PageSummary[];
  meta: ProjectMeta;
}) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const folders = useMemo(() => folderList(pages, project, meta), [pages, project, meta]);

  // Default to the folder the current page lives in.
  const currentFolder = useMemo(() => {
    const rel = stripProjectPrefix(currentPath);
    const parent = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";
    return folders.includes(parent) ? parent : "";
  }, [currentPath, folders]);

  const [kind, setKind] = useState<Kind>("page");
  const [parent, setParent] = useState(currentFolder);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setKind("page");
      setParent(currentFolder);
      setName("");
      setTitle("");
      setError("");
    }
  }, [open, currentFolder]);

  const cleanName = normalizeSegment(name);
  const rel = parent ? `${parent}/${cleanName}` : cleanName;

  const createFolder = async () => {
    const store = getStore();
    const existing = await store.getMeta(project);
    if (folders.some((f) => f.toLowerCase() === rel.toLowerCase())) {
      throw new Error(`"${rel}" already exists.`);
    }
    await store.saveMeta(project, { ...existing, folders: [...existing.folders, rel] });
  };

  const submit = async () => {
    if (!cleanName || busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (kind === "folder") {
        await createFolder();
        revalidator.revalidate();
        onOpenChange(false);
      } else {
        const created = await getStore().createPage(`${project}/${rel}`, title);
        revalidator.revalidate();
        onOpenChange(false);
        navigate(`/${created}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not create the ${kind}.`);
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      submit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {kind}</DialogTitle>
          <DialogDescription>
            {kind === "page"
              ? "The page is created immediately — the URL can be shared right away."
              : "An empty folder to organise pages into. Drag it in the index to move it later."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Type</Label>
            <div className="flex gap-2">
              {(["page", "folder"] as Kind[]).map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant={kind === option ? "default" : "outline"}
                  size="sm"
                  className="flex-1 capitalize"
                  onClick={() => setKind(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-page-parent">Location</Label>
            <select
              id="new-page-parent"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface px-2 font-mono text-[13px] outline-none focus:ring-1 focus:ring-accent-line"
            >
              {folders.map((folder) => (
                <option key={folder} value={folder}>
                  {folder ? `${project}/${folder}` : project}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-page-name">{kind === "page" ? "Page name" : "Folder name"}</Label>
            <Input
              id="new-page-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === "page" ? "TheHunter" : "Enemies"}
              className="font-mono"
              autoFocus
              onKeyDown={onEnter}
            />
            {cleanName && (
              <p className="font-mono text-[11.5px] text-text-faint">
                /{project}/{rel}
              </p>
            )}
          </div>
          {kind === "page" && (
            <div className="grid gap-2">
              <Label htmlFor="new-page-title">Title (optional)</Label>
              <Input
                id="new-page-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="The Hunter"
                onKeyDown={onEnter}
              />
            </div>
          )}
          {error && <p className="text-sm text-crit">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!cleanName || busy}>
            {busy ? "Creating…" : `Create ${kind}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
