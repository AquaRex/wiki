import { useEffect, useRef, useState } from "react";

export interface HtmlEmbedProps {
  /** Inline HTML document to render (from :::html). */
  html?: string;
  /** External URL to load live (from :::embed). Mutually exclusive with `html`. */
  src?: string;
  /** Fixed box width in px; null fills the available width. */
  width: number | null;
  /** Fixed box height in px; null lets the content report its own height. */
  height: number | null;
  /** Scale the whole document to fit the box instead of scrolling. */
  noscroll: boolean;
  /** Logical "device" width to render at, then scale into the box (phone preview). */
  device: number | null;
  /** Break out of the wiki column to fill the whole content area (auto width). */
  full: boolean;
  /** Inner padding in px — side padding / top-bottom padding. */
  padX?: number;
  padY?: number;
  /** Horizontal placement of a fixed-width embed within the column. */
  align?: "left" | "center" | "right";
  /** In the editor's live preview we don't auto-run — a heavy script would restart
   *  on every keystroke — so we show a click-to-run placeholder instead. */
  editing?: boolean;
}

/**
 * A small script appended to an inline document so the parent can size the frame
 * without needing same-origin access (the sandbox withholds it). It only ever
 * posts two numbers, which the parent reads and nothing else. Not usable for an
 * external URL — a cross-origin frame can't be measured, so those keep a set height.
 */
const SIZE_REPORTER = `
<script>
(function(){
  function size(){
    var d=document.documentElement, b=document.body||d;
    var w=Math.max(d.scrollWidth, b.scrollWidth||0);
    var h=Math.max(d.scrollHeight, b.scrollHeight||0);
    try{ parent.postMessage({__wikiHtmlSize:1, w:w, h:h}, "*"); }catch(e){}
  }
  window.addEventListener("load", size);
  window.addEventListener("resize", size);
  if(window.ResizeObserver && document.body){ new ResizeObserver(size).observe(document.body); }
  setTimeout(size,60); setTimeout(size,300); setInterval(size,1500);
})();
<\/script>`;

function withReporter(html: string): string {
  const close = html.lastIndexOf("</body>");
  if (close >= 0) {
    return html.slice(0, close) + SIZE_REPORTER + html.slice(close);
  }
  return html + SIZE_REPORTER;
}

const DEFAULT_H = 480;

export function HtmlEmbed({ html, src, width, height, noscroll, device, full, padX = 0, padY = 0, align, editing }: HtmlEmbedProps) {
  const external = src != null;
  const wrapCls = align && align !== "left" ? `html-embed h-${align}` : "html-embed";
  const validSrc = external && /^https?:\/\//i.test(src ?? "");
  const [run, setRun] = useState(!editing);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [content, setContent] = useState({ w: 0, h: 0 });

  useEffect(() => {
    setRun(!editing);
  }, [editing, html, src]);

  useEffect(() => {
    if (!run || external) {
      return; // an external cross-origin frame can't post its size back
    }
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) {
        return;
      }
      const d = e.data;
      if (d && d.__wikiHtmlSize) {
        setContent({ w: Number(d.w) || 0, h: Number(d.h) || 0 });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [run, external]);

  if (external && !validSrc) {
    return (
      <div className="html-embed">
        <div className="html-embed-ph">
          <span className="html-embed-ph-run">Invalid embed URL</span>
          <span className="html-embed-ph-meta">only http(s) URLs can be embedded</span>
        </div>
      </div>
    );
  }

  if (!run) {
    const meta = external ? src : `embedded document · ${(html ?? "").split("\n").length} lines`;
    return (
      <div className="html-embed">
        <button type="button" className="html-embed-ph" onClick={() => setRun(true)}>
          <span className="html-embed-ph-run">▷ {external ? "Load site" : "Run HTML"}</span>
          <span className="html-embed-ph-meta">{meta} · sandboxed</span>
        </button>
      </div>
    );
  }

  // One frame element for every mode, sourced from a URL or inline HTML. An
  // external URL keeps a permissive-but-capped sandbox (its scripts/login work,
  // but it can't navigate the wiki away); inline HTML is origin-isolated.
  const renderFrame = (style: React.CSSProperties) =>
    external ? (
      <iframe
        ref={frameRef}
        className="html-embed-frame"
        title="Embedded site"
        src={src}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-pointer-lock"
        allow="fullscreen"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        style={style}
      />
    ) : (
      <iframe
        ref={frameRef}
        className="html-embed-frame"
        title="Embedded HTML"
        sandbox="allow-scripts"
        srcDoc={withReporter(html ?? "")}
        style={style}
      />
    );

  const scaled = noscroll || device != null;

  // Full-bleed: break out of the wiki column (CSS handles the width/offset) and
  // fill the content area. Height is fixed when given, else auto/default; padX/padY
  // pad the inside.
  if (full) {
    const h = height != null ? height : content.h || DEFAULT_H;
    return (
      <div className="html-embed full" style={{ padding: `${padY}px ${padX}px` }}>
        {renderFrame({ width: "100%", height: h })}
      </div>
    );
  }

  // Phone-style preview: render at a logical device width and scale that to fit
  // the box width. The frame keeps a real viewport, so the page lays out
  // responsively and scrolls inside its "screen" if taller.
  if (device != null && width != null && height != null) {
    const scale = width / device;
    return (
      <div className={wrapCls} style={{ width }}>
        <div className="html-embed-clip" style={{ width, height }}>
          {renderFrame({ width: device, height: height / scale, transform: `scale(${scale})`, transformOrigin: "top left" })}
        </div>
      </div>
    );
  }

  // Fit-to-box: shrink the whole document so it fits inside the box with no
  // scrollbars. Needs the reported content size (inline HTML only), so it snaps
  // in once measured; an external URL can't be measured and stays at scale 1.
  if (scaled && width != null && height != null) {
    const scale = content.w && content.h ? Math.min(width / content.w, height / content.h) : 1;
    return (
      <div className={wrapCls} style={{ width }}>
        <div className="html-embed-clip" style={{ width, height }}>
          {renderFrame({ width: content.w || width, height: content.h || height, transform: `scale(${scale})`, transformOrigin: "top left" })}
        </div>
      </div>
    );
  }

  // Fixed box that scrolls, or auto-height that fills the width. An external URL
  // has no measured height, so auto falls back to DEFAULT_H — set (h=…) to size it.
  const boxStyle: React.CSSProperties = { padding: padX || padY ? `${padY}px ${padX}px` : undefined };
  if (width != null) {
    boxStyle.width = width;
  }
  return (
    <div className={wrapCls} style={boxStyle}>
      {renderFrame({ width: width != null ? width : "100%", height: height != null ? height : content.h || DEFAULT_H })}
    </div>
  );
}
