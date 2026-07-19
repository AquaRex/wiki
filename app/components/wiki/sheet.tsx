import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Bold,
  ClipboardPaste,
  Copy,
  Italic,
  Plus,
  Redo2,
  Undo2,
  X,
} from "lucide-react";
import { getStore } from "~/lib/store";
import { useAuth } from "~/lib/auth";
import { makeFormulaEngine } from "~/lib/sheet-formula";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  cellRef,
  colName,
  defaultSheet,
  SHEET_DEFAULT_COL_WIDTH,
  SHEET_DEFAULT_ROW_HEIGHT,
  type SheetCell,
  type SheetCellType,
  type SheetData,
} from "~/lib/shared";

/*
 * A spreadsheet grid rendered by the :::cells directive. Like :::roadmap, its
 * data lives in its own `sheets` table row (loaded after the page so RLS can
 * withhold a private page's sheet), it is edit-gated, and every change saves
 * debounced.
 *
 * The grid is a sparse cell map: only populated cells are stored. Columns are
 * A..Z (grows via the context menu), rows are 1..N. Single-click selects a cell;
 * typing or double-click edits it. Drag selects a range; clicking a row number
 * or column letter selects the whole row/column. Right-click opens a context
 * menu (cut/copy/paste, colours, type, and — on rows/columns — resize/sort).
 * Dragging a selected cell onto another copies its value there.
 */

/* ------------------------------------------------------------------ */
/* Colour options — wiki tones + custom, with localStorage presets     */
/* ------------------------------------------------------------------ */

/** Named colours already used on the site, offered first in the picker. */
const TONE_SWATCHES: { name: string; label: string; css: string }[] = [
  { name: "", label: "Default", css: "transparent" },
  { name: "error", label: "Error", css: "var(--crit)" },
  { name: "warn", label: "Warn", css: "var(--warn)" },
  { name: "good", label: "Good", css: "var(--good)" },
  { name: "tips", label: "Tips", css: "var(--info)" },
  { name: "muted", label: "Muted", css: "var(--text-faint)" },
  { name: "white", label: "White", css: "#ffffff" },
];

/** The site's own palette (dark theme), so header/cell colours match the wiki.
 *  Stored verbatim as #hex. Backgrounds first, then accents and text tones. */
const SITE_SWATCHES: { hex: string; label: string }[] = [
  { hex: "#0f1319", label: "Page bg" },
  { hex: "#10141a", label: "Deep" },
  { hex: "#12171e", label: "Code bg" },
  { hex: "#161b23", label: "Surface" },
  { hex: "#1c222c", label: "Surface 2" },
  { hex: "#29313d", label: "Border" },
  { hex: "#38414f", label: "Border strong" },
  { hex: "#2a2113", label: "Accent soft" },
  { hex: "#b9822f", label: "Accent line" },
  { hex: "#bb8a43", label: "Gold" },
  { hex: "#da781c", label: "Orange" },
  { hex: "#e5a64b", label: "Accent" },
  { hex: "#57b382", label: "Green" },
  { hex: "#e07070", label: "Red" },
  { hex: "#d99b3f", label: "Amber" },
  { hex: "#6aa9dd", label: "Blue" },
  { hex: "#e7eaf0", label: "Text" },
  { hex: "#9aa3b2", label: "Text dim" },
];

const PRESETS_KEY = "wiki-sheet-color-presets";

function loadPresets(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(PRESETS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function savePreset(hex: string) {
  if (typeof window === "undefined") {
    return;
  }
  const existing = loadPresets().filter((c) => c.toLowerCase() !== hex.toLowerCase());
  const next = [hex, ...existing].slice(0, 12);
  try {
    window.localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked — presets are best-effort */
  }
}

/** Resolves a stored colour (tone name or #hex) to a CSS value. */
function colorToCss(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const tone = TONE_SWATCHES.find((t) => t.name === value && t.name !== "");
  if (tone) {
    return tone.css;
  }
  return value; // a #hex custom colour, stored verbatim
}

/* ------------------------------------------------------------------ */
/* Selection model                                                     */
/* ------------------------------------------------------------------ */

interface Rect {
  c1: number;
  r1: number;
  c2: number;
  r2: number;
}

function normRect(a: { c: number; r: number }, b: { c: number; r: number }): Rect {
  return {
    c1: Math.min(a.c, b.c),
    c2: Math.max(a.c, b.c),
    r1: Math.min(a.r, b.r),
    r2: Math.max(a.r, b.r),
  };
}

function rectHas(rect: Rect | null, c: number, r: number): boolean {
  return !!rect && c >= rect.c1 && c <= rect.c2 && r >= rect.r1 && r <= rect.r2;
}

/** Keeps a sheet crash contained to its block rather than blanking the page. */
class SheetBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <div className="sheet-empty">This sheet couldn’t be drawn.</div>;
    }
    return this.props.children;
  }
}

export function Sheet(props: { pagePath: string; sheetKey: string }) {
  return (
    <SheetBoundary>
      <SheetGrid {...props} />
    </SheetBoundary>
  );
}

type MenuState = {
  x: number;
  y: number;
  /** Whether the selection is a full set of columns / rows (enables resize/sort). */
  scope: "cells" | "columns" | "rows";
} | null;

function SheetGrid({ pagePath, sheetKey }: { pagePath: string; sheetKey: string }) {
  const { editUnlocked } = useAuth();
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const [sel, setSel] = useState<Rect | null>(null);
  const anchor = useRef<{ c: number; r: number } | null>(null);
  const dragging = useRef(false);
  const [editing, setEditing] = useState<{ c: number; r: number } | null>(null);
  const editValue = useRef("");
  const [menu, setMenu] = useState<MenuState>(null);
  // The dragged cell; `block` is the selection rect when dragging a whole
  // multi-cell selection (a move), null for a single cell (a copy).
  const cellDrag = useRef<{ c: number; r: number; block: Rect | null } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set on mousedown when a list cell was already the sole active cell, so the
  // ensuing click opens its dropdown instead of merely re-selecting.
  const clickToEdit = useRef(false);
  // Set when the press landed inside an existing multi-cell selection: the
  // selection is kept (not collapsed) so a hold can drag the whole block; a
  // plain click then collapses to the pressed cell.
  const pressInside = useRef(false);
  const pendingCollapse = useRef<{ c: number; r: number } | null>(null);
  // Dragging a column letter / row number to reorder: the dragged index range.
  const headerDrag = useRef<{ kind: "col" | "row"; a: number; b: number } | null>(null);
  const [headerDropTarget, setHeaderDropTarget] = useState<{ kind: "col" | "row"; i: number } | null>(null);
  // The last internal copy, kept so an internal paste restores colours/types the
  // plain-text OS clipboard can't carry. `tsv` is what we wrote to the OS
  // clipboard; a paste whose text matches it is known to be our own copy.
  const lastCopy = useRef<{ tsv: string; cells: (SheetCell | undefined)[][] } | null>(null);
  // A cell only becomes HTML5-draggable after a short press-and-hold, so the
  // default press gesture stays selection. Moving to select disarms it.
  const [armedCell, setArmedCell] = useState<{ c: number; r: number } | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Options being edited in the list-type dialog, or null when it's closed.
  const [listDialog, setListDialog] = useState<{ c1: number; c2: number; options: string[] } | null>(null);

  const disarm = () => {
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setArmedCell((a) => (a ? null : a));
  };

  useEffect(() => {
    let cancelled = false;
    getStore()
      .getSheet(pagePath, sheetKey)
      .then((data) => {
        if (!cancelled) {
          setSheet(data ?? defaultSheet());
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pagePath, sheetKey]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoStack = useRef<SheetData[]>([]);
  const redoStack = useRef<SheetData[]>([]);

  const scheduleSave = (next: SheetData) => {
    setSheet(next);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(() => {
      getStore()
        .saveSheet(pagePath, sheetKey, next)
        .catch((e) => alert(e instanceof Error ? e.message : "Could not save sheet."));
    }, 500);
  };

  // Every user edit routes through commit, which snapshots the prior state for
  // undo. Redo is cleared because a fresh edit forks a new history branch.
  const commit = (next: SheetData) => {
    if (sheet) {
      undoStack.current.push(sheet);
      if (undoStack.current.length > 100) {
        undoStack.current.shift();
      }
    }
    redoStack.current = [];
    scheduleSave(next);
  };

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev || !sheet) {
      return;
    }
    redoStack.current.push(sheet);
    scheduleSave(prev);
  };

  const redo = () => {
    const nextState = redoStack.current.pop();
    if (!nextState || !sheet) {
      return;
    }
    undoStack.current.push(sheet);
    scheduleSave(nextState);
  };

  // Close the context menu on any outside click / Escape.
  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (status === "loading") {
    return <div className="sheet-empty">Loading sheet…</div>;
  }
  if (status === "error" || !sheet) {
    return <div className="sheet-empty">This sheet couldn’t be loaded.</div>;
  }

  const cols = sheet.cols;
  const rows = sheet.rows;
  const colWidths = sheet.colWidths ?? {};
  const rowHeights = sheet.rowHeights ?? {};
  const colTypes = sheet.colTypes ?? {};
  const colLists = sheet.colLists ?? {};
  const freezeCols = sheet.freezeCols ?? 0;
  const freezeRows = sheet.freezeRows ?? 0;

  const widthOf = (c: number) => colWidths[c] ?? SHEET_DEFAULT_COL_WIDTH;
  const heightOf = (r: number) => rowHeights[r] ?? SHEET_DEFAULT_ROW_HEIGHT;
  // Left edge (px from the grid start) of a frozen column's sticky anchor, and
  // top edge of a frozen row's — the running sum of the sizes before it, past
  // the row-header / column-letter gutters that are always pinned.
  const frozenLeft = (c: number) => {
    let x = ROW_HEADER_W;
    for (let i = 0; i < c; i++) {
      x += widthOf(i);
    }
    return x;
  };
  const frozenTop = (r: number) => {
    let y = HEADER_ROW_H;
    for (let i = 0; i < r; i++) {
      y += heightOf(i);
    }
    return y;
  };
  const typeOf = (c: number, r: number): SheetCellType =>
    sheet.cells[cellRef(c, r)]?.type ?? colTypes[c] ?? "normal";

  /* ---- cell mutations ---- */

  const setCell = (draft: SheetData, c: number, r: number, patch: Partial<SheetCell>) => {
    const ref = cellRef(c, r);
    const current = draft.cells[ref] ?? {};
    const merged: SheetCell = { ...current, ...patch };
    // Drop empty cells from the sparse map entirely. A cell counts as populated
    // if it carries any value, colour, type or formatting (so a pre-formatted
    // header cell survives even before it holds text).
    const empty =
      !merged.v &&
      !merged.color &&
      !merged.bg &&
      !merged.type &&
      !merged.bold &&
      !merged.italic &&
      !merged.size;
    if (empty) {
      const { [ref]: _drop, ...rest } = draft.cells;
      draft.cells = rest;
    } else {
      draft.cells = { ...draft.cells, [ref]: merged };
    }
  };

  const cloneSheet = (): SheetData => ({
    ...sheet,
    cells: { ...sheet.cells },
    colWidths: { ...colWidths },
    rowHeights: { ...rowHeights },
    colTypes: { ...colTypes },
    colLists: { ...colLists },
  });

  const applyToSelection = (patch: Partial<SheetCell>) => {
    if (!sel) {
      return;
    }
    const next = cloneSheet();
    for (let c = sel.c1; c <= sel.c2; c++) {
      for (let r = sel.r1; r <= sel.r2; r++) {
        setCell(next, c, r, patch);
      }
    }
    commit(next);
  };

  const setCellValue = (c: number, r: number, v: string) => {
    const next = cloneSheet();
    setCell(next, c, r, { v });
    commit(next);
  };

  /* ---- formatting (applies to the whole selection) ---- */

  const activeCell = (): SheetCell | undefined => (sel ? sheet.cells[cellRef(sel.c1, sel.r1)] : undefined);

  const toggleBold = () => applyToSelection({ bold: !activeCell()?.bold });
  const toggleItalic = () => applyToSelection({ italic: !activeCell()?.italic });
  const bumpSize = (delta: number) => {
    const current = activeCell()?.size ?? SHEET_DEFAULT_FONT_SIZE;
    const size = Math.max(9, Math.min(48, current + delta));
    applyToSelection({ size: size === SHEET_DEFAULT_FONT_SIZE ? undefined : size });
  };

  /* ---- selection handlers ---- */

  const beginEdit = (c: number, r: number, initial?: string) => {
    editValue.current = initial ?? sheet.cells[cellRef(c, r)]?.v ?? "";
    setEditing({ c, r });
  };

  const commitEdit = () => {
    if (editing) {
      setCellValue(editing.c, editing.r, editValue.current);
    }
    setEditing(null);
  };

  const selectCell = (c: number, r: number, extend: boolean) => {
    if (extend && anchor.current) {
      setSel(normRect(anchor.current, { c, r }));
    } else {
      anchor.current = { c, r };
      setSel({ c1: c, r1: r, c2: c, r2: r });
    }
  };

  const selectColumns = (c1: number, c2: number) => {
    anchor.current = { c: c1, r: 0 };
    setSel({ c1: Math.min(c1, c2), c2: Math.max(c1, c2), r1: 0, r2: rows - 1 });
  };

  const selectRows = (r1: number, r2: number) => {
    anchor.current = { c: 0, r: r1 };
    setSel({ c1: 0, c2: cols - 1, r1: Math.min(r1, r2), r2: Math.max(r1, r2) });
  };

  const selScope = (): "cells" | "columns" | "rows" => {
    if (!sel) {
      return "cells";
    }
    if (sel.r1 === 0 && sel.r2 === rows - 1 && !(sel.c1 === 0 && sel.c2 === cols - 1)) {
      return "columns";
    }
    if (sel.c1 === 0 && sel.c2 === cols - 1 && !(sel.r1 === 0 && sel.r2 === rows - 1)) {
      return "rows";
    }
    return "cells";
  };

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, scope: selScope() });
  };

  /* ---- clipboard (TSV interop with Excel / Sheets) ---- */

  const buildCopy = (): { tsv: string; cells: (SheetCell | undefined)[][] } | null => {
    if (!sel) {
      return null;
    }
    const cells: (SheetCell | undefined)[][] = [];
    for (let r = sel.r1; r <= sel.r2; r++) {
      const row: (SheetCell | undefined)[] = [];
      for (let c = sel.c1; c <= sel.c2; c++) {
        const cell = sheet.cells[cellRef(c, r)];
        row.push(cell ? { ...cell } : undefined);
      }
      cells.push(row);
    }
    const tsv = toTSV(cells.map((row) => row.map((cell) => cell?.v ?? "")));
    return { tsv, cells };
  };

  /** Writes the selection to a clipboard event (used by native copy/cut). */
  const writeClipboard = (e: React.ClipboardEvent): boolean => {
    const copy = buildCopy();
    if (!copy) {
      return false;
    }
    lastCopy.current = copy;
    e.clipboardData.setData("text/plain", copy.tsv);
    return true;
  };

  /** Fallback copy for the toolbar button (no clipboard event to write into). */
  const doCopyButton = () => {
    const copy = buildCopy();
    if (!copy) {
      return;
    }
    lastCopy.current = copy;
    navigator.clipboard?.writeText(copy.tsv).catch(() => {});
  };

  /** Pastes clipboard text at the selection, growing the sheet to fit. Uses the
   *  style-carrying internal copy when the text matches what we last copied. */
  const pasteText = (text: string) => {
    if (!sel || !text) {
      return;
    }
    const startC = sel.c1;
    const startR = sel.r1;
    const internal = lastCopy.current && text === lastCopy.current.tsv ? lastCopy.current.cells : null;
    const grid = internal ? internal.map((row) => row.map((cell) => cell?.v ?? "")) : fromTSV(text);
    if (grid.length === 0) {
      return;
    }
    const height = grid.length;
    const width = Math.max(...grid.map((row) => row.length));
    const next = cloneSheet();
    next.cols = Math.max(next.cols, startC + width);
    next.rows = Math.max(next.rows, startR + height);
    for (let dr = 0; dr < height; dr++) {
      for (let dc = 0; dc < grid[dr].length; dc++) {
        const src = internal ? internal[dr][dc] : undefined;
        setCell(next, startC + dc, startR + dr, {
          v: grid[dr][dc] ?? "",
          color: src?.color,
          bg: src?.bg,
          type: src?.type,
          bold: src?.bold,
          italic: src?.italic,
          size: src?.size,
        });
      }
    }
    commit(next);
    setSel({ c1: startC, r1: startR, c2: startC + width - 1, r2: startR + height - 1 });
  };

  const doPasteButton = () => {
    navigator.clipboard
      ?.readText()
      .then((text) => pasteText(text))
      .catch(() => {});
  };

  const doCutButton = () => {
    doCopyButton();
    applyToSelection({ v: "" });
  };

  /** Moves a whole block of cells by (dc, dr) — clears the source, overwrites
   *  the destination — and follows it with the selection. */
  const moveBlock = (block: Rect, dc: number, dr: number) => {
    if (block.c1 + dc < 0 || block.r1 + dr < 0) {
      return; // would move off the top / left edge
    }
    const next = cloneSheet();
    const moved: { ref: string; cell: SheetCell }[] = [];
    for (let cc = block.c1; cc <= block.c2; cc++) {
      for (let rr = block.r1; rr <= block.r2; rr++) {
        const cell = next.cells[cellRef(cc, rr)];
        if (cell) {
          moved.push({ ref: cellRef(cc + dc, rr + dr), cell });
        }
        delete next.cells[cellRef(cc, rr)];
      }
    }
    // Clear the destination region, then drop the moved cells in.
    for (let cc = block.c1 + dc; cc <= block.c2 + dc; cc++) {
      for (let rr = block.r1 + dr; rr <= block.r2 + dr; rr++) {
        delete next.cells[cellRef(cc, rr)];
      }
    }
    for (const m of moved) {
      next.cells[m.ref] = m.cell;
    }
    next.cols = Math.max(next.cols, block.c2 + dc + 1);
    next.rows = Math.max(next.rows, block.r2 + dr + 1);
    commit(next);
    setSel({ c1: block.c1 + dc, r1: block.r1 + dr, c2: block.c2 + dc, r2: block.r2 + dr });
  };

  /* ---- structure ops ---- */

  const addColumns = (n: number) => commit({ ...cloneSheet(), cols: cols + n });
  const addRows = (n: number) => commit({ ...cloneSheet(), rows: rows + n });

  const deleteColumns = (c1: number, c2: number) => {
    const next = cloneSheet();
    const kept: Record<string, SheetCell> = {};
    const removed = c2 - c1 + 1;
    for (const [ref, cell] of Object.entries(next.cells)) {
      const { c, r } = parseRef(ref);
      if (c < c1) {
        kept[ref] = cell;
      } else if (c > c2) {
        kept[cellRef(c - removed, r)] = cell;
      }
    }
    next.cells = kept;
    next.cols = Math.max(1, cols - removed);
    shiftIndexMaps(next, "col", c1, removed);
    commit(next);
    setSel(null);
  };

  const deleteRows = (r1: number, r2: number) => {
    const next = cloneSheet();
    const kept: Record<string, SheetCell> = {};
    const removed = r2 - r1 + 1;
    for (const [ref, cell] of Object.entries(next.cells)) {
      const { c, r } = parseRef(ref);
      if (r < r1) {
        kept[ref] = cell;
      } else if (r > r2) {
        kept[cellRef(c, r - removed)] = cell;
      }
    }
    next.cells = kept;
    next.rows = Math.max(1, rows - removed);
    shiftIndexMaps(next, "row", r1, removed);
    commit(next);
    setSel(null);
  };

  /** Reorders columns c1..c2 to sit before `target`, remapping cells and the
   *  per-column sizing/type/list maps. Follows the moved block with selection. */
  const moveColumns = (c1: number, c2: number, target: number) => {
    if (target >= c1 && target <= c2) {
      return; // dropped onto itself
    }
    const order: number[] = [];
    for (let i = 0; i < cols; i++) {
      order.push(i);
    }
    const count = c2 - c1 + 1;
    const moving = order.splice(c1, count);
    const pos = order.indexOf(target);
    const insertAt = pos === -1 ? order.length : pos;
    order.splice(insertAt, 0, ...moving);
    // order[newIndex] = oldIndex → invert to oldIndex → newIndex.
    const newOf: Record<number, number> = {};
    order.forEach((oldC, newC) => (newOf[oldC] = newC));

    const next = cloneSheet();
    const cells: Record<string, SheetCell> = {};
    for (const [ref, cell] of Object.entries(next.cells)) {
      const { c, r } = parseRef(ref);
      cells[cellRef(newOf[c] ?? c, r)] = cell;
    }
    next.cells = cells;
    next.colWidths = remapIndexMap(next.colWidths, newOf);
    next.colTypes = remapIndexMap(next.colTypes, newOf);
    next.colLists = remapIndexMap(next.colLists, newOf);
    commit(next);
    setSel({ c1: insertAt, c2: insertAt + count - 1, r1: 0, r2: rows - 1 });
  };

  const moveRows = (r1: number, r2: number, target: number) => {
    if (target >= r1 && target <= r2) {
      return;
    }
    const order: number[] = [];
    for (let i = 0; i < rows; i++) {
      order.push(i);
    }
    const count = r2 - r1 + 1;
    const moving = order.splice(r1, count);
    const pos = order.indexOf(target);
    const insertAt = pos === -1 ? order.length : pos;
    order.splice(insertAt, 0, ...moving);
    const newOf: Record<number, number> = {};
    order.forEach((oldR, newR) => (newOf[oldR] = newR));

    const next = cloneSheet();
    const cells: Record<string, SheetCell> = {};
    for (const [ref, cell] of Object.entries(next.cells)) {
      const { c, r } = parseRef(ref);
      cells[cellRef(c, newOf[r] ?? r)] = cell;
    }
    next.cells = cells;
    next.rowHeights = remapIndexMap(next.rowHeights, newOf);
    commit(next);
    setSel({ c1: 0, c2: cols - 1, r1: insertAt, r2: insertAt + count - 1 });
  };

  const resizeSelection = (px: number) => {
    const scope = selScope();
    if (!sel || (scope !== "columns" && scope !== "rows")) {
      return;
    }
    const next = cloneSheet();
    if (scope === "columns") {
      for (let c = sel.c1; c <= sel.c2; c++) {
        next.colWidths = { ...next.colWidths, [c]: px };
      }
    } else {
      for (let r = sel.r1; r <= sel.r2; r++) {
        next.rowHeights = { ...next.rowHeights, [r]: px };
      }
    }
    commit(next);
  };

  const setSelectionType = (type: SheetCellType, list?: string[]) => {
    if (!sel) {
      return;
    }
    const next = cloneSheet();
    const scope = selScope();
    // List options are shared per column, so store them for every column the
    // selection spans regardless of whether whole columns or just cells are
    // selected — otherwise a cell-scoped list would have an empty dropdown.
    if (type === "list" && list) {
      for (let col = sel.c1; col <= sel.c2; col++) {
        next.colLists = { ...next.colLists, [col]: list };
      }
    }
    if (scope === "columns") {
      // A whole-column type is stored per-column so new cells inherit it.
      for (let col = sel.c1; col <= sel.c2; col++) {
        next.colTypes = { ...next.colTypes, [col]: type };
      }
    } else {
      for (let col = sel.c1; col <= sel.c2; col++) {
        for (let r = sel.r1; r <= sel.r2; r++) {
          setCell(next, col, r, { type });
        }
      }
    }
    commit(next);
  };

  const sortColumn = (c: number, dir: "asc" | "desc") => {
    // Reorder whole rows by column c's value. Rows keep their cells together.
    const next = cloneSheet();
    const order = Array.from({ length: rows }, (_, r) => r);
    const valAt = (r: number) => sheet.cells[cellRef(c, r)]?.v ?? "";
    order.sort((a, b) => {
      const va = valAt(a);
      const vb = valAt(b);
      const na = parseFloat(va);
      const nb = parseFloat(vb);
      let cmp: number;
      if (!isNaN(na) && !isNaN(nb) && va.trim() !== "" && vb.trim() !== "") {
        cmp = na - nb;
      } else {
        cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
      }
      return dir === "asc" ? cmp : -cmp;
    });
    const remapped: Record<string, SheetCell> = {};
    order.forEach((oldR, newR) => {
      for (let col = 0; col < cols; col++) {
        const cell = sheet.cells[cellRef(col, oldR)];
        if (cell) {
          remapped[cellRef(col, newR)] = cell;
        }
      }
    });
    next.cells = remapped;
    commit(next);
  };

  /* ---- render ---- */

  let totalWidth = ROW_HEADER_W;
  for (let c = 0; c < cols; c++) {
    totalWidth += widthOf(c);
  }

  // Fresh formula engine each render over the current cells (memoised + cycle
  // safe internally). A cell whose text starts with "=" shows its result.
  const engine = makeFormulaEngine((c, r) => sheet.cells[cellRef(c, r)]?.v ?? "");

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (!editUnlocked || editing || !sel) {
      return;
    }
    const active = { c: sel.c1, r: sel.r1 };
    const move = (dc: number, dr: number) => {
      e.preventDefault();
      selectCell(
        Math.max(0, Math.min(cols - 1, active.c + dc)),
        Math.max(0, Math.min(rows - 1, active.r + dr)),
        e.shiftKey
      );
    };
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      // Copy / cut / paste are handled by the native clipboard events on the
      // grid (so Excel/Sheets interop works both ways) — not intercepted here.
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
        return;
      }
      if (key === "b") {
        e.preventDefault();
        toggleBold();
        return;
      }
      if (key === "i") {
        e.preventDefault();
        toggleItalic();
        return;
      }
    }
    switch (e.key) {
      case "ArrowUp":
        return move(0, -1);
      case "ArrowDown":
      case "Enter":
        return move(0, 1);
      case "ArrowLeft":
        return move(-1, 0);
      case "ArrowRight":
      case "Tab":
        return move(1, 0);
      case "Delete":
      case "Backspace":
        e.preventDefault();
        applyToSelection({ v: "" });
        return;
      case "F2":
        e.preventDefault();
        beginEdit(active.c, active.r);
        return;
    }
    // A printable character starts editing, replacing the cell (Excel behaviour).
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (typeOf(active.c, active.r) !== "list") {
        e.preventDefault();
        beginEdit(active.c, active.r, e.key);
      }
    }
  };

  const active = activeCell();

  return (
    <div className="sheet" onContextMenu={(e) => e.preventDefault()}>
      {editUnlocked && (
        <div className="sheet-formatbar">
          <button className="sheet-fmt-btn" title="Undo (Ctrl+Z)" disabled={undoStack.current.length === 0} onClick={undo}>
            <Undo2 />
          </button>
          <button className="sheet-fmt-btn" title="Redo (Ctrl+Y)" disabled={redoStack.current.length === 0} onClick={redo}>
            <Redo2 />
          </button>
          <span className="sheet-fmt-sep" />
          <button className="sheet-fmt-btn" title="Copy (Ctrl+C)" disabled={!sel} onClick={doCopyButton}>
            <Copy />
          </button>
          <button className="sheet-fmt-btn" title="Paste (Ctrl+V)" disabled={!sel} onClick={doPasteButton}>
            <ClipboardPaste />
          </button>
          <span className="sheet-fmt-sep" />
          <button
            className={`sheet-fmt-btn${active?.bold ? " on" : ""}`}
            title="Bold (Ctrl+B)"
            disabled={!sel}
            onClick={toggleBold}
          >
            <Bold />
          </button>
          <button
            className={`sheet-fmt-btn${active?.italic ? " on" : ""}`}
            title="Italic (Ctrl+I)"
            disabled={!sel}
            onClick={toggleItalic}
          >
            <Italic />
          </button>
          <span className="sheet-fmt-sep" />
          <button className="sheet-fmt-btn" title="Smaller text" disabled={!sel} onClick={() => bumpSize(-2)}>
            <span className="sheet-fmt-az small">A</span>
          </button>
          <span className="sheet-fmt-size">{active?.size ?? SHEET_DEFAULT_FONT_SIZE}</span>
          <button className="sheet-fmt-btn" title="Larger text" disabled={!sel} onClick={() => bumpSize(2)}>
            <span className="sheet-fmt-az large">A</span>
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="sheet-scroll"
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onCopy={(e) => {
          if (!editing && writeClipboard(e)) {
            e.preventDefault();
          }
        }}
        onCut={(e) => {
          if (!editing && editUnlocked && writeClipboard(e)) {
            e.preventDefault();
            applyToSelection({ v: "" });
          }
        }}
        onPaste={(e) => {
          if (editing || !editUnlocked) {
            return;
          }
          const text = e.clipboardData.getData("text/plain");
          if (text) {
            e.preventDefault();
            pasteText(text);
          }
        }}
        onMouseUp={() => {
          dragging.current = false;
          disarm();
        }}
        onMouseLeave={() => {
          dragging.current = false;
          disarm();
        }}
      >
        <div className="sheet-grid" style={{ width: totalWidth }}>
          {/* Header row: corner + column letters */}
          <div className="sheet-row sheet-head-row">
            <div className="sheet-corner" style={{ width: ROW_HEADER_W, zIndex: 20 }} />
            {Array.from({ length: cols }, (_, c) => (
              <div
                key={c}
                className={`sheet-colhead${sel && sel.c1 <= c && c <= sel.c2 ? " sel" : ""}${
                  c < freezeCols ? " frozen" : ""
                }${c === freezeCols - 1 ? " freeze-edge" : ""}${
                  headerDropTarget?.kind === "col" && headerDropTarget.i === c ? " drop-target" : ""
                }`}
                style={{
                  width: widthOf(c),
                  ...(c < freezeCols ? { position: "sticky", left: frozenLeft(c), zIndex: 11 } : null),
                }}
                draggable={editUnlocked}
                onClick={(e) => {
                  if (e.shiftKey && anchor.current) {
                    selectColumns(anchor.current.c, c);
                  } else {
                    selectColumns(c, c);
                  }
                }}
                onContextMenu={(e) => {
                  if (!sel || !(sel.c1 <= c && c <= sel.c2 && selScope() === "columns")) {
                    selectColumns(c, c);
                  }
                  openMenu(e);
                }}
                onDragStart={(e) => {
                  const inSel = !!sel && selScope() === "columns" && sel.c1 <= c && c <= sel.c2;
                  const a = inSel ? sel!.c1 : c;
                  const b = inSel ? sel!.c2 : c;
                  if (!inSel) {
                    selectColumns(c, c);
                  }
                  headerDrag.current = { kind: "col", a, b };
                  e.dataTransfer.setData("text/plain", "");
                }}
                onDragOver={(e) => {
                  if (headerDrag.current?.kind === "col") {
                    e.preventDefault();
                    setHeaderDropTarget({ kind: "col", i: c });
                  }
                }}
                onDragEnd={() => {
                  headerDrag.current = null;
                  setHeaderDropTarget(null);
                }}
                onDrop={(e) => {
                  const h = headerDrag.current;
                  headerDrag.current = null;
                  setHeaderDropTarget(null);
                  if (h?.kind === "col") {
                    e.preventDefault();
                    moveColumns(h.a, h.b, c);
                  }
                }}
              >
                {colName(c)}
                {editUnlocked && (
                  <span
                    className="sheet-col-resize"
                    onMouseDown={(e) =>
                      startResize(e, "col", c, widthOf(c), (px) => {
                        const next = cloneSheet();
                        next.colWidths = { ...next.colWidths, [c]: px };
                        commit(next);
                      })
                    }
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Data rows */}
          {Array.from({ length: rows }, (_, r) => (
            <div
              className={`sheet-row${r < freezeRows ? " frozen-row" : ""}${
                r === freezeRows - 1 ? " freeze-edge-row" : ""
              }`}
              key={r}
              style={{ height: heightOf(r), ...(r < freezeRows ? { position: "sticky", top: frozenTop(r), zIndex: 8 } : null) }}
            >
              <div
                className={`sheet-rowhead${sel && sel.r1 <= r && r <= sel.r2 ? " sel" : ""}${
                  r < freezeRows ? " frozen" : ""
                }${headerDropTarget?.kind === "row" && headerDropTarget.i === r ? " drop-target" : ""}`}
                style={{ width: ROW_HEADER_W, ...(r < freezeRows ? { zIndex: 9 } : null) }}
                draggable={editUnlocked}
                onClick={(e) => {
                  if (e.shiftKey && anchor.current) {
                    selectRows(anchor.current.r, r);
                  } else {
                    selectRows(r, r);
                  }
                }}
                onContextMenu={(e) => {
                  if (!sel || !(sel.r1 <= r && r <= sel.r2 && selScope() === "rows")) {
                    selectRows(r, r);
                  }
                  openMenu(e);
                }}
                onDragStart={(e) => {
                  const inSel = !!sel && selScope() === "rows" && sel.r1 <= r && r <= sel.r2;
                  const a = inSel ? sel!.r1 : r;
                  const b = inSel ? sel!.r2 : r;
                  if (!inSel) {
                    selectRows(r, r);
                  }
                  headerDrag.current = { kind: "row", a, b };
                  e.dataTransfer.setData("text/plain", "");
                }}
                onDragOver={(e) => {
                  if (headerDrag.current?.kind === "row") {
                    e.preventDefault();
                    setHeaderDropTarget({ kind: "row", i: r });
                  }
                }}
                onDragEnd={() => {
                  headerDrag.current = null;
                  setHeaderDropTarget(null);
                }}
                onDrop={(e) => {
                  const h = headerDrag.current;
                  headerDrag.current = null;
                  setHeaderDropTarget(null);
                  if (h?.kind === "row") {
                    e.preventDefault();
                    moveRows(h.a, h.b, r);
                  }
                }}
              >
                {r + 1}
                {editUnlocked && (
                  <span
                    className="sheet-row-resize"
                    onMouseDown={(e) =>
                      startResize(e, "row", r, heightOf(r), (px) => {
                        const next = cloneSheet();
                        next.rowHeights = { ...next.rowHeights, [r]: px };
                        commit(next);
                      })
                    }
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </div>

              {Array.from({ length: cols }, (_, c) => {
                const ref = cellRef(c, r);
                const cell = sheet.cells[ref];
                const selected = rectHas(sel, c, r);
                const isEditing = editing?.c === c && editing?.r === r;
                const type = typeOf(c, r);
                const list = colLists[c] ?? [];
                return (
                  <div
                    key={c}
                    className={`sheet-cell${selected ? " sel" : ""}${
                      selected && sel && sel.c1 === c && sel.r1 === r ? " active" : ""
                    }${isEditing && type === "list" ? " editing-list" : ""}${c < freezeCols ? " frozen-col" : ""}${
                      c === freezeCols - 1 ? " freeze-edge" : ""
                    }`}
                    style={{
                      width: widthOf(c),
                      color: colorToCss(cell?.color),
                      background: colorToCss(cell?.bg),
                      fontWeight: cell?.bold ? 700 : undefined,
                      fontStyle: cell?.italic ? "italic" : undefined,
                      fontSize: cell?.size ? `${cell.size}px` : undefined,
                      ...(c < freezeCols ? { position: "sticky", left: frozenLeft(c), zIndex: 5 } : null),
                    }}
                    draggable={editUnlocked && !isEditing && armedCell?.c === c && armedCell?.r === r}
                    onMouseDown={(e) => {
                      if (e.button !== 0) {
                        return;
                      }
                      scrollRef.current?.focus({ preventScroll: true });
                      const multiSel = !!sel && (sel.c1 !== sel.c2 || sel.r1 !== sel.r2);
                      // Pressing inside an existing multi-selection keeps it (so a
                      // hold can drag the whole block); a plain click collapses it.
                      if (multiSel && rectHas(sel, c, r) && !e.shiftKey) {
                        clickToEdit.current = false;
                        pressInside.current = true;
                        pendingCollapse.current = { c, r };
                        dragging.current = false;
                        if (editUnlocked) {
                          if (armTimer.current) {
                            clearTimeout(armTimer.current);
                          }
                          armTimer.current = setTimeout(() => setArmedCell({ c, r }), 50);
                        }
                        return;
                      }
                      // A click on an already-active list cell (not a fresh select)
                      // opens its dropdown — so one click selects, the next edits.
                      const wasSoleActive =
                        !!sel && sel.c1 === c && sel.c2 === c && sel.r1 === r && sel.r2 === r;
                      clickToEdit.current = wasSoleActive && type === "list" && !e.shiftKey;
                      pressInside.current = false;
                      pendingCollapse.current = null;
                      dragging.current = true;
                      selectCell(c, r, e.shiftKey);
                      // Arm this cell for dragging only after a press-and-hold, so
                      // a normal press still starts a selection drag.
                      if (editUnlocked && !e.shiftKey) {
                        if (armTimer.current) {
                          clearTimeout(armTimer.current);
                        }
                        armTimer.current = setTimeout(() => setArmedCell({ c, r }), 50);
                      }
                    }}
                    onMouseEnter={() => {
                      if (dragging.current && anchor.current) {
                        // Moving to extend the selection means this isn't a drag —
                        // cancel the pending arm so it stays a selection gesture.
                        clickToEdit.current = false;
                        disarm();
                        setSel(normRect(anchor.current, { c, r }));
                      } else if (pressInside.current && pendingCollapse.current && !armedCell) {
                        // Pressed inside a selection then moved before the block
                        // armed → begin a fresh selection from the pressed cell.
                        const start = pendingCollapse.current;
                        pressInside.current = false;
                        pendingCollapse.current = null;
                        disarm();
                        dragging.current = true;
                        anchor.current = start;
                        setSel(normRect(start, { c, r }));
                      }
                    }}
                    onClick={() => {
                      if (pressInside.current && pendingCollapse.current) {
                        const p = pendingCollapse.current;
                        pressInside.current = false;
                        pendingCollapse.current = null;
                        if (!armedCell) {
                          selectCell(p.c, p.r, false);
                        }
                        return;
                      }
                      if (editUnlocked && type === "list" && clickToEdit.current && !isEditing) {
                        beginEdit(c, r);
                      }
                    }}
                    onDoubleClick={() => {
                      if (editUnlocked) {
                        beginEdit(c, r);
                      }
                    }}
                    onContextMenu={(e) => {
                      if (!selected) {
                        selectCell(c, r, false);
                      }
                      openMenu(e);
                    }}
                    onDragStart={(e) => {
                      const isBlock = !!sel && rectHas(sel, c, r) && (sel.c1 !== sel.c2 || sel.r1 !== sel.r2);
                      cellDrag.current = { c, r, block: isBlock ? sel : null };
                      pressInside.current = false;
                      pendingCollapse.current = null;
                      e.dataTransfer.setData("text/plain", isBlock ? "" : cell?.v ?? "");
                    }}
                    onDragEnd={disarm}
                    onDragOver={(e) => {
                      if (editUnlocked && cellDrag.current) {
                        e.preventDefault();
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = cellDrag.current;
                      cellDrag.current = null;
                      disarm();
                      if (!editUnlocked || !from) {
                        return;
                      }
                      if (from.block) {
                        moveBlock(from.block, c - from.c, r - from.r);
                        return;
                      }
                      if (from.c === c && from.r === r) {
                        return;
                      }
                      const src = sheet.cells[cellRef(from.c, from.r)];
                      const next = cloneSheet();
                      setCell(next, c, r, {
                        v: src?.v ?? "",
                        color: src?.color,
                        bg: src?.bg,
                        type: src?.type,
                        bold: src?.bold,
                        italic: src?.italic,
                        size: src?.size,
                      });
                      commit(next);
                    }}
                  >
                    {isEditing && type === "list" ? (
                      <ListDropdown
                        value={cell?.v ?? ""}
                        options={list}
                        onPick={(v) => {
                          setCellValue(c, r, v);
                          setEditing(null);
                        }}
                        onClose={() => setEditing(null)}
                      />
                    ) : isEditing ? (
                      <input
                        autoFocus
                        className="sheet-input"
                        defaultValue={editValue.current}
                        onChange={(e) => (editValue.current = e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit();
                            selectCell(c, Math.min(r + 1, rows - 1), false);
                            // Return focus to the grid so the newly-selected cell
                            // is immediately typeable (start typing to edit it).
                            scrollRef.current?.focus({ preventScroll: true });
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                            scrollRef.current?.focus({ preventScroll: true });
                          } else if (e.key === "Tab") {
                            e.preventDefault();
                            commitEdit();
                            selectCell(Math.min(c + 1, cols - 1), r, false);
                            scrollRef.current?.focus({ preventScroll: true });
                          }
                        }}
                      />
                    ) : (
                      (() => {
                        const raw = cell?.v ?? "";
                        const shown = raw.startsWith("=") ? engine.get(c, r) : cell?.v;
                        const isErr = raw.startsWith("=") && typeof shown === "string" && shown.startsWith("#");
                        return (
                          <span className={`sheet-value${isErr ? " err" : ""}`}>
                            {displayValue(shown, type)}
                            {type === "list" && <span className="sheet-list-caret">▾</span>}
                          </span>
                        );
                      })()
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {editUnlocked && (
        <div className="sheet-toolbar">
          <button className="sheet-tool-btn" onClick={() => addRows(10)}>
            + 10 rows
          </button>
          <button className="sheet-tool-btn" onClick={() => addColumns(4)}>
            + 4 columns
          </button>
        </div>
      )}

      {menu && editUnlocked && (
        <SheetMenu
          menu={menu}
          selEndCol={sel ? sel.c2 : 0}
          selEndRow={sel ? sel.r2 : 0}
          frozen={freezeCols > 0 || freezeRows > 0}
          onClose={() => setMenu(null)}
          onCut={doCutButton}
          onCopy={doCopyButton}
          onPaste={doPasteButton}
          onColor={(v) => applyToSelection({ color: v })}
          onBg={(v) => applyToSelection({ bg: v })}
          onType={(t) => setSelectionType(t)}
          onListEditor={() =>
            setListDialog({
              c1: sel ? sel.c1 : 0,
              c2: sel ? sel.c2 : 0,
              options: sel ? colLists[sel.c1] ?? [] : [],
            })
          }
          onFreezeCols={() => commit({ ...cloneSheet(), freezeCols: sel ? sel.c2 + 1 : 0 })}
          onFreezeRows={() => commit({ ...cloneSheet(), freezeRows: sel ? sel.r2 + 1 : 0 })}
          onUnfreeze={() => commit({ ...cloneSheet(), freezeCols: 0, freezeRows: 0 })}
          onResize={resizeSelection}
          onSort={(dir) => sel && sortColumn(sel.c1, dir)}
          onInsertColAfter={() => addColumns(1)}
          onInsertRowAfter={() => addRows(1)}
          onDeleteColumns={() => sel && deleteColumns(sel.c1, sel.c2)}
          onDeleteRows={() => sel && deleteRows(sel.r1, sel.r2)}
        />
      )}

      {listDialog && (
        <ListEditorDialog
          initial={listDialog.options}
          onCancel={() => setListDialog(null)}
          onSave={(options) => {
            setSelectionType("list", options);
            setListDialog(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

function SheetMenu({
  menu,
  selEndCol,
  selEndRow,
  frozen,
  onClose,
  onCut,
  onCopy,
  onPaste,
  onColor,
  onBg,
  onType,
  onListEditor,
  onFreezeCols,
  onFreezeRows,
  onUnfreeze,
  onResize,
  onSort,
  onInsertColAfter,
  onInsertRowAfter,
  onDeleteColumns,
  onDeleteRows,
}: {
  menu: NonNullable<MenuState>;
  selEndCol: number;
  selEndRow: number;
  frozen: boolean;
  onClose: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onColor: (v: string) => void;
  onBg: (v: string) => void;
  onType: (t: SheetCellType) => void;
  onListEditor: () => void;
  onFreezeCols: () => void;
  onFreezeRows: () => void;
  onUnfreeze: () => void;
  onResize: (px: number) => void;
  onSort: (dir: "asc" | "desc") => void;
  onInsertColAfter: () => void;
  onInsertRowAfter: () => void;
  onDeleteColumns: () => void;
  onDeleteRows: () => void;
}) {
  const [sub, setSub] = useState<"color" | "bg" | "type" | "resize" | null>(null);
  const isCols = menu.scope === "columns";
  const isRows = menu.scope === "rows";

  return (
    <div
      className="sheet-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className="sheet-menu-item" onClick={() => (onCut(), onClose())}>
        Cut
      </button>
      <button className="sheet-menu-item" onClick={() => (onCopy(), onClose())}>
        Copy
      </button>
      <button className="sheet-menu-item" onClick={() => (onPaste(), onClose())}>
        Paste
      </button>

      <div className="sheet-menu-sep" />

      <button className="sheet-menu-item" onClick={() => (onFreezeCols(), onClose())}>
        Freeze up to column {colName(selEndCol)}
      </button>
      <button className="sheet-menu-item" onClick={() => (onFreezeRows(), onClose())}>
        Freeze up to row {selEndRow + 1}
      </button>
      {frozen && (
        <button className="sheet-menu-item" onClick={() => (onUnfreeze(), onClose())}>
          Unfreeze all
        </button>
      )}

      <div className="sheet-menu-sep" />

      <ColorMenuItem label="Text Color" open={sub === "color"} onToggle={() => setSub(sub === "color" ? null : "color")} onPick={(v) => (onColor(v), onClose())} />
      <ColorMenuItem label="Background Color" open={sub === "bg"} onToggle={() => setSub(sub === "bg" ? null : "bg")} onPick={(v) => (onBg(v), onClose())} />

      <div className="sheet-menu-item has-sub" onClick={() => setSub(sub === "type" ? null : "type")}>
        Type ▸
        {sub === "type" && (
          <div className="sheet-submenu" onClick={(e) => e.stopPropagation()}>
            <button className="sheet-menu-item" onClick={() => (onType("normal"), onClose())}>
              Normal
            </button>
            <button className="sheet-menu-item" onClick={() => (onType("price"), onClose())}>
              Price ($)
            </button>
            <button className="sheet-menu-item" onClick={() => (onListEditor(), onClose())}>
              List…
            </button>
          </div>
        )}
      </div>

      {(isCols || isRows) && (
        <>
          <div className="sheet-menu-sep" />
          <div className="sheet-menu-item has-sub" onClick={() => setSub(sub === "resize" ? null : "resize")}>
            Resize…
            {sub === "resize" && (
              <div className="sheet-submenu" onClick={(e) => e.stopPropagation()}>
                <button
                  className="sheet-menu-item"
                  onClick={() => {
                    const raw = window.prompt(
                      `${isCols ? "Width" : "Height"} in pixels:`,
                      String(isCols ? SHEET_DEFAULT_COL_WIDTH : SHEET_DEFAULT_ROW_HEIGHT)
                    );
                    const px = parseInt(raw ?? "", 10);
                    if (!isNaN(px) && px > 12) {
                      onResize(px);
                    }
                    onClose();
                  }}
                >
                  Set {isCols ? "width" : "height"}…
                </button>
              </div>
            )}
          </div>
          {isCols && (
            <>
              <button className="sheet-menu-item" onClick={() => (onSort("asc"), onClose())}>
                <ArrowDownAZ className="sheet-menu-icon" /> Sort A→Z / low→high
              </button>
              <button className="sheet-menu-item" onClick={() => (onSort("desc"), onClose())}>
                <ArrowUpAZ className="sheet-menu-icon" /> Sort Z→A / high→low
              </button>
            </>
          )}
          <div className="sheet-menu-sep" />
          {isCols ? (
            <>
              <button className="sheet-menu-item" onClick={() => (onInsertColAfter(), onClose())}>
                Insert column
              </button>
              <button className="sheet-menu-item danger" onClick={() => (onDeleteColumns(), onClose())}>
                Delete column(s)
              </button>
            </>
          ) : (
            <>
              <button className="sheet-menu-item" onClick={() => (onInsertRowAfter(), onClose())}>
                Insert row
              </button>
              <button className="sheet-menu-item danger" onClick={() => (onDeleteRows(), onClose())}>
                Delete row(s)
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** A colour menu row with an expandable swatch grid (tones + custom + presets). */
function ColorMenuItem({
  label,
  open,
  onToggle,
  onPick,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onPick: (value: string) => void;
}) {
  const [presets, setPresets] = useState<string[]>(() => loadPresets());
  const [custom, setCustom] = useState("#e5a64b");

  return (
    <div className="sheet-menu-item has-sub" onClick={onToggle}>
      {label} ▸
      {open && (
        <div className="sheet-submenu sheet-color-pop" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-swatches">
            {TONE_SWATCHES.map((t) => (
              <button
                key={t.name || "default"}
                className="sheet-swatch"
                title={t.label}
                style={{ background: t.css, border: t.name === "" ? "1px dashed var(--border-strong)" : undefined }}
                onClick={() => onPick(t.name)}
              />
            ))}
            {SITE_SWATCHES.map((s) => (
              <button
                key={s.hex}
                className="sheet-swatch"
                title={`${s.label} (${s.hex})`}
                style={{ background: s.hex }}
                onClick={() => onPick(s.hex)}
              />
            ))}
            {presets.map((hex) => (
              <button
                key={hex}
                className="sheet-swatch"
                title={hex}
                style={{ background: hex }}
                onClick={() => onPick(hex)}
              />
            ))}
          </div>
          <div className="sheet-custom-color">
            <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button
              className="sheet-menu-item"
              onClick={() => {
                savePreset(custom);
                setPresets(loadPresets());
                onPick(custom);
              }}
            >
              Use {custom}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* List cell dropdown (themed, replaces the native <select>)           */
/* ------------------------------------------------------------------ */

function ListDropdown({
  value,
  options,
  onPick,
  onClose,
}: {
  value: string;
  options: string[];
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // Position fixed against the host cell so the scroll container can't clip it.
  useEffect(() => {
    const cell = anchorRef.current?.parentElement;
    if (cell) {
      const r = cell.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom, width: r.width });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <span ref={anchorRef} className="sheet-listdrop-anchor" />
      {/* Full-screen catcher so a click anywhere else closes the dropdown. */}
      <div className="sheet-listdrop-backdrop" onMouseDown={onClose} />
      <div
        className="sheet-listdrop"
        style={pos ? { left: pos.left, top: pos.top, minWidth: pos.width } : { visibility: "hidden" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className={`sheet-listopt${value === "" ? " on" : ""}`} onMouseDown={() => onPick("")}>
          <span className="sheet-listopt-empty">— empty —</span>
        </button>
        {options.map((opt) => (
          <button key={opt} className={`sheet-listopt${value === opt ? " on" : ""}`} onMouseDown={() => onPick(opt)}>
            {opt}
          </button>
        ))}
        {options.length === 0 && <div className="sheet-listopt-none">No options — set them via Type ▸ List…</div>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* List option editor dialog                                          */
/* ------------------------------------------------------------------ */

function ListEditorDialog({
  initial,
  onSave,
  onCancel,
}: {
  initial: string[];
  onSave: (options: string[]) => void;
  onCancel: () => void;
}) {
  const [items, setItems] = useState<string[]>(initial.length ? initial : [""]);

  const setAt = (i: number, v: string) => setItems((xs) => xs.map((x, j) => (j === i ? v : x)));
  const removeAt = (i: number) => setItems((xs) => (xs.length > 1 ? xs.filter((_, j) => j !== i) : [""]));
  const add = () => setItems((xs) => [...xs, ""]);

  const save = () => {
    const cleaned = items.map((s) => s.trim()).filter(Boolean);
    onSave(cleaned);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>List options</DialogTitle>
          <DialogDescription>
            The values a cell in this column can be set to. Each cell shows a dropdown of these.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-1">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={item}
                autoFocus={i === items.length - 1}
                placeholder={`Option ${i + 1}`}
                className="font-mono"
                onChange={(e) => setAt(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <button className="sheet-list-remove" title="Remove" onClick={() => removeAt(i)}>
                <X />
              </button>
            </div>
          ))}
          <button className="sheet-list-add" onClick={add}>
            <Plus /> Add option
          </button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={save}>Save list</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const ROW_HEADER_W = 44;
const HEADER_ROW_H = 30;
const SHEET_DEFAULT_FONT_SIZE = 13;

function displayValue(v: string | undefined, type: SheetCellType): string {
  if (!v) {
    return "";
  }
  if (type === "price") {
    const n = parseFloat(v);
    return isNaN(n) ? v : `$${v}`;
  }
  return v;
}

/** Serialises a value grid to TSV, quoting fields that contain a tab, newline
 *  or quote so Excel / Google Sheets round-trip them. */
function toTSV(grid: string[][]): string {
  return grid
    .map((row) =>
      row
        .map((v) => {
          const s = v ?? "";
          if (/[\t\n\r"]/.test(s)) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join("\t")
    )
    .join("\n");
}

/** Parses TSV (as pasted from Excel / Sheets) into a value grid, honouring
 *  quoted fields that may contain tabs, newlines and escaped ("") quotes. */
function fromTSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const push = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    push();
    rows.push(row);
    row = [];
  };
  // Strip a single trailing newline so a copied block doesn't yield a blank row.
  const src = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === "\t") {
      push();
      i++;
    } else if (ch === "\n") {
      pushRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  pushRow();
  return rows;
}

/** Parses an A1-style ref back to 0-based { c, r }. */
function parseRef(ref: string): { c: number; r: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) {
    return { c: 0, r: 0 };
  }
  let c = 0;
  for (const ch of m[1]) {
    c = c * 26 + (ch.charCodeAt(0) - 64);
  }
  return { c: c - 1, r: parseInt(m[2], 10) - 1 };
}

/** Rebuilds an index-keyed map (widths/types/…) under an old→new index remap. */
function remapIndexMap<T>(map: Record<number, T> | undefined, newOf: Record<number, number>): Record<number, T> {
  const out: Record<number, T> = {};
  for (const [k, val] of Object.entries(map ?? {})) {
    const i = Number(k);
    out[newOf[i] ?? i] = val;
  }
  return out;
}

/** Shifts colWidths/colTypes/colLists (or row heights) down after a delete. */
function shiftIndexMaps(sheet: SheetData, axis: "col" | "row", from: number, removed: number) {
  const shiftMap = <T,>(map: Record<number, T> | undefined): Record<number, T> => {
    const out: Record<number, T> = {};
    for (const [k, val] of Object.entries(map ?? {})) {
      const i = Number(k);
      if (i < from) {
        out[i] = val;
      } else if (i >= from + removed) {
        out[i - removed] = val;
      }
    }
    return out;
  };
  if (axis === "col") {
    sheet.colWidths = shiftMap(sheet.colWidths);
    sheet.colTypes = shiftMap(sheet.colTypes);
    sheet.colLists = shiftMap(sheet.colLists);
  } else {
    sheet.rowHeights = shiftMap(sheet.rowHeights);
  }
}

/** Drives a drag-resize on a column width or row height. */
function startResize(
  e: React.MouseEvent,
  axis: "col" | "row",
  index: number,
  start: number,
  onCommit: (px: number) => void
) {
  e.preventDefault();
  e.stopPropagation();
  const origin = axis === "col" ? e.clientX : e.clientY;
  let latest = start;
  const move = (ev: MouseEvent) => {
    const delta = (axis === "col" ? ev.clientX : ev.clientY) - origin;
    latest = Math.max(axis === "col" ? 40 : 18, Math.round(start + delta));
    onCommit(latest);
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
