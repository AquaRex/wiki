import React, { useEffect, useState } from "react";
import { Link } from "react-router";
import { UnrealGraph } from "~/components/wiki/unreal-graph";
import { openLightbox } from "~/components/wiki/lightbox";

export interface RenderVariable {
  name: string;
  value: string;
  description: string;
  page: string;
  blockId: string;
}

export interface RenderTerm {
  name: string;
  explanation: string;
  page: string;
  blockId: string;
}

export interface RenderContext {
  variables: Record<string, RenderVariable>;
  /** Named term definitions ({{TypeDef}}), used to resolve {{TypeRef}} links. */
  terms?: Record<string, RenderTerm>;
  /** All pages (across projects) — used for link resolution. */
  pages: { path: string; title: string }[];
  currentPath: string;
  /** Current project slug; wiki links resolve inside it first. */
  project?: string;
  /** Async because a private image's URL must be signed on demand. */
  resolveAsset?: (src: string) => Promise<string>;
  /**
   * Every heading on the page, in order — supplied by the page renderer so a
   * :::contents box can list them. Undefined when rendering out of page context
   * (e.g. a hover card), in which case :::contents has nothing to show.
   */
  headings?: PageHeading[];
}

export interface PageHeading {
  /** 2 for ## / # , 3 for ### , 4 for #### . */
  level: number;
  /** The heading text with its markup stripped for the anchor label. */
  text: string;
  /** slugify(text) — matches the id the Heading component renders. */
  slug: string;
  /** The auto-number shown before a ## section; undefined for other levels. */
  num?: number;
}

/**
 * Resolved image URLs, kept across renders and across component instances.
 * A remounted <Asset> reads its URL from here synchronously, so an image that
 * has already been resolved once never flashes empty again.
 */
const assetUrls = new Map<string, string>();

/**
 * Renders an image whose URL has to be resolved asynchronously. Markdown
 * rendering is synchronous, so the resolution happens here rather than being
 * awaited up front.
 *
 * The effect deliberately depends on `src` alone: `ctx` is rebuilt on every
 * render by its caller, so depending on it would re-run this constantly.
 */
function Asset({
  ctx,
  src,
  alt,
  className,
  size,
}: {
  ctx: RenderContext;
  src: string;
  alt: string;
  className?: string;
  /** Optional display size in px, from a {w=…, h=…} suffix. */
  size?: ImageSize;
}) {
  const resolver = ctx.resolveAsset;
  const [resolved, setResolved] = useState<string | null>(() => assetUrls.get(src) ?? null);
  // "pending" while resolving, "failed" once the URL can't resolve or the image
  // itself won't load — at which point a labelled placeholder box stands in.
  const [status, setStatus] = useState<"pending" | "ok" | "failed">(() =>
    assetUrls.get(src) ? "ok" : "pending"
  );

  useEffect(() => {
    const cached = assetUrls.get(src);
    if (cached) {
      setResolved(cached);
      setStatus("ok");
      return;
    }
    setStatus("pending");
    if (!resolver) {
      setResolved(src);
      setStatus("ok");
      return;
    }
    let cancelled = false;
    resolver(src)
      .then((url) => {
        assetUrls.set(src, url);
        if (!cancelled) {
          setResolved(url);
          setStatus("ok");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved(null);
          setStatus("failed");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // A missing image renders a placeholder box rather than a broken icon, so both
  // documentation examples and pages with a deleted upload show something clear.
  if (status === "failed" || (status === "ok" && !resolved)) {
    return (
      <span className={`wk-img-placeholder ${className ?? ""}`.trim()} role="img" aria-label={alt || "image"}>
        <span className="wk-img-placeholder-icon" aria-hidden>
          ▨
        </span>
        <span className="wk-img-placeholder-label">{alt || src}</span>
      </span>
    );
  }

  if (!resolved) {
    // Reserve space so the layout doesn't collapse while the URL resolves.
    return <span className={className} style={{ display: "block", minHeight: 24 }} aria-hidden />;
  }
  // A pinned width/height sets that dimension; the other stays `auto` so the
  // aspect ratio is kept when only one is given. maxWidth keeps it responsive.
  const style: React.CSSProperties = { cursor: "zoom-in" };
  if (size?.width === "max") {
    style.width = "100%";
  } else if (size?.width != null) {
    style.width = size.width;
    style.maxWidth = "100%";
  }
  if (size?.height != null) {
    style.height = size.height;
  }
  return (
    <img
      className={`${className ?? ""} wk-img-zoomable`.trim()}
      src={resolved}
      alt={alt}
      style={style}
      onError={() => setStatus("failed")}
      onClick={() => openLightbox(resolved, alt)}
    />
  );
}

/**
 * Keys for rendered nodes.
 *
 * Inline nodes are keyed positionally, which is fine: they are short-lived
 * spans with no state or network cost, and they always re-render with their
 * parent block anyway.
 *
 * Block-level nodes are keyed by content instead — see blockKey. A positional
 * key would shift every following element when a line is added, remounting
 * everything after the caret: images would refetch and flash, the page height
 * would lurch, and the view would jump while typing.
 */
let keyCounter = 0;
function k(): number {
  return keyCounter++;
}

/**
 * A stable key for a block-level node, derived from what it renders rather than
 * where it sits. Identical content on the next render keeps the same DOM.
 * The suffix disambiguates the rare case of two identical blocks in one parent.
 */
function blockKey(seen: Map<string, number>, kind: string, content: string): string {
  const base = `${kind}:${content}`;
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}#${count}`;
}

/*
 * Syntax highlighting.
 *
 * One shared keyword set across languages rather than per-language grammars:
 * the goal is to make structure scannable, not to be a compiler. A word that is
 * a keyword in C# but an identifier in Python simply tints in both — harmless,
 * and far cheaper than shipping real grammars to a static site.
 */
const CODE_KEYWORDS = new Set(
  (
    "abstract as async await base bool break byte case catch char checked class const continue decimal default " +
    "delegate do double else enum event explicit extern false finally fixed float for foreach from get global goto " +
    "if implicit in int interface internal is lock long namespace new null object operator out override params " +
    "private protected public readonly ref return sbyte sealed set short sizeof stackalloc static string struct " +
    "switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield " +
    "function let const export import default extends implements instanceof typeof undefined " +
    "def elif except lambda None pass raise self True False and or not with"
  ).split(" ")
);

/**
 * A raw, verbatim text block — like a code block but with no markdown parsing,
 * no syntax highlighting, and a "Copy all" button. Delimited by a `~~~` fence so
 * the content may freely contain backticks (```), colons, or other markup that
 * would otherwise break a normal code fence.
 */
function RawBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked — ignore */
      });
  };
  return (
    <div className="code raw">
      <div className="file">
        <span>{label || "TEXT"}</span>
        <button type="button" className="raw-copy" onClick={copy}>
          {copied ? "Copied" : "Copy all"}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

/** Splits a line into keyword / comment / plain runs. */
function highlightCode(text: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (lineIndex > 0) {
      out.push("\n");
    }
    // A comment swallows the rest of the line, so find it first.
    const comment = /(^|[^:])(\/\/|#(?!\w)).*$/.exec(line);
    const codePart = comment ? line.slice(0, comment.index + comment[1].length) : line;
    const commentPart = comment ? line.slice(comment.index + comment[1].length) : "";

    for (const token of codePart.split(/(\b[A-Za-z_]\w*\b)/)) {
      if (CODE_KEYWORDS.has(token)) {
        out.push(
          <span key={k()} className="k">
            {token}
          </span>
        );
      } else if (token) {
        out.push(token);
      }
    }
    if (commentPart) {
      out.push(
        <span key={k()} className="cm">
          {commentPart}
        </span>
      );
    }
  }
  return out;
}

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "bottom";

export interface ImageAlign {
  h: HAlign;
  v: VAlign;
  /** Whether any alignment marker was written at all. */
  set: boolean;
}

/**
 * Alignment rides on the end of the image URL, inside the ordinary image syntax,
 * so every existing image keeps working. A trailing token combines a horizontal
 * and a vertical pin, in either order:
 *
 *   horizontal — "<" left (default), "c" centre, ">" right
 *   vertical   — "^" top (default), "v" bottom
 *
 *   ![cap](/x.png)      left, top   (the default)
 *   ![cap](/x.png >)    right, top
 *   ![cap](/x.png c)    centre, top
 *   ![cap](/x.png >v)   right, bottom
 *   ![cap](/x.png cv)   centre, bottom
 *   ![cap](/x.png v>)   same as >v — order doesn't matter
 */
function splitImageAlign(src: string): { src: string; align: ImageAlign } {
  const match = /^(.*?)\s*([<>cv^]{1,2})\s*$/i.exec(src);
  if (!match) {
    return { src: src.trim(), align: { h: "left", v: "top", set: false } };
  }
  const marker = match[2].toLowerCase();
  let h: HAlign = "left";
  let v: VAlign = "top";
  if (marker.includes(">")) {
    h = "right";
  } else if (marker.includes("c")) {
    h = "center";
  } else if (marker.includes("<")) {
    h = "left";
  }
  if (marker.includes("v")) {
    v = "bottom";
  }
  return { src: match[1].trim(), align: { h, v, set: true } };
}

/** CSS classes for an image's horizontal + vertical pin. */
function alignClasses(align: ImageAlign): string {
  return `h-${align.h} v-${align.v}`;
}

export interface ImageSize {
  /** A pixel width, or "max" to fill the available width. Height has no "max". */
  width: number | "max" | null;
  height: number | null;
}

const EMPTY_SIZE: ImageSize = { width: null, height: null };

/**
 * Reads an optional size suffix written after the image, e.g.
 *   ![cap](/x.png){w=300}          — width only (height keeps the aspect ratio)
 *   ![cap](/x.png){h=200}          — height only (width keeps the aspect ratio)
 *   ![cap](/x.png){w=300, h=200}   — both, exact box (order doesn't matter)
 *   ![cap](/x.png){w=max}          — fill the available width (no height "max")
 * Accepts `w`/`width` and `h`/`height`, pixels. Since we click to view an image
 * full size, a smaller inline size is fine.
 */
function parseImageSize(suffix: string | undefined): ImageSize {
  if (!suffix) {
    return EMPTY_SIZE;
  }
  const w = /\b(?:w|width)\s*=\s*(max|\d{1,4})\s*(?:px)?/i.exec(suffix);
  const h = /\b(?:h|height)\s*=\s*(\d{1,4})\s*(?:px)?/i.exec(suffix);
  const width = w ? (/^max$/i.test(w[1]) ? "max" : Number(w[1])) : null;
  return { width, height: h ? Number(h[1]) : null };
}

/** The `maxWidth` a figure wrapper should carry for a given image width. */
function figureMaxWidth(width: ImageSize["width"]): string | number | undefined {
  if (width === "max") {
    return "100%";
  }
  return width ?? undefined;
}

/** Splits an image token into its `![…](…)` part and any trailing `{…}` suffix. */
function splitImageSuffix(token: string): { image: string; suffix: string | undefined } {
  const m = /^(!\[[^\]]*\]\([^)]+\))(\{[^}]*\})?$/.exec(token);
  if (!m) {
    return { image: token, suffix: undefined };
  }
  return { image: m[1], suffix: m[2] };
}

interface RowImage {
  src: string;
  caption: string;
  align: ImageAlign;
  size: ImageSize;
}

/**
 * If a whole line is nothing but images (`![cap](src){w=…}`), separated only by
 * whitespace, returns them parsed; otherwise null. Lets several sized images
 * share one line as a gallery row, and also handles the ordinary single image.
 */
const ROW_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)(\{[^}]*\})?/g;

function parseImageRow(line: string): RowImage[] | null {
  if (!line.startsWith("![")) {
    return null;
  }
  const images: RowImage[] = [];
  ROW_IMAGE_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = ROW_IMAGE_RE.exec(line)) !== null) {
    // Anything but whitespace between/around the images means it's prose, not a row.
    if (line.slice(last, m.index).trim() !== "") {
      return null;
    }
    const { src, align } = splitImageAlign(m[2]);
    images.push({ src, caption: m[1], align, size: parseImageSize(m[3]) });
    last = m.index + m[0].length;
  }
  if (line.slice(last).trim() !== "") {
    return null;
  }
  return images.length > 0 ? images : null;
}

/**
 * Strips inline markers so a formatted caption can still be used as alt text,
 * which must be a plain string.
 */
function plainCaption(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function countH2(text: string): number {
  let count = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
    } else if (!inFence && line.startsWith("## ")) {
      count++;
    }
  }
  return count;
}

// Wiki-link resolution, in order:
//  1. project-relative path  — [[Systems/Player-Vitals]] inside a project
//  2. absolute path          — [[OtherProject/Systems/Player-Vitals]]
//  3. bare page name         — [[Player-Vitals]], matched against page names in
//     this project. Name links carry no folder, so they survive a page being
//     moved between folders; they only resolve when the name is unambiguous.
function findPage(ctx: RenderContext, target: string) {
  const wanted = target.toLowerCase().replace(/^\/+|\/+$/g, "");
  if (ctx.project) {
    const scoped = `${ctx.project.toLowerCase()}/${wanted}`;
    const hit = ctx.pages.find((p) => p.path.toLowerCase() === scoped);
    if (hit) {
      return hit;
    }
  }
  const absolute = ctx.pages.find((p) => p.path.toLowerCase() === wanted);
  if (absolute) {
    return absolute;
  }
  if (!wanted.includes("/") && ctx.project) {
    const named = ctx.pages.filter(
      (p) =>
        p.path.toLowerCase().startsWith(ctx.project!.toLowerCase() + "/") &&
        p.path.split("/").pop()!.toLowerCase() === wanted
    );
    if (named.length === 1) {
      return named[0];
    }
  }
  return undefined;
}

/* ---------------------------------------------------------------- */
/* Inline rendering                                                   */
/* ---------------------------------------------------------------- */

const INLINE_SRC = [
    "(`[^`]+`)", // 1 code
    "(\\{\\{def:[^}]+\\}\\})", // 2 variable definition
    "(\\{\\{-?\\d[^|}]*(?:\\|[^}]*)?\\}\\})", // 3 magic value (starts with a digit — names can't)
    "(\\{\\{TermDef\\([^)]*\\)\\}\\})", // 4 term definition
    "(\\{\\{TermNote\\([^)]*\\)\\}\\})", // 5 term note (with hover explanation)
    "(\\{\\{TermRef\\([^)]*\\)\\}\\})", // 6 term reference
    "(\\{\\{[A-Za-z0-9_.-]+(?:\\|[^}]*)?\\}\\})", // 7 variable reference
    "(\\[\\[[^\\]]+\\]\\])", // 8 wiki link
    "(!\\[[^\\]]*\\]\\([^)]+\\)(?:\\{[^}]*\\})?)", // 9 image (optional {w=…} size)
    "(\\[[^\\]]+\\]\\([^)]+\\))", // 10 external link
    "(\\*\\*.+?\\*\\*)", // 11 bold
    "(\\*[^*\\n]+\\*)", // 12 italic
    "(==[^=]+==)", // 13 accent term
    "(:(?:error|warn|good|tips|muted|white)\\[[^\\]]*\\])", // 14 coloured span :tone[text]
    "((?<!:):(?:error|warn|good|tips|muted)\\b[^\\n]*)", // 15 coloured inline run (to line end)
].join("|");

/** ":error text" — colour only, to end of line. */
const INLINE_TONE_RE = /^:(error|warn|good|tips|muted)\b[ \t]*([\s\S]*)$/;

/** "::error text" — a coloured rule in front of the text, no box. */
const LINE_TONE_RE = /^::(error|warn|good|tips|muted)\b[ \t]*([\s\S]*)$/;

// Mirrors DEF_RE in shared.ts — name, value, description, then the optional
// "private" flag that keeps the definition out of the All variables index.
const DEF_INNER_RE = /^\{\{def:([A-Za-z0-9_.-]+)\s*=\s*([^|}]*?)\s*(?:\|\s*([^|}]*?)\s*)?(?:\|\s*([^}]*?)\s*)?\}\}$/;

/* ---------------------------------------------------------------- */
/* Chip — the shared primitive for variable & term defs/refs/notes.   */
/*                                                                    */
/* Every one is a boxed label, optionally a link to its definition,   */
/* optionally with a formatted hover card. Both the label and the     */
/* card description accept full inline markup, so "value in white",   */
/* coloured runs, code, etc. all just work. The specific tokens below */
/* are thin wrappers that decide the label, link target and variant.  */
/* ---------------------------------------------------------------- */

function Chip({
  ctx,
  variant,
  label,
  description,
  id,
  to,
  preventScrollReset,
}: {
  ctx: RenderContext;
  /** Style variant class, e.g. "vardef", "termref". */
  variant: string;
  /** The chip's visible label — already-rendered inline nodes. */
  label: React.ReactNode;
  /** Markdown for the hover card; empty means no card. */
  description?: string;
  id?: string;
  /** When set, the chip is a link to this path. */
  to?: string;
  preventScrollReset?: boolean;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const hoverProps = description
    ? {
        onMouseEnter: (e: React.MouseEvent) => setPos({ x: e.clientX, y: e.clientY }),
        onMouseMove: (e: React.MouseEvent) => setPos({ x: e.clientX, y: e.clientY }),
        onMouseLeave: () => setPos(null),
      }
    : {};
  const card = description && pos && (
    <span className="hovercard" style={{ left: pos.x + 12, top: pos.y + 16 }} role="tooltip">
      {/* noLinkify: a card shouldn't turn every bare word into a variable chip. */}
      <span className="wiki">{renderInline(description, ctx, { noLinkify: true })}</span>
    </span>
  );
  const cls = `chip ${variant}`;
  if (to) {
    return (
      <Link className={cls} id={id} to={to} preventScrollReset={preventScrollReset} {...hoverProps}>
        {label}
        {card}
      </Link>
    );
  }
  return (
    <span className={cls} id={id} {...hoverProps}>
      {label}
      {card}
    </span>
  );
}

/** Variable references become a link chip showing just the name. */
function variableLink(ctx: RenderContext, name: string, label: React.ReactNode): React.ReactNode {
  const def = ctx.variables[name];
  if (!def) {
    return null;
  }
  // The card shows the value and (formatted) description; the value renders white.
  const description = `**${def.name}** = :white[${def.value}]${def.description ? ` — ${def.description}` : ""}`;
  const samePage = def.page.toLowerCase() === ctx.currentPath.toLowerCase();
  return (
    <Chip
      key={k()}
      ctx={ctx}
      variant="varref"
      label={label}
      description={description}
      to={`/${def.page}#var-${name}`}
      preventScrollReset={samePage}
    />
  );
}

/** Term id anchors are slugified so a TermRef can jump to them. */
function termId(name: string): string {
  return `term-${slugify(name)}`;
}

/** Parses the inner of a {{TermDef|TermNote|TermRef(...)}} token. */
function parseTermToken(token: string): { name: string; explanation: string } {
  const inner = token.replace(/^\{\{Term(?:Def|Note|Ref)\(/, "").replace(/\)\}\}$/, "");
  const pipe = inner.indexOf("|");
  return {
    name: (pipe === -1 ? inner : inner.slice(0, pipe)).trim(),
    explanation: pipe === -1 ? "" : inner.slice(pipe + 1).trim(),
  };
}

// {{TermDef(Name)}} — a neutral boxed anchor. Notes are a separate token.
function renderTermDef(ctx: RenderContext, token: string): React.ReactNode {
  const { name } = parseTermToken(token);
  return <Chip key={k()} ctx={ctx} variant="termdef" label={renderInline(name, ctx)} id={termId(name)} />;
}

// {{TermNote(Name|explanation)}} — an anchor that shows its explanation on hover.
function renderTermNote(ctx: RenderContext, token: string): React.ReactNode {
  const { name, explanation } = parseTermToken(token);
  return (
    <Chip
      key={k()}
      ctx={ctx}
      variant="termnote"
      label={renderInline(name, ctx)}
      description={explanation}
      id={termId(name)}
    />
  );
}

// {{TermRef(Name)}} or {{TermRef(Name|own description)}} — a link chip to the def.
function renderTermRef(ctx: RenderContext, token: string): React.ReactNode {
  const { name, explanation } = parseTermToken(token);
  const def = ctx.terms?.[name];
  if (!def) {
    return (
      <span key={k()} className="chip termref missing" title={`Undefined term: ${name}`}>
        {name}
      </span>
    );
  }
  const samePage = def.page.toLowerCase() === ctx.currentPath.toLowerCase();
  return (
    <Chip
      key={k()}
      ctx={ctx}
      variant="termref"
      label={renderInline(name, ctx)}
      description={explanation || def.explanation}
      to={`/${def.page}#${termId(name)}`}
      preventScrollReset={samePage}
    />
  );
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary regex matching every defined variable name, cached per variables map.
const varNameRegexCache = new WeakMap<Record<string, RenderVariable>, RegExp | null>();

function variableNameRegex(ctx: RenderContext): RegExp | null {
  if (!varNameRegexCache.has(ctx.variables)) {
    const names = Object.keys(ctx.variables);
    varNameRegexCache.set(
      ctx.variables,
      names.length === 0
        ? null
        : new RegExp(
            `(?<![\\w.-])(${names
              .sort((a, b) => b.length - a.length)
              .map(escapeRe)
              .join("|")})(?![\\w-])(?!\\.[\\w-])`,
            "g"
          )
    );
  }
  return varNameRegexCache.get(ctx.variables) ?? null;
}

// Plain prose: bare words that exactly match a defined variable name become links to it.
function linkifyPlain(text: string, ctx: RenderContext, out: React.ReactNode[]) {
  const re = variableNameRegex(ctx);
  if (!re) {
    out.push(text);
    return;
  }
  re.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    out.push(variableLink(ctx, m[1], m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
}

// `code` spans: link to a variable definition or, failing that, a page whose
// title or final path segment matches. Plain code when nothing matches.
function renderCodeSpan(ctx: RenderContext, content: string): React.ReactNode {
  const viaVariable = variableLink(ctx, content, <code>{content}</code>);
  if (viaVariable) {
    return viaVariable;
  }
  const wanted = content.toLowerCase();
  const matches = (p: { path: string; title: string }) =>
    p.title.toLowerCase() === wanted || p.path.split("/").pop()!.toLowerCase() === wanted;
  const inProject = ctx.project ? ctx.pages.filter((p) => p.path.toLowerCase().startsWith(ctx.project!.toLowerCase() + "/")) : [];
  const page = inProject.find(matches) ?? ctx.pages.find(matches);
  if (page && page.path.toLowerCase() !== ctx.currentPath.toLowerCase()) {
    return (
      <Link key={k()} className="coderef" title={`/${page.path}`} to={`/${page.path}`}>
        <code>{content}</code>
      </Link>
    );
  }
  return <code key={k()}>{content}</code>;
}

export function renderInline(
  text: string,
  ctx: RenderContext,
  opts?: { noLinkify?: boolean }
): React.ReactNode[] {
  // A definition's own name must not auto-link to itself, so callers can turn
  // off bare-name variable linking while keeping all other inline formatting.
  const plain = (t: string, o: React.ReactNode[]) => {
    if (opts?.noLinkify) {
      o.push(t);
    } else {
      linkifyPlain(t, ctx, o);
    }
  };
  const out: React.ReactNode[] = [];
  let last = 0;
  const inlineRe = new RegExp(INLINE_SRC, "g");
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(text)) !== null) {
    if (m.index > last) {
      plain(text.slice(last, m.index), out);
    }
    const token = m[0];
    if (m[1]) {
      out.push(renderCodeSpan(ctx, token.slice(1, -1)));
    } else if (m[2]) {
      const dm = DEF_INNER_RE.exec(token);
      if (dm) {
        const [, name, value, desc, display] = dm;
        // A VarDef is a chip. If a custom display (4th field) is given it's used
        // verbatim (full formatting); otherwise the default shows the name and,
        // after "=", the value in white. The name is rendered without auto-link
        // so a def never turns its own name into a reference chip.
        const label = display ? (
          renderInline(display, ctx)
        ) : (
          <>
            {renderInline(name, ctx, { noLinkify: true })} = <span className="val">{renderInline(value, ctx)}</span>
          </>
        );
        out.push(
          <Chip key={k()} ctx={ctx} variant="vardef" label={label} description={desc || ""} id={`var-${name}`} />
        );
      } else {
        out.push(token);
      }
    } else if (m[3]) {
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf("|");
      const value = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const note = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
      out.push(
        <Chip key={k()} ctx={ctx} variant="magicval" label={renderInline(value, ctx)} description={note} />
      );
    } else if (m[4]) {
      // {{TermDef(Name)}} — a bare term anchor.
      out.push(renderTermDef(ctx, token));
    } else if (m[5]) {
      // {{TermNote(Name|explanation)}} — term with a hover explanation.
      out.push(renderTermNote(ctx, token));
    } else if (m[6]) {
      // {{TermRef(Name)}} — links to the term's definition.
      out.push(renderTermRef(ctx, token));
    } else if (m[7]) {
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf("|");
      const name = pipe === -1 ? inner : inner.slice(0, pipe);
      const label = pipe === -1 ? name : inner.slice(pipe + 1);
      const link = variableLink(ctx, name, label);
      if (link) {
        out.push(link);
      } else {
        // Unknown variable — a plain dashed-red chip, no link.
        out.push(
          <span key={k()} className="chip varref missing" title={`Undefined variable: ${name}`}>
            {label}
          </span>
        );
      }
    } else if (m[8]) {
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf("|");
      const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const page = findPage(ctx, target);
      const label = pipe === -1 ? (page ? page.title : target.split("/").pop()!) : inner.slice(pipe + 1).trim();
      out.push(
        <Link key={k()} className={page ? "wikilink" : "wikilink missing"} to={`/${page ? page.path : target.replace(/^\/+/, "")}`} title={page ? page.path : `Create page: ${target}`}>
          {label}
        </Link>
      );
    } else if (m[9]) {
      const { image, suffix } = splitImageSuffix(token);
      const im = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(image)!;
      const { src: imgSrc, align } = splitImageAlign(im[2]);
      const inlineClass = `wk-inline-img ${alignClasses(align)}`;
      out.push(
        <Asset key={k()} ctx={ctx} src={imgSrc} alt={im[1]} className={inlineClass} size={parseImageSize(suffix)} />
      );
    } else if (m[10]) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      if (lm[2].startsWith("#")) {
        // An in-page anchor: link by hash so the route's scroll effect runs.
        out.push(
          <Link key={k()} className="anchor" to={lm[2]} preventScrollReset>
            {renderInline(lm[1], ctx)}
          </Link>
        );
      } else {
        out.push(
          <a key={k()} className="ext" href={lm[2]} target="_blank" rel="noreferrer">
            {lm[1]}
          </a>
        );
      }
    } else if (m[11]) {
      out.push(<strong key={k()}>{renderInline(token.slice(2, -2), ctx)}</strong>);
    } else if (m[12]) {
      out.push(<em key={k()}>{renderInline(token.slice(1, -1), ctx)}</em>);
    } else if (m[13]) {
      out.push(
        <em key={k()} className="term">
          {renderInline(token.slice(2, -2), ctx)}
        </em>
      );
    } else if (m[14]) {
      // :tone[text] — colours just the bracketed text, formatting preserved.
      const tm = /^:(\w+)\[([\s\S]*)\]$/.exec(token)!;
      out.push(
        <span key={k()} className={`tone-${tm[1]}`}>
          {renderInline(tm[2], ctx)}
        </span>
      );
    } else if (m[15]) {
      // :tone … — colours the rest of the run.
      const tm = INLINE_TONE_RE.exec(token)!;
      out.push(
        <span key={k()} className={`tone-${tm[1]}`}>
          {renderInline(tm[2], ctx)}
        </span>
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) {
    plain(text.slice(last), out);
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Block rendering                                                    */
/* ---------------------------------------------------------------- */

interface DirectiveLines {
  type: string;
  param: string;
  lines: string[];
}

/**
 * Splits a trailing image off a heading line, so `## Title ![](/x.png)` can
 * render the image to the right of the title rather than inline in the text.
 */
function splitHeadingImage(text: string): {
  text: string;
  image: { src: string; alt: string } | null;
} {
  // A trailing {…} size is tolerated but ignored — heading images are height-
  // constrained icons.
  const match = /^(.*?)\s*!\[([^\]]*)\]\(([^)]+)\)(?:\{[^}]*\})?\s*$/.exec(text);
  if (!match) {
    return { text, image: null };
  }
  return { text: match[1].trim(), image: { alt: match[2], src: match[3] } };
}

/**
 * Scans page text for every heading, in order, mirroring how renderBlocks
 * detects and numbers them: ## sections carry a running auto-number, code and
 * raw fences are skipped so a `## ` inside them isn't picked up. The slug and
 * label match what the Heading component renders, so a :::contents link lands
 * on the right element. `h2Start` continues the numbering from earlier blocks.
 */
export function extractHeadings(text: string, h2Start = 0): PageHeading[] {
  const out: PageHeading[] = [];
  let h2 = h2Start;
  let fence: string | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fenceMatch = /^(```|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1].startsWith("`") ? "```" : "~~~";
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) {
      continue;
    }
    let level = 0;
    let rest = "";
    if (line.startsWith("#### ")) {
      level = 4;
      rest = line.slice(5);
    } else if (line.startsWith("### ")) {
      level = 3;
      rest = line.slice(4);
    } else if (line.startsWith("## ")) {
      level = 2;
      rest = line.slice(3);
    } else if (line.startsWith("# ")) {
      // An unnumbered top heading still renders as an h2, but carries no number.
      level = 2;
      rest = line.slice(2);
    }
    if (!level) {
      continue;
    }
    const label = splitHeadingImage(rest).text;
    const numbered = line.startsWith("## ");
    if (numbered) {
      h2++;
    }
    out.push({ level, text: label, slug: slugify(label), num: numbered ? h2 : undefined });
  }
  return out;
}

interface ContentsOptions {
  /** Include ### / #### subheadings, not just ## sections. */
  all: boolean;
  /** Lay the list out as one vertical column instead of flowing into columns. */
  vertical: boolean;
  /** Render as a compact card that floats beside the text, like an infobox. */
  mini: boolean;
  /** Pin for a mini box — set via `mini[<v]`; only meaningful when mini. */
  align: ImageAlign;
  /** A hand-picked list of heading names to show, in the given order. */
  only: string[] | null;
  /** The box heading text (everything left after the keywords/list are removed). */
  header: string;
}

/**
 * Parses the text after `:::contents`. In any order it accepts the keywords
 * `all`, `vertical` and `mini`, an optional `[Name, Name]` filter list, and free
 * header text — so `:::contents[Intro,Setup] vertical Overview` is understood as
 * a two-item vertical box titled "Overview". The `[…]` may abut the word, as in
 * `:::contents[a,b]`.
 *
 * A `mini` box may carry a pin in parentheses right after the word — `mini(>v)` —
 * using the same <>c^v tokens as images/infoboxes. Parens keep the pin distinct
 * from the `[Name, Name]` name filter, so the two never collide.
 */
function parseContentsParam(param: string): ContentsOptions {
  let rest = param;
  let align: ImageAlign = { h: "right", v: "top", set: false };

  // A pin attached to mini: `mini(>v)`. Pulled out first so nothing else sees it.
  const miniPin = /\bmini\s*\(([<>cv^\s]*)\)/i.exec(rest);
  if (miniPin) {
    const marker = miniPin[1].trim();
    if (marker) {
      align = splitImageAlign(`x ${marker}`).align;
    }
    rest = rest.slice(0, miniPin.index) + "mini" + rest.slice(miniPin.index + miniPin[0].length);
  }

  let only: string[] | null = null;
  const list = /\[([^\]]*)\]/.exec(rest);
  if (list) {
    only = list[1].split(",").map((s) => s.trim()).filter(Boolean);
    rest = rest.slice(0, list.index) + rest.slice(list.index + list[0].length);
  }

  const all = /\ball\b/i.test(rest);
  const vertical = /\bvertical\b/i.test(rest);
  const mini = /\bmini\b/i.test(rest);
  const header = rest
    .replace(/\ball\b/i, "")
    .replace(/\bvertical\b/i, "")
    .replace(/\bmini\b/i, "")
    .trim();
  return { all, vertical, mini, align, only, header };
}

function Heading({
  level,
  text,
  ctx,
  num,
}: {
  level: 2 | 3 | 4;
  text: string;
  ctx: RenderContext;
  num?: number;
}) {
  const { text: label, image } = splitHeadingImage(text);
  const Tag = (level === 4 ? "h4" : level === 3 ? "h3" : "h2") as React.ElementType;
  // A heading image pins to the far right by default (that's its purpose); an
  // explicit marker overrides both axes. Vertical maps to bottom/top alignment
  // against the heading text.
  const aligned = image ? splitImageAlign(image.src) : null;
  const headImgClass =
    aligned && aligned.align.set
      ? `wk-h-img ${alignClasses(aligned.align)}`
      : "wk-h-img h-right v-bottom";
  return (
    <Tag className={level === 2 ? "wk-h2" : "wk-h3"} id={slugify(label)}>
      {num !== undefined && <span className="num">{String(num).padStart(2, "0")}</span>}
      <span>{renderInline(label, ctx)}</span>
      {/* Heading images are height-constrained icons, so a {w=…} size is ignored. */}
      {image && aligned && <Asset ctx={ctx} src={aligned.src} alt={image.alt} className={headImgClass} />}
    </Tag>
  );
}

const CALLOUT_ICONS: Record<string, string> = {
  error: "✕",
  warn: "!",
  good: "✓",
  tips: "i",
};

function renderDirective(dir: DirectiveLines, ctx: RenderContext): React.ReactNode {
  const body = dir.lines;
  switch (dir.type) {
    case "callout":
    case "note": {
      const cls = dir.type === "callout" ? "callout core" : "note";
      return (
        <div key={k()} className={cls}>
          {dir.param && <p className="label">{renderInline(dir.param, ctx)}</p>}
          {renderMarkdown(body.join("\n"), ctx)}
        </div>
      );
    }
    /*
     * A bordered box with no coloured rule — for displayed material that isn't
     * code: quotes, ASCII diagrams, worked examples. Unlike a code block it
     * wraps rather than scrolling, and full formatting works inside.
     */
    case "quote": {
      return (
        <div key={k()} className="quote-box">
          {dir.param && <p className="label">{renderInline(dir.param, ctx)}</p>}
          {renderMarkdown(body.join("\n"), ctx)}
        </div>
      );
    }
    case "error":
    case "pitfall":
    case "warn":
    case "good":
    case "tips": {
      // "pitfall" is the old name for "error" — kept so existing pages render.
      const kind = dir.type === "pitfall" ? "error" : dir.type;
      // The body goes through the block renderer so dividers, captions,
      // headings and nested callouts work the same inside a box as outside.
      const text = [dir.param, ...body].filter(Boolean).join("\n");
      return (
        <div key={k()} className={`callout-box ${kind === "error" ? "" : kind}`.trim()}>
          <span className="icon">{CALLOUT_ICONS[kind]}</span>
          <div className="callout-body">{renderMarkdown(text, ctx)}</div>
        </div>
      );
    }
    case "blueprint":
    case "material": {
      // The body is raw Unreal T3D text, kept verbatim so it round-trips back
      // into the editor. UnrealGraph only reads it to draw.
      return <UnrealGraph key={k()} source={body.join("\n")} />;
    }
    case "infobox": {
      // The title may carry an image-style pin token — `:::infobox Name >v` —
      // to override the default (float right, top). It uses the same <>c^v
      // markers as images, so left/centre and bottom pinning are available.
      const { src: title, align } = splitImageAlign(dir.param);
      let image = "";
      const rows: { label: string; value: string }[] = [];
      const freeText: string[] = [];
      for (const line of body) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (/^image\s*:/i.test(trimmed)) {
          image = trimmed.replace(/^image\s*:\s*/i, "");
        } else {
          const colon = trimmed.indexOf(":");
          if (colon > 0 && colon < 40) {
            rows.push({ label: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() });
          } else {
            freeText.push(trimmed);
          }
        }
      }
      const infoboxClass = `infobox${align.set ? ` ${alignClasses(align)}` : ""}`;
      return (
        <aside key={k()} className={infoboxClass}>
          {title && <div className="ib-title">{renderInline(title, ctx)}</div>}
          {image && <Asset ctx={ctx} src={image} alt={title} />}
          {rows.length > 0 && (
            <div className="ib-rows">
              {rows.map((row) => (
                <React.Fragment key={k()}>
                  <div className="ib-label">{renderInline(row.label, ctx)}</div>
                  <div className="ib-value">{renderInline(row.value, ctx)}</div>
                </React.Fragment>
              ))}
            </div>
          )}
          {freeText.map((line) => (
            <div key={k()} className="ib-text">
              {renderInline(line, ctx)}
            </div>
          ))}
        </aside>
      );
    }
    /*
     * A table of contents that builds itself from the page's headings, so it
     * stays in sync as headings are added, removed or renamed. The `param` after
     * `:::contents` is an optional heading for the box. Only ## sections are
     * listed by default; add `all` to include ### / #### subheadings too.
     */
    case "contents": {
      const opts = parseContentsParam(dir.param);
      let items = ctx.headings ?? [];
      if (opts.only) {
        // An explicit [a,b,c] list picks headings by name, keeping the order the
        // author wrote — so the box can be a hand-curated subset, not the page order.
        const want = opts.only.map((s) => s.toLowerCase());
        items = want
          .map((name) => items.find((h) => h.text.trim().toLowerCase() === name))
          .filter((h): h is PageHeading => h !== undefined);
      } else if (!opts.all) {
        items = items.filter((h) => h.level === 2);
      }
      if (items.length === 0) {
        return null;
      }
      // A "^ subheader" line in the body becomes the box's subtext, like a heading's.
      const sub = dir.lines.map((l) => l.trim()).find((l) => l.startsWith("^ "));
      const cls = [
        "contents-box",
        opts.vertical && "vertical",
        opts.mini && "mini",
        opts.mini && opts.align.set && alignClasses(opts.align),
      ]
        .filter(Boolean)
        .join(" ");
      return (
        <nav key={k()} className={cls} aria-label="Contents">
          <p className="label">{opts.header ? renderInline(opts.header, ctx) : "Contents"}</p>
          {sub && <p className="toc-sub">{renderInline(sub.slice(2), ctx)}</p>}
          <ul>
            {items.map((h) => (
              <li key={k()} className={`toc-l${h.level}`}>
                <Link className="anchor" to={`#${h.slug}`} preventScrollReset>
                  {h.num !== undefined && <span className="toc-num">{String(h.num).padStart(2, "0")}</span>}
                  <span>{renderInline(h.text, ctx)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      );
    }
    case "flow": {
      const steps = body.map((l) => l.trim()).filter(Boolean);
      return (
        <div key={k()} className="flow">
          {steps.map((step, i) => (
            <React.Fragment key={k()}>
              {i > 0 && <span className="arrow">→</span>}
              <div className="step">
                <div className="n">STEP {String(i + 1).padStart(2, "0")}</div>
                <div className="t">{renderInline(step, ctx)}</div>
              </div>
            </React.Fragment>
          ))}
        </div>
      );
    }
    case "steps": {
      const items = body.filter((l) => l.trim().startsWith("- "));
      return (
        <ol key={k()} className="build">
          {items.map((item) => {
            const raw = item.trim().slice(2);
            const tm = /^\*\*(.+?)\*\*\s*[—:–-]?\s*(.*)$/.exec(raw);
            return (
              <li key={k()}>
                {tm ? (
                  <>
                    <b>{renderInline(tm[1], ctx)}</b>
                    <span className="step-body">{renderInline(tm[2], ctx)}</span>
                  </>
                ) : (
                  <span className="step-body">{renderInline(raw, ctx)}</span>
                )}
              </li>
            );
          })}
        </ol>
      );
    }
    default:
      return (
        <div key={k()} className="note">
          {body.map((line) => (
            <p key={k()}>{renderInline(line, ctx)}</p>
          ))}
        </div>
      );
  }
}

function renderTable(lines: string[], ctx: RenderContext): React.ReactNode {
  const rows = lines.map((line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim())
  );
  let header: string[] | null = null;
  let bodyRows = rows;
  if (rows.length >= 2 && rows[1].every((cell) => /^:?-{2,}:?$/.test(cell))) {
    header = rows[0];
    bodyRows = rows.slice(2);
  }
  return (
    <div key={k()} className="table-scroll">
      <table>
        {header && (
          <thead>
            <tr>
              {header.map((cell) => (
                <th key={k()}>{renderInline(cell, ctx)}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {bodyRows.map((row) => (
            <tr key={k()}>
              {row.map((cell) => (
                <td key={k()}>{renderInline(cell, ctx)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Nesting depth — only the outermost call may reset the key counter. */
let renderDepth = 0;

export function renderMarkdown(text: string, ctx: RenderContext, h2Start = 0): React.ReactNode {
  if (renderDepth === 0) {
    keyCounter = 0;
  }
  renderDepth++;
  try {
    return renderBlocks(text, ctx, h2Start);
  } finally {
    renderDepth--;
  }
}

function renderBlocks(text: string, ctx: RenderContext, h2Start: number): React.ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  // Content-derived keys, scoped to this parent — see blockKey.
  const seen = new Map<string, number>();
  const bk = (kind: string, content: string) => blockKey(seen, kind, content);
  let h2Index = h2Start;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Raw verbatim block: `~~~` (optionally `~~~~`… for content containing ~~~).
    // No markdown, no highlighting; closes on a fence at least as long as it
    // opened, so the body may contain backticks and other markup safely.
    const rawFence = /^(~{3,})[ \t]*(.*)$/.exec(line);
    if (rawFence) {
      const fence = rawFence[1];
      const label = rawFence[2].trim();
      const rawLines: string[] = [];
      i++;
      const closeRe = new RegExp(`^~{${fence.length},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i])) {
        rawLines.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <React.Fragment key={bk("raw", rawLines.join("\n"))}>
          <RawBlock text={rawLines.join("\n")} label={label || undefined} />
        </React.Fragment>
      );
      continue;
    }

    if (line.startsWith("```")) {
      const spec = line.slice(3).trim();
      const [lang, file] = spec.includes(":") ? [spec.split(":")[0], spec.split(":").slice(1).join(":")] : [spec, ""];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <div key={bk("code", codeLines.join("\n"))} className="code">
          {(lang || file) && (
            <div className="file">
              <span>{file || lang}</span>
              {file && <span className="lang">{lang}</span>}
            </div>
          )}
          <pre>{highlightCode(codeLines.join("\n"))}</pre>
        </div>
      );
      continue;
    }

    if (line.startsWith(":::")) {
      const headMatch = /^:::\s*([a-zA-Z]+)\s*(.*)$/.exec(line);
      const dirLines: string[] = [];
      i++;
      // Track nesting so an inner ::: block doesn't close the outer one.
      let depth = 1;
      while (i < lines.length) {
        const current = lines[i];
        if (current.trim() === ":::") {
          depth--;
          if (depth === 0) {
            break;
          }
        } else if (/^:::\s*[a-zA-Z]+/.test(current.trim())) {
          depth++;
        }
        dirLines.push(current);
        i++;
      }
      i++;
      const dirType = headMatch ? headMatch[1].toLowerCase() : "note";
      out.push(
        // Wrapped so the box gets a content key — renderDirective's own key is
        // positional, which would remount any image inside it while typing.
        <React.Fragment key={bk("dir", dirType + dirLines.join("\n"))}>
          {renderDirective(
            { type: dirType, param: headMatch ? headMatch[2].trim() : "", lines: dirLines },
            ctx
          )}
        </React.Fragment>
      );
      continue;
    }

    if (line.startsWith("#### ")) {
      out.push(<Heading key={bk("h4", line)} level={4} text={line.slice(5)} ctx={ctx} />);
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      out.push(<Heading key={bk("h3", line)} level={3} text={line.slice(4)} ctx={ctx} />);
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      h2Index++;
      out.push(<Heading key={bk("h2", line)} level={2} text={line.slice(3)} ctx={ctx} num={h2Index} />);
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(<Heading key={bk("h1", line)} level={2} text={line.slice(2)} ctx={ctx} />);
      i++;
      continue;
    }

    if (line.startsWith("^ ")) {
      out.push(
        <p key={bk("kicker", line)} className="kicker">
          {renderInline(line.slice(2), ctx)}
        </p>
      );
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={bk("hr", String(i))} />);
      i++;
      continue;
    }

    /*
     * "::error" on its own line opens a coloured rule that runs until a bare
     * "::" closes it, mirroring how ":::" delimits a box. An unclosed region
     * runs to the end of the block — "the rest of this".
     *
     * "::error some text" with text on the same line is a one-liner and ends
     * there. Without that distinction a one-liner would silently swallow every
     * following paragraph, since it has no terminator.
     */
    const lineTone = LINE_TONE_RE.exec(line.trim());
    if (lineTone) {
      const tone = lineTone[1];
      const inlineText = lineTone[2].trim();
      const runLines: string[] = [];
      i++;

      if (inlineText) {
        runLines.push(inlineText);
      } else {
        // Track nesting so an inner ::: box's own markers don't close this run.
        let depth = 0;
        while (i < lines.length) {
          const current = lines[i];
          const trimmed = current.trim();
          if (depth === 0 && trimmed === "::") {
            i++;
            break;
          }
          if (/^:::\s*[a-zA-Z]+/.test(trimmed)) {
            depth++;
          } else if (trimmed === ":::" && depth > 0) {
            depth--;
          }
          runLines.push(current);
          i++;
        }
      }

      out.push(
        <div key={bk("toneline", tone + runLines.join("\n"))} className={`note line-${tone}`}>
          {renderMarkdown(runLines.join("\n"), ctx)}
        </div>
      );
      continue;
    }

    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      out.push(renderTable(tableLines, ctx));
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(
        <blockquote key={bk("quote", quoteLines.join("\n"))}>{renderInline(quoteLines.join(" "), ctx)}</blockquote>
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={bk("ul", items.join("\n"))}>
          {items.map((item) => (
            <li key={k()}>{renderInline(item, ctx)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(
        <ol key={bk("ol", items.join("\n"))}>
          {items.map((item) => (
            <li key={k()}>{renderInline(item, ctx)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // A line that is only images (one or more, space-separated) becomes a row.
    // With one image it's the usual single figure; with several they sit side by
    // side and wrap to the next line as needed — a lightweight gallery.
    const rowImages = parseImageRow(line.trim());
    if (rowImages) {
      if (rowImages.length === 1) {
        const im = rowImages[0];
        const figClass = `wk-img ${alignClasses(im.align)}`;
        out.push(
          <figure key={bk("img", im.src)} className={figClass} style={im.size.width != null ? { maxWidth: figureMaxWidth(im.size.width) } : undefined}>
            <Asset ctx={ctx} src={im.src} alt={plainCaption(im.caption)} size={im.size} />
            {im.caption && <figcaption>{renderInline(im.caption, ctx)}</figcaption>}
          </figure>
        );
      } else {
        // The row's horizontal alignment follows the first image's pin.
        const rowAlign = rowImages[0].align.h;
        out.push(
          <div key={bk("imgrow", line.trim())} className={`wk-img-row row-${rowAlign}`}>
            {rowImages.map((im, idx) => (
              <figure key={idx} className="wk-img" style={im.size.width != null ? { maxWidth: figureMaxWidth(im.size.width) } : undefined}>
                <Asset ctx={ctx} src={im.src} alt={plainCaption(im.caption)} size={im.size} />
                {im.caption && <figcaption>{renderInline(im.caption, ctx)}</figcaption>}
              </figure>
            ))}
          </div>
        );
      }
      i++;
      continue;
    }

    // A "::" with no open tone region is a stray terminator — drop it rather
    // than render it as text.
    if (line.trim() === "::") {
      i++;
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      // "::" opens or closes a tone region and ends the paragraph; a bare
      // ":" (the inline tone marker) does not.
      !/^(```|~{3,}|:::|::(?:error|warn|good|tips|muted)\b|::\s*$|#|\^ |>|\||\s*[-*]\s|\s*\d+\.\s|!\[|-{3,}\s*$|\*{3,}\s*$)/.test(
        lines[i].trim()
      )
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    // Joined with newlines, not spaces: a line break the author typed is a line
    // break they meant. `.wiki p` preserves them via white-space: pre-line.
    const para = paraLines.join("\n");
    out.push(<p key={bk("p", para)}>{renderInline(para, ctx)}</p>);
  }

  return <>{out}</>;
}
