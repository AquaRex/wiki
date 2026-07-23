import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import { Globe, Lock, EyeOff, ShieldCheck, UserRound } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { getStore, type AccessScope } from "~/lib/store";
import type { AccessLevel } from "~/lib/shared";
import { GrantList } from "./grant-list";

/*
 * Sets the access level of a project, folder or page: public, locked (visible
 * but password-gated), hidden (off the public wiki, open to every editor) or
 * private (its owner and whoever they list). Locking prompts for a password;
 * the other two manage an allow-list, which is how a hidden item is opened to a
 * read-only account or a private one is shared with a colleague.
 *
 * Passwords and grants live server-side (supabase/schema.sql) and are never read
 * back. Whatever is set here also covers everything inside it.
 */

const LEVELS: { value: AccessLevel; label: string; icon: React.ReactNode; blurb: string }[] = [
  { value: "public", label: "Public", icon: <Globe className="size-3.5" />, blurb: "Anyone can see and read it." },
  { value: "locked", label: "Locked", icon: <Lock className="size-3.5" />, blurb: "Everyone sees it; a password unlocks the content." },
  { value: "hidden", label: "Hidden", icon: <EyeOff className="size-3.5" />, blurb: "Off the public wiki. Every editor still sees it." },
  {
    value: "private",
    label: "Private",
    icon: <UserRound className="size-3.5" />,
    blurb: "Only you, the people you list, and the wiki owner.",
  },
];

export function AccessControl({
  scope,
  itemKey,
  name,
  current,
  className,
}: {
  scope: AccessScope;
  /** project slug, or "slug/rel" for a page. */
  itemKey: string;
  /** Display name shown in the popover header. */
  name: string;
  current: AccessLevel;
  className?: string;
}) {
  const revalidator = useRevalidator();
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<AccessLevel>(current);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLevel(current);
  }, [current]);

  const store = getStore();

  const chooseLevel = async (next: AccessLevel) => {
    if (next === level || busy) {
      return;
    }
    // Locking needs a password first — don't switch until one is entered.
    if (next === "locked") {
      setLevel("locked");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await store.setAccess(scope, itemKey, next);
      setLevel(next);
      revalidator.revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change access.");
    } finally {
      setBusy(false);
    }
  };

  const applyLock = async () => {
    if (!password || busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await store.setLockPassword(scope, itemKey, password);
      await store.setAccess(scope, itemKey, "locked");
      setPassword("");
      revalidator.revalidate();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not lock.");
    } finally {
      setBusy(false);
    }
  };

  const CurrentIcon =
    current === "locked" ? Lock : current === "private" ? UserRound : current === "hidden" ? EyeOff : Globe;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={`Access: ${current}`}
            className={`flex items-center gap-1 rounded font-mono text-[10.5px] uppercase tracking-wider ${
              current === "public" ? "text-text-faint" : "text-waccent"
            } ${className ?? ""}`}
          >
            <CurrentIcon className="size-3.5" />
            {current}
          </button>
        }
      />
      <PopoverContent align="end" className="w-80 gap-3">
        <div className="flex flex-col gap-1">
          <div className="font-mono text-[10px] uppercase tracking-wider text-text-faint">
            Access · {scope}
          </div>
          <div className="truncate font-heading text-sm font-semibold">{name}</div>
        </div>

        <div className="flex flex-col gap-1.5">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              onClick={() => chooseLevel(l.value)}
              disabled={busy}
              className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                level === l.value
                  ? "border-accent-line bg-accent-soft"
                  : "border-border hover:bg-surface-2"
              }`}
            >
              <span className={level === l.value ? "text-waccent" : "text-text-faint"}>{l.icon}</span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{l.label}</span>
                <span className="block text-[11.5px] text-text-dim">{l.blurb}</span>
              </span>
            </button>
          ))}
        </div>

        {level === "locked" && (
          <div className="grid gap-2 border-t border-border pt-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-text-faint">
              Set access password
            </div>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  applyLock();
                }
              }}
              placeholder={current === "locked" ? "Change password…" : "New password"}
              className="font-mono"
            />
            <Button size="sm" onClick={applyLock} disabled={busy || !password}>
              <Lock className="size-3.5" /> {current === "locked" ? "Update lock" : "Lock it"}
            </Button>
            {scope === "project" && (
              <p className="text-[11px] text-text-dim">
                Pages inside inherit this lock unless a page sets its own access or password.
              </p>
            )}
          </div>
        )}

        {(level === "hidden" || level === "private") && (
          <div className="border-t border-border pt-3">
            <GrantList scope={scope} itemKey={itemKey} />
          </div>
        )}

        {error && <p className="text-[12px] text-crit">{error}</p>}

        <div className="flex items-center gap-1.5 border-t border-border pt-2 text-[11px] text-text-faint">
          <ShieldCheck className="size-3.5" /> Enforced by the database, not the interface.
        </div>
      </PopoverContent>
    </Popover>
  );
}
