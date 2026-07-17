import { useEffect, useRef, useState } from "react";

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
  current = null;
  listeners.forEach((l) => l());
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

export function Lightbox() {
  const [state, setState] = useState<LightboxState | null>(current);
  const [view, setView] = useState<View>(FIT);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  // Subscribe to the external store.
  useEffect(() => {
    const update = () => setState(current);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);

  // Reset zoom/pan each time a new image opens, and lock body scroll while open.
  useEffect(() => {
    if (state) {
      setView(FIT);
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
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
    const el = wrapRef.current;
    if (!el || !state) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = Math.min(8, Math.max(1, v.scale * factor));
        // Keep the point under the cursor fixed while zooming.
        return {
          scale: next,
          x: px - ((px - v.x) / v.scale) * next,
          y: py - ((py - v.y) / v.scale) * next,
        };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [state]);

  if (!state) {
    return null;
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (pan.current) {
      setView((v) => ({ ...v, x: pan.current!.vx + (e.clientX - pan.current!.sx), y: pan.current!.vy + (e.clientY - pan.current!.sy) }));
    }
  };
  const onPointerUp = () => {
    pan.current = null;
  };

  return (
    <div
      className="wk-lightbox"
      onClick={(e) => {
        // Click the backdrop (not the image) to close.
        if (e.target === e.currentTarget) {
          closeLightbox();
        }
      }}
    >
      <button type="button" className="wk-lightbox-close" onClick={closeLightbox} aria-label="Close">
        ✕
      </button>
      <div
        ref={wrapRef}
        className="wk-lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setView(FIT)}
      >
        <img
          className="wk-lightbox-img"
          src={state.src}
          alt={state.alt}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      <div className="wk-lightbox-hint">Scroll to zoom · drag to pan · double-click to reset · Esc to close</div>
    </div>
  );
}
