import { useMemo, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { parseUeGraph, type UeGraph, type UeNode, type UePin } from "~/lib/ueGraph";

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
const PIN_PAD = 10;
const NODE_MIN_W = 150;
const CHAR_W = 7.5;

/** UE-ish pin/wire colours by PinType.PinCategory. */
const PIN_COLOR: Record<string, string> = {
  exec: "#e8e8e8",
  bool: "#8b0000",
  byte: "#006e6e",
  int: "#1fe4b7",
  int64: "#8be9b0",
  real: "#a6ff00",
  float: "#a6ff00",
  double: "#a6ff00",
  string: "#ff00d4",
  name: "#c88fff",
  text: "#e4a6ff",
  struct: "#0088ff",
  object: "#3737ff",
  class: "#8b53d6",
  delegate: "#ff2b2b",
  interface: "#ffb300",
};

function pinColor(category: string): string {
  return PIN_COLOR[category] ?? "#9aa0a6";
}

/** Header tint by node kind — a rough nod to UE's node-title colours. */
function headerColor(node: UeNode): string {
  const c = node.classLeaf;
  if (c === "K2Node_Event") {
    return "#7a1f1f";
  }
  if (c === "K2Node_IfThenElse" || c === "K2Node_ExecutionSequence") {
    return "#3a4a5a";
  }
  if (c === "K2Node_VariableGet" || c === "K2Node_VariableSet") {
    return "#1f5a3a";
  }
  if (c.startsWith("MaterialExpression")) {
    return "#3a3a5a";
  }
  return "#22303c";
}

interface Placed {
  node: UeNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

function nodeWidth(node: UeNode): number {
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
  const rows = Math.max(node.inputs.length, node.outputs.length);
  return HEADER_H + rows * PIN_ROW_H + PIN_PAD;
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
  const inIdx = p.node.inputs.findIndex((pin) => pin.id === pinId);
  if (inIdx !== -1) {
    return { x: p.x, y: p.y + HEADER_H + inIdx * PIN_ROW_H + PIN_ROW_H / 2, cat: p.node.inputs[inIdx].category };
  }
  const outIdx = p.node.outputs.findIndex((pin) => pin.id === pinId);
  if (outIdx !== -1) {
    return { x: p.x + p.w, y: p.y + HEADER_H + outIdx * PIN_ROW_H + PIN_ROW_H / 2, cat: p.node.outputs[outIdx].category };
  }
  return null;
}

function PinRow({ pin, side }: { pin: UePin; side: "left" | "right" }) {
  const color = pinColor(pin.category);
  const dot = (
    <span
      aria-hidden
      style={{
        width: 9,
        height: 9,
        flex: "none",
        borderRadius: pin.category === "exec" ? 1 : 9,
        background: pin.category === "exec" ? "transparent" : color,
        border: `2px solid ${color}`,
        transform: pin.category === "exec" ? "rotate(0deg)" : undefined,
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

function NodeBox({ p, selected }: { p: Placed; selected: boolean }) {
  const rows = Math.max(p.node.inputs.length, p.node.outputs.length);
  return (
    <div
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", padding: "5px 0" }}>
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

  // Resolve the view lazily so we can fit to the measured viewport on first paint.
  const current = view ?? (wrapRef.current ? fitView(placed, wrapRef.current.clientWidth, wrapRef.current.clientHeight) : { x: 0, y: 0, scale: 1 });

  const toCanvas = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - current.x) / current.scale,
      y: (clientY - rect.top - current.y) / current.scale,
    };
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = wrapRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(2.5, Math.max(0.1, current.scale * factor));
    // Keep the point under the cursor fixed while zooming.
    setView({
      scale: next,
      x: px - ((px - current.x) / current.scale) * next,
      y: py - ((py - current.y) / current.scale) * next,
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
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
        </span>
        <button type="button" onClick={copy} className="ue-graph-copy" title="Copy the original text back for Unreal">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div
        ref={wrapRef}
        className="ue-graph-viewport"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => setView(fitView(placed, wrapRef.current!.clientWidth, wrapRef.current!.clientHeight))}
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
                  stroke={pinColor(w.category)}
                  strokeWidth={w.category === "exec" ? 2.5 : 1.75}
                  strokeOpacity={0.9}
                />
              );
            })}
          </svg>
          {placed.map((p) => (
            <NodeBox key={p.node.name} p={p} selected={selection.has(p.node.name)} />
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
        <div className="ue-graph-hint">Scroll to zoom · right-drag to pan · drag to select · double-click to fit</div>
      </div>
    </div>
  );
}
