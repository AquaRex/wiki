import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { getStore } from "~/lib/store";
import { renderMarkdown, type RenderContext } from "~/lib/markdown";
import type { WikiPage } from "~/lib/shared";

function applyField(page: WikiPage, field: string, value: string) {
  if (field === "title") {
    page.title = value;
  } else if (field === "eyebrow") {
    page.eyebrow = value;
  } else if (field === "lede") {
    page.lede = value;
  } else if (field === "tags") {
    page.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
  }
}

export function EditableText({
  value,
  field,
  pagePath,
  editUnlocked,
  className = "",
  placeholder,
  multiline = false,
  as: Tag = "div",
  markdown,
  renderAs,
}: {
  value: string;
  field: string;
  pagePath: string;
  editUnlocked: boolean;
  className?: string;
  placeholder: string;
  multiline?: boolean;
  as?: React.ElementType;
  /** Render the value as markdown when not editing, instead of plain text. */
  markdown?: RenderContext;
  /** Custom display for the value when not editing — e.g. tags as chips. */
  renderAs?: (value: string) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const revalidator = useRevalidator();
  const inputRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = async () => {
    setEditing(false);
    if (draft !== value) {
      try {
        await getStore().updatePage(pagePath, (page) => applyField(page, field, draft));
        revalidator.revalidate();
      } catch (e) {
        alert(e instanceof Error ? e.message : "Saving failed.");
        setDraft(value);
      }
    }
  };

  const rendered = renderAs
    ? renderAs(value)
    : markdown
      ? <div className="wiki">{renderMarkdown(value, markdown)}</div>
      : value;

  if (!editUnlocked) {
    if (!value) {
      return null;
    }
    return <Tag className={className}>{rendered}</Tag>;
  }

  if (editing) {
    const shared = {
      ref: inputRef,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => setDraft(e.target.value),
      onBlur: save,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && (!multiline || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      },
      placeholder,
      className: `${className} w-full bg-transparent outline-none ring-1 ring-accent-line rounded-md px-2 -mx-2`,
    };
    return multiline ? <textarea rows={3} {...shared} /> : <input {...shared} />;
  }

  return (
    <Tag
      className={`${className} cursor-text rounded-md decoration-dotted hover:ring-1 hover:ring-accent-line ${!value ? "italic opacity-40" : ""}`}
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value ? rendered : placeholder}
    </Tag>
  );
}
