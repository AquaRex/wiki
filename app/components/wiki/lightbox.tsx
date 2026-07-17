import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/*
 * A single, app-wide image lightbox. Any image opens it via openLightbox(); the
 * <Lightbox /> element mounted once at the app root renders the overlay. Kept as
 * a tiny external store rather than context so the synchronous markdown renderer
 * can trigger it from a plain onClick without threading a provider through.
 */

interface LightboxState {
  src: string;
  alt: string;
}

let current: LightboxState | null = null;
const listeners = new Set<() => void>();

export function openLightbox(src: string, alt: string) {
  current = { src, alt };
  listeners.forEach((l) => l());
}

function closeLightbox() {
  if (!current) {
    return; // idempotent — a second close (e.g. bubbled event) is a no-op
  }
  current = null;
  listeners.forEach((l) => l());
}

/*
 * The image is absolutely placed at the stage's top-left with transform-origin
 * 0 0, so a translate+scale is a plain affine map from image space to stage
 * pixels. That keeps the cursor-anchored zoom maths simple and correct — the
 * point under the cursor stays put because we solve for the translate that keeps
 * (cursorImagePoint) fixed on screen.
 */
interface View {
  scale: number;
  x: number;
  y: number;
}

export function Lightbox() {
  const [state, setState] = useState<LightboxState | null>(current);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  // Subscribe to the external store.
  useEffect(() => {
    const update = () => setState(current);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);

  // Centre the image in the stage at its natural (max) size — the initial fit.
  const fit = useCallback(() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img || !img.naturalWidth) {
      return;
    }
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    // Fit the natural image inside the stage with a small margin, never upscaling.
    const scale = Math.min(1, (sw * 0.94) / img.naturalWidth, (sh * 0.94) / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    setView({ scale, x: (sw - w) / 2, y: (sh - h) / 2 });
  }, []);

  // Lock body scroll while open; reset when the image changes.
  useEffect(() => {
    if (!state) {
      return;
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [state]);

  // Esc closes.
  useEffect(() => {
    if (!state) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeLightbox();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  // Non-passive wheel so zooming doesn't scroll the page behind the overlay.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !state) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const v = viewRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(8, Math.max(0.2, v.scale * factor));
      // The image point currently under the cursor must stay under the cursor.
      setView({
        scale: next,
        x: px - ((px - v.x) / v.scale) * next,
        y: py - ((py - v.y) / v.scale) * next,
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [state]);

  // Fit once the image (and stage) are laid out.
  useLayoutEffect(() => {
    if (state && imgRef.current?.complete) {
      fit();
    }
  }, [state, fit]);

  if (!state) {
    return null;
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    pan.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone — ignore */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (p) {
      setView((v) => ({ ...v, x: p.vx + (e.clientX - p.sx), y: p.vy + (e.clientY - p.sy) }));
    }
  };
  const onPointerUp = () => {
    pan.current = null;
  };

  return (
    <div
      className="wk-lightbox"
      onPointerDown={(e) => {
        // Press on the empty backdrop (not the image) closes.
        if (e.target === e.currentTarget) {
          closeLightbox();
        }
      }}
    >
      <button
        type="button"
        className="wk-lightbox-close"
        onClick={(e) => {
          e.stopPropagation();
          closeLightbox();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Close"
      >
        ✕
      </button>
      <div
        ref={stageRef}
        className="wk-lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={fit}
      >
        <img
          ref={imgRef}
          className="wk-lightbox-img"
          src={state.src}
          alt={state.alt}
          draggable={false}
          onLoad={fit}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      <div className="wk-lightbox-hint">Scroll to zoom · drag to pan · double-click to reset · Esc to close</div>
    </div>
  );
}
