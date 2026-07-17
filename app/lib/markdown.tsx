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
 * Renders an image whose URL has to be resolved asynchronously. Markdown
 * rendering is synchronous, so the resolution happens here rather than being
 * awaited up front.
 */
function Asset({
  ctx,
  src,
  alt,
  style,
}: {
  ctx: RenderContext;
  src: string;
  alt: string;
  style?: React.CSSProperties;
}) {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!ctx.resolveAsset) {
      setResolved(src);
      return;
    }
    ctx
      .resolveAsset(src)
      .then((url) => {
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
  }, [ctx, src]);

  if (!resolved) {
    return <span className="inline-block h-4 w-4 animate-pulse rounded bg-surface-2" aria-hidden />;
  }
  return <img src={resolved} alt={alt} style={style} />;
}

let keyCounter = 0;
function k(): number {
  return keyCounter++;
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
].join("|");

const DEF_INNER_RE = /^\{\{def:([A-Za-z0-9_.-]+)\s*=\s*([^|}]*?)\s*(?:\|\s*([^}]*?)\s*)?\}\}$/;

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
      out.push(<Asset key={k()} ctx={ctx} src={im[2]} alt={im[1]} style={{ maxWidth: "100%" }} />);
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
          {body
            .join("\n")
            .split(/\n{2,}/)
            .filter((s) => s.trim())
            .map((para) => (
              <p key={k()}>{renderInline(para.replace(/\n/g, " "), ctx)}</p>
            ))}
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
      const text = [dir.param, ...body].filter(Boolean).join("\n");
      return (
        <div key={k()} className={`callout-box ${kind === "error" ? "" : kind}`.trim()}>
          <span className="icon">{CALLOUT_ICONS[kind]}</span>
          <p>{renderInline(text.replace(/\n/g, " "), ctx)}</p>
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

export function renderMarkdown(text: string, ctx: RenderContext, h2Start = 0): React.ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
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
        <div key={k()} className="code">
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
      while (i < lines.length && lines[i].trim() !== ":::") {
        dirLines.push(lines[i]);
        i++;
      }
      i++;
      out.push(renderDirective({ type: headMatch ? headMatch[1].toLowerCase() : "note", param: headMatch ? headMatch[2].trim() : "", lines: dirLines }, ctx));
      continue;
    }

    if (line.startsWith("#### ")) {
      out.push(
        <h4 key={k()} className="wk-h3" id={slugify(line.slice(5))}>
          {renderInline(line.slice(5), ctx)}
        </h4>
      );
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      out.push(
        <h3 key={k()} className="wk-h3" id={slugify(line.slice(4))}>
          {renderInline(line.slice(4), ctx)}
        </h3>
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      h2Index++;
      out.push(
        <h2 key={k()} className="wk-h2" id={slugify(line.slice(3))}>
          <span className="num">{String(h2Index).padStart(2, "0")}</span>
          <span>{renderInline(line.slice(3), ctx)}</span>
        </h2>
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(
        <h2 key={k()} className="wk-h2" id={slugify(line.slice(2))}>
          {renderInline(line.slice(2), ctx)}
        </h2>
      );
      i++;
      continue;
    }

    if (line.startsWith("^ ")) {
      out.push(
        <p key={k()} className="kicker">
          {renderInline(line.slice(2), ctx)}
        </p>
      );
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={k()} />);
      i++;
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
      out.push(<blockquote key={k()}>{renderInline(quoteLines.join(" "), ctx)}</blockquote>);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={k()}>
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
        <ol key={k()}>
          {items.map((item) => (
            <li key={k()}>{renderInline(item, ctx)}</li>
          ))}
        </ol>
      );
      continue;
    }

    const imgMatch = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line.trim());
    if (imgMatch) {
      out.push(
        <figure key={k()} className="wk-img">
          <Asset ctx={ctx} src={imgMatch[2]} alt={imgMatch[1]} />
          {imgMatch[1] && <figcaption>{imgMatch[1]}</figcaption>}
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
      !/^(```|:::|#|\^ |>|\||\s*[-*]\s|\s*\d+\.\s|!\[)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(<p key={k()}>{renderInline(paraLines.join(" "), ctx)}</p>);
  }

  return <>{out}</>;
}
