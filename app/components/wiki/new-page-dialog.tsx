import { useEffect, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getStore } from "~/lib/store";
import { normalizePath, stripProjectPrefix } from "~/lib/shared";

type Kind = "page" | "folder";

export function NewPageDialog({
  open,
  onOpenChange,
  currentPath,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: string;
  project: string;
}) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const inProjectFolder = currentPath.includes("/") ? currentPath.split("/").slice(0, -1).join("/") + "/" : `${project}/`;
  const folder = inProjectFolder.toLowerCase().startsWith(project.toLowerCase()) ? inProjectFolder : `${project}/`;
  const [kind, setKind] = useState<Kind>("page");
  const [path, setPath] = useState(folder);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setKind("page");
      setPath(folder);
      setTitle("");
      setError("");
    }
  }, [open, folder]);

  const createFolder = async () => {
    const store = getStore();
    const rel = stripProjectPrefix(normalizePath(path));
    if (!rel) {
      throw new Error("Give the folder a name.");
    }
    const meta = await store.getMeta(project);
    if (meta.folders.some((f) => f.toLowerCase() === rel.toLowerCase())) {
      throw new Error(`"${rel}" already exists.`);
    }
    await store.saveMeta(project, { ...meta, folders: [...meta.folders, rel] });
  };

  const submit = async () => {
    if (!path.trim() || busy) {
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
        const created = await getStore().createPage(path, title);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {kind}</DialogTitle>
          <DialogDescription>
            {kind === "page" ? (
              <>
                The page is created immediately — the URL can be shared right away. Use{" "}
                <span className="font-mono">/</span> for folders, e.g.{" "}
                <span className="font-mono">{project}/Enemies/TheHunter</span>.
              </>
            ) : (
              <>
                An empty folder to organise pages into. Lock it from the index to put everything inside it behind the edit
                password.
              </>
            )}
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
            <Label htmlFor="new-page-path">Path</Label>
            <Input
              id="new-page-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={kind === "page" ? "Enemies/TheHunter" : "Enemies"}
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  submit();
                }
              }}
            />
          </div>
          {kind === "page" && (
            <div className="grid gap-2">
              <Label htmlFor="new-page-title">Title (optional)</Label>
              <Input
                id="new-page-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="The Hunter"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    submit();
                  }
                }}
              />
            </div>
          )}
          {error && <p className="text-sm text-crit">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!path.trim() || busy}>
            {busy ? "Creating…" : `Create ${kind}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
