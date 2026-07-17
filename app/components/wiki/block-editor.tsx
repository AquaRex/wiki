import { useEffect, useRef, useState } from "react";
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
  Code,
  Code2,
  GitBranch,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Info,
  Italic,
  Link2,
  ListOrdered,
  MessageSquareWarning,
  PanelRight,
  Pencil,
  Plus,
  Sigma,
  Table2,
  Trash2,
  TriangleAlert,
  X,
  Check,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { renderMarkdown, countH2, type RenderContext } from "~/lib/markdown";
import { newBlockId, type WikiBlock, type WikiPage } from "~/lib/shared";
import { getStore } from "~/lib/store";

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
  { label: "Term", icon: <Sigma className="size-3.5" />, text: "==highlighted term==", wrap: ["==", "=="], core: true },
  { label: "Subtext", icon: <Baseline className="size-3.5" />, text: "^ subtext", block: true, core: true },
  { label: "Error", icon: <CircleX className="size-3.5" />, text: ":error text", wrap: [":error ", ""] },
  { label: "Warn", icon: <TriangleAlert className="size-3.5" />, text: ":warn text", wrap: [":warn ", ""] },
  { label: "Good", icon: <CircleCheck className="size-3.5" />, text: ":good text", wrap: [":good ", ""] },
  { label: "Tip", icon: <Info className="size-3.5" />, text: ":tips text", wrap: [":tips ", ""] },
  { label: "Muted", icon: <Baseline className="size-3.5" />, text: ":muted text", wrap: [":muted ", ""] },
  { label: "Wiki link", icon: <Link2 className="size-3.5" />, text: "[[Enemies/Example|label]]", wrap: ["[[", "]]"], core: true },
  { label: "Link", icon: <Link2 className="size-3.5" />, text: "[label](https://example.com)", wrap: ["[", "](https://example.com)"] },
  { label: "Var def", icon: <Braces className="size-3.5" />, text: "{{def:varName=100|What this variable controls}}" },
  { label: "Var ref", icon: <Braces className="size-3.5" />, text: "{{varName|shown text}}" },
  { label: "Value", icon: <Braces className="size-3.5" />, text: "{{0.57|why this value}}" },
  { label: "Code", icon: <Code2 className="size-3.5" />, text: "```csharp:EnemyAI.cs\n// code here\n```", block: true },
  {
    label: "Table",
    icon: <Table2 className="size-3.5" />,
    text: "| Column | Column |\n| --- | --- |\n| Cell | Cell |",
    block: true,
  },
  { label: "Callout", icon: <Info className="size-3.5" />, text: ":::callout The core idea\nThe headline statement.\n\nSupporting detail.\n:::", block: true },
  { label: "Note", icon: <MessageSquareWarning className="size-3.5" />, text: ":::note Worth knowing\nA side remark.\n:::", block: true, wrap: [":::note\n", "\n:::"] },
  { label: "Tips box", icon: <Info className="size-3.5" />, text: ":::tips\n**The tip.** Something helpful that isn't obvious.\n:::", block: true, wrap: [":::tips\n", "\n:::"] },
  { label: "Error box", icon: <TriangleAlert className="size-3.5" />, text: ":::error\n**The mistake.** Why it goes wrong and what to do instead.\n:::", block: true, wrap: [":::error\n", "\n:::"] },
  { label: "Error line", icon: <CircleX className="size-3.5" />, text: "::error Something that went wrong.", block: true, wrap: ["::error ", ""] },
  { label: "Warn line", icon: <TriangleAlert className="size-3.5" />, text: "::warn Something to be careful about.", block: true, wrap: ["::warn ", ""] },
  { label: "Tips line", icon: <Info className="size-3.5" />, text: "::tips Something helpful.", block: true, wrap: ["::tips ", ""] },
  {
    label: "Infobox",
    icon: <PanelRight className="size-3.5" />,
    text: ":::infobox Subject name\nimage: /uploads/example.png\nType: Hostile\nHP: {{varName}}\nSpeed: 4.5\nOne-line summary at the bottom.\n:::",
    block: true,
  },
  { label: "Flow", icon: <GitBranch className="size-3.5" />, text: ":::flow\nFirst thing happens\nThen this\nFinally this\n:::", block: true },
  { label: "Steps", icon: <ListOrdered className="size-3.5" />, text: ":::steps\n- **First step** — what to do and why\n- **Second step** — what to do and why\n:::", block: true },
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
  const { mutate, busy } = useMutatePage(pagePath);

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
    el.style.height = el.scrollHeight + 4 + "px";
    const drift = el.getBoundingClientRect().top - before;
    if (drift !== 0) {
      window.scrollBy({ top: drift, behavior: "instant" as ScrollBehavior });
    }
  };

  const mountTextarea = (el: HTMLTextAreaElement | null) => {
    (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    if (el && !el.dataset.mounted) {
      el.dataset.mounted = "1";
      el.style.height = el.scrollHeight + 4 + "px";
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  };

  /**
   * The live preview sits above the textarea, so anything that changes its
   * height — a new block, an image finishing loading — pushes the textarea
   * down mid-keystroke. Watch it and hold the textarea still instead.
   */
  useEffect(() => {
    const el = textareaRef.current;
    const preview = previewRef.current;
    if (!el || !preview) {
      return;
    }
    let last = el.getBoundingClientRect().top;
    const observer = new ResizeObserver(() => {
      const now = el.getBoundingClientRect().top;
      const drift = now - last;
      // Only correct while the author is actually typing in this block.
      if (drift !== 0 && document.activeElement === el) {
        window.scrollBy({ top: drift, behavior: "instant" as ScrollBehavior });
        last = el.getBoundingClientRect().top;
      } else {
        last = now;
      }
    });
    observer.observe(preview);
    return () => observer.disconnect();
  }, []);

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

    setDraft(before + text + after);
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

  return (
    <div className="my-4 rounded-lg border border-accent-line bg-surface shadow-lg">
      <div ref={previewRef} className="wiki border-b border-border px-5 pb-4 pt-1">
        {renderMarkdown(draft, ctx, h2Start)}
        <div className="clear-both" />
      </div>
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
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-faint">
          Live preview above · Ctrl+Enter to save · Esc to cancel · paste images directly
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

  let h2Count = 0;

  if (!editUnlocked) {
    return (
      <div className="wiki">
        {blocks.map((block) => {
          const start = h2Count;
          h2Count += countH2(block.text);
          return <div key={block.id}>{renderMarkdown(block.text, ctx, start)}</div>;
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
              <BlockEditorPanel block={block} pagePath={pagePath} ctx={ctx} h2Start={start} onClose={() => setEditingId(null)} />
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
                {renderMarkdown(block.text, ctx, start)}
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
