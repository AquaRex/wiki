import { initialsOf } from "~/lib/auth";

/**
 * A round initials badge. There are no uploaded profile pictures — initials are
 * enough to tell people apart in a byline or a user list, and cost nothing.
 *
 * The colour is derived from the name, so the same person is always the same
 * colour without anyone choosing one.
 */
export function Avatar({ name, size = 28, className = "" }: { name: string; size?: number; className?: string }) {
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-mono font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `oklch(0.62 0.11 ${hue} / 0.22)`,
        color: `oklch(0.72 0.13 ${hue})`,
        border: `1px solid oklch(0.62 0.11 ${hue} / 0.45)`,
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
