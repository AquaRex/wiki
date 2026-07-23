/**
 * A line diff, the way a code review shows one: kept lines, added lines and
 * removed lines in their original order.
 *
 * Longest-common-subsequence over lines, which is what git shows too. Pages are
 * small enough that the O(n·m) table is not worth avoiding, but the guard below
 * keeps a pathological page from freezing the tab.
 */
export type DiffKind = "same" | "add" | "remove";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

const MAX_LINES = 4000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];

  // Too big to compare line by line — report it as a wholesale replacement
  // rather than locking up.
  if (a.length * b.length > MAX_LINES * MAX_LINES) {
    return [
      ...a.map((text): DiffLine => ({ kind: "remove", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "remove", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    out.push({ kind: "remove", text: a[i++] });
  }
  while (j < b.length) {
    out.push({ kind: "add", text: b[j++] });
  }
  return out;
}

/**
 * Drops long stretches of unchanged text, keeping `context` lines around each
 * change — the same reason a diff has hunks rather than the whole file.
 * A dropped stretch becomes a single `null` marker.
 */
export function collapseUnchanged(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.kind === "same") {
      return;
    }
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true;
    }
  });

  const out: (DiffLine | null)[] = [];
  let skipping = false;
  lines.forEach((line, i) => {
    if (keep[i]) {
      out.push(line);
      skipping = false;
    } else if (!skipping) {
      out.push(null);
      skipping = true;
    }
  });
  return out;
}
