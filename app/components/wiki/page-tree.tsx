import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import { ChevronRight, FileText, FolderClosed, FolderOpen, GripVertical, Lock, Trash2, Unlock } from "lucide-react";
import { getStore } from "~/lib/store";
import {
  lastSegment,
  parentOfRel,
  stripProjectPrefix,
  type PageMove,
  type PageSummary,
  type ProjectMeta,
} from "~/lib/shared";

interface TreeNode {
  name: string;
  /** Project-relative path, e.g. "Systems/Player-Vitals". Order keys use this. */
  rel: string;
  /** Full path including the project segment. */
  fullPath: string;
  page?: PageSummary;
  /** Folder recorded in meta.folders — the only way an empty folder exists. */
  explicitFolder?: boolean;
  children: TreeNode[];
}

type DropPosition = "before" | "after" | "inside";

interface DragState {
  rel: string;
  isFolder: boolean;
}

interface OverState {
  rel: string;
  pos: DropPosition;
}

const HOME = "Home";

/** A node holds children if it has any, was created as a folder, or is a bare path segment. */
function isFolderNode(node: TreeNode): boolean {
  return !node.page || node.children.length > 0 || Boolean(node.explicitFolder);
}

function buildTree(pages: PageSummary[], project: string, meta: ProjectMeta) {
  const root: TreeNode = { name: "", rel: "", fullPath: project, children: [] };
  const byRel = new Map<string, TreeNode>();

  const nodeFor = (segments: string[]): TreeNode => {
    let node = root;
    let rel = "";
    for (const segment of segments) {
      rel = rel ? `${rel}/${segment}` : segment;
      let child = node.children.find((c) => c.name.toLowerCase() === segment.toLowerCase());
      if (!child) {
        child = { name: segment, rel, fullPath: `${project}/${rel}`, children: [] };
        node.children.push(child);
        byRel.set(rel, child);
      }
      node = child;
    }
    return node;
  };

  for (const page of pages) {
    const segments = page.path.split("/").slice(1);
    if (segments.length > 0) {
      nodeFor(segments).page = page;
    }
  }

  for (const rel of meta.folders) {
    const segments = rel.split("/").filter(Boolean);
    if (segments.length > 0) {
      nodeFor(segments).explicitFolder = true;
    }
  }

  // Home is the project's landing page — pin it first and keep it out of the way.
  const rank = (n: TreeNode) => (n.rel in meta.order ? meta.order[n.rel] : Number.MAX_SAFE_INTEGER);
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.rel === HOME) return -1;
      if (b.rel === HOME) return 1;
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(root.children);

  return { tree: root.children, byRel };
}

function TreeItem({
  node,
  depth,
  currentPath,
  draggable,
  ownsLock,
  lockedAbove,
  canView,
  drag,
  over,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onToggleLock,
  onDeleteFolder,
}: {
  node: TreeNode;
  depth: number;
  currentPath: string;
  draggable: boolean;
  /** Whether a rel is itself an entry in the private list, i.e. owns a lock. */
  ownsLock: (rel: string) => boolean;
  /** A folder above this node is locked, so this node inherits it. */
  lockedAbove: boolean;
  canView: boolean;
  drag: DragState | null;
  over: OverState | null;
  onDragStart: (node: TreeNode) => void;
  onDragEnd: () => void;
  onDragOver: (node: TreeNode, e: React.DragEvent) => void;
  onDrop: (node: TreeNode, e: React.DragEvent) => void;
  onToggleLock: (node: TreeNode, locked: boolean) => void;
  onDeleteFolder: (node: TreeNode) => void;
}) {
  const isActive = node.page && node.page.path.toLowerCase() === currentPath.toLowerCase();
  const isAncestor = currentPath.toLowerCase().startsWith(node.fullPath.toLowerCase() + "/");
  const [open, setOpen] = useState(depth === 0 || isAncestor);
  const lockedHere = ownsLock(node.rel);
  const isHome = node.rel === HOME;
  const canDrag = draggable && !isHome;
  // A locked subtree stays collapsed for readers — the lock itself is not a secret.
  const hideChildren = (lockedHere || lockedAbove) && !canView;
  const hasChildren = node.children.length > 0 && !hideChildren;
  const isFolder = isFolderNode(node);

  const isDragging = drag?.rel === node.rel;
  const marker = over?.rel === node.rel ? over.pos : null;

  const dropClass =
    marker === "before"
      ? "shadow-[inset_0_2px_0_0_var(--waccent)]"
      : marker === "after"
        ? "shadow-[inset_0_-2px_0_0_var(--waccent)]"
        : marker === "inside"
          ? "ring-1 ring-accent-line bg-accent-soft"
          : "";

  const label = (
    <span className="flex min-w-0 items-center gap-1.5">
      {isFolder ? (
        open && hasChildren ? (
          <FolderOpen className="size-3.5 shrink-0 text-text-faint" />
        ) : (
          <FolderClosed className="size-3.5 shrink-0 text-text-faint" />
        )
      ) : (
        <FileText className="size-3.5 shrink-0 text-text-faint" />
      )}
      <span className="truncate">{node.page ? node.page.title : node.name}</span>
      {lockedHere && <Lock className="size-3 shrink-0 text-waccent" />}
    </span>
  );

  // A folder with no page of its own only toggles open; there is nothing to link to.
  const linkable = node.page && !(lockedHere && !canView && isFolder);

  return (
    <div>
      <div
        draggable={canDrag}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.rel);
          onDragStart(node);
        }}
        onDragEnd={onDragEnd}
        onDragOver={(e) => onDragOver(node, e)}
        onDrop={(e) => onDrop(node, e)}
        className={`group flex items-center rounded-md text-[13.5px] transition-opacity ${dropClass} ${
          isDragging ? "opacity-40" : ""
        } ${
          isActive ? "bg-accent-soft font-medium text-waccent" : "text-text-dim hover:bg-surface-2 hover:text-foreground"
        }`}
        style={{ paddingLeft: depth * 14 + 4 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex size-5 shrink-0 items-center justify-center text-text-faint hover:text-foreground"
            aria-label={open ? "Collapse" : "Expand"}
          >
            <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        {linkable ? (
          <Link to={`/${node.page!.path}`} className="min-w-0 flex-1 py-1.5 pr-1">
            {label}
          </Link>
        ) : (
          <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 py-1.5 pr-1 text-left">
            {label}
          </button>
        )}
        {draggable && !isHome && !lockedAbove && (
          <button
            type="button"
            onClick={() => onToggleLock(node, !lockedHere)}
            title={lockedHere ? "Make public" : "Lock behind the edit password"}
            aria-label={lockedHere ? "Make public" : "Make private"}
            className={`mr-1 flex size-5 shrink-0 items-center justify-center rounded text-text-faint hover:text-waccent ${
              lockedHere ? "opacity-100 text-waccent" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            {lockedHere ? <Lock className="size-3" /> : <Unlock className="size-3" />}
          </button>
        )}
        {/* Folders only — a page is deleted from its own header. */}
        {draggable && !isHome && !node.page && isFolder && (
          <button
            type="button"
            onClick={() => onDeleteFolder(node)}
            title="Delete folder"
            aria-label="Delete folder"
            className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-text-faint opacity-0 hover:text-crit group-hover:opacity-100"
          >
            <Trash2 className="size-3" />
          </button>
        )}
        {canDrag && (
          <GripVertical className="mr-1 size-3 shrink-0 cursor-grab text-text-faint opacity-0 group-hover:opacity-100" />
        )}
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeItem
              key={child.rel}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              draggable={draggable}
              ownsLock={ownsLock}
              lockedAbove={lockedHere || lockedAbove}
              canView={canView}
              drag={drag}
              over={over}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onToggleLock={onToggleLock}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function PageTree({
  pages,
  project,
  currentPath,
  editUnlocked,
  privateUnlocked,
  meta,
}: {
  pages: PageSummary[];
  project: string;
  currentPath: string;
  editUnlocked: boolean;
  privateUnlocked: boolean;
  meta: ProjectMeta;
}) {
  const [local, setLocal] = useState<ProjectMeta>(meta);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [over, setOver] = useState<OverState | null>(null);
  const [busy, setBusy] = useState(false);
  const revalidator = useRevalidator();
  const navigate = useNavigate();

  useEffect(() => {
    setLocal(meta);
  }, [meta]);

  const { tree, byRel } = useMemo(() => buildTree(pages, project, local), [pages, project, local]);

  const childrenOf = (rel: string) => (rel === "" ? tree : (byRel.get(rel)?.children ?? []));

  const ownsLock = (rel: string) => local.private.some((locked) => locked.toLowerCase() === rel.toLowerCase());

  // A folder can't be dropped into itself or its own subtree.
  const isValidTarget = (target: TreeNode, pos: DropPosition): boolean => {
    if (!drag) {
      return false;
    }
    if (target.rel === drag.rel) {
      return false;
    }
    if (target.rel === HOME && pos === "inside") {
      return false;
    }
    if (drag.isFolder && (target.rel === drag.rel || target.rel.startsWith(drag.rel + "/"))) {
      return false;
    }
    return true;
  };

  const handleDragOver = (node: TreeNode, e: React.DragEvent) => {
    if (!drag) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    let pos: DropPosition;
    if (isFolderNode(node)) {
      pos = y < rect.height * 0.3 ? "before" : y > rect.height * 0.7 ? "after" : "inside";
    } else {
      pos = y < rect.height * 0.5 ? "before" : "after";
    }
    if (!isValidTarget(node, pos)) {
      e.dataTransfer.dropEffect = "none";
      setOver(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver({ rel: node.rel, pos });
  };

  const reset = () => {
    setDrag(null);
    setOver(null);
  };

  const persist = async (next: ProjectMeta, moves: PageMove[], failure: string) => {
    const previous = local;
    setLocal(next);
    setBusy(true);
    try {
      const store = getStore();
      if (moves.length > 0) {
        await store.movePages(moves);
      }
      await store.saveMeta(project, next);

      const movedCurrent = moves.find((m) => m.from.toLowerCase() === currentPath.toLowerCase());
      revalidator.revalidate();
      if (movedCurrent) {
        navigate(`/${movedCurrent.to}`, { replace: true });
      }
    } catch (e) {
      setLocal(previous);
      alert(e instanceof Error ? e.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (dragRel: string, newParent: string, insertIndex: number) => {
    const name = lastSegment(dragRel);
    const newRel = newParent ? `${newParent}/${name}` : name;
    const moved = newRel !== dragRel;

    if (moved && childrenOf(newParent).some((n) => n.name.toLowerCase() === name.toLowerCase())) {
      alert(`"${name}" already exists in that folder. Rename one of them first.`);
      return;
    }

    // Sibling order after the move, with the dragged node inserted at its new spot.
    const sibs = childrenOf(newParent)
      .map((n) => n.rel)
      .filter((r) => r !== dragRel);
    sibs.splice(Math.min(insertIndex, sibs.length), 0, newRel);

    const rekey = (key: string) => (key.startsWith(dragRel + "/") ? newRel + key.slice(dragRel.length) : key);

    // Re-key any entries living under a moved folder, then renumber siblings.
    const nextOrder: Record<string, number> = {};
    for (const [key, value] of Object.entries(local.order)) {
      if (key === dragRel) {
        continue;
      }
      nextOrder[rekey(key)] = value;
    }
    sibs.forEach((rel, i) => {
      nextOrder[rel] = i;
    });

    const next: ProjectMeta = {
      order: nextOrder,
      private: local.private.map((rel) => (rel === dragRel ? newRel : rekey(rel))),
      folders: local.folders.map((rel) => (rel === dragRel ? newRel : rekey(rel))),
    };

    const moves: PageMove[] = [];
    if (moved) {
      const oldFull = `${project}/${dragRel}`;
      const newFull = `${project}/${newRel}`;
      for (const page of pages) {
        if (page.path === oldFull) {
          moves.push({ from: page.path, to: newFull });
        } else if (page.path.startsWith(oldFull + "/")) {
          moves.push({ from: page.path, to: newFull + page.path.slice(oldFull.length) });
        }
      }
    }

    await persist(next, moves, "Could not reorder the index.");
  };

  const toggleLock = async (node: TreeNode, locked: boolean) => {
    if (busy) {
      return;
    }
    const next: ProjectMeta = {
      ...local,
      private: locked
        ? [...local.private, node.rel]
        : local.private.filter((rel) => rel.toLowerCase() !== node.rel.toLowerCase()),
    };
    await persist(next, [], "Could not change the lock.");
  };

  /**
   * Deletes a folder. An empty folder is just a meta entry, so it goes quietly.
   * A folder holding pages would take them with it, so that asks first and names
   * the count — the pages are the part that can't be undone.
   */
  const deleteFolder = async (node: TreeNode) => {
    if (busy) {
      return;
    }
    const prefix = node.rel + "/";
    const doomed = pages.filter((p) => {
      const rel = stripProjectPrefix(p.path);
      return rel.toLowerCase() === node.rel.toLowerCase() || rel.toLowerCase().startsWith(prefix.toLowerCase());
    });

    const message =
      doomed.length > 0
        ? `Delete "${node.rel}" and the ${doomed.length} page${doomed.length === 1 ? "" : "s"} inside it?\n\n` +
          doomed.map((p) => `  ${stripProjectPrefix(p.path)}`).join("\n") +
          "\n\nThis cannot be undone."
        : `Delete the empty folder "${node.rel}"?`;
    if (!confirm(message)) {
      return;
    }

    const covered = (rel: string) =>
      rel.toLowerCase() === node.rel.toLowerCase() || rel.toLowerCase().startsWith(prefix.toLowerCase());

    const next: ProjectMeta = {
      order: Object.fromEntries(Object.entries(local.order).filter(([rel]) => !covered(rel))),
      private: local.private.filter((rel) => !covered(rel)),
      folders: local.folders.filter((rel) => !covered(rel)),
    };

    const previous = local;
    setLocal(next);
    setBusy(true);
    try {
      const store = getStore();
      for (const page of doomed) {
        await store.deletePage(page.path);
      }
      await store.saveMeta(project, next);
      revalidator.revalidate();
      // Navigating away from a page that no longer exists.
      if (doomed.some((p) => p.path.toLowerCase() === currentPath.toLowerCase())) {
        navigate(`/${project}`, { replace: true });
      }
    } catch (e) {
      setLocal(previous);
      alert(e instanceof Error ? e.message : "Could not delete the folder.");
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = (node: TreeNode, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = drag;
    const target = over;
    reset();
    if (!state || !target || target.rel !== node.rel || busy) {
      return;
    }

    if (target.pos === "inside") {
      apply(state.rel, node.rel, childrenOf(node.rel).length);
      return;
    }
    const parent = parentOfRel(node.rel);
    const sibs = childrenOf(parent)
      .map((n) => n.rel)
      .filter((r) => r !== state.rel);
    const index = sibs.indexOf(node.rel);
    const insertAt = index === -1 ? sibs.length : target.pos === "before" ? index : index + 1;
    apply(state.rel, parent, insertAt);
  };

  const rootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const state = drag;
    reset();
    if (!state || busy) {
      return;
    }
    apply(state.rel, "", childrenOf("").length);
  };

  return (
    <div className={busy ? "pointer-events-none opacity-60" : ""}>
      {tree.map((node) => (
        <TreeItem
          key={node.rel}
          node={node}
          depth={0}
          currentPath={currentPath}
          draggable={editUnlocked}
          ownsLock={ownsLock}
          lockedAbove={false}
          canView={privateUnlocked}
          drag={drag}
          over={over}
          onDragStart={(n) => setDrag({ rel: n.rel, isFolder: isFolderNode(n) })}
          onDragEnd={reset}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onToggleLock={toggleLock}
          onDeleteFolder={deleteFolder}
        />
      ))}
      {editUnlocked && (
        <div
          onDragOver={(e) => {
            if (drag) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={rootDrop}
          className={`mt-1 rounded-md border border-dashed text-center font-mono text-[10px] uppercase tracking-wider transition-all ${
            drag ? "border-accent-line py-2 text-text-faint" : "border-transparent py-0 text-transparent"
          }`}
        >
          {drag ? "Drop here for top level" : ""}
        </div>
      )}
    </div>
  );
}
