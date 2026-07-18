import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, X, GripVertical, AlignLeft, Calendar, MessageSquare, Send } from "lucide-react";
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
 * Card face: the header (markdown), plus a footer of icons — due date, a "has
 * details" marker, assignees, and a status dot coloured by the column's tone.
 * The header and assignees are edited in place on the face (edit mode); clicking
 * a card opens its fullscreen view (inside the board), which is also where the
 * body, due date, activity log and comments live.
 *
 * Editing is gated on edit mode (signed in + edit toggle), like the rest of the
 * wiki. Every change saves (debounced) to the board row.
 */

const TONES = ["", "good", "warn", "error", "tips", "muted"] as const;
const TONE_LABEL: Record<string, string> = {
  "": "None",
  good: "Green",
  warn: "Orange",
  error: "Red",
  tips: "Blue",
  muted: "Grey",
};

/** Keeps a board crash contained to its block rather than blanking the page. */
class BoardBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
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
  const { editUnlocked, email } = useAuth();
  const me = useMemo(() => (email ? email.split("@")[0] : "someone"), [email]);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [openCard, setOpenCard] = useState<{ colId: string; cardId: string } | null>(null);
  const drag = useRef<DragState>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openCard && rootRef.current) {
      rootRef.current.scrollTop = 0;
      rootRef.current.scrollLeft = 0;
    }
  }, [openCard]);

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

  useEffect(() => {
    if (!openCard) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenCard(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCard]);

  if (status === "loading") {
    return <div className="roadmap-empty">Loading board…</div>;
  }
  if (status === "error" || !board) {
    return <div className="roadmap-empty">This board couldn’t be loaded.</div>;
  }

  const mapColumns = (fn: (cols: BoardColumn[]) => BoardColumn[]) =>
    commit({ ...board, columns: fn(board.columns.map((c) => ({ ...c, cards: [...c.cards] }))) });

  const logEntry = (what: string) => ({ who: me, what, at: new Date().toISOString() });

  const patchCard = (colId: string, cardId: string, patch: Partial<BoardCard>, activity?: string) =>
    mapColumns((cols) =>
      cols.map((c) =>
        c.id === colId
          ? {
              ...c,
              cards: c.cards.map((cd) =>
                cd.id === cardId
                  ? { ...cd, ...patch, activity: activity ? [...(cd.activity ?? []), logEntry(activity)] : cd.activity }
                  : cd
              ),
            }
          : c
      )
    );

  const addCard = (colId: string) => {
    const card: BoardCard = { id: newBoardId("card"), title: "New card", body: "", activity: [logEntry("created this card")] };
    mapColumns((cols) => cols.map((c) => (c.id === colId ? { ...c, cards: [...c.cards, card] } : c)));
  };

  const deleteCard = (colId: string, cardId: string) => {
    if (!confirm("Delete this card?")) {
      return;
    }
    mapColumns((cols) => cols.map((c) => (c.id === colId ? { ...c, cards: c.cards.filter((cd) => cd.id !== cardId) } : c)));
    if (openCard?.cardId === cardId) {
      setOpenCard(null);
    }
  };

  /** Moves a card to targetCol, before targetCardId (or to the end when null). */
  const moveCard = (from: { colId: string; cardId: string }, targetColId: string, targetCardId: string | null) => {
    mapColumns((cols) => {
      const src = cols.find((c) => c.id === from.colId);
      const card = src?.cards.find((cd) => cd.id === from.cardId);
      if (!src || !card) {
        return cols;
      }
      const crossing = from.colId !== targetColId;
      const targetTitle = cols.find((c) => c.id === targetColId)?.title ?? "";
      const moved: BoardCard = crossing
        ? { ...card, activity: [...(card.activity ?? []), logEntry(`moved to ${targetTitle}`)] }
        : card;
      return cols.map((c) => {
        if (c.id === from.colId && c.id === targetColId) {
          const without = c.cards.filter((cd) => cd.id !== from.cardId);
          const at = targetCardId ? without.findIndex((cd) => cd.id === targetCardId) : without.length;
          without.splice(at === -1 ? without.length : at, 0, moved);
          return { ...c, cards: without };
        }
        if (c.id === from.colId) {
          return { ...c, cards: c.cards.filter((cd) => cd.id !== from.cardId) };
        }
        if (c.id === targetColId) {
          const cards = [...c.cards];
          const at = targetCardId ? cards.findIndex((cd) => cd.id === targetCardId) : cards.length;
          cards.splice(at === -1 ? cards.length : at, 0, moved);
          return { ...c, cards };
        }
        return c;
      });
    });
  };

  /* --- column operations --- */

  const addColumn = () => mapColumns((cols) => [...cols, { id: newBoardId("col"), title: "New column", tone: "", cards: [] }]);
  const patchColumn = (colId: string, patch: Partial<BoardColumn>) =>
    mapColumns((cols) => cols.map((c) => (c.id === colId ? { ...c, ...patch } : c)));
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

  const onColumnDrop = (targetColId: string) => {
    const d = drag.current;
    if (d?.kind === "column") {
      moveColumn(d.colId, targetColId);
    } else if (d?.kind === "card") {
      // Dropping anywhere on the column (not on a specific card) appends to it.
      moveCard({ colId: d.colId, cardId: d.cardId }, targetColId, null);
    }
    drag.current = null;
    setDragOverCol(null);
  };

  const openCol = openCard && board.columns.find((c) => c.id === openCard.colId);
  const openData = openCol?.cards.find((cd) => cd.id === openCard!.cardId);

  return (
    <div ref={rootRef} className={`roadmap${openCard ? " roadmap-has-overlay" : ""}`}>
      <div className="roadmap-cols">
        {board.columns.map((col) => (
          <div
            key={col.id}
            className={`roadmap-col${dragOverCol === col.id ? " drag-over" : ""}${col.tone ? ` tone-${col.tone}` : ""}`}
            onDragOver={(e) => {
              if (editUnlocked && drag.current) {
                e.preventDefault();
                setDragOverCol(col.id);
              }
            }}
            onDragLeave={(e) => {
              // Only clear when the pointer actually left the column, not a child.
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverCol((c) => (c === col.id ? null : c));
              }
            }}
            onDrop={(e) => {
              if (editUnlocked && drag.current) {
                e.preventDefault();
                onColumnDrop(col.id);
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
              <span className={`roadmap-status-dot${col.tone ? ` tone-${col.tone}` : ""}`} />
              {editUnlocked ? (
                <input
                  className="roadmap-col-title-input"
                  value={col.title}
                  onChange={(e) => patchColumn(col.id, { title: e.target.value })}
                />
              ) : (
                <span className="roadmap-col-title">{col.title}</span>
              )}
              <span className="roadmap-col-count">{col.cards.length}</span>
              {editUnlocked && (
                <>
                  <ToneMenu tone={col.tone ?? ""} onPick={(t) => patchColumn(col.id, { tone: t })} />
                  <button className="roadmap-icon-btn" title="Delete column" onClick={() => deleteColumn(col.id)}>
                    <Trash2 />
                  </button>
                </>
              )}
            </div>

            <div className="roadmap-col-body">
              {col.cards.map((card) => (
                <CardFace
                  key={card.id}
                  card={card}
                  tone={col.tone ?? ""}
                  editable={editUnlocked}
                  ctx={ctx}
                  onOpen={() => setOpenCard({ colId: col.id, cardId: card.id })}
                  onDelete={() => deleteCard(col.id, card.id)}
                  onTitle={(title) => patchCard(col.id, card.id, { title })}
                  onAssignees={(assignees) => patchCard(col.id, card.id, { assignees }, "changed assignees")}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", card.id);
                    drag.current = { kind: "card", colId: col.id, cardId: card.id };
                  }}
                  onDragOverCard={(e) => {
                    // Let the event bubble so the column keeps its snap highlight;
                    // only preventDefault to mark this a valid card drop target.
                    if (editUnlocked && drag.current?.kind === "card") {
                      e.preventDefault();
                    }
                  }}
                  onDropCard={(e) => {
                    if (editUnlocked && drag.current?.kind === "card") {
                      e.preventDefault();
                      e.stopPropagation();
                      moveCard(
                        { colId: drag.current.colId, cardId: drag.current.cardId },
                        col.id,
                        card.id
                      );
                      drag.current = null;
                      setDragOverCol(null);
                    }
                  }}
                />
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

      {openCard && openData && openCol && (
        <CardView
          card={openData}
          columnTitle={openCol.title}
          tone={openCol.tone ?? ""}
          editable={editUnlocked}
          me={me}
          ctx={ctx}
          onClose={() => setOpenCard(null)}
          onPatch={(patch, activity) => patchCard(openCard.colId, openCard.cardId, patch, activity)}
          onDelete={() => deleteCard(openCard.colId, openCard.cardId)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card face (in a column)                                             */
/* ------------------------------------------------------------------ */

function CardFace({
  card,
  tone,
  editable,
  ctx,
  onOpen,
  onDelete,
  onTitle,
  onAssignees,
  onDragStart,
  onDragOverCard,
  onDropCard,
}: {
  card: BoardCard;
  tone: string;
  editable: boolean;
  ctx: RenderContext;
  onOpen: () => void;
  onDelete: () => void;
  onTitle: (title: string) => void;
  onAssignees: (names: string[]) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOverCard: (e: React.DragEvent) => void;
  onDropCard: (e: React.DragEvent) => void;
}) {
  const assignees = card.assignees ?? [];
  const hasBody = card.body.trim().length > 0;
  const comments = card.comments?.length ?? 0;

  return (
    <div
      className="roadmap-card"
      draggable={editable}
      onDragStart={(e) => editable && (e.stopPropagation(), onDragStart(e))}
      onDragOver={onDragOverCard}
      onDrop={onDropCard}
      onClick={() => onOpen()}
    >
      {editable && (
        <button
          className="roadmap-icon-btn roadmap-card-del"
          title="Delete card"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 />
        </button>
      )}

      {editable ? (
        <textarea
          className="roadmap-card-title-input"
          rows={1}
          value={card.title}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onTitle(e.target.value)}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "0px";
            el.style.height = el.scrollHeight + "px";
          }}
        />
      ) : (
        <div className="roadmap-card-title wiki">{renderMarkdown(card.title, ctx)}</div>
      )}

      <div className="roadmap-card-foot">
        {tone && <span className={`roadmap-status-dot tone-${tone}`} title="Status" />}
        {card.due && (
          <span className="roadmap-badge" title={`Due ${card.due}`}>
            <Calendar /> {formatDue(card.due)}
          </span>
        )}
        {hasBody && (
          <span className="roadmap-badge" title="Has a description">
            <AlignLeft />
          </span>
        )}
        {comments > 0 && (
          <span className="roadmap-badge" title={`${comments} comment(s)`}>
            <MessageSquare /> {comments}
          </span>
        )}
        <span className="roadmap-foot-spacer" />
        {editable ? (
          <AssigneeEditor names={assignees} onChange={onAssignees} />
        ) : (
          assignees.map((n) => (
            <span key={n} className="roadmap-assignee" title={n}>
              {initials(n)}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fullscreen card view                                               */
/* ------------------------------------------------------------------ */

function CardView({
  card,
  columnTitle,
  tone,
  editable,
  me,
  ctx,
  onClose,
  onPatch,
  onDelete,
}: {
  card: BoardCard;
  columnTitle: string;
  tone: string;
  editable: boolean;
  me: string;
  ctx: RenderContext;
  onClose: () => void;
  onPatch: (patch: Partial<BoardCard>, activity?: string) => void;
  onDelete: () => void;
}) {
  const [comment, setComment] = useState("");
  const assignees = card.assignees ?? [];

  const postComment = () => {
    const text = comment.trim();
    if (!text) {
      return;
    }
    onPatch({ comments: [...(card.comments ?? []), { id: newBoardId("cmt"), who: me, text, at: new Date().toISOString() }] });
    setComment("");
  };

  return (
    <div className="roadmap-fullcard" role="dialog" aria-modal="true">
      <button className="roadmap-fullcard-close" title="Close" onClick={onClose}>
        <X />
      </button>
      <div className="roadmap-fullcard-inner">
        <div className="roadmap-fullcard-eyebrow">
          {tone && <span className={`roadmap-status-dot tone-${tone}`} />}
          {columnTitle}
        </div>

        {editable ? (
          <textarea
            className="roadmap-fullcard-title-input"
            rows={1}
            value={card.title}
            onChange={(e) => onPatch({ title: e.target.value })}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "0px";
              el.style.height = el.scrollHeight + "px";
            }}
          />
        ) : (
          <div className="roadmap-fullcard-title wiki">{renderMarkdown(card.title, ctx)}</div>
        )}

        {/* Meta row: due date + assignees */}
        <div className="roadmap-fullcard-meta">
          <label className="roadmap-meta-field">
            <Calendar />
            {editable ? (
              <input
                type="date"
                value={card.due ?? ""}
                onChange={(e) => onPatch({ due: e.target.value || undefined }, "set the due date")}
              />
            ) : (
              <span>{card.due ? formatDue(card.due) : "No due date"}</span>
            )}
          </label>
          <div className="roadmap-meta-field">
            <span className="roadmap-meta-label">Assignees</span>
            {editable ? (
              <AssigneeEditor names={assignees} onChange={(names) => onPatch({ assignees: names }, "changed assignees")} />
            ) : assignees.length ? (
              assignees.map((n) => (
                <span key={n} className="roadmap-assignee-chip">
                  {n}
                </span>
              ))
            ) : (
              <span className="roadmap-muted">None</span>
            )}
          </div>
          {editable && (
            <button className="roadmap-icon-btn roadmap-meta-del" title="Delete card" onClick={onDelete}>
              <Trash2 />
            </button>
          )}
        </div>

        {/* Description (body) */}
        <div className="roadmap-fullcard-section-label">Description</div>
        {editable ? (
          <textarea
            className="roadmap-body-input"
            rows={10}
            value={card.body}
            placeholder="Full details — markdown: images, boxes, links, everything."
            onChange={(e) => onPatch({ body: e.target.value })}
            onBlur={() => onPatch({}, undefined)}
          />
        ) : card.body.trim() ? (
          <div className="wiki roadmap-fullcard-body">{renderMarkdown(card.body, ctx)}</div>
        ) : (
          <p className="roadmap-muted">No description yet.</p>
        )}

        {/* Comments */}
        <div className="roadmap-fullcard-section-label">
          <MessageSquare /> Comments
        </div>
        <div className="roadmap-comments">
          {(card.comments ?? []).map((c) => (
            <div key={c.id} className="roadmap-comment">
              <div className="roadmap-comment-head">
                <span className="roadmap-comment-who">{c.who}</span>
                <span className="roadmap-comment-at">{formatWhen(c.at)}</span>
              </div>
              <div className="wiki roadmap-comment-body">{renderMarkdown(c.text, ctx)}</div>
            </div>
          ))}
          {(card.comments ?? []).length === 0 && <p className="roadmap-muted">No comments yet.</p>}
        </div>
        {editable && (
          <div className="roadmap-comment-compose">
            <textarea
              rows={2}
              value={comment}
              placeholder="Write a comment…"
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  postComment();
                }
              }}
            />
            <button className="roadmap-comment-send" title="Post (Ctrl+Enter)" onClick={postComment} disabled={!comment.trim()}>
              <Send />
            </button>
          </div>
        )}

        {/* Activity */}
        <div className="roadmap-fullcard-section-label">Activity</div>
        <div className="roadmap-activity">
          {(card.activity ?? [])
            .slice()
            .reverse()
            .map((a, i) => (
              <div key={i} className="roadmap-activity-row">
                <span className="roadmap-activity-who">{a.who}</span> {a.what}
                <span className="roadmap-activity-at">{formatWhen(a.at)}</span>
              </div>
            ))}
          {(card.activity ?? []).length === 0 && <p className="roadmap-muted">No activity yet.</p>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

/** Free-text assignee chips with an inline add field. */
function AssigneeEditor({ names, onChange }: { names: string[]; onChange: (names: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const commit = () => {
    const n = value.trim();
    if (n && !names.includes(n)) {
      onChange([...names, n]);
    }
    setValue("");
    setAdding(false);
  };
  return (
    <span className="roadmap-assignees" onClick={(e) => e.stopPropagation()}>
      {names.map((n) => (
        <span key={n} className="roadmap-assignee-chip">
          {n}
          <button className="roadmap-chip-x" title={`Remove ${n}`} onClick={() => onChange(names.filter((x) => x !== n))}>
            <X />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          className="roadmap-assignee-input"
          value={value}
          placeholder="name"
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
            }
            if (e.key === "Escape") {
              setValue("");
              setAdding(false);
            }
          }}
        />
      ) : (
        <button className="roadmap-assignee-add" title="Add assignee" onClick={() => setAdding(true)}>
          <Plus />
        </button>
      )}
    </span>
  );
}

/** A small swatch menu for a column's status tone. */
function ToneMenu({ tone, onPick }: { tone: string; onPick: (t: BoardColumn["tone"]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="roadmap-tone-menu" onClick={(e) => e.stopPropagation()}>
      <button
        className={`roadmap-icon-btn roadmap-tone-swatch${tone ? ` tone-${tone}` : ""}`}
        title="Column colour"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="roadmap-status-dot" />
      </button>
      {open && (
        <span className="roadmap-tone-pop">
          {TONES.map((t) => (
            <button
              key={t || "none"}
              className={`roadmap-tone-opt${t ? ` tone-${t}` : ""}${t === tone ? " active" : ""}`}
              title={TONE_LABEL[t]}
              onClick={() => {
                onPick(t);
                setOpen(false);
              }}
            >
              <span className="roadmap-status-dot" />
              {TONE_LABEL[t]}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatDue(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
