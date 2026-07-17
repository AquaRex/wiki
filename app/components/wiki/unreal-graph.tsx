import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { parseUeGraph, type UeGraph, type UeNode, type UePin, type UeRole } from "~/lib/ueGraph";

const GRID = 24;

/*
 * A read-only, pan/zoom/select viewer for Unreal Engine node graphs pasted as
 * T3D text. The raw paste is passed straight through and offered back via the
 * Copy button, so nodes can be pasted back into Unreal unchanged — the parser
 * only reads it to draw.
 *
 * Coordinates: UE grid units are used directly as pixels inside an inner canvas
 * layer that a single CSS transform pans and zooms. Nodes are absolutely placed
 * at their NodePosX/Y; wires are an SVG layer beneath the nodes. UE does not
 * export node sizes, so they are measured from title length and pin count —
 * faithful, though not pixel-identical to the editor.
 */

const HEADER_H = 30;
const PIN_ROW_H = 22;
/** Vertical padding above the first pin row — shared by layout and wire anchors. */
const PINS_TOP = 5;
const PIN_PAD = 10;
const NODE_MIN_W = 150;
const CHAR_W = 7.5;
const DOT = 10;

/*
 * Exact Unreal pin/wire colours by PinType.PinCategory. Structs share one
 * category ("struct") but Vector/Rotator/Transform are tinted by their
 * PinSubCategoryObject — see STRUCT_COLOR.
 */
const PIN_COLOR: Record<string, string> = {
  exec: "#f0f0f0",
  bool: "#950000",
  byte: "#006f65",
  int: "#1fe3af",
  int64: "#ace3af",
  real: "#38d500",
  float: "#38d500",
  double: "#38d500",
  name: "#cd82ff",
  string: "#ff00d4",
  text: "#e77caa",
  struct: "#0059cb",
  object: "#00aaf5",
  class: "#5900bc",
  softobject: "#95ffff",
  softclass: "#ff95ff",
  interface: "#f1ffaa",
  enum: "#006f65",
  delegate: "#ff2b2b",
  // Material graph pin categories.
  materialinput: "#d0d0d0",
  optional: "#7f9f7f",
  required: "#d0d0d0",
  mask: "#c8c8c8",
};

/** Struct pins UE tints by their concrete type rather than the generic struct blue. */
const STRUCT_COLOR: Record<string, string> = {
  Vector: "#ffca23",
  Vector3f: "#ffca23",
  Rotator: "#a0b4ff",
  Transform: "#ff7300",
};

function pinColor(pin: { category: string; subType: string }): string {
  if (pin.category === "struct" && STRUCT_COLOR[pin.subType]) {
    return STRUCT_COLOR[pin.subType];
  }
  // Material data pins often have an empty category — treat as a neutral wire.
  return PIN_COLOR[pin.category] ?? "#c0c4c8";
}

/** Header tint by the node's role — matches UE's title-bar colouring. */
const ROLE_HEADER: Record<UeRole, string> = {
  event: "#8c1f1e",
  pure: "#6b9065",
  function: "#5b819b",
  macro: "#949594",
  "variable-get": "#5b819b",
  "variable-set": "#5b819b",
  flow: "#5b819b",
  material: "#3a3a5a",
  other: "#22303c",
};

function headerColor(node: UeNode): string {
  return ROLE_HEADER[node.role] ?? ROLE_HEADER.other;
}

/** A variable Get renders as a compact coloured pill, not a full node. */
function isPill(node: UeNode): boolean {
  return node.role === "variable-get";
}

/** The variable's type colour — from the Get node's single output pin. */
function pillColor(node: UeNode): string {
  const out = node.outputs[0];
  return out ? pinColor(out) : "#c0c4c8";
}

interface Placed {
  node: UeNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The bare variable name for a Get pill — "Get FooBar" -> "FooBar". */
function pillLabel(node: UeNode): string {
  return node.title.replace(/^Get\s+/, "");
}

function nodeWidth(node: UeNode): number {
  if (isPill(node)) {
    // Name text + a pin dot at each end.
    return Math.max(56, pillLabel(node).length * CHAR_W + 34);
  }
  const rows = Math.max(node.inputs.length, node.outputs.length);
  const titleW = node.title.length * CHAR_W + 28;
  let pinW = 0;
  for (let i = 0; i < rows; i++) {
    const left = node.inputs[i]?.label.length ?? 0;
    const right = node.outputs[i]?.label.length ?? 0;
    pinW = Math.max(pinW, (left + right) * CHAR_W + 44);
  }
  return Math.max(NODE_MIN_W, titleW, pinW);
}

function nodeHeight(node: UeNode): number {
  if (isPill(node)) {
    return 30;
  }
  const rows = Math.max(node.inputs.length, node.outputs.length);
  return HEADER_H + PINS_TOP + rows * PIN_ROW_H + PIN_PAD;
}

function place(graph: UeGraph): { placed: Placed[]; byName: Map<string, Placed> } {
  const placed = graph.nodes.map((node) => ({
    node,
    x: node.posX,
    y: node.posY,
    w: nodeWidth(node),
    h: nodeHeight(node),
  }));
  const byName = new Map(placed.map((p) => [p.node.name, p]));
  return { placed, byName };
}

/** Anchor point (canvas coords) for a pin on a placed node. */
function pinAnchor(p: Placed, pinId: string): { x: number; y: number; cat: string } | null {
  // A pill-rendered node (variable Get) has no pin rows — anchor at its middle.
  if (isPill(p.node)) {
    return { x: p.x + p.w, y: p.y + p.h / 2, cat: p.node.outputs[0]?.category ?? "" };
  }
  const rowY = (idx: number) => p.y + HEADER_H + PINS_TOP + idx * PIN_ROW_H + PIN_ROW_H / 2;
  const inIdx = p.node.inputs.findIndex((pin) => pin.id === pinId);
  if (inIdx !== -1) {
    return { x: p.x, y: rowY(inIdx), cat: p.node.inputs[inIdx].category };
  }
  const outIdx = p.node.outputs.findIndex((pin) => pin.id === pinId);
  if (outIdx !== -1) {
    return { x: p.x + p.w, y: rowY(outIdx), cat: p.node.outputs[outIdx].category };
  }
  return null;
}

function PinRow({ pin, side }: { pin: UePin; side: "left" | "right" }) {
  const color = pinColor(pin);
  const isExec = pin.category === "exec";
  // Exec pins are the hollow arrow/triangle; data pins are the filled circle.
  const dot = isExec ? (
    <span
      aria-hidden
      style={{
        width: 0,
        height: 0,
        flex: "none",
        borderTop: `${DOT / 2}px solid transparent`,
        borderBottom: `${DOT / 2}px solid transparent`,
        borderLeft: `${DOT}px solid ${color}`,
      }}
    />
  ) : (
    <span
      aria-hidden
      style={{
        width: DOT,
        height: DOT,
        flex: "none",
        borderRadius: DOT,
        background: color,
      }}
    />
  );
  return (
    <div
      style={{
        height: PIN_ROW_H,
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexDirection: side === "left" ? "row" : "row-reverse",
        padding: side === "left" ? "0 8px 0 6px" : "0 6px 0 8px",
      }}
    >
      {dot}
      <span style={{ color: "#c8ccd0", fontSize: 12, whiteSpace: "nowrap" }}>{pin.label}</span>
    </div>
  );
}

function NodeBox({
  p,
  selected,
  onSelect,
}: {
  p: Placed;
  selected: boolean;
  onSelect: (name: string, additive: boolean) => void;
}) {
  const onDown = (e: React.PointerEvent) => {
    // Clicking a node selects it (Ctrl/Shift to add), rather than starting a
    // marquee on the canvas behind it.
    if (e.button === 0) {
      e.stopPropagation();
      onSelect(p.node.name, e.ctrlKey || e.shiftKey || e.metaKey);
    }
  };

  // A variable Get is a compact coloured pill with just the variable name.
  if (isPill(p.node)) {
    const color = pillColor(p.node);
    return (
      <div
        onPointerDown={onDown}
        title={p.node.title}
        style={{
          position: "absolute",
          left: p.x,
          top: p.y,
          width: p.w,
          height: p.h,
          borderRadius: p.h / 2,
          background: color,
          border: `1px solid ${selected ? "#ffb300" : "rgba(0,0,0,0.5)"}`,
          boxShadow: selected ? "0 0 0 2px rgba(255,179,0,0.6)" : "0 2px 6px rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 12px",
          color: "#0b0e10",
          fontSize: 12,
          fontWeight: 700,
          whiteSpace: "nowrap",
          userSelect: "none",
          cursor: "pointer",
        }}
      >
        {pillLabel(p.node)}
      </div>
    );
  }

  const rows = Math.max(p.node.inputs.length, p.node.outputs.length);
  return (
    <div
      onPointerDown={onDown}
      style={{
        position: "absolute",
        left: p.x,
        top: p.y,
        width: p.w,
        minHeight: p.h,
        borderRadius: 6,
        background: "#1a1f24",
        border: `1px solid ${selected ? "#ffb300" : "#000"}`,
        boxShadow: selected ? "0 0 0 2px rgba(255,179,0,0.5)" : "0 3px 10px rgba(0,0,0,0.5)",
        overflow: "hidden",
        userSelect: "none",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          height: HEADER_H,
          background: headerColor(p.node),
          color: "#fff",
          display: "flex",
          alignItems: "center",
          padding: "0 10px",
          fontSize: 12.5,
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        {p.node.title}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", padding: `${PINS_TOP}px 0` }}>
        <div>
          {p.node.inputs.map((pin) => (
            <PinRow key={pin.id} pin={pin} side="left" />
          ))}
        </div>
        <div>
          {p.node.outputs.map((pin) => (
            <PinRow key={pin.id} pin={pin} side="right" />
          ))}
        </div>
      </div>
      {rows === 0 && <div style={{ height: PIN_PAD }} />}
    </div>
  );
}

interface View {
  x: number;
  y: number;
  scale: number;
}

/** Fits the graph's bounding box into the given viewport size. */
function fitView(placed: Placed[], vw: number, vh: number): View {
  if (placed.length === 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  const pad = 60;
  const gw = maxX - minX + pad * 2;
  const gh = maxY - minY + pad * 2;
  const scale = Math.min(1, Math.min(vw / gw, vh / gh));
  return {
    scale,
    x: -(minX - pad) * scale + (vw - gw * scale) / 2,
    y: -(minY - pad) * scale + (vh - gh * scale) / 2,
  };
}

export function UnrealGraph({ source }: { source: string }) {
  const graph = useMemo(() => parseUeGraph(source), [source]);
  const { placed, byName } = useMemo(() => place(graph), [graph]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const pan = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null);

  const current = view ?? { x: 0, y: 0, scale: 1 };

  // A ref mirror of the live view so the non-passive wheel listener (attached
  // natively below) reads current values without re-subscribing every render.
  const viewRef = useRef(current);
  viewRef.current = current;

  const fit = () => {
    const el = wrapRef.current;
    if (el) {
      setView(fitView(placed, el.clientWidth, el.clientHeight));
    }
  };

  /*
   * Zoom on wheel, and — crucially — stop the page from scrolling when the
   * cursor is over the viewport. React's onWheel is registered passive, so its
   * preventDefault is ignored; only a native non-passive listener can block the
   * page scroll. Attached here rather than via onWheel for that reason.
   */
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const v = viewRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(2.5, Math.max(0.1, v.scale * factor));
      setView({
        scale: next,
        x: px - ((px - v.x) / v.scale) * next,
        y: py - ((py - v.y) / v.scale) * next,
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Fit on mount and whenever a fresh paste comes in. Before paint, so the graph
  // never flashes at 0,0.
  useLayoutEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const toCanvas = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - current.x) / current.scale,
      y: (clientY - rect.top - current.y) / current.scale,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Focus the viewport so "F" (fit) works after interacting with it.
    wrapRef.current?.focus({ preventScroll: true });
    if (e.button === 2 || e.button === 1 || (e.button === 0 && e.altKey)) {
      // Right / middle / alt-left drag pans.
      pan.current = { startX: e.clientX, startY: e.clientY, viewX: current.x, viewY: current.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      const c = toCanvas(e.clientX, e.clientY);
      setMarquee({ x0: c.x, y0: c.y, x1: c.x, y1: c.y });
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pan.current) {
      setView({
        scale: current.scale,
        x: pan.current.viewX + (e.clientX - pan.current.startX),
        y: pan.current.viewY + (e.clientY - pan.current.startY),
      });
      return;
    }
    if (marquee) {
      const c = toCanvas(e.clientX, e.clientY);
      setMarquee({ ...marquee, x1: c.x, y1: c.y });
    }
  };

  const onPointerUp = () => {
    if (marquee) {
      const lx = Math.min(marquee.x0, marquee.x1);
      const rx = Math.max(marquee.x0, marquee.x1);
      const ty = Math.min(marquee.y0, marquee.y1);
      const by = Math.max(marquee.y0, marquee.y1);
      const hit = new Set<string>();
      const drag = Math.abs(rx - lx) > 3 || Math.abs(by - ty) > 3;
      if (drag) {
        for (const p of placed) {
          if (p.x < rx && p.x + p.w > lx && p.y < by && p.y + p.h > ty) {
            hit.add(p.node.name);
          }
        }
      }
      setSelection(hit);
      setMarquee(null);
    }
    pan.current = null;
  };

  const toggleSelect = (name: string, additive: boolean) => {
    setSelection((prev) => {
      if (additive) {
        const next = new Set(prev);
        if (next.has(name)) {
          next.delete(name);
        } else {
          next.add(name);
        }
        return next;
      }
      // Plain click on the only selected node clears it; otherwise selects just it.
      if (prev.size === 1 && prev.has(name)) {
        return new Set();
      }
      return new Set([name]);
    });
  };

  // Copy the selected nodes back out for Unreal — or the whole graph when nothing
  // is selected. Each node keeps its exact source, so the result pastes cleanly.
  const copy = async () => {
    let text = source;
    if (selection.size > 0) {
      text = graph.nodes
        .filter((n) => selection.has(n.name))
        .map((n) => n.raw)
        .join("\n");
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  if (graph.nodes.length === 0) {
    return (
      <div className="ue-graph-empty">
        Paste Unreal node text between the fences. Nothing recognisable was found.
      </div>
    );
  }

  return (
    <div className="ue-graph">
      <div className="ue-graph-bar">
        <span className="ue-graph-kind">{graph.kind === "material" ? "Material" : "Blueprint"}</span>
        <span className="ue-graph-count">
          {graph.nodes.length} nodes · {graph.wires.length} links
          {selection.size > 0 && ` · ${selection.size} selected`}
        </span>
        <button
          type="button"
          onClick={copy}
          className="ue-graph-copy"
          title={
            selection.size > 0
              ? "Copy the selected nodes back for Unreal"
              : "Copy the whole graph back for Unreal"
          }
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : selection.size > 0 ? `Copy ${selection.size}` : "Copy all"}
        </button>
      </div>
      <div
        ref={wrapRef}
        className="ue-graph-viewport"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={fit}
        onKeyDown={(e) => {
          if (e.key === "f" || e.key === "F") {
            e.preventDefault();
            fit();
          }
        }}
        // The dot grid rides the pan/zoom so movement is visible: its size scales
        // with zoom and its origin tracks the canvas translation.
        style={{
          backgroundSize: `${GRID * current.scale}px ${GRID * current.scale}px`,
          backgroundPosition: `${current.x}px ${current.y}px`,
        }}
      >
        <div
          className="ue-graph-canvas"
          style={{ transform: `translate(${current.x}px, ${current.y}px) scale(${current.scale})` }}
        >
          <svg className="ue-graph-wires" style={{ overflow: "visible" }}>
            {graph.wires.map((w, idx) => {
              const from = byName.get(w.fromNode);
              const to = byName.get(w.toNode);
              if (!from || !to) {
                return null;
              }
              const a = pinAnchor(from, w.fromPin);
              const b = pinAnchor(to, w.toPin);
              if (!a || !b) {
                return null;
              }
              const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
              return (
                <path
                  key={idx}
                  d={`M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`}
                  fill="none"
                  stroke={pinColor(w)}
                  strokeWidth={w.category === "exec" ? 2.5 : 1.75}
                  strokeOpacity={0.9}
                />
              );
            })}
          </svg>
          {placed.map((p) => (
            <NodeBox
              key={p.node.name}
              p={p}
              selected={selection.has(p.node.name)}
              onSelect={toggleSelect}
            />
          ))}
          {marquee && (
            <div
              className="ue-graph-marquee"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}
        </div>
        <div className="ue-graph-hint">Scroll to zoom · right-drag to pan · drag to select · F or double-click to fit</div>
      </div>
    </div>
  );
}
