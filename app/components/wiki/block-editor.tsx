import { useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  ArrowDown,
  ArrowUp,
  Baseline,
  Bold,
  Braces,
  ChevronDown,
  CircleCheck,
  CircleX,
  Clipboard,
  Code,
  Code2,
  Copy,
  FileText,
  GitBranch,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Info,
  Italic,
  Link2,
  List,
  ListOrdered,
  Megaphone,
  MessageSquareWarning,
  Minus,
  PanelRight,
  Pencil,
  Plus,
  Quote,
  Sigma,
  Table2,
  Trash2,
  TriangleAlert,
  X,
  Check,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { renderMarkdown, countH2, extractHeadings, type RenderContext } from "~/lib/markdown";
import { collectTermDefs, collectVariableDefs, newBlockId, resolveTermsForPage, resolveVariablesForPage, type WikiBlock, type WikiPage } from "~/lib/shared";
import { getStore } from "~/lib/store";

type Segment =
  | { kind: "text"; text: string }
  | { kind: "bp"; type: "blueprint" | "material"; inner: string };

/**
 * Splits a block's text into prose and blueprint/material segments. A pasted
 * graph is thousands of characters; in the editor its segment collapses to a
 * one-line box while the prose around it stays a normal editable field. Ordinary
 * blocks come back as a single text segment. Reassembled by joinSegments.
 */
const BP_REGION = /^[ \t]*:::(blueprint|material)\b[^\n]*\n([\s\S]*?)\n[ \t]*:::[ \t]*$/gm;

function splitBlueprintSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  BP_REGION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BP_REGION.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ kind: "text", text: text.slice(last, m.index) });
    }
    segments.push({ kind: "bp", type: m[1] as "blueprint" | "material", inner: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ kind: "text", text: text.slice(last) });
  }
  if (segments.length === 0) {
    segments.push({ kind: "text", text: "" });
  }
  return segments;
}

function joinSegments(segments: Segment[]): string {
  return segments
    .map((s) => (s.kind === "text" ? s.text : `:::${s.type}\n${s.inner}\n:::`))
    .join("");
}

/** True when the block contains at least one blueprint/material region. */
function hasBlueprint(text: string): boolean {
  BP_REGION.lastIndex = 0;
  return BP_REGION.test(text);
}

interface Snippet {
  label: string;
  icon: React.ReactNode;
  /** Inserted when nothing is selected — doubles as a syntax example. */
  text: string;
  /** [before, after] placed around the selection, when there is one. */
  wrap?: [string, string];
  block?: boolean;
  /** Shown in the always-visible row; the rest hide behind "More". */
  core?: boolean;
}

const SNIPPETS: Snippet[] = [
  { label: "Section", icon: <Heading2 className="size-3.5" />, text: "## Section title\n^ Optional kicker line\n\nBody text.", block: true, core: true },
  { label: "Subheading", icon: <Heading3 className="size-3.5" />, text: "### Subheading", block: true, core: true },
  { label: "Bold", icon: <Bold className="size-3.5" />, text: "**bold**", wrap: ["**", "**"], core: true },
  { label: "Italic", icon: <Italic className="size-3.5" />, text: "*italic*", wrap: ["*", "*"], core: true },
  { label: "Code", icon: <Code className="size-3.5" />, text: "`code`", wrap: ["`", "`"], core: true },
  { label: "Accent", icon: <Sigma className="size-3.5" />, text: "==accented term==", wrap: ["==", "=="], core: true },
  { label: "Subtext", icon: <Baseline className="size-3.5" />, text: "^ subtext", block: true, core: true },
  { label: "Wiki link", icon: <Link2 className="size-3.5" />, text: "[[Enemies/Example|label]]", wrap: ["[[", "]]"], core: true },

  // --- inline tones: ":tone[text]" colours just the bracketed words
  { label: ":Error", icon: <CircleX className="size-3.5" />, text: ":error[text]", wrap: [":error[", "]"] },
  { label: ":Warn", icon: <TriangleAlert className="size-3.5" />, text: ":warn[text]", wrap: [":warn[", "]"] },
  { label: ":Good", icon: <CircleCheck className="size-3.5" />, text: ":good[text]", wrap: [":good[", "]"] },
  { label: ":Tip", icon: <Info className="size-3.5" />, text: ":tips[text]", wrap: [":tips[", "]"] },
  { label: ":Muted", icon: <Baseline className="size-3.5" />, text: ":muted[text]", wrap: [":muted[", "]"] },

  // --- structure
  { label: "Divider", icon: <Minus className="size-3.5" />, text: "---", block: true },
  { label: "Quote line", icon: <Quote className="size-3.5" />, text: "> Quoted line", block: true, wrap: ["> ", ""] },
  { label: "Bullets", icon: <List className="size-3.5" />, text: "- First item\n- Second item", block: true },
  { label: "Numbered", icon: <ListOrdered className="size-3.5" />, text: "1. First step\n2. Second step", block: true },
  { label: "Link", icon: <Link2 className="size-3.5" />, text: "[label](https://example.com)", wrap: ["[", "](https://example.com)"] },
  { label: "Head image", icon: <ImageIcon className="size-3.5" />, text: "## Section title ![](/uploads/icon.png)", block: true },
  { label: "Var def", icon: <Braces className="size-3.5" />, text: "{{def:varName=100|What this variable controls}}" },
  { label: "Var def global", icon: <Braces className="size-3.5" />, text: "{{def:global:varName=100|A project-wide default any page can override}}" },
  { label: "Var def styled", icon: <Braces className="size-3.5" />, text: "{{def:varName=100|What it controls|:good[varName] = :white[100]}}" },
  { label: "Var ref", icon: <Braces className="size-3.5" />, text: "{{varName}}" },
  { label: "Term def", icon: <Braces className="size-3.5" />, text: "{{TermDef(Hearing)}}" },
  { label: "Term def global", icon: <Braces className="size-3.5" />, text: "{{TermDef(global:Hearing)}}" },
  { label: "Term note", icon: <Braces className="size-3.5" />, text: "{{TermNote(Hearing|A **formatted** explanation shown on hover)}}" },
  { label: "Term ref", icon: <Braces className="size-3.5" />, text: "{{TermRef(Hearing)}}" },
  { label: "Term ref note", icon: <Braces className="size-3.5" />, text: "{{TermRef(Hearing|A note shown only on this reference)}}" },
  { label: "Value", icon: <Braces className="size-3.5" />, text: "{{0.57|why this value}}" },
  { label: "Value units", icon: <Braces className="size-3.5" />, text: "{{30 u/s}}" },
  { label: "Image", icon: <ImageIcon className="size-3.5" />, text: "![caption](/uploads/example.png)", block: true },
  { label: "Image sized", icon: <ImageIcon className="size-3.5" />, text: "![caption](/uploads/example.png){w=300}", block: true },
  { label: "Image right", icon: <ImageIcon className="size-3.5" />, text: "![caption](/uploads/example.png >){w=260}", block: true },
  { label: "Image full", icon: <ImageIcon className="size-3.5" />, text: "![caption](/uploads/example.png){w=max}", block: true },
  { label: "Code block", icon: <Code2 className="size-3.5" />, text: "```csharp:EnemyAI.cs\n// code here\n```", block: true },
  { label: "Raw text", icon: <FileText className="size-3.5" />, text: "~~~ Label\nPaste raw text here — backticks and any markup are shown verbatim.\n~~~", block: true, wrap: ["~~~\n", "\n~~~"] },
  {
    label: "Table",
    icon: <Table2 className="size-3.5" />,
    text: "| Column | Column |\n| --- | --- |\n| Cell | Cell |",
    block: true,
  },
  // --- line tones: "::tone … ::" puts a coloured rule beside the text
  { label: "::Error", icon: <CircleX className="size-3.5" />, text: "::error\nSomething that went wrong.\n::", block: true, wrap: ["::error\n", "\n::"] },
  { label: "::Warn", icon: <TriangleAlert className="size-3.5" />, text: "::warn\nSomething to be careful about.\n::", block: true, wrap: ["::warn\n", "\n::"] },
  { label: "::Good", icon: <CircleCheck className="size-3.5" />, text: "::good\nConfirmed-safe advice.\n::", block: true, wrap: ["::good\n", "\n::"] },
  { label: "::Tips", icon: <Info className="size-3.5" />, text: "::tips\nSomething helpful.\n::", block: true, wrap: ["::tips\n", "\n::"] },
  { label: "::Muted", icon: <Baseline className="size-3.5" />, text: "::muted\nA quiet aside.\n::", block: true, wrap: ["::muted\n", "\n::"] },

  // --- boxes: ":::type … :::"
  { label: "Callout", icon: <Megaphone className="size-3.5" />, text: ":::callout The core idea\nThe headline statement.\n\nSupporting detail.\n:::", block: true, wrap: [":::callout The core idea\n", "\n:::"] },
  { label: "Quote box", icon: <Quote className="size-3.5" />, text: ":::quote\nDisplayed text or a diagram — **formatting** works and it wraps.\n:::", block: true, wrap: [":::quote\n", "\n:::"] },
  { label: "Note", icon: <MessageSquareWarning className="size-3.5" />, text: ":::note Worth knowing\nA side remark.\n:::", block: true, wrap: [":::note\n", "\n:::"] },
  { label: ":::Error", icon: <CircleX className="size-3.5" />, text: ":::error\n**The mistake.** Why it goes wrong and what to do instead.\n:::", block: true, wrap: [":::error\n", "\n:::"] },
  { label: ":::Warn", icon: <TriangleAlert className="size-3.5" />, text: ":::warn\n**The risk.** What to watch out for.\n:::", block: true, wrap: [":::warn\n", "\n:::"] },
  { label: ":::Good", icon: <CircleCheck className="size-3.5" />, text: ":::good\n**The right way.** Confirmed-safe advice.\n:::", block: true, wrap: [":::good\n", "\n:::"] },
  { label: ":::Tips", icon: <Info className="size-3.5" />, text: ":::tips\n**The tip.** Something helpful that isn't obvious.\n:::", block: true, wrap: [":::tips\n", "\n:::"] },
  {
    label: "Infobox",
    icon: <PanelRight className="size-3.5" />,
    text: ":::infobox Subject name\nimage: /uploads/example.png\nType: Hostile\nHP: {{varName}}\nSpeed: 4.5\nOne-line summary at the bottom.\n:::",
    block: true,
  },
  { label: "Flow", icon: <GitBranch className="size-3.5" />, text: ":::flow\nFirst thing happens\nThen this\nFinally this\n:::", block: true },
  { label: "Steps", icon: <ListOrdered className="size-3.5" />, text: ":::steps\n- **First step** — what to do and why\n- **Second step** — what to do and why\n:::", block: true },
  { label: "Contents", icon: <List className="size-3.5" />, text: ":::contents On this page\n:::", block: true },
  { label: "Contents mini", icon: <PanelRight className="size-3.5" />, text: ":::contents mini(>) On this page\n:::", block: true },
  { label: "Blueprint", icon: <GitBranch className="size-3.5" />, text: ":::blueprint\nPaste copied Unreal Blueprint nodes here.\n:::", block: true, wrap: [":::blueprint\n", "\n:::"] },
  { label: "Material", icon: <GitBranch className="size-3.5" />, text: ":::material\nPaste copied Unreal Material nodes here.\n:::", block: true, wrap: [":::material\n", "\n:::"] },
];

function SnippetButton({ snippet, onInsert }: { snippet: Snippet; onInsert: (s: Snippet) => void }) {
  return (
    <button
      type="button"
      // Keep the textarea's selection: a click would otherwise blur it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onInsert(snippet)}
      title={snippet.label}
      className="flex items-center gap-1 rounded border border-transparent px-1.5 py-1 font-mono text-[10.5px] uppercase tracking-wide text-text-dim hover:border-border hover:bg-surface hover:text-foreground"
    >
      {snippet.icon}
      {snippet.label}
    </button>
  );
}

function useMutatePage(pagePath: string) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);

  const mutate = async (fn: (page: WikiPage) => void): Promise<boolean> => {
    setBusy(true);
    try {
      await getStore().updatePage(pagePath, fn);
      revalidator.revalidate();
      return true;
    } catch (e) {
      alert(e instanceof Error ? e.message : "Saving failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { mutate, busy };
}

/**
 * The collapsed one-line box that stands in for a blueprint/material region in
 * the editor: a truncated preview of the graph text with Copy / Paste / Delete.
 * The full T3D lives in the block but is never shown at length.
 */
function BlueprintBox({
  type,
  inner,
  onReplace,
  onDelete,
}: {
  type: "blueprint" | "material";
  inner: string;
  onReplace: (inner: string) => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // First non-empty line, trimmed to a short teaser — enough to recognise it.
  const teaser = useMemo(() => {
    const firstLine = inner.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    const short = firstLine.length > 52 ? firstLine.slice(0, 52) + "…" : firstLine;
    return short || "empty";
  }, [inner]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inner);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const pasteNew = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        onReplace(text.replace(/\r\n/g, "\n").trim());
      }
    } catch {
      alert("Couldn't read the clipboard. Copy the nodes from Unreal, then try again.");
    }
  };

  return (
    <div className="mx-5 my-2 flex items-center gap-2 rounded-md border border-border bg-code-bg px-3 py-2">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-waccent">
        {type}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-faint" title="Graph text (hidden)">
        [ {teaser} ]
      </span>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          onClick={copy}
          title="Copy the graph text"
          className="flex items-center gap-1 rounded border border-border px-1.5 py-1 font-mono text-[10px] uppercase tracking-wide text-text-dim hover:bg-surface hover:text-foreground"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={pasteNew}
          title="Replace with nodes from the clipboard"
          className="flex items-center gap-1 rounded border border-border px-1.5 py-1 font-mono text-[10px] uppercase tracking-wide text-text-dim hover:bg-surface hover:text-foreground"
        >
          <Clipboard className="size-3" /> Paste
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Remove this graph"
          className="flex items-center rounded border border-transparent px-1.5 py-1 text-text-faint hover:border-border hover:text-crit"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  );
}

/**
 * Edits a block that mixes prose and blueprint/material regions. Prose segments
 * render as auto-growing textareas; each graph region collapses to a BlueprintBox
 * so its huge text never fills the editor. Any edit reassembles the whole draft.
 */
function SegmentedEditor({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const segments = useMemo(() => splitBlueprintSegments(draft), [draft]);

  const replaceSegment = (index: number, next: Segment | null) => {
    const nextSegments = segments.slice();
    if (next === null) {
      nextSegments.splice(index, 1);
    } else {
      nextSegments[index] = next;
    }
    onChange(joinSegments(nextSegments));
  };

  const grow = (el: HTMLTextAreaElement | null) => {
    if (el) {
      el.style.height = "0px";
      el.style.height = el.scrollHeight + 2 + "px";
    }
  };

  return (
    <div className="bg-code-bg py-2">
      {segments.map((seg, i) =>
        seg.kind === "bp" ? (
          <BlueprintBox
            key={i}
            type={seg.type}
            inner={seg.inner}
            onReplace={(inner) => replaceSegment(i, { kind: "bp", type: seg.type, inner })}
            onDelete={() => replaceSegment(i, null)}
          />
        ) : (
          <textarea
            key={i}
            ref={grow}
            value={seg.text}
            onChange={(e) => {
              replaceSegment(i, { kind: "text", text: e.target.value });
              grow(e.target);
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                onSave();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            spellCheck={false}
            placeholder="Text…"
            className="editor-textarea block w-full resize-none bg-transparent px-5 py-1 text-foreground outline-none"
          />
        )
      )}
    </div>
  );
}

function BlockEditorPanel({
  block,
  pagePath,
  ctx,
  h2Start,
  onClose,
}: {
  block: WikiBlock;
  pagePath: string;
  ctx: RenderContext;
  h2Start: number;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(block.text);
  const [showAll, setShowAll] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // The live preview merges variable/term definitions from the CURRENT draft into
  // the page's registry, so a def and its reference written in the same edit
  // resolve immediately instead of appearing "undefined" until the page is saved.
  const previewCtx = useMemo<RenderContext>(() => {
    const draftPage: WikiPage = {
      path: ctx.currentPath,
      title: "",
      header: "",
      eyebrow: "",
      lede: "",
      tags: [],
      blocks: [{ id: block.id, text: draft }],
      updated: "",
      access: "public",
      locked: false,
    };
    // Resolve the draft's own defs for this page so a local def and its reference
    // written in the same edit resolve immediately, locals included.
    const draftVars = resolveVariablesForPage(collectVariableDefs([draftPage]), ctx.currentPath);
    const draftTerms = resolveTermsForPage(collectTermDefs([draftPage]), ctx.currentPath);
    return {
      ...ctx,
      variables: { ...ctx.variables, ...draftVars },
      terms: { ...(ctx.terms ?? {}), ...draftTerms },
    };
  }, [ctx, draft, block.id]);
  const { mutate, busy } = useMutatePage(pagePath);

  // A pasted Unreal graph is thousands of characters long. Let the textarea grow
  // for ordinary prose, but cap it and scroll internally once a block carries one
  // of these directives, so the huge text chunk doesn't swamp the editor.
  const MAX_TEXTAREA_H = 360;
  const isBulky = /^:::(blueprint|material)\b/m.test(draft);

  /**
   * Grows the textarea to fit its content. Measuring requires collapsing the
   * height first, which would scroll the page; pinning the element's viewport
   * position across the measure and correcting for any drift keeps the caret
   * where the author left it.
   */
  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    const before = el.getBoundingClientRect().top;
    el.style.height = "0px";
    const full = el.scrollHeight + 4;
    el.style.height = (isBulky ? Math.min(full, MAX_TEXTAREA_H) : full) + "px";
    el.style.overflowY = isBulky && full > MAX_TEXTAREA_H ? "auto" : "hidden";
    const drift = el.getBoundingClientRect().top - before;
    if (drift !== 0) {
      window.scrollBy({ top: drift, behavior: "instant" as ScrollBehavior });
    }
  };

  const mountTextarea = (el: HTMLTextAreaElement | null) => {
    (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    if (el && !el.dataset.mounted) {
      el.dataset.mounted = "1";
      const full = el.scrollHeight + 4;
      el.style.height = (isBulky ? Math.min(full, MAX_TEXTAREA_H) : full) + "px";
      el.style.overflowY = isBulky && full > MAX_TEXTAREA_H ? "auto" : "hidden";
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  };

  /**
   * Applies a snippet. With text selected, a snippet that defines a wrap keeps
   * the selection and formats around it; otherwise the snippet's sample text is
   * inserted so the button still teaches the syntax.
   */
  const insert = (snippet: Snippet) => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = draft.slice(start, end);
    const before = draft.slice(0, start);
    const after = draft.slice(end);

    let text: string;
    let selectFrom: number;
    let selectTo: number;

    if (selected && snippet.wrap) {
      const [open, close] = snippet.wrap;
      text = open + selected + close;
      // Keep the original text selected, now inside its new markers.
      selectFrom = start + open.length;
      selectTo = selectFrom + selected.length;
    } else {
      text = snippet.text;
      selectFrom = start + text.length;
      selectTo = selectFrom;
    }

    if (snippet.block) {
      const lead = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
      const tail = after.startsWith("\n") ? "" : "\n";
      text = lead + text + tail;
      selectFrom += lead.length;
      selectTo += lead.length;
    }

    /*
     * Written through execCommand rather than setDraft so the browser records
     * it on the textarea's native undo stack — Ctrl+Z then steps back through
     * toolbar insertions exactly like typed text. Setting value directly would
     * wipe that history. execCommand is deprecated but remains the only way to
     * write to a field undoably; if it's unavailable we fall back to setDraft
     * and lose only the undo entry.
     */
    el.focus();
    el.setSelectionRange(start, end);
    const inserted = document.execCommand?.("insertText", false, text);
    if (!inserted) {
      setDraft(before + text + after);
    }
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selectFrom, selectTo);
      autoGrow();
    });
  };

  const insertImage = async (file: File) => {
    try {
      const url = await getStore().uploadImage(file, pagePath);
      insert({ label: "", icon: null, text: `![caption](${url})`, block: true });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Image upload failed.");
    }
  };

  const save = async () => {
    const ok = await mutate((page) => {
      const target = page.blocks.find((b) => b.id === block.id);
      if (target) {
        target.text = draft;
      }
    });
    if (ok) {
      onClose();
    }
  };

  // When the block carries a blueprint/material region, edit it as segments: the
  // graph text collapses to a one-line box while prose around it stays editable.
  if (hasBlueprint(draft)) {
    return (
      <div className="my-4 rounded-lg border border-accent-line bg-surface shadow-lg">
        <SegmentedEditor draft={draft} onChange={setDraft} onSave={save} onCancel={onClose} />
        <div className="wiki border-t border-border px-5 pb-4 pt-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-faint">Preview</div>
          {renderMarkdown(draft, previewCtx, h2Start)}
          <div className="clear-both" />
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-faint">
            Graph text is collapsed · Ctrl+Enter to save · Esc to cancel
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="xs" onClick={onClose} disabled={busy}>
              <X className="size-3" /> Cancel
            </Button>
            <Button size="xs" onClick={save} disabled={busy}>
              <Check className="size-3" /> {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="my-4 rounded-lg border border-accent-line bg-surface shadow-lg">
      <div className="border-b border-border bg-surface-2 px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {SNIPPETS.filter((s) => s.core).map((snippet) => (
            <SnippetButton key={snippet.label} snippet={snippet} onInsert={insert} />
          ))}
          <label
            title="Upload image"
            className="flex cursor-pointer items-center gap-1 rounded border border-transparent px-1.5 py-1 font-mono text-[10.5px] uppercase tracking-wide text-text-dim hover:border-border hover:bg-surface hover:text-foreground"
          >
            <ImageIcon className="size-3.5" />
            Image
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  insertImage(file);
                }
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            title={showAll ? "Fewer options" : "More options"}
            className="ml-auto flex items-center gap-1 rounded border border-transparent px-1.5 py-1 font-mono text-[10.5px] uppercase tracking-wide text-text-faint hover:border-border hover:bg-surface hover:text-foreground"
          >
            {showAll ? "Less" : "More"}
            <ChevronDown className={`size-3.5 transition-transform ${showAll ? "rotate-180" : ""}`} />
          </button>
        </div>
        {showAll && (
          <div className="mt-1 flex flex-wrap gap-1 border-t border-border pt-1.5">
            {SNIPPETS.filter((s) => !s.core).map((snippet) => (
              <SnippetButton key={snippet.label} snippet={snippet} onInsert={insert} />
            ))}
          </div>
        )}
      </div>
      <textarea
        ref={mountTextarea}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autoGrow();
        }}
        onPaste={(e) => {
          const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
          if (file) {
            e.preventDefault();
            insertImage(file);
          }
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        spellCheck={false}
        className="editor-textarea block w-full resize-none bg-code-bg px-5 py-4 text-foreground outline-none"
      />
      <div ref={previewRef} className="wiki border-t border-border px-5 pb-4 pt-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-faint">Preview</div>
        {renderMarkdown(draft, previewCtx, h2Start)}
        <div className="clear-both" />
      </div>
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-faint">
          Live preview below · Ctrl+Enter to save · Esc to cancel · paste images directly
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="xs" onClick={onClose} disabled={busy}>
            <X className="size-3" /> Cancel
          </Button>
          <Button size="xs" onClick={save} disabled={busy}>
            <Check className="size-3" /> {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddBlockButton({ pagePath, afterId }: { pagePath: string; afterId: string }) {
  const { mutate, busy } = useMutatePage(pagePath);

  const add = () =>
    mutate((page) => {
      const block = { id: newBlockId(), text: "New block — double-click to edit." };
      if (afterId === "__start__") {
        page.blocks.unshift(block);
      } else {
        const index = page.blocks.findIndex((b) => b.id === afterId);
        page.blocks.splice(index === -1 ? page.blocks.length : index + 1, 0, block);
      }
    });

  return (
    <div className="group/add relative -my-2 flex h-5 items-center justify-center">
      <button
        type="button"
        onClick={add}
        disabled={busy}
        className="z-10 flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-faint opacity-0 shadow-sm transition-opacity hover:border-accent-line hover:text-waccent group-hover/add:opacity-100"
      >
        <Plus className="size-3" /> Add block
      </button>
      <div className="absolute inset-x-0 top-1/2 h-px bg-border opacity-0 transition-opacity group-hover/add:opacity-100" />
    </div>
  );
}

export function BlockList({
  blocks,
  pagePath,
  ctx,
  editUnlocked,
}: {
  blocks: WikiBlock[];
  pagePath: string;
  ctx: RenderContext;
  editUnlocked: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const { mutate } = useMutatePage(pagePath);

  // The whole page's headings, so any block's :::contents box can list them.
  // Recomputed only when the blocks' text changes.
  const pageCtx = useMemo<RenderContext>(() => {
    let h2 = 0;
    const headings = blocks.flatMap((block) => {
      const start = h2;
      h2 += countH2(block.text);
      return extractHeadings(block.text, start);
    });
    return { ...ctx, headings };
  }, [ctx, blocks]);

  let h2Count = 0;

  if (!editUnlocked) {
    return (
      <div className="wiki">
        {blocks.map((block) => {
          const start = h2Count;
          h2Count += countH2(block.text);
          // display:contents — the wrapper adds no box, so a float in one block
          // escapes into the next and following boxes flow beside it.
          return (
            <div key={block.id} className="wiki-block">
              {renderMarkdown(block.text, pageCtx, start)}
            </div>
          );
        })}
        <div className="clear-both" />
      </div>
    );
  }

  const moveBlock = (blockId: string, dir: number) =>
    mutate((page) => {
      const index = page.blocks.findIndex((b) => b.id === blockId);
      const target = index + dir;
      if (index !== -1 && target >= 0 && target < page.blocks.length) {
        const [block] = page.blocks.splice(index, 1);
        page.blocks.splice(target, 0, block);
      }
    });

  const deleteBlock = (blockId: string) => {
    if (confirm("Delete this block?")) {
      mutate((page) => {
        page.blocks = page.blocks.filter((b) => b.id !== blockId);
      });
    }
  };

  return (
    <div className="wiki">
      <AddBlockButton pagePath={pagePath} afterId="__start__" />
      {blocks.map((block, index) => {
        const start = h2Count;
        h2Count += countH2(block.text);
        return (
          <div key={block.id}>
            {editingId === block.id ? (
              <BlockEditorPanel block={block} pagePath={pagePath} ctx={pageCtx} h2Start={start} onClose={() => setEditingId(null)} />
            ) : (
              <div className="edit-block" onDoubleClick={() => setEditingId(block.id)}>
                <div className="block-tools absolute -top-3 right-2 z-20 flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-md">
                  <Button variant="ghost" size="icon-xs" title="Edit block" onClick={() => setEditingId(block.id)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-xs" title="Move up" disabled={index === 0} onClick={() => moveBlock(block.id, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Move down"
                    disabled={index === blocks.length - 1}
                    onClick={() => moveBlock(block.id, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button variant="ghost" size="icon-xs" title="Delete block" className="text-crit" onClick={() => deleteBlock(block.id)}>
                    <Trash2 />
                  </Button>
                </div>
                {renderMarkdown(block.text, pageCtx, start)}
              </div>
            )}
            <AddBlockButton pagePath={pagePath} afterId={block.id} />
          </div>
        );
      })}
      <div className="clear-both" />
    </div>
  );
}
