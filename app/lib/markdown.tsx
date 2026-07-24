import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { UnrealGraph } from "~/components/wiki/unreal-graph";
import { Roadmap } from "~/components/wiki/roadmap";
import { Sheet } from "~/components/wiki/sheet";
import { HtmlEmbed } from "~/components/wiki/html-embed";
import { openLightbox } from "~/components/wiki/lightbox";
import { searchHref } from "~/lib/shared";

export interface RenderVariable {
  name: string;
  value: string;
  description: string;
  page: string;
  blockId: string;
  scope?: "global" | "local";
  /** The shadowed global def, when this local one overrides a global. */
  global?: RenderVariable;
}

export interface RenderTerm {
  name: string;
  explanation: string;
  page: string;
  blockId: string;
  scope?: "global" | "local";
  global?: RenderTerm;
}

export interface RenderContext {
  variables: Record<string, RenderVariable>;
  /** Named term definitions ({{TypeDef}}), used to resolve {{TypeRef}} links. */
  terms?: Record<string, RenderTerm>;
  /** Every tag in use in the project — a bare mention of one links to search. */
  tags?: string[];
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
  /** True inside the editor's live preview — heavy embeds (e.g. :::html) show a
   *  click-to-run placeholder rather than mounting and restarting on each keystroke. */
  editing?: boolean;
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
 * A fenced code block. One component covers every ``` fence:
 *   ```               → plain verbatim text, no highlighting (same as ```text)
 *   ```text: Label     → plain verbatim text with a header label
 *   ```c#: EnemyAI.cs  → C# syntax highlighting, header label + language badge
 * A `text` (or empty) language means no highlighting and the body wraps like the
 * old raw block; a real language tints keywords/comments. Every block gets a
 * "Copy all" button so any fenced content is one click to copy.
 */
function CodeBlock({ code, lang, label }: { code: string; lang?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const language = (lang || "").trim();
  const PLAIN = new Set(["text", "txt", "plain", "plaintext", "none", "raw"]);
  const highlight = language !== "" && !PLAIN.has(language.toLowerCase());
  const title = label || (highlight ? language : "TEXT");
  const copy = () => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked — ignore */
      });
  };
  return (
    <div className={highlight ? "code" : "code raw"}>
      <div className="file">
        <span>
          {title}
          {label && highlight && <span className="lang">{language}</span>}
        </span>
        <button type="button" className="raw-copy" onClick={copy}>
          {copied ? "Copied" : "Copy all"}
        </button>
      </div>
      <pre>{highlight ? highlightCode(code) : code}</pre>
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
    "(\\{\\{var:[^}]+\\}\\})", // 2 variable definition
    "(\\{\\{-?\\d[^|}]*(?:\\|[^}]*)?\\}\\})", // 3 magic value (starts with a digit — names can't)
    "(\\{\\{term:[^}]+\\}\\})", // 4 term definition
    "(\\{\\{[A-Za-z0-9_.-]+(?:\\|[^}]*)?\\}\\})", // 5 reference — variable or term, resolved by name
    "(\\[\\[[^\\]]+\\]\\])", // 6 wiki link
    "(!\\[[^\\]]*\\]\\([^)]+\\)(?:\\{[^}]*\\})?)", // 7 image (optional {w=…} size)
    "(\\[[^\\]]+\\]\\([^)]+\\))", // 8 external link
    "(\\*\\*.+?\\*\\*)", // 9 bold
    "(\\*[^*\\n]+\\*)", // 10 italic
    "(==[^=]+==)", // 11 accent term
    "(:(?:error|warn|good|tips|muted|white)\\[[^\\]]*\\])", // 12 coloured span :tone[text]
    "((?<!:):(?:error|warn|good|tips|muted)\\b[^\\n]*)", // 13 coloured inline run (to line end)
].join("|");

/** ":error text" — colour only, to end of line. */
const INLINE_TONE_RE = /^:(error|warn|good|tips|muted)\b[ \t]*([\s\S]*)$/;

/** "::error text" — a coloured rule in front of the text, no box. */
const LINE_TONE_RE = /^::(error|warn|good|tips|muted)\b[ \t]*([\s\S]*)$/;

// Mirrors DEF_RE in shared.ts — name, value, description, then the optional
// "private" flag that keeps the definition out of the All variables index.
const DEF_INNER_RE = /^\{\{var:(global:)?([A-Za-z0-9_.-]+)\s*(?:=\s*([^|}]*?)\s*)?(?:\|\s*([^|}]*?)\s*)?(?:\|\s*([^}]*?)\s*)?\}\}$/;

/* ---------------------------------------------------------------- */
/* Chip — the shared primitive for variable & term defs/refs/notes.   */
/*                                                                    */
/* Every one is a boxed label, optionally a link to its definition,   */
/* optionally with a formatted hover card. Both the label and the     */
/* card description accept full inline markup, so "value in white",   */
/* coloured runs, code, etc. all just work. The specific tokens below */
/* are thin wrappers that decide the label, link target and variant.  */
/* ---------------------------------------------------------------- */

/**
 * Points out a definition that is already on this page: flashes it, and only
 * scrolls if it isn't on screen. Following the link instead would re-render the
 * route and jump the page — which reads as a reload for a definition that was
 * often visible all along.
 */
function flashTarget(hash: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const el = document.getElementById(hash.replace(/^#/, ""));
  if (!el) {
    return false;
  }
  const box = el.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  // Removing and forcing a reflow restarts the animation on a second click.
  el.classList.remove("flash-target");
  void el.offsetWidth;
  el.classList.add("flash-target");
  window.setTimeout(() => el.classList.remove("flash-target"), 1600);
  return true;
}

/**
 * Whether Alt is held right now, shared across every chip. Holding Alt "pins"
 * hover cards: a pinned card freezes where it is and stays after the mouse
 * leaves, so a card that names another variable can be read while hovering that
 * second variable's own card. Releasing Alt (or leaving the window) drops them.
 */
let altHeld = false;
const altListeners = new Set<(held: boolean) => void>();

if (typeof window !== "undefined") {
  const set = (held: boolean) => {
    if (held !== altHeld) {
      altHeld = held;
      altListeners.forEach((fn) => fn(held));
    }
  };
  window.addEventListener("keydown", (e) => e.key === "Alt" && set(true));
  window.addEventListener("keyup", (e) => e.key === "Alt" && set(false));
  window.addEventListener("blur", () => set(false));
}

function Chip({
  ctx,
  variant,
  label,
  description,
  id,
  to,
  sameDoc,
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
  /** The target is on this very page — highlight it rather than navigating. */
  sameDoc?: boolean;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState(false);
  const hovering = useRef(false);

  // Releasing Alt drops this card unless the mouse is still on the chip, where
  // it reverts to a normal cursor-following tooltip.
  useEffect(() => {
    const onAlt = (held: boolean) => {
      if (!held && !hovering.current) {
        setPinned(false);
        setPos(null);
      }
    };
    altListeners.add(onAlt);
    return () => {
      altListeners.delete(onAlt);
    };
  }, []);

  const hoverProps = description
    ? {
        onMouseEnter: (e: React.MouseEvent) => {
          hovering.current = true;
          setPos({ x: e.clientX, y: e.clientY });
          setPinned(altHeld);
        },
        onMouseMove: (e: React.MouseEvent) => {
          // A pinned card holds still so it can be read while the mouse moves on
          // to the variable it mentions; an ordinary one trails the cursor.
          if (altHeld) {
            setPinned(true);
          } else {
            setPinned(false);
            setPos({ x: e.clientX, y: e.clientY });
          }
        },
        onMouseLeave: () => {
          hovering.current = false;
          if (altHeld) {
            setPinned(true);
          } else {
            setPos(null);
          }
        },
      }
    : {};
  const card = description && pos && (
    <span
      className={`hovercard${pinned ? " pinned" : ""}`}
      style={{ left: pos.x + 12, top: pos.y + 16 }}
      role="tooltip"
    >
      {/* noLinkify: a card shouldn't turn every bare word into a variable chip. */}
      <span className="wiki">{renderInline(description, ctx, { noLinkify: true })}</span>
    </span>
  );
  const cls = `chip ${variant}`;
  const hash = to && to.includes("#") ? to.slice(to.indexOf("#")) : "";
  if (to) {
    return (
      <Link
        className={cls}
        id={id}
        to={to}
        onClick={(e) => {
          // Only intercept a plain click: ctrl/cmd/middle-click should still
          // open the definition's page in a new tab.
          if (sameDoc && hash && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && flashTarget(hash)) {
            e.preventDefault();
          }
        }}
        {...hoverProps}
      >
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

/**
 * Where a definition's chip links to — nothing when the def has no page. That
 * happens for a global lifted out of a hidden or locked page: the definition is
 * shared project-wide, but there is no page this viewer could be sent to.
 */
function defHref(page: string, hash: string): string | undefined {
  return page ? `/${page}${hash}` : undefined;
}

/** The hover card markup for a variable: name = value — description. */
function variableCard(def: RenderVariable): string {
  return `**${def.name}**${def.value ? ` = :white[${def.value}]` : ""}${def.description ? ` — ${def.description}` : ""}`;
}

/** Variable references ({{name}}) become a boxed link chip showing just the name. */
function variableLink(ctx: RenderContext, name: string, label: React.ReactNode): React.ReactNode {
  const def = ctx.variables[name];
  if (!def) {
    return null;
  }
  const samePage = def.page.toLowerCase() === ctx.currentPath.toLowerCase();
  return (
    <Chip
      key={k()}
      ctx={ctx}
      variant="varref"
      label={label}
      description={variableCard(def)}
      to={defHref(def.page, `#var-${name}`)}
      sameDoc={samePage}
    />
  );
}

/**
 * A bare word matching a variable name — orange text, hover for value and
 * description, click to jump to the definition. Unlike {{name}} it's not boxed.
 */
function variableInlineLink(ctx: RenderContext, name: string): React.ReactNode {
  const def = ctx.variables[name];
  if (!def) {
    return name;
  }
  const samePage = def.page.toLowerCase() === ctx.currentPath.toLowerCase();
  return (
    <Chip
      key={k()}
      ctx={ctx}
      variant="varinline"
      label={name}
      description={variableCard(def)}
      to={defHref(def.page, `#var-${name}`)}
      sameDoc={samePage}
    />
  );
}

/** Term id anchors are slugified so a term reference can jump to them. */
function termId(name: string): string {
  return `term-${slugify(name)}`;
}

/** Parses the inner of a {{term:...}} token; strips the global: prefix. */
function parseTermToken(token: string): { name: string; explanation: string } {
  const inner = token.slice(2, -2).replace(/^term:/, "").replace(/^global:/, "");
  const pipe = inner.indexOf("|");
  return {
    name: (pipe === -1 ? inner : inner.slice(0, pipe)).trim(),
    explanation: pipe === -1 ? "" : inner.slice(pipe + 1).trim(),
  };
}

// {{term:Name}} — a bare anchor; {{term:Name|explanation}} adds a hover card. A
// local def that shadows a global hovers/links the global (like the vardef).
function renderTermDef(ctx: RenderContext, token: string): React.ReactNode {
  const { name, explanation } = parseTermToken(token);
  const shadowed = ctx.terms?.[name]?.global;
  return (
    <Chip
      key={k()}
      ctx={ctx}
      variant={explanation || shadowed ? "termnote" : "termdef"}
      label={renderInline(name, ctx)}
      id={termId(name)}
      description={shadowed ? shadowed.explanation : explanation}
      to={shadowed ? defHref(shadowed.page, `#${termId(name)}`) : undefined}
    />
  );
}

/**
 * {{name}} / {{name|extra}} — a reference resolved to a variable or a term by
 * name (variables win a name collision, as they do for bare words). For a
 * variable, `extra` is a display label; for a term, a per-reference hover note.
 */
function renderReference(ctx: RenderContext, name: string, extra: string): React.ReactNode {
  if (ctx.variables[name]) {
    const link = variableLink(ctx, name, extra || name);
    return link ?? name;
  }
  const term = ctx.terms?.[name];
  if (term) {
    const samePage = term.page.toLowerCase() === ctx.currentPath.toLowerCase();
    return (
      <Chip
        key={k()}
        ctx={ctx}
        variant="termref"
        label={renderInline(name, ctx)}
        description={extra || term.explanation}
        to={defHref(term.page, `#${termId(name)}`)}
        sameDoc={samePage}
      />
    );
  }
  // Neither a variable nor a term — a dashed-red missing chip, no link.
  return (
    <span key={k()} className="chip varref missing" title={`Undefined variable or term: ${name}`}>
      {extra || name}
    </span>
  );
}

/**
 * A bare word matching a term name — orange text, hover for the explanation,
 * click to jump to the term's definition. The inline counterpart of a variable's
 * bare-word link.
 */
function termInlineLink(ctx: RenderContext, name: string): React.ReactNode {
  const def = ctx.terms?.[name];
  if (!def) {
    return name;
  }
  const samePage = def.page.toLowerCase() === ctx.currentPath.toLowerCase();
  return (
    <Chip
      key={k()}
      ctx={ctx}
      variant="varinline"
      label={name}
      description={def.explanation}
      to={defHref(def.page, `#${termId(name)}`)}
      sameDoc={samePage}
    />
  );
}

type BarePage = { path: string; title: string };

/**
 * A bare mention of a page's exact name — orange text like a variable, hover for
 * the page it points at, click to open it. Written this way so prose can name a
 * page and have it link to the explanation without any markup.
 */
function pageInlineLink(ctx: RenderContext, name: string, page: BarePage): React.ReactNode {
  return (
    <Chip
      key={k()}
      ctx={ctx}
      variant="varinline"
      label={name}
      description={`**${page.title}** — \`/${page.path}\``}
      to={`/${page.path}`}
    />
  );
}

/**
 * Names that a bare mention may link to a page: its title and its final path
 * segment, for pages of the current project only. The page being rendered is
 * skipped (a page shouldn't link to itself), as is the "Home" segment — every
 * project has one and the word is far too common in prose. Home's title (the
 * project's own name) still counts.
 */
function pageNameMap(ctx: RenderContext): Record<string, BarePage> {
  const map: Record<string, BarePage> = {};
  if (!ctx.project) {
    return map;
  }
  const prefix = ctx.project.toLowerCase() + "/";
  for (const page of ctx.pages) {
    if (!page.path.toLowerCase().startsWith(prefix) || page.path.toLowerCase() === ctx.currentPath.toLowerCase()) {
      continue;
    }
    for (const name of [page.title, page.path.split("/").pop()!]) {
      if (name.length > 1 && name !== "Home" && !(name in map)) {
        map[name] = page;
      }
    }
  }
  return map;
}

/**
 * A bare mention of one of the project's tags — a grey box like `code`, but a
 * link: it opens the search page listing every page carrying that tag.
 */
function tagInlineLink(ctx: RenderContext, tag: string): React.ReactNode {
  return (
    <Link key={k()} className="tagref" to={searchHref(ctx.project!, { tags: [tag] })} title={`Pages tagged ${tag}`}>
      {tag}
    </Link>
  );
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface BareMatcher {
  re: RegExp;
  kind: Record<string, "var" | "term" | "page" | "tag">;
  pages: Record<string, BarePage>;
}

// Word-boundary regex matching every variable, term and page name, plus a
// name→kind lookup. Cached against the page list, and rebuilt whenever any of
// the three maps is replaced (they all come from one loader run).
const nameRegexCache = new WeakMap<
  object,
  {
    variables: object;
    terms: object | undefined;
    tags: object | undefined;
    currentPath: string;
    matcher: BareMatcher | null;
  }
>();

function bareNameMatcher(ctx: RenderContext): BareMatcher | null {
  const cached = nameRegexCache.get(ctx.pages);
  if (
    cached &&
    cached.variables === ctx.variables &&
    cached.terms === ctx.terms &&
    cached.tags === ctx.tags &&
    cached.currentPath === ctx.currentPath
  ) {
    return cached.matcher;
  }

  const kind: Record<string, "var" | "term" | "page" | "tag"> = {};
  // Least specific first: a page of the same name overrides a tag, a term
  // overrides both, and a variable overrides all three (values win).
  if (ctx.project) {
    for (const tag of ctx.tags ?? []) {
      if (tag.length > 1) {
        kind[tag] = "tag";
      }
    }
  }
  const pages = pageNameMap(ctx);
  for (const name of Object.keys(pages)) {
    kind[name] = "page";
  }
  for (const name of Object.keys(ctx.terms ?? {})) {
    kind[name] = "term";
  }
  for (const name of Object.keys(ctx.variables)) {
    kind[name] = "var";
  }

  const names = Object.keys(kind);
  const matcher =
    names.length === 0
      ? null
      : {
          kind,
          pages,
          re: new RegExp(
            `(?<![\\w.-])(${names
              .sort((a, b) => b.length - a.length)
              .map(escapeRe)
              .join("|")})(?![\\w-])(?!\\.[\\w-])`,
            "g"
          ),
        };
  nameRegexCache.set(ctx.pages, {
    variables: ctx.variables,
    terms: ctx.terms,
    tags: ctx.tags,
    currentPath: ctx.currentPath,
    matcher,
  });
  return matcher;
}

// Plain prose: bare words matching a defined variable, term or page name become
// inline (orange, non-boxed) links to their definition; a tag becomes a grey box
// linking to the pages that carry it.
function linkifyPlain(text: string, ctx: RenderContext, out: React.ReactNode[]) {
  const matcher = bareNameMatcher(ctx);
  if (!matcher) {
    out.push(text);
    return;
  }
  const { re, kind, pages } = matcher;
  re.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    const name = m[1];
    if (kind[name] === "tag") {
      out.push(tagInlineLink(ctx, name));
    } else if (kind[name] === "page") {
      out.push(pageInlineLink(ctx, name, pages[name]));
    } else {
      out.push(kind[name] === "term" ? termInlineLink(ctx, name) : variableInlineLink(ctx, name));
    }
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
        const [, , name, value, desc, display] = dm;
        // A VarDef is a chip. If a custom display (4th field) is given it's used
        // verbatim (full formatting); otherwise the default shows the name and,
        // after "=", the value in white. The name is rendered without auto-link
        // so a def never turns its own name into a reference chip.
        const label = display ? (
          renderInline(display, ctx)
        ) : value ? (
          <>
            {renderInline(name, ctx, { noLinkify: true })} = <span className="val">{renderInline(value, ctx)}</span>
          </>
        ) : (
          renderInline(name, ctx, { noLinkify: true })
        );
        // When this local def shadows a global, its own chip hovers the GLOBAL
        // description and links to the GLOBAL definition — refs on the page use
        // the local one instead (via ctx.variables resolution).
        const shadowed = ctx.variables[name]?.global;
        out.push(
          <Chip
            key={k()}
            ctx={ctx}
            variant="vardef"
            label={label}
            description={shadowed ? variableCard(shadowed) : desc || ""}
            id={`var-${name}`}
            to={shadowed ? defHref(shadowed.page, `#var-${name}`) : undefined}
          />
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
      // {{term:[global:]Name[|explanation]}} — a term definition/anchor.
      out.push(renderTermDef(ctx, token));
    } else if (m[5]) {
      // {{name}} or {{name|extra}} — a reference. Resolves to a variable or a
      // term (whichever the name is defined as); for a variable the extra is a
      // display label, for a term it's a per-reference hover note.
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf("|");
      const name = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const extra = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
      out.push(renderReference(ctx, name, extra));
    } else if (m[6]) {
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
    } else if (m[7]) {
      const { image, suffix } = splitImageSuffix(token);
      const im = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(image)!;
      const { src: imgSrc, align } = splitImageAlign(im[2]);
      const inlineClass = `wk-inline-img ${alignClasses(align)}`;
      // Keyed by src, not position, so editing text around an image doesn't
      // remount it (which would blink the picture while typing).
      out.push(
        <Asset key={`img:${imgSrc}`} ctx={ctx} src={imgSrc} alt={im[1]} className={inlineClass} size={parseImageSize(suffix)} />
      );
    } else if (m[8]) {
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
    } else if (m[9]) {
      out.push(<strong key={k()}>{renderInline(token.slice(2, -2), ctx)}</strong>);
    } else if (m[10]) {
      out.push(<em key={k()}>{renderInline(token.slice(1, -1), ctx)}</em>);
    } else if (m[11]) {
      out.push(
        <em key={k()} className="term">
          {renderInline(token.slice(2, -2), ctx)}
        </em>
      );
    } else if (m[12]) {
      // :tone[text] — colours just the bracketed text, formatting preserved.
      const tm = /^:(\w+)\[([\s\S]*)\]$/.exec(token)!;
      out.push(
        <span key={k()} className={`tone-${tm[1]}`}>
          {renderInline(tm[2], ctx)}
        </span>
      );
    } else if (m[13]) {
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
 * detects and numbers them: ## sections carry a running auto-number, code
 * fences are skipped so a `## ` inside them isn't picked up. The slug and
 * label match what the Heading component renders, so a :::contents link lands
 * on the right element. `h2Start` continues the numbering from earlier blocks.
 */
export function extractHeadings(text: string, h2Start = 0): PageHeading[] {
  const out: PageHeading[] = [];
  let h2 = h2Start;
  let inFence = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
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
  let header = rest
    .replace(/\ball\b/i, "")
    .replace(/\bvertical\b/i, "")
    .replace(/\bmini\b/i, "")
    .trim();

  // A mini may also carry a bare trailing pin — `:::contents mini On this page <`
  // or just `:::contents mini <` — like an :::infobox does, not only the
  // parenthesised `mini(<)` form. Only read it when no parens pin was given.
  if (mini && !align.set) {
    const bare = splitImageAlign(header);
    if (bare.align.set) {
      align = bare.align;
      header = bare.src;
    }
  }

  return { all, vertical, mini, align, only, header };
}

/**
 * One shared box grammar for :::window, :::html and :::embed. Parenthesised
 * groups, where the FIRST size group sets the box and later size groups are
 * padding:
 *
 *   size group  — up to two space-separated slots [width height]; each slot is a
 *                 number, `w=`/`h=` (or `max`), or `auto`:
 *                   (w=300 h=200)   fixed both      (auto)        fill both axes
 *                   (auto h=1000)   auto width      (w=500 auto)  auto height
 *   padding     — any size group AFTER the first: `w=`/bare → side padding,
 *                 `h=` → top/bottom padding; `pad=`/`px=`/`py=` work anywhere:
 *                   (auto)(w=24)    full width, 24px side padding
 *                   (auto h=800)(h=12)  auto width, 800 tall, 12px vertical pad
 *   pin         — a pure `<>c^v` group aligns the box:  (>)  (c)  (^v)
 *   extras      — (noscroll) and (device=390) for :::html / :::embed
 *
 * `auto` width means "fill the available space" (full-bleed for html/embed, full
 * column width for window); `auto`/omitted height means content height.
 */
interface BoxParams {
  width: number | "max" | null;
  /** `auto` in the width slot — fill the available width. */
  widthAuto: boolean;
  height: number | null;
  padX: number;
  padY: number;
  align: ImageAlign;
  noscroll: boolean;
  device: number | null;
}

function parseBoxParams(param: string): BoxParams {
  let width: number | "max" | null = null;
  let widthAuto = false;
  let height: number | null = null;
  let padX = 0;
  let padY = 0;
  let align: ImageAlign = { h: "right", v: "top", set: false };
  let noscroll = false;
  let device: number | null = null;
  let sizeSeen = false;

  const readSize = (inner: string) => {
    inner.split(/[\s,]+/).filter(Boolean).forEach((tok, i) => {
      if (/^auto$/i.test(tok)) {
        if (i === 0) {
          widthAuto = true;
        }
        return; // auto in the height slot just leaves height null (= auto)
      }
      const wm = /^(?:w|width)\s*=\s*(max|\d{1,4})$/i.exec(tok);
      const hm = /^(?:h|height)\s*=\s*(\d{1,5})$/i.exec(tok);
      const nm = /^(\d{1,5})$/.exec(tok);
      if (wm) {
        width = /max/i.test(wm[1]) ? "max" : Number(wm[1]);
      } else if (hm) {
        height = Number(hm[1]);
      } else if (nm) {
        if (i === 0) {
          width = Number(nm[1]);
        } else {
          height = Number(nm[1]);
        }
      }
    });
  };

  const readPad = (inner: string) => {
    const p = /\bpad\s*=\s*(\d{1,3})/i.exec(inner);
    if (p) {
      padX = padY = Number(p[1]);
    }
    const x = /\b(?:px|w|width)\s*=\s*(\d{1,3})/i.exec(inner);
    if (x) {
      padX = Number(x[1]);
    }
    const y = /\b(?:py|h|height)\s*=\s*(\d{1,3})/i.exec(inner);
    if (y) {
      padY = Number(y[1]);
    }
    const nm = /^(\d{1,3})$/.exec(inner.trim());
    if (nm && !p && !x && !y) {
      padX = Number(nm[1]);
    }
  };

  for (const group of param.match(/\(([^)]*)\)/g) ?? []) {
    const inner = group.slice(1, -1).trim();
    if (!inner) {
      continue;
    }
    if (/^[<>cv^\s]+$/i.test(inner)) {
      align = splitImageAlign(`x ${inner}`).align;
    } else if (/^noscroll$/i.test(inner)) {
      noscroll = true;
    } else if (/\bdevice\s*=/i.test(inner)) {
      const m = /=\s*(\d{2,4})/.exec(inner);
      device = m ? Number(m[1]) : null;
    } else if (/\b(?:pad|px|py)\s*=/i.test(inner)) {
      readPad(inner);
    } else if (!sizeSeen) {
      readSize(inner);
      sizeSeen = true;
    } else {
      readPad(inner);
    }
  }
  return { width, widthAuto, height, padX, padY, align, noscroll, device };
}

/**
 * The shared floating card that :::window, :::infobox and :::contentsmini all
 * render into — one box model, so the three stay pixel-identical. It floats and
 * pushes surrounding text aside using the same <>c^v pins as images. Width
 * defaults to 300px; padding defaults to none so an image can fill it edge to edge.
 * `widthAuto` makes it a full-column-width block instead of a fixed float.
 */
function Window({
  align,
  widthAuto = false,
  width = 300,
  height = null,
  padX = 0,
  padY = 0,
  className,
  children,
}: {
  align: ImageAlign;
  widthAuto?: boolean;
  width?: number | "max" | null;
  height?: number | null;
  padX?: number;
  padY?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const cls = ["window", widthAuto ? "wfull" : "", align.set ? alignClasses(align) : "", className]
    .filter(Boolean)
    .join(" ");
  const style: React.CSSProperties = {};
  if (widthAuto || width === "max") {
    style.width = "100%";
  } else if (typeof width === "number") {
    style.width = width;
  } else {
    style.width = 300;
  }
  if (typeof height === "number") {
    style.height = height;
  }
  if (padX || padY) {
    style.padding = `${padY}px ${padX}px`;
  }
  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
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

/** Picks the headings a :::contents / :::contentsmini box lists, honouring the
 *  `all` and `[a,b]` options. Returns null when there is nothing to show. */
function selectTocItems(opts: ContentsOptions, ctx: RenderContext): PageHeading[] | null {
  let items = ctx.headings ?? [];
  if (opts.only) {
    // An explicit [a,b,c] list picks headings by name, keeping the author's order.
    const want = opts.only.map((s) => s.toLowerCase());
    items = want
      .map((name) => items.find((h) => h.text.trim().toLowerCase() === name))
      .filter((h): h is PageHeading => h !== undefined);
  } else if (!opts.all) {
    items = items.filter((h) => h.level === 2);
  }
  return items.length ? items : null;
}

/** The inner of a contents box — heading label, optional subtext, and the link
 *  list — shared by the full :::contents card and the floating :::contentsmini. */
function tocNav(items: PageHeading[], opts: ContentsOptions, sub: string | undefined, ctx: RenderContext, cls: string): React.ReactNode {
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

/** The floating contents card (:::contentsmini, or :::contents mini) — the TOC
 *  list dropped into the shared Window so it pins and sizes like an :::infobox. */
function renderContentsMini(opts: ContentsOptions, dir: DirectiveLines, ctx: RenderContext): React.ReactNode {
  const items = selectTocItems(opts, ctx);
  if (!items) {
    return null;
  }
  const sub = dir.lines.map((l) => l.trim()).find((l) => l.startsWith("^ "));
  return (
    <Window key={k()} align={opts.align} width={300} className="contentsmini">
      {tocNav(items, opts, sub, ctx, "contents-box mini")}
    </Window>
  );
}

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
    /*
     * A Trello-style board. The param is an optional board key — so one page can
     * hold several boards — followed by the same box grammar as :::window:
     *
     *   :::roadmap                 default box (tall, scrolls inside)
     *   :::roadmap(auto)           full width of the page
     *   :::roadmap(auto h=900)     full width, 900 tall
     *   :::roadmap plans(w=700)    a named board, 700 wide
     *
     * The board's data lives in its own table row, keyed by page + key, loaded
     * after the page (RLS withholds a restricted page's board).
     */
    case "roadmap": {
      const b = parseBoxParams(dir.param);
      return (
        <Roadmap
          key={k()}
          pagePath={ctx.currentPath}
          boardKey={dir.param.replace(/\([^)]*\)/g, "").trim()}
          ctx={ctx}
          full={b.widthAuto || b.width === "max"}
          width={b.width === "max" ? null : b.width}
          height={b.height}
          align={b.align.set ? b.align.h : undefined}
        />
      );
    }
    // A spreadsheet grid. `dir.param` is an optional sheet key so one page can
    // hold several sheets; the sheet's data lives in its own table row, keyed by
    // page + key, loaded after the page (RLS withholds a private page's sheet).
    case "cells": {
      return <Sheet key={k()} pagePath={ctx.currentPath} sheetKey={dir.param} />;
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
      // A quick-info card is just a Window with a fixed structure — title bar,
      // optional image, label/value rows — so it shares the window box model.
      return (
        <Window key={k()} align={align} width={300} className="infobox">
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
        </Window>
      );
    }
    // A free-form floating card. Unlike :::infobox it imposes no inner structure —
    // any markdown goes inside — and its size/pin/padding are set explicitly:
    // `:::window(w=300)(>)`. It's the backend :::infobox and :::contentsmini use.
    case "window": {
      const b = parseBoxParams(dir.param);
      return (
        <Window
          key={k()}
          align={b.align}
          widthAuto={b.widthAuto}
          width={b.width}
          height={b.height}
          padX={b.padX}
          padY={b.padY}
        >
          {renderMarkdown(body.join("\n"), ctx)}
        </Window>
      );
    }
    // Raw HTML rendered in a sandboxed, origin-isolated iframe — scripts run but
    // can't reach the wiki, cookies or the viewer's session. Body is verbatim.
    case "html": {
      const b = parseBoxParams(dir.param);
      return (
        <HtmlEmbed
          key={k()}
          html={body.join("\n")}
          full={b.widthAuto}
          width={b.width === "max" ? null : b.width}
          height={b.height}
          padX={b.padX}
          padY={b.padY}
          align={b.align.set ? b.align.h : undefined}
          noscroll={b.noscroll}
          device={b.device}
          editing={ctx.editing}
        />
      );
    }
    // A live external site in the same sandboxed frame as :::html, sized the same
    // way — `:::embed(https://example.com)(h=600)`. The URL is the first paren
    // group; sizing options follow. Cross-origin, so auto-height isn't available
    // (a set height is used) and sites that forbid framing won't load.
    case "embed": {
      const groups = dir.param.match(/\(([^)]*)\)/g) ?? [];
      let url = groups[0] ? groups[0].slice(1, -1).trim() : "";
      if (url && !/^https?:\/\//i.test(url)) {
        url = "https://" + url;
      }
      // The URL is the first group; the rest follow the shared box grammar.
      const b = parseBoxParams(groups.slice(1).join(""));
      return (
        <HtmlEmbed
          key={k()}
          src={url}
          full={b.widthAuto}
          width={b.width === "max" ? null : b.width}
          height={b.height}
          padX={b.padX}
          padY={b.padY}
          align={b.align.set ? b.align.h : undefined}
          noscroll={b.noscroll}
          device={b.device}
          editing={ctx.editing}
        />
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
      // `:::contents mini` is the old spelling of the standalone :::contentsmini
      // directive; route it there so both produce the identical floating box.
      if (opts.mini) {
        return renderContentsMini(opts, dir, ctx);
      }
      const items = selectTocItems(opts, ctx);
      if (!items) {
        return null;
      }
      // A "^ subheader" line in the body becomes the box's subtext, like a heading's.
      const sub = dir.lines.map((l) => l.trim()).find((l) => l.startsWith("^ "));
      const cls = ["contents-box", opts.vertical && "vertical"].filter(Boolean).join(" ");
      return tocNav(items, opts, sub, ctx, cls);
    }
    // A table of contents as a floating window — set up exactly like :::infobox
    // (header text + trailing <>c^v pin), backed by the shared Window box.
    case "contentsmini": {
      // "mini " primes parseContentsParam to read the trailing pin like :::infobox.
      return renderContentsMini(parseContentsParam(`mini ${dir.param}`), dir, ctx);
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
    // A native <details> box: the param is the clickable summary, the body is
    // hidden until expanded. Native so it toggles with no JS and stays open on
    // re-render. Accepts either spelling.
    case "collapsable":
    case "collapsible": {
      return (
        <details key={k()} className="collapsible">
          <summary>{renderInline(dir.param || "Details", ctx)}</summary>
          <div className="collapsible-body">{renderMarkdown(body.join("\n"), ctx)}</div>
        </details>
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

/**
 * Splits a table row into cells on the `|` separators, honouring `\|` as a
 * literal pipe (the standard markdown escape) so a cell can contain one — e.g.
 * `{{term:Name\|explanation}}`. The escape is then removed so the cell
 * renders a bare `|`.
 */
function splitTableCells(line: string): string[] {
  const inner = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function renderTable(lines: string[], ctx: RenderContext): React.ReactNode {
  const rows = lines.map(splitTableCells);
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

    if (line.startsWith("```")) {
      const spec = line.slice(3).trim();
      const [lang, label] = spec.includes(":")
        ? [spec.split(":")[0].trim(), spec.split(":").slice(1).join(":").trim()]
        : [spec, ""];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <React.Fragment key={bk("code", codeLines.join("\n"))}>
          <CodeBlock code={codeLines.join("\n")} lang={lang || undefined} label={label || undefined} />
        </React.Fragment>
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
      !/^(```|:::|::(?:error|warn|good|tips|muted)\b|::\s*$|#|\^ |>|\||\s*[-*]\s|\s*\d+\.\s|!\[|-{3,}\s*$|\*{3,}\s*$)/.test(
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
