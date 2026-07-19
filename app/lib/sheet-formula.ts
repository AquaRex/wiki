/*
 * A small spreadsheet formula engine for the :::cells grid. A cell whose value
 * starts with "=" is a formula; everything else is a literal. Supports cell
 * refs (A1), ranges (A1:B3), the operators + - * / ^ & and comparisons, and a
 * set of common functions (SUM, AVERAGE, IF, ROUND, …).
 *
 * makeFormulaEngine takes a getRaw(col,row) that returns a cell's stored text
 * and returns { get(col,row) } giving the computed display string. It caches
 * per instance and detects circular references, so build a fresh engine each
 * render pass over the current cells.
 */

type FVal = number | string;

class FErr {
  constructor(public msg: string) {}
}

/* ---- AST ---- */

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; c: number; r: number }
  | { t: "range"; c1: number; r1: number; c2: number; r2: number }
  | { t: "un"; op: string; e: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "call"; name: string; args: Node[] };

/* ---- tokenizer ---- */

interface Token {
  k: "num" | "str" | "ref" | "ident" | "op";
  v: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const ops = ["<=", ">=", "<>", "(", ")", ",", ":", "+", "-", "*", "/", "^", "&", "%", "<", ">", "="];
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === '"') {
      let s = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      tokens.push({ k: "str", v: s });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let n = "";
      while (i < src.length && /[0-9.]/.test(src[i])) {
        n += src[i++];
      }
      tokens.push({ k: "num", v: n });
      continue;
    }
    // A cell ref is letters immediately followed by digits (A1, BC12).
    const ref = /^([A-Za-z]+)([0-9]+)/.exec(src.slice(i));
    if (ref) {
      tokens.push({ k: "ref", v: ref[0].toUpperCase() });
      i += ref[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let id = "";
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) {
        id += src[i++];
      }
      tokens.push({ k: "ident", v: id });
      continue;
    }
    const op = ops.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ k: "op", v: op });
      i += op.length;
      continue;
    }
    throw new FErr("#ERROR!");
  }
  return tokens;
}

function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function refToCoord(ref: string): { c: number; r: number } {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref)!;
  return { c: colToIndex(m[1]), r: parseInt(m[2], 10) - 1 };
}

/* ---- parser (recursive descent) ---- */

function parse(src: string): Node {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const eat = (v?: string) => {
    const t = tokens[p];
    if (!t || (v !== undefined && t.v !== v)) {
      throw new FErr("#ERROR!");
    }
    p++;
    return t;
  };

  const parseComparison = (): Node => {
    let left = parseAdditive();
    const t = peek();
    if (t && t.k === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(t.v)) {
      eat();
      const right = parseAdditive();
      left = { t: "bin", op: t.v, a: left, b: right };
    }
    return left;
  };

  const parseAdditive = (): Node => {
    let left = parseMul();
    while (peek() && peek().k === "op" && ["+", "-", "&"].includes(peek().v)) {
      const op = eat().v;
      left = { t: "bin", op, a: left, b: parseMul() };
    }
    return left;
  };

  const parseMul = (): Node => {
    let left = parsePow();
    while (peek() && peek().k === "op" && ["*", "/"].includes(peek().v)) {
      const op = eat().v;
      left = { t: "bin", op, a: left, b: parsePow() };
    }
    return left;
  };

  const parsePow = (): Node => {
    let left = parseUnary();
    while (peek() && peek().k === "op" && peek().v === "^") {
      eat();
      left = { t: "bin", op: "^", a: left, b: parseUnary() };
    }
    return left;
  };

  const parseUnary = (): Node => {
    const t = peek();
    if (t && t.k === "op" && (t.v === "-" || t.v === "+")) {
      eat();
      return { t: "un", op: t.v, e: parseUnary() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): Node => {
    const t = peek();
    if (!t) {
      throw new FErr("#ERROR!");
    }
    if (t.k === "num") {
      eat();
      return { t: "num", v: parseFloat(t.v) };
    }
    if (t.k === "str") {
      eat();
      return { t: "str", v: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      eat("(");
      const e = parseComparison();
      eat(")");
      return e;
    }
    if (t.k === "ref") {
      eat();
      const from = refToCoord(t.v);
      if (peek() && peek().k === "op" && peek().v === ":") {
        eat(":");
        const to = refToCoord(eat().v);
        return {
          t: "range",
          c1: Math.min(from.c, to.c),
          r1: Math.min(from.r, to.r),
          c2: Math.max(from.c, to.c),
          r2: Math.max(from.r, to.r),
        };
      }
      return { t: "ref", c: from.c, r: from.r };
    }
    if (t.k === "ident") {
      eat();
      // TRUE / FALSE literals; otherwise a function call.
      if (t.v.toUpperCase() === "TRUE") {
        return { t: "num", v: 1 };
      }
      if (t.v.toUpperCase() === "FALSE") {
        return { t: "num", v: 0 };
      }
      eat("(");
      const args: Node[] = [];
      if (!(peek() && peek().k === "op" && peek().v === ")")) {
        args.push(parseComparison());
        while (peek() && peek().k === "op" && peek().v === ",") {
          eat(",");
          args.push(parseComparison());
        }
      }
      eat(")");
      return { t: "call", name: t.v.toUpperCase(), args };
    }
    throw new FErr("#ERROR!");
  };

  const node = parseComparison();
  if (p !== tokens.length) {
    throw new FErr("#ERROR!");
  }
  return node;
}

/* ---- evaluation ---- */

interface Ctx {
  get: (c: number, r: number) => FVal;
}

function formatNum(n: number): string {
  if (!isFinite(n)) {
    throw new FErr("#NUM!");
  }
  return String(Math.round(n * 1e10) / 1e10);
}

function valToStr(v: FVal): string {
  return typeof v === "number" ? formatNum(v) : v;
}

function toNum(v: FVal): number {
  if (typeof v === "number") {
    return v;
  }
  const t = v.trim();
  if (t === "") {
    return 0;
  }
  const n = Number(t);
  if (isNaN(n)) {
    throw new FErr("#VALUE!");
  }
  return n;
}

/** True when a computed value is a usable number (or numeric text). */
function asNumberOrNull(v: FVal): number | null {
  if (typeof v === "number") {
    return v;
  }
  const t = v.trim();
  if (t === "" || isNaN(Number(t))) {
    return null;
  }
  return Number(t);
}

function evalVal(node: Node, ctx: Ctx): FVal {
  switch (node.t) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "ref":
      return ctx.get(node.c, node.r);
    case "range":
      throw new FErr("#VALUE!"); // a range is only valid as a function argument
    case "un":
      return node.op === "-" ? -toNum(evalVal(node.e, ctx)) : toNum(evalVal(node.e, ctx));
    case "bin":
      return evalBin(node.op, node.a, node.b, ctx);
    case "call":
      return evalCall(node.name, node.args, ctx);
  }
}

function evalBin(op: string, aNode: Node, bNode: Node, ctx: Ctx): FVal {
  if (op === "&") {
    return valToStr(evalVal(aNode, ctx)) + valToStr(evalVal(bNode, ctx));
  }
  const a = evalVal(aNode, ctx);
  const b = evalVal(bNode, ctx);
  if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
    // Numeric compare when both look numeric, else string compare.
    const an = asNumberOrNull(a);
    const bn = asNumberOrNull(b);
    let cmp: number;
    if (an !== null && bn !== null) {
      cmp = an - bn;
    } else {
      cmp = valToStr(a).localeCompare(valToStr(b));
    }
    const res =
      op === "=" ? cmp === 0 : op === "<>" ? cmp !== 0 : op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
    return res ? 1 : 0;
  }
  const x = toNum(a);
  const y = toNum(b);
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      if (y === 0) {
        throw new FErr("#DIV/0!");
      }
      return x / y;
    case "^":
      return Math.pow(x, y);
  }
  throw new FErr("#ERROR!");
}

/** Numbers gathered from an argument: ranges/refs skip blanks and text. */
function collectNums(node: Node, ctx: Ctx): number[] {
  if (node.t === "range") {
    const out: number[] = [];
    for (let c = node.c1; c <= node.c2; c++) {
      for (let r = node.r1; r <= node.r2; r++) {
        const n = asNumberOrNull(ctx.get(c, r));
        if (n !== null) {
          out.push(n);
        }
      }
    }
    return out;
  }
  if (node.t === "ref") {
    const n = asNumberOrNull(ctx.get(node.c, node.r));
    return n !== null ? [n] : [];
  }
  return [toNum(evalVal(node, ctx))];
}

/** Non-empty values from an argument (numbers and text), for COUNTA / CONCAT. */
function collectVals(node: Node, ctx: Ctx): FVal[] {
  if (node.t === "range") {
    const out: FVal[] = [];
    for (let c = node.c1; c <= node.c2; c++) {
      for (let r = node.r1; r <= node.r2; r++) {
        const v = ctx.get(c, r);
        if (!(typeof v === "string" && v.trim() === "")) {
          out.push(v);
        }
      }
    }
    return out;
  }
  if (node.t === "ref") {
    const v = ctx.get(node.c, node.r);
    return typeof v === "string" && v.trim() === "" ? [] : [v];
  }
  return [evalVal(node, ctx)];
}

function evalCall(name: string, args: Node[], ctx: Ctx): FVal {
  const nums = () => args.flatMap((a) => collectNums(a, ctx));
  const sum = (xs: number[]) => xs.reduce((p, x) => p + x, 0);
  const n0 = () => toNum(evalVal(args[0], ctx));
  const n1 = () => toNum(evalVal(args[1], ctx));

  switch (name) {
    case "SUM":
      return sum(nums());
    case "AVERAGE":
    case "AVG": {
      const xs = nums();
      if (!xs.length) {
        throw new FErr("#DIV/0!");
      }
      return sum(xs) / xs.length;
    }
    case "COUNT":
      return nums().length;
    case "COUNTA":
      return args.flatMap((a) => collectVals(a, ctx)).length;
    case "MIN": {
      const xs = nums();
      return xs.length ? Math.min(...xs) : 0;
    }
    case "MAX": {
      const xs = nums();
      return xs.length ? Math.max(...xs) : 0;
    }
    case "PRODUCT":
      return nums().reduce((p, x) => p * x, 1);
    case "MEDIAN": {
      const xs = nums().sort((a, b) => a - b);
      if (!xs.length) {
        throw new FErr("#NUM!");
      }
      const mid = Math.floor(xs.length / 2);
      return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    }
    case "ROUND": {
      const f = Math.pow(10, args[1] ? n1() : 0);
      return Math.round(n0() * f) / f;
    }
    case "ROUNDUP": {
      const f = Math.pow(10, args[1] ? n1() : 0);
      return Math.ceil(Math.abs(n0()) * f) / f * Math.sign(n0());
    }
    case "ROUNDDOWN": {
      const f = Math.pow(10, args[1] ? n1() : 0);
      return (Math.floor(Math.abs(n0()) * f) / f) * Math.sign(n0());
    }
    case "ABS":
      return Math.abs(n0());
    case "INT":
      return Math.floor(n0());
    case "SQRT":
      return Math.sqrt(n0());
    case "POWER":
      return Math.pow(n0(), n1());
    case "MOD": {
      const b = n1();
      if (b === 0) {
        throw new FErr("#DIV/0!");
      }
      return n0() - b * Math.floor(n0() / b);
    }
    case "IF": {
      const cond = toNum(evalVal(args[0], ctx));
      return cond !== 0 ? evalVal(args[1], ctx) : args[2] ? evalVal(args[2], ctx) : 0;
    }
    case "AND":
      return args.flatMap((a) => collectNums(a, ctx)).every((x) => x !== 0) ? 1 : 0;
    case "OR":
      return args.flatMap((a) => collectNums(a, ctx)).some((x) => x !== 0) ? 1 : 0;
    case "NOT":
      return toNum(evalVal(args[0], ctx)) === 0 ? 1 : 0;
    case "CONCAT":
    case "CONCATENATE":
      return args.flatMap((a) => collectVals(a, ctx)).map(valToStr).join("");
    case "ROUNDTO":
      return Math.round(n0());
  }
  throw new FErr("#NAME?");
}

export interface FormulaEngine {
  /** Computed display string for a cell (raw text for non-formula cells). */
  get(c: number, r: number): string;
}

export function makeFormulaEngine(getRaw: (c: number, r: number) => string): FormulaEngine {
  const cache = new Map<string, FVal>();
  const stack = new Set<string>();

  const ctx: Ctx = { get: (c, r) => computed(c, r) };

  function computed(c: number, r: number): FVal {
    const key = `${c},${r}`;
    if (cache.has(key)) {
      return cache.get(key)!;
    }
    const raw = getRaw(c, r) ?? "";
    if (!raw.startsWith("=")) {
      cache.set(key, raw);
      return raw;
    }
    if (stack.has(key)) {
      throw new FErr("#CIRC!");
    }
    stack.add(key);
    try {
      const v = evalVal(parse(raw.slice(1)), ctx);
      cache.set(key, v);
      return v;
    } finally {
      stack.delete(key);
    }
  }

  return {
    get(c, r) {
      const raw = getRaw(c, r) ?? "";
      if (!raw.startsWith("=")) {
        return raw;
      }
      try {
        const v = computed(c, r);
        return typeof v === "number" ? formatNum(v) : v;
      } catch (e) {
        return e instanceof FErr ? e.msg : "#ERROR!";
      }
    },
  };
}
