/*
 * Parses Unreal Engine's T3D clipboard text — what you get when you copy nodes
 * out of a Blueprint or Material graph — into a small, render-ready model.
 *
 * The parser only READS the text. The raw paste is always kept verbatim by the
 * caller so it can be copied straight back into Unreal, so nothing here mutates
 * or re-serialises the input.
 */

export type PinDirection = "input" | "output";

export interface UePin {
  id: string;
  name: string;
  /** UE's PinFriendlyName when present — what the graph actually labels the pin. */
  label: string;
  direction: PinDirection;
  /** PinType.PinCategory: exec, bool, real, int, struct, object, delegate, name, string… */
  category: string;
  /**
   * The struct/enum leaf from PinSubCategoryObject (e.g. "Vector", "Rotator",
   * "Transform"), used to colour struct pins that UE tints specially. "" when
   * the pin has no sub-type object.
   */
  subType: string;
  hidden: boolean;
  /**
   * Targets this pin links to. Unreal reuses pin IDs across nodes (they are only
   * unique within a node), so a link must carry the target node name too — the
   * pin id alone is ambiguous.
   */
  links: { node: string; pin: string }[];
}

export interface UeNode {
  /** Object Name="…" — unique within a paste, used to resolve links. */
  name: string;
  className: string;
  /** The K2Node_X / MaterialExpressionX leaf of the class path. */
  classLeaf: string;
  posX: number;
  posY: number;
  title: string;
  inputs: UePin[];
  outputs: UePin[];
  /** Broad classification used for the header colour and pill rendering. */
  role: UeRole;
  /**
   * The node's exact source slice, "Begin Object … End Object" verbatim. Kept so
   * a selection of nodes can be copied back into Unreal unchanged.
   */
  raw: string;
}

export type UeRole =
  | "event"
  | "pure"
  | "function"
  | "macro"
  | "variable-get"
  | "variable-set"
  | "flow"
  | "material"
  | "other";

export interface UeWire {
  fromNode: string;
  fromPin: string;
  toNode: string;
  toPin: string;
  /** Category + sub-type of the source (output) pin — drive the wire colour. */
  category: string;
  subType: string;
}

export interface UeGraph {
  nodes: UeNode[];
  wires: UeWire[];
  kind: "blueprint" | "material" | "unknown";
}

/**
 * Splits the top-level `key=value` pairs of one line, respecting quotes and
 * balanced parentheses so nested tuples like `LinkedTo=(A B,C D,)` or
 * `NSLOCTEXT("K2Node","true","true")` are not torn apart on their inner commas.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (!inQuote) {
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
    }
    if (ch === "," && depth === 0 && !inQuote) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

/**
 * Reads the first `key=…` value out of `line`, quote/paren aware. The key must
 * sit on a field boundary (line start, or after whitespace/comma/paren) so that
 * "NodePosX" never matches inside a longer token. Uses a plain scan rather than
 * a built regex to avoid escaping ambiguity around the boundary class.
 */
function fieldValue(line: string, key: string): string | null {
  const needle = key + "=";
  let at = -1;
  let from = 0;
  while (true) {
    const idx = line.indexOf(needle, from);
    if (idx === -1) {
      return null;
    }
    const prev = idx === 0 ? "" : line[idx - 1];
    if (idx === 0 || prev === " " || prev === "\t" || prev === "\n" || prev === "\r" || prev === "," || prev === "(") {
      at = idx;
      break;
    }
    from = idx + needle.length;
  }
  const start = at + needle.length;
  let depth = 0;
  let inQuote = false;
  let out = "";
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (!inQuote) {
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth < 0) {
          break;
        }
      } else if ((ch === "," || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") && depth === 0) {
        break;
      }
    }
    out += ch;
  }
  return out;
}

function unquote(value: string | null): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Pulls MemberName out of a `(…MemberName="X"…)` tuple. */
function memberName(tuple: string | null): string {
  if (!tuple) {
    return "";
  }
  const m = /MemberName="?([^",)]+)"?/.exec(tuple);
  return m ? m[1] : "";
}

/** Splits "ReceiveBeginPlay" / "K2_GetActorLocation" into spaced words. */
function humanise(raw: string): string {
  return raw
    .replace(/^Receive/, "")
    .replace(/^K2_/, "")
    .replace(/^bp_/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
}

function nodeTitle(classLeaf: string, headerLines: string[], innerLines: string[] = []): string {
  const header = headerLines.join("\n");
  const inner = innerLines.join("\n");
  const member = () => humanise(memberName(fieldValue(header, "EventReference") ?? fieldValue(header, "FunctionReference") ?? fieldValue(header, "VariableReference")));
  switch (classLeaf) {
    case "K2Node_Event":
      return `Event ${member()}`.trim();
    case "K2Node_CallFunction":
      return member() || "Call Function";
    case "K2Node_VariableGet":
      return `Get ${member()}`.trim();
    case "K2Node_VariableSet":
      return `Set ${member()}`.trim();
    case "K2Node_IfThenElse":
      return "Branch";
    case "K2Node_ExecutionSequence":
      return "Sequence";
    case "K2Node_DynamicCast":
      return "Cast";
    case "K2Node_CommutativeAssociativeBinaryOperator":
    case "K2Node_PromotableOperator":
      return member() || "Operator";
    // --- Material expression nodes -------------------------------------
    case "MaterialGraphNode_Root":
      return "Material";
    case "MaterialExpressionReroute":
      return "Reroute";
    default:
      break;
  }
  if (classLeaf.startsWith("MaterialExpression")) {
    const base = humanise(classLeaf.replace(/^MaterialExpression/, ""));
    // Parameters and named constants carry their name — show it.
    const paramName = unquote(fieldValue(inner, "ParameterName"));
    if (paramName) {
      return `${base} (${paramName})`;
    }
    return base;
  }
  // K2Node_Foo -> "Foo"; anything else -> humanised leaf.
  return humanise(classLeaf.replace(/^K2Node_/, ""));
}

/** Classifies a node for header colour and pill rendering. */
function nodeRole(classLeaf: string, headerLines: string[]): UeRole {
  const header = headerLines.join("\n");
  const isPure = /(^|\n)\s*bIsPureFunc=True\b/.test(header);
  switch (classLeaf) {
    case "K2Node_Event":
    case "K2Node_CustomEvent":
    case "K2Node_ComponentBoundEvent":
    case "K2Node_ActorBoundEvent":
    case "K2Node_InputAction":
    case "K2Node_InputKey":
      return "event";
    case "K2Node_VariableGet":
      return "variable-get";
    case "K2Node_VariableSet":
      return "variable-set";
    case "K2Node_MacroInstance":
    case "K2Node_ForEachElementInEnumArray":
      return "macro";
    case "K2Node_IfThenElse":
    case "K2Node_ExecutionSequence":
    case "K2Node_MultiGate":
    case "K2Node_Select":
    case "K2Node_SwitchEnum":
    case "K2Node_SwitchInt":
    case "K2Node_SwitchString":
      return "flow";
    case "K2Node_CallFunction":
    case "K2Node_CommutativeAssociativeBinaryOperator":
    case "K2Node_PromotableOperator":
      return isPure ? "pure" : "function";
    default:
      if (classLeaf.startsWith("MaterialGraphNode") || classLeaf.startsWith("MaterialExpression")) {
        return "material";
      }
      return isPure ? "pure" : "other";
  }
}

/** Parses one `CustomProperties Pin (…)` line. */
function parsePin(line: string): UePin | null {
  const open = line.indexOf("(");
  const inner = open === -1 ? "" : line.slice(open + 1, line.lastIndexOf(")"));
  const fields = splitTopLevel(inner);

  let id = "";
  let name = "";
  let label = "";
  let direction: PinDirection = "input";
  let category = "";
  let subType = "";
  let hidden = false;
  const links: { node: string; pin: string }[] = [];

  for (const field of fields) {
    const eq = field.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1).trim();
    switch (key) {
      case "PinId":
        id = value;
        break;
      case "PinName":
        name = unquote(value);
        break;
      case "PinFriendlyName": {
        // Either a bare quoted string or NSLOCTEXT(ns, key, "Actual Text").
        const loc = /NSLOCTEXT\(\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"([^"]*)"\s*\)/.exec(value);
        label = loc ? loc[1] : unquote(value);
        break;
      }
      case "Direction":
        direction = unquote(value) === "EGPD_Output" ? "output" : "input";
        break;
      case "PinType.PinCategory":
        category = unquote(value);
        break;
      case "PinType.PinSubCategoryObject": {
        // e.g. "/Script/CoreUObject.ScriptStruct'/Script/CoreUObject.Vector'" -> "Vector"
        const raw = unquote(value);
        if (raw && raw !== "None") {
          const m = /([A-Za-z0-9_]+)'?\s*$/.exec(raw.replace(/'$/, ""));
          subType = m ? m[1] : "";
        }
        break;
      }
      case "bHidden":
        hidden = value.toLowerCase() === "true";
        break;
      case "LinkedTo": {
        // (NodeName PinId,NodeName PinId,) — each entry is a target node + pin.
        for (const entry of value.replace(/^\(|\)$/g, "").split(",")) {
          const parts = entry.trim().split(/\s+/);
          if (parts.length < 2) {
            continue;
          }
          const pin = parts[parts.length - 1];
          const node = parts.slice(0, -1).join(" ");
          if (/^[0-9A-Fa-f]{32}$/.test(pin)) {
            links.push({ node, pin });
          }
        }
        break;
      }
    }
  }

  if (!id) {
    return null;
  }
  return { id, name, label: label || name, direction, category, subType, hidden, links };
}

const CLASS_RE = /^Begin Object Class=(\S+)\s+Name="([^"]+)"/;

/** Parses the full T3D paste into nodes; wires are resolved afterwards. */
export function parseUeGraph(text: string): UeGraph {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nodes: UeNode[] = [];

  let i = 0;
  let kindVote = { blueprint: 0, material: 0 };

  while (i < lines.length) {
    const line = lines[i].trim();
    const begin = CLASS_RE.exec(line);
    if (!begin) {
      i++;
      continue;
    }
    const classPath = begin[1];
    const name = begin[2];
    const classLeaf = classPath.split(/[./]/).pop() ?? classPath;

    // Keep the untrimmed lines so the node can be re-emitted for Unreal exactly
    // as it was pasted, including indentation. Pins are read from the OUTER level
    // only; a node's header may contain nested Begin/End Object blocks (material
    // nodes wrap a MaterialExpression), so depth-track to find the matching End
    // and to skip pins/headers that belong to inner objects.
    const rawLines: string[] = [lines[i]];
    const headerLines: string[] = [];
    const innerLines: string[] = [];
    const pins: UePin[] = [];
    let innerClassLeaf = "";
    let depth = 1;
    i++;
    while (i < lines.length && depth > 0) {
      const rawLine = lines[i];
      const body = rawLine.trim();
      if (body === "End Object") {
        depth--;
        rawLines.push(rawLine);
        i++;
        continue;
      }
      const innerBegin = CLASS_RE.exec(body);
      if (innerBegin || /^Begin Object\b/.test(body)) {
        // First nested class is the material node's real expression type.
        if (innerBegin && !innerClassLeaf && classLeaf === "MaterialGraphNode") {
          innerClassLeaf = innerBegin[1].split(/[./]/).pop() ?? "";
        }
        depth++;
        rawLines.push(rawLine);
        if (depth > 1) {
          innerLines.push(body);
        }
        i++;
        continue;
      }
      rawLines.push(rawLine);
      if (depth === 1) {
        if (body.startsWith("CustomProperties Pin")) {
          const pin = parsePin(body);
          if (pin) {
            pins.push(pin);
          }
        } else {
          headerLines.push(body);
        }
      } else {
        innerLines.push(body);
      }
      i++;
    }

    // The effective type: for a material node, the wrapped expression class.
    const effLeaf = innerClassLeaf || classLeaf;
    if (effLeaf.startsWith("K2Node")) {
      kindVote.blueprint++;
    } else if (
      classLeaf.startsWith("MaterialGraphNode") ||
      effLeaf.startsWith("MaterialExpression")
    ) {
      kindVote.material++;
    }

    // Positions: outer NodePosX/Y when present, else the inner expression's
    // MaterialExpressionEditorX/Y (material nodes store the position there).
    const header = headerLines.join("\n");
    const inner = innerLines.join("\n");
    const num = (v: string | null) => {
      if (v === null || v.trim() === "") {
        return null; // Number("") and Number(null) are both 0 — reject explicitly.
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const posX =
      num(fieldValue(header, "NodePosX")) ?? num(fieldValue(inner, "MaterialExpressionEditorX")) ?? 0;
    const posY =
      num(fieldValue(header, "NodePosY")) ?? num(fieldValue(inner, "MaterialExpressionEditorY")) ?? 0;

    nodes.push({
      name,
      className: classPath,
      classLeaf: effLeaf,
      posX,
      posY,
      title: nodeTitle(effLeaf, headerLines, innerLines),
      role: nodeRole(effLeaf, headerLines),
      inputs: pins.filter((p) => p.direction === "input" && !p.hidden),
      outputs: pins.filter((p) => p.direction === "output" && !p.hidden),
      raw: rawLines.join("\n"),
    });
  }

  // Resolve wires. A link names its target node + pin, so index by that pair —
  // pin ids repeat across nodes. Each link is emitted once, oriented output→input.
  const pinIndex = new Map<string, { node: string; pin: UePin }>();
  const pinKey = (node: string, pinId: string) => `${node} ${pinId}`;
  for (const node of nodes) {
    for (const pin of [...node.inputs, ...node.outputs]) {
      pinIndex.set(pinKey(node.name, pin.id), { node: node.name, pin });
    }
  }

  const wires: UeWire[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    for (const pin of [...node.inputs, ...node.outputs]) {
      for (const link of pin.links) {
        const target = pinIndex.get(pinKey(link.node, link.pin));
        if (!target) {
          continue; // link into a node/pin that wasn't part of the paste (or hidden)
        }
        // Orient the wire output→input regardless of which end we found first.
        const out = pin.direction === "output" ? { node: node.name, pin } : { node: target.node, pin: target.pin };
        const inp = pin.direction === "output" ? { node: target.node, pin: target.pin } : { node: node.name, pin };
        const key = `${pinKey(out.node, out.pin.id)}->${pinKey(inp.node, inp.pin.id)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        wires.push({
          fromNode: out.node,
          fromPin: out.pin.id,
          toNode: inp.node,
          toPin: inp.pin.id,
          category: out.pin.category,
          subType: out.pin.subType,
        });
      }
    }
  }

  const kind = kindVote.blueprint >= kindVote.material ? (kindVote.blueprint > 0 ? "blueprint" : "unknown") : "material";
  return { nodes, wires, kind };
}
