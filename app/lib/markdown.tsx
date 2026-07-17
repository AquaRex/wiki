import React, { useEffect, useState } from "react";
import { Link } from "react-router";

export interface RenderVariable {
  name: string;
  value: string;
  description: string;
  page: string;
  blockId: string;
}

export interface RenderContext {
  variables: Record<string, RenderVariable>;
  /** All pages (across projects) — used for link resolution. */
  pages: { path: string; title: string }[];
  currentPath: string;
  /** Current project slug; wiki links resolve inside it first. */
  project?: string;
  /** Async because a private image's URL must be signed on demand. */
  resolveAsset?: (src: string) => Promise<string>;
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
function Asset({ ctx, src, alt, className }: { ctx: RenderContext; src: string; alt: string; className?: string }) {
  const resolver = ctx.resolveAsset;
  const [resolved, setResolved] = useState<string | null>(() => assetUrls.get(src) ?? null);

  useEffect(() => {
    const cached = assetUrls.get(src);
    if (cached) {
      setResolved(cached);
      return;
    }
    if (!resolver) {
      setResolved(src);
      return;
    }
    let cancelled = false;
    resolver(src)
      .then((url) => {
        assetUrls.set(src, url);
        if (!cancelled) {
          setResolved(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved(null);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (!resolved) {
    // Reserve space so the layout doesn't collapse while the URL resolves.
    return <span className={className} style={{ display: "block", minHeight: 24 }} aria-hidden />;
  }
  return <img className={className} src={resolved} alt={alt} />;
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
    "(\\{\\{[A-Za-z0-9_.-]+(?:\\|[^}]*)?\\}\\})", // 4 variable reference
    "(\\[\\[[^\\]]+\\]\\])", // 5 wiki link
    "(!\\[[^\\]]*\\]\\([^)]+\\))", // 6 image
    "(\\[[^\\]]+\\]\\([^)]+\\))", // 7 external link
    "(\\*\\*.+?\\*\\*)", // 8 bold
    "(\\*[^*\\n]+\\*)", // 9 italic
    "(==[^=]+==)", // 10 accent term
    "((?<!:):(?:error|warn|good|tips|muted)\\b[^\\n]*)", // 11 coloured inline run
].join("|");

/** ":error text" — colour only, to end of line. */
const INLINE_TONE_RE = /^:(error|warn|good|tips|muted)\b[ \t]*([\s\S]*)$/;

/** "::error text" — a coloured rule in front of the text, no box. */
const LINE_TONE_RE = /^::(error|warn|good|tips|muted)\b[ \t]*([\s\S]*)$/;

// Mirrors DEF_RE in shared.ts — name, value, description, then the optional
// "private" flag that keeps the definition out of the All variables index.
const DEF_INNER_RE = /^\{\{def:([A-Za-z0-9_.-]+)\s*=\s*([^|}]*?)\s*(?:\|\s*([^|}]*?)\s*)?(?:\|\s*([^}]*?)\s*)?\}\}$/;

function variableLink(ctx: RenderContext, name: string, label: React.ReactNode): React.ReactNode {
  const def = ctx.variables[name];
  if (!def) {
    return null;
  }
  const tooltip = `${def.name} = ${def.value}${def.description ? ` — ${def.description}` : ""}`;
  const samePage = def.page.toLowerCase() === ctx.currentPath.toLowerCase();
  return (
    <Link key={k()} className="varref" title={tooltip} to={`/${def.page}#var-${name}`} preventScrollReset={samePage}>
      {label}
    </Link>
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

export function renderInline(text: string, ctx: RenderContext): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  const inlineRe = new RegExp(INLINE_SRC, "g");
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(text)) !== null) {
    if (m.index > last) {
      linkifyPlain(text.slice(last, m.index), ctx, out);
    }
    const token = m[0];
    if (m[1]) {
      out.push(renderCodeSpan(ctx, token.slice(1, -1)));
    } else if (m[2]) {
      const dm = DEF_INNER_RE.exec(token);
      if (dm) {
        out.push(
          <span key={k()} className="vardef" id={`var-${dm[1]}`} title={dm[3] || undefined}>
            {dm[1]} = <span className="val">{dm[2]}</span>
          </span>
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
        <span key={k()} className="magicval" title={note || undefined}>
          {value}
        </span>
      );
    } else if (m[4]) {
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf("|");
      const name = pipe === -1 ? inner : inner.slice(0, pipe);
      const label = pipe === -1 ? name : inner.slice(pipe + 1);
      const link = variableLink(ctx, name, label);
      if (link) {
        out.push(link);
      } else {
        out.push(
          <span key={k()} className="varref" style={{ borderBottomStyle: "dashed", color: "var(--crit)" }} title={`Undefined variable: ${name}`}>
            {label}
          </span>
        );
      }
    } else if (m[5]) {
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
    } else if (m[6]) {
      const im = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token)!;
      out.push(<Asset key={k()} ctx={ctx} src={im[2]} alt={im[1]} className="wk-inline-img" />);
    } else if (m[7]) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      out.push(
        <a key={k()} className="ext" href={lm[2]} target="_blank" rel="noreferrer">
          {lm[1]}
        </a>
      );
    } else if (m[8]) {
      out.push(<strong key={k()}>{renderInline(token.slice(2, -2), ctx)}</strong>);
    } else if (m[9]) {
      out.push(<em key={k()}>{renderInline(token.slice(1, -1), ctx)}</em>);
    } else if (m[10]) {
      out.push(
        <em key={k()} className="term">
          {renderInline(token.slice(2, -2), ctx)}
        </em>
      );
    } else if (m[11]) {
      // Colour only — the rest of the run keeps its own formatting.
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
    linkifyPlain(text.slice(last), ctx, out);
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
function splitHeadingImage(text: string): { text: string; image: { src: string; alt: string } | null } {
  const match = /^(.*?)\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(text);
  if (!match) {
    return { text, image: null };
  }
  return { text: match[1].trim(), image: { alt: match[2], src: match[3] } };
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
  return (
    <Tag className={level === 2 ? "wk-h2" : "wk-h3"} id={slugify(label)}>
      {num !== undefined && <span className="num">{String(num).padStart(2, "0")}</span>}
      <span>{renderInline(label, ctx)}</span>
      {image && <Asset ctx={ctx} src={image.src} alt={image.alt} className="wk-h-img" />}
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
          {dir.param && <p className="label">{dir.param}</p>}
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
    case "infobox": {
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
      return (
        <aside key={k()} className="infobox">
          {dir.param && <div className="ib-title">{dir.param}</div>}
          {image && <Asset ctx={ctx} src={image} alt={dir.param} />}
          {rows.length > 0 && (
            <div className="ib-rows">
              {rows.map((row) => (
                <React.Fragment key={k()}>
                  <div className="ib-label">{row.label}</div>
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
          <pre>{codeLines.join("\n")}</pre>
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
     * "::error" opens a coloured rule that runs until a bare "::" closes it,
     * mirroring how ":::" delimits a box. Text on the opening line is included,
     * so a one-liner needs no terminator — an unclosed region simply runs to the
     * end of the block, which is what a writer means by "the rest of this".
     */
    const lineTone = LINE_TONE_RE.exec(line.trim());
    if (lineTone) {
      const tone = lineTone[1];
      const runLines: string[] = [];
      if (lineTone[2].trim()) {
        runLines.push(lineTone[2]);
      }
      i++;
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

    const imgMatch = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line.trim());
    if (imgMatch) {
      const caption = imgMatch[1];
      out.push(
        // Keyed by src so editing text elsewhere never remounts the image.
        <figure key={bk("img", imgMatch[2])} className="wk-img">
          <Asset ctx={ctx} src={imgMatch[2]} alt={plainCaption(caption)} />
          {caption && <figcaption>{renderInline(caption, ctx)}</figcaption>}
        </figure>
      );
      i++;
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      // "::" starts a tone line and ends the paragraph; a bare ":" does not.
      !/^(```|:::|::(?:error|warn|good|tips|muted)\b|#|\^ |>|\||\s*[-*]\s|\s*\d+\.\s|!\[|-{3,}\s*$|\*{3,}\s*$)/.test(
        lines[i]
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
