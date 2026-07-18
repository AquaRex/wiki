import React, { useEffect, useRef, useState } from "react";
import { Plus, Pencil, Trash2, X, GripVertical, Check } from "lucide-react";
import { getStore } from "~/lib/store";
import { useAuth } from "~/lib/auth";
import { renderMarkdown, type RenderContext } from "~/lib/markdown";
import {
  defaultBoard,
  newBoardId,
  type BoardCard,
  type BoardColumn,
  type BoardData,
} from "~/lib/shared";

/*
 * A Trello-style board rendered by the :::roadmap directive. The board's data
 * (columns + cards) lives in its own `boards` table row, loaded after the page
 * so a private page's board is withheld by RLS until the viewer may see it.
 *
 * Reading (preview / public): columns of cards; a card shows its title and short
 * description as markdown, and clicking it opens the card's full body in a
 * fullscreen view inside the board.
 *
 * Editing (only with edit mode on, like the rest of the wiki): drag cards within
 * and between columns, add / edit / delete cards, and add / rename / remove /
 * reorder columns. Every change is saved (debounced) to the board row.
 */

/** Keeps a board crash contained to its block rather than blanking the page. */
class BoardBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <div className="roadmap-empty">This board couldn’t be drawn.</div>;
    }
    return this.props.children;
  }
}

export function Roadmap(props: { pagePath: string; boardKey: string; ctx: RenderContext }) {
  return (
    <BoardBoundary>
      <RoadmapBoard {...props} />
    </BoardBoundary>
  );
}

type DragState =
  | { kind: "card"; colId: string; cardId: string }
  | { kind: "column"; colId: string }
  | null;

function RoadmapBoard({ pagePath, boardKey, ctx }: { pagePath: string; boardKey: string; ctx: RenderContext }) {
  const { editUnlocked } = useAuth();
  const [board, setBoard] = useState<BoardData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [openCard, setOpenCard] = useState<{ colId: string; cardId: string } | null>(null);
  const [editingCard, setEditingCard] = useState<{ colId: string; cardId: string } | null>(null);
  const drag = useRef<DragState>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The card overlay is absolute within the board, so it must sit at the board's
  // scroll origin — reset scroll to the top when one opens.
  useEffect(() => {
    if ((openCard || editingCard) && rootRef.current) {
      rootRef.current.scrollTop = 0;
      rootRef.current.scrollLeft = 0;
    }
  }, [openCard, editingCard]);

  useEffect(() => {
    let cancelled = false;
    getStore()
      .getBoard(pagePath, boardKey)
      .then((data) => {
        if (!cancelled) {
          setBoard(data ?? defaultBoard());
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
  }, [pagePath, boardKey]);

  // Esc closes the fullscreen card / card editor, matching the image lightbox.
  useEffect(() => {
    if (!openCard && !editingCard) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenCard(null);
        setEditingCard(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCard, editingCard]);

  // Persist after edits, debounced so a burst of drags/keystrokes is one write.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = (next: BoardData) => {
    setBoard(next);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(() => {
      getStore()
        .saveBoard(pagePath, boardKey, next)
        .catch((e) => alert(e instanceof Error ? e.message : "Could not save board."));
    }, 500);
  };

  if (status === "loading") {
    return <div className="roadmap-empty">Loading board…</div>;
  }
  if (status === "error" || !board) {
    return <div className="roadmap-empty">This board couldn’t be loaded.</div>;
  }

  const mapColumns = (fn: (cols: BoardColumn[]) => BoardColumn[]) =>
    commit({ ...board, columns: fn(board.columns.map((c) => ({ ...c, cards: [...c.cards] }))) });

  /* --- card operations --- */

  const addCard = (colId: string) => {
    const card: BoardCard = { id: newBoardId("card"), title: "New card", desc: "", body: "" };
    mapColumns((cols) => cols.map((c) => (c.id === colId ? { ...c, cards: [...c.cards, card] } : c)));
    setEditingCard({ colId, cardId: card.id });
  };

  const updateCard = (colId: string, cardId: string, patch: Partial<BoardCard>) => {
    mapColumns((cols) =>
      cols.map((c) =>
        c.id === colId ? { ...c, cards: c.cards.map((cd) => (cd.id === cardId ? { ...cd, ...patch } : cd)) } : c
      )
    );
  };

  const deleteCard = (colId: string, cardId: string) => {
    mapColumns((cols) => cols.map((c) => (c.id === colId ? { ...c, cards: c.cards.filter((cd) => cd.id !== cardId) } : c)));
  };

  /** Moves a card to targetCol, before targetCardId (or to the end when null). */
  const moveCard = (from: { colId: string; cardId: string }, targetColId: string, targetCardId: string | null) => {
    mapColumns((cols) => {
      const src = cols.find((c) => c.id === from.colId);
      const card = src?.cards.find((cd) => cd.id === from.cardId);
      if (!src || !card) {
        return cols;
      }
      return cols.map((c) => {
        if (c.id === from.colId && c.id === targetColId) {
          // Same-column reorder: drop the card out, then splice it back in.
          const without = c.cards.filter((cd) => cd.id !== from.cardId);
          const at = targetCardId ? without.findIndex((cd) => cd.id === targetCardId) : without.length;
          without.splice(at === -1 ? without.length : at, 0, card);
          return { ...c, cards: without };
        }
        if (c.id === from.colId) {
          return { ...c, cards: c.cards.filter((cd) => cd.id !== from.cardId) };
        }
        if (c.id === targetColId) {
          const cards = [...c.cards];
          const at = targetCardId ? cards.findIndex((cd) => cd.id === targetCardId) : cards.length;
          cards.splice(at === -1 ? cards.length : at, 0, card);
          return { ...c, cards };
        }
        return c;
      });
    });
  };

  /* --- column operations --- */

  const addColumn = () =>
    mapColumns((cols) => [...cols, { id: newBoardId("col"), title: "New column", cards: [] }]);

  const renameColumn = (colId: string, title: string) =>
    mapColumns((cols) => cols.map((c) => (c.id === colId ? { ...c, title } : c)));

  const deleteColumn = (colId: string) => {
    const col = board.columns.find((c) => c.id === colId);
    if (col && col.cards.length > 0 && !confirm(`Delete "${col.title}" and its ${col.cards.length} card(s)?`)) {
      return;
    }
    mapColumns((cols) => cols.filter((c) => c.id !== colId));
  };

  const moveColumn = (colId: string, targetColId: string) => {
    mapColumns((cols) => {
      const from = cols.findIndex((c) => c.id === colId);
      const to = cols.findIndex((c) => c.id === targetColId);
      if (from === -1 || to === -1 || from === to) {
        return cols;
      }
      const [moved] = cols.splice(from, 1);
      cols.splice(to, 0, moved);
      return cols;
    });
  };

  /* --- drag handlers (edit mode only) --- */

  const onCardDrop = (targetColId: string, targetCardId: string | null) => {
    const d = drag.current;
    if (d?.kind === "card") {
      moveCard({ colId: d.colId, cardId: d.cardId }, targetColId, targetCardId);
    }
    drag.current = null;
    setDragOverCol(null);
  };

  const openCardData = openCard && board.columns.find((c) => c.id === openCard.colId)?.cards.find((cd) => cd.id === openCard.cardId);

  const overlayOpen = Boolean((openCard && openCardData) || editingCard);

  return (
    <div ref={rootRef} className={`roadmap${overlayOpen ? " roadmap-has-overlay" : ""}`}>
      <div className="roadmap-cols">
        {board.columns.map((col) => (
          <div
            key={col.id}
            className={`roadmap-col${dragOverCol === col.id ? " drag-over" : ""}`}
            onDragOver={(e) => {
              if (editUnlocked && drag.current) {
                e.preventDefault();
                setDragOverCol(col.id);
              }
            }}
            onDrop={(e) => {
              if (!editUnlocked) {
                return;
              }
              e.preventDefault();
              if (drag.current?.kind === "column") {
                moveColumn(drag.current.colId, col.id);
                drag.current = null;
                setDragOverCol(null);
              } else {
                onCardDrop(col.id, null);
              }
            }}
          >
            <div className="roadmap-col-head">
              {editUnlocked && (
                <span
                  className="roadmap-grip"
                  draggable
                  title="Drag to reorder column"
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", col.id);
                    drag.current = { kind: "column", colId: col.id };
                  }}
                >
                  <GripVertical />
                </span>
              )}
              {editUnlocked ? (
                <input
                  className="roadmap-col-title-input"
                  value={col.title}
                  onChange={(e) => renameColumn(col.id, e.target.value)}
                />
              ) : (
                <span className="roadmap-col-title">{col.title}</span>
              )}
              <span className="roadmap-col-count">{col.cards.length}</span>
              {editUnlocked && (
                <button className="roadmap-icon-btn" title="Delete column" onClick={() => deleteColumn(col.id)}>
                  <Trash2 />
                </button>
              )}
            </div>

            <div className="roadmap-col-body">
              {col.cards.map((card) => (
                <div
                  key={card.id}
                  className="roadmap-card"
                  draggable={editUnlocked}
                  onDragStart={(e) => {
                    if (editUnlocked) {
                      e.stopPropagation();
                      e.dataTransfer.setData("text/plain", card.id);
                      drag.current = { kind: "card", colId: col.id, cardId: card.id };
                    }
                  }}
                  onDragOver={(e) => {
                    if (editUnlocked && drag.current?.kind === "card") {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                  onDrop={(e) => {
                    if (editUnlocked && drag.current?.kind === "card") {
                      e.preventDefault();
                      e.stopPropagation();
                      onCardDrop(col.id, card.id);
                    }
                  }}
                  onClick={() => setOpenCard({ colId: col.id, cardId: card.id })}
                >
                  {editUnlocked && (
                    <div className="roadmap-card-tools">
                      <button
                        className="roadmap-icon-btn"
                        title="Edit card"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingCard({ colId: col.id, cardId: card.id });
                        }}
                      >
                        <Pencil />
                      </button>
                      <button
                        className="roadmap-icon-btn"
                        title="Delete card"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteCard(col.id, card.id);
                        }}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  )}
                  <div className="roadmap-card-title wiki">{renderMarkdown(card.title, ctx)}</div>
                  {card.desc && <div className="roadmap-card-desc wiki">{renderMarkdown(card.desc, ctx)}</div>}
                </div>
              ))}
              {editUnlocked && (
                <button className="roadmap-add-card" onClick={() => addCard(col.id)}>
                  <Plus /> Add card
                </button>
              )}
            </div>
          </div>
        ))}

        {editUnlocked && (
          <button className="roadmap-add-col" onClick={addColumn}>
            <Plus /> Add column
          </button>
        )}
      </div>

      {/* Fullscreen card detail, inside the board's own viewport. */}
      {openCard && openCardData && (
        <div className="roadmap-fullcard" role="dialog" aria-modal="true">
          <button className="roadmap-fullcard-close" title="Close" onClick={() => setOpenCard(null)}>
            <X />
          </button>
          <div className="roadmap-fullcard-inner wiki">
            <div className="roadmap-fullcard-title">{renderMarkdown(openCardData.title, ctx)}</div>
            {openCardData.desc && <div className="roadmap-fullcard-desc">{renderMarkdown(openCardData.desc, ctx)}</div>}
            {openCardData.body ? (
              renderMarkdown(openCardData.body, ctx)
            ) : (
              <p className="roadmap-empty">No details yet.</p>
            )}
          </div>
        </div>
      )}

      {/* Card editor (edit mode). */}
      {editingCard && (
        <CardEditor
          card={board.columns.find((c) => c.id === editingCard.colId)?.cards.find((cd) => cd.id === editingCard.cardId)}
          onChange={(patch) => updateCard(editingCard.colId, editingCard.cardId, patch)}
          onClose={() => setEditingCard(null)}
        />
      )}
    </div>
  );
}

/** A small modal for editing a card's title, short description and full body. */
function CardEditor({
  card,
  onChange,
  onClose,
}: {
  card: BoardCard | undefined;
  onChange: (patch: Partial<BoardCard>) => void;
  onClose: () => void;
}) {
  if (!card) {
    return null;
  }
  return (
    <div className="roadmap-fullcard" role="dialog" aria-modal="true">
      <button className="roadmap-fullcard-close" title="Done" onClick={onClose}>
        <Check />
      </button>
      <div className="roadmap-fullcard-inner roadmap-card-editor">
        <label>
          <span>Title (markdown)</span>
          <input value={card.title} onChange={(e) => onChange({ title: e.target.value })} />
        </label>
        <label>
          <span>Short description (markdown)</span>
          <textarea rows={2} value={card.desc} onChange={(e) => onChange({ desc: e.target.value })} />
        </label>
        <label>
          <span>Full body (markdown — images, boxes, everything)</span>
          <textarea rows={12} value={card.body} onChange={(e) => onChange({ body: e.target.value })} />
        </label>
      </div>
    </div>
  );
}
