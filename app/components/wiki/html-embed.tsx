import { useEffect, useRef, useState } from "react";

export interface HtmlEmbedProps {
  html: string;
  /** Fixed box width in px; null fills the available width. */
  width: number | null;
  /** Fixed box height in px; null lets the content report its own height. */
  height: number | null;
  /** Scale the whole document to fit the box instead of scrolling. */
  noscroll: boolean;
  /** Logical "device" width to render at, then scale into the box (phone preview). */
  device: number | null;
  /** Break out of the wiki column to fill the whole content area. In this mode
   *  `width`/`height` are read as horizontal/vertical padding, not a size. */
  full: boolean;
  /** In the editor's live preview we don't auto-run — a heavy script would restart
   *  on every keystroke — so we show a click-to-run placeholder instead. */
  editing?: boolean;
}

/**
 * A small script appended to the embedded document so the parent can size the
 * frame without needing same-origin access (the sandbox withholds it). It only
 * ever posts two numbers, which the parent reads and nothing else.
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

export function HtmlEmbed({ html, width, height, noscroll, device, full, editing }: HtmlEmbedProps) {
  const [run, setRun] = useState(!editing);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [content, setContent] = useState({ w: 0, h: 0 });

  useEffect(() => {
    setRun(!editing);
  }, [editing, html]);

  useEffect(() => {
    if (!run) {
      return;
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
  }, [run]);

  if (!run) {
    const lines = html.split("\n").length;
    return (
      <div className="html-embed">
        <button type="button" className="html-embed-ph" onClick={() => setRun(true)}>
          <span className="html-embed-ph-run">▷ Run HTML</span>
          <span className="html-embed-ph-meta">embedded document · {lines} lines · sandboxed</span>
        </button>
      </div>
    );
  }

  const srcDoc = withReporter(html);
  const scaled = noscroll || device != null;

  // Full-bleed: break out of the wiki column (CSS handles the width/offset) and
  // fill the content area. width/height are re-read as side / top-bottom padding.
  if (full) {
    const padX = width != null ? width : 0;
    const padY = height != null ? height : 0;
    return (
      <div className="html-embed full" style={{ padding: `${padY}px ${padX}px` }}>
        <iframe
          ref={frameRef}
          className="html-embed-frame"
          title="Embedded HTML"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          style={{ width: "100%", height: content.h ? content.h : 480 }}
        />
      </div>
    );
  }

  // Phone-style preview: render at a logical device width and scale that to fit
  // the box width. The frame keeps a real viewport, so the page lays out
  // responsively and scrolls inside its "screen" if taller.
  if (device != null && width != null && height != null) {
    const scale = width / device;
    const logicalH = height / scale;
    return (
      <div className="html-embed" style={{ width }}>
        <div className="html-embed-clip" style={{ width, height }}>
          <iframe
            ref={frameRef}
            className="html-embed-frame"
            title="Embedded HTML"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            style={{
              width: device,
              height: logicalH,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          />
        </div>
      </div>
    );
  }

  // Fit-to-box: shrink the whole document so it fits inside the box with no
  // scrollbars. Needs the reported content size, so it snaps in once measured.
  if (scaled && width != null && height != null) {
    const scale = content.w && content.h ? Math.min(width / content.w, height / content.h) : 1;
    return (
      <div className="html-embed" style={{ width }}>
        <div className="html-embed-clip" style={{ width, height }}>
          <iframe
            ref={frameRef}
            className="html-embed-frame"
            title="Embedded HTML"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            style={{
              width: content.w || width,
              height: content.h || height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          />
        </div>
      </div>
    );
  }

  // Fixed box that scrolls, or auto-height that fills the width.
  const style: React.CSSProperties = {};
  style.width = width != null ? width : "100%";
  style.height = height != null ? height : content.h ? content.h : 480;
  return (
    <div className="html-embed" style={width != null ? { width } : undefined}>
      <iframe
        ref={frameRef}
        className="html-embed-frame"
        title="Embedded HTML"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={style}
      />
    </div>
  );
}
