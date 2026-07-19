import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownAZ, ArrowUpAZ } from "lucide-react";
import { getStore } from "~/lib/store";
import { useAuth } from "~/lib/auth";
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
  const [clipboard, setClipboard] = useState<{ rect: Rect; cells: (SheetCell | undefined)[][] } | null>(null);
  const cellDrag = useRef<{ c: number; r: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  const commit = (next: SheetData) => {
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

  const widthOf = (c: number) => colWidths[c] ?? SHEET_DEFAULT_COL_WIDTH;
  const heightOf = (r: number) => rowHeights[r] ?? SHEET_DEFAULT_ROW_HEIGHT;
  const typeOf = (c: number, r: number): SheetCellType =>
    sheet.cells[cellRef(c, r)]?.type ?? colTypes[c] ?? "normal";

  /* ---- cell mutations ---- */

  const setCell = (draft: SheetData, c: number, r: number, patch: Partial<SheetCell>) => {
    const ref = cellRef(c, r);
    const current = draft.cells[ref] ?? {};
    const merged: SheetCell = { ...current, ...patch };
    // Drop empty cells from the sparse map entirely.
    const empty = !merged.v && !merged.color && !merged.bg && !merged.type;
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

  /* ---- clipboard ---- */

  const doCopy = () => {
    if (!sel) {
      return;
    }
    const grid: (SheetCell | undefined)[][] = [];
    for (let r = sel.r1; r <= sel.r2; r++) {
      const row: (SheetCell | undefined)[] = [];
      for (let c = sel.c1; c <= sel.c2; c++) {
        const cell = sheet.cells[cellRef(c, r)];
        row.push(cell ? { ...cell } : undefined);
      }
      grid.push(row);
    }
    setClipboard({ rect: sel, cells: grid });
    // Mirror plain text to the OS clipboard so external paste works too.
    const text = grid.map((row) => row.map((cell) => cell?.v ?? "").join("\t")).join("\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  const doCut = () => {
    doCopy();
    applyToSelection({ v: "" });
  };

  const doPaste = () => {
    if (!clipboard || !sel) {
      return;
    }
    const next = cloneSheet();
    for (let dr = 0; dr < clipboard.cells.length; dr++) {
      for (let dc = 0; dc < clipboard.cells[dr].length; dc++) {
        const c = sel.c1 + dc;
        const r = sel.r1 + dr;
        if (c >= cols || r >= rows) {
          continue;
        }
        const src = clipboard.cells[dr][dc];
        setCell(next, c, r, { v: src?.v ?? "", color: src?.color, bg: src?.bg, type: src?.type });
      }
    }
    commit(next);
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
    if (scope === "columns") {
      // Column type is stored per-column so new cells inherit it.
      for (let col = sel.c1; col <= sel.c2; col++) {
        next.colTypes = { ...next.colTypes, [col]: type };
        if (type === "list" && list) {
          next.colLists = { ...next.colLists, [col]: list };
        }
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

  const totalWidth = useMemo(() => {
    let w = ROW_HEADER_W;
    for (let c = 0; c < cols; c++) {
      w += widthOf(c);
    }
    return w;
  }, [cols, colWidths]);

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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      doCopy();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
      e.preventDefault();
      doCut();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      doPaste();
      return;
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
        if (typeOf(active.c, active.r) !== "list") {
          beginEdit(active.c, active.r);
        }
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

  return (
    <div className="sheet" onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={scrollRef}
        className="sheet-scroll"
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onMouseUp={() => {
          dragging.current = false;
        }}
        onMouseLeave={() => {
          dragging.current = false;
        }}
      >
        <div className="sheet-grid" style={{ width: totalWidth }}>
          {/* Header row: corner + column letters */}
          <div className="sheet-row sheet-head-row">
            <div className="sheet-corner" style={{ width: ROW_HEADER_W }} />
            {Array.from({ length: cols }, (_, c) => (
              <div
                key={c}
                className={`sheet-colhead${sel && sel.c1 <= c && c <= sel.c2 ? " sel" : ""}`}
                style={{ width: widthOf(c) }}
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
            <div className="sheet-row" key={r} style={{ height: heightOf(r) }}>
              <div
                className={`sheet-rowhead${sel && sel.r1 <= r && r <= sel.r2 ? " sel" : ""}`}
                style={{ width: ROW_HEADER_W }}
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
                    }`}
                    style={{
                      width: widthOf(c),
                      color: colorToCss(cell?.color),
                      background: colorToCss(cell?.bg),
                    }}
                    draggable={editUnlocked && !isEditing}
                    onMouseDown={(e) => {
                      if (e.button !== 0) {
                        return;
                      }
                      dragging.current = true;
                      selectCell(c, r, e.shiftKey);
                      scrollRef.current?.focus({ preventScroll: true });
                    }}
                    onMouseEnter={() => {
                      if (dragging.current && anchor.current) {
                        setSel(normRect(anchor.current, { c, r }));
                      }
                    }}
                    onDoubleClick={() => {
                      if (editUnlocked && type !== "list") {
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
                      cellDrag.current = { c, r };
                      e.dataTransfer.setData("text/plain", cell?.v ?? "");
                    }}
                    onDragOver={(e) => {
                      if (editUnlocked && cellDrag.current) {
                        e.preventDefault();
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = cellDrag.current;
                      cellDrag.current = null;
                      if (!editUnlocked || !from || (from.c === c && from.r === r)) {
                        return;
                      }
                      const src = sheet.cells[cellRef(from.c, from.r)];
                      const next = cloneSheet();
                      setCell(next, c, r, { v: src?.v ?? "", color: src?.color, bg: src?.bg, type: src?.type });
                      commit(next);
                    }}
                  >
                    {isEditing ? (
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
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                          } else if (e.key === "Tab") {
                            e.preventDefault();
                            commitEdit();
                            selectCell(Math.min(c + 1, cols - 1), r, false);
                          }
                        }}
                      />
                    ) : type === "list" && editUnlocked ? (
                      <select
                        className="sheet-select"
                        value={cell?.v ?? ""}
                        onChange={(e) => setCellValue(c, r, e.target.value)}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <option value=""></option>
                        {list.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="sheet-value">{displayValue(cell?.v, type)}</span>
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
          hasClipboard={!!clipboard}
          activeColumn={sel ? sel.c1 : 0}
          listOptions={sel ? colLists[sel.c1] ?? [] : []}
          onClose={() => setMenu(null)}
          onCut={doCut}
          onCopy={doCopy}
          onPaste={doPaste}
          onColor={(v) => applyToSelection({ color: v })}
          onBg={(v) => applyToSelection({ bg: v })}
          onType={(t, list) => setSelectionType(t, list)}
          onResize={resizeSelection}
          onSort={(dir) => sel && sortColumn(sel.c1, dir)}
          onInsertColAfter={() => addColumns(1)}
          onInsertRowAfter={() => addRows(1)}
          onDeleteColumns={() => sel && deleteColumns(sel.c1, sel.c2)}
          onDeleteRows={() => sel && deleteRows(sel.r1, sel.r2)}
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
  hasClipboard,
  activeColumn,
  listOptions,
  onClose,
  onCut,
  onCopy,
  onPaste,
  onColor,
  onBg,
  onType,
  onResize,
  onSort,
  onInsertColAfter,
  onInsertRowAfter,
  onDeleteColumns,
  onDeleteRows,
}: {
  menu: NonNullable<MenuState>;
  hasClipboard: boolean;
  activeColumn: number;
  listOptions: string[];
  onClose: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onColor: (v: string) => void;
  onBg: (v: string) => void;
  onType: (t: SheetCellType, list?: string[]) => void;
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
      <button className="sheet-menu-item" disabled={!hasClipboard} onClick={() => (onPaste(), onClose())}>
        Paste
      </button>

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
            <button
              className="sheet-menu-item"
              onClick={() => {
                const raw = window.prompt(
                  "List options (one per line or comma-separated):",
                  listOptions.join("\n")
                );
                if (raw !== null) {
                  const opts = raw
                    .split(/[\n,]/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                  onType("list", opts);
                }
                onClose();
              }}
            >
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
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const ROW_HEADER_W = 44;

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
