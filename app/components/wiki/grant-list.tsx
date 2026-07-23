import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import { X } from "lucide-react";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { getStore, type AccessScope } from "~/lib/store";

/*
 * The allow-list for a hidden project, folder or page: the emails that may see
 * it at all. Signing in grants nothing by itself, so this is the only way to
 * open a hidden item to someone who is not an admin.
 *
 * Shared by the access popover and the index's context menu — both edit the
 * same grants, so they must not drift apart.
 */
export function GrantList({ scope, itemKey }: { scope: AccessScope; itemKey: string }) {
  const revalidator = useRevalidator();
  const [grants, setGrants] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getStore()
      .listGrants(scope, itemKey)
      .then(setGrants)
      .catch(() => setGrants([]));
  }, [scope, itemKey]);

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setGrants(await getStore().listGrants(scope, itemKey));
      revalidator.revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const wanted = email.trim();
    if (!wanted || busy) {
      return;
    }
    void run(async () => {
      await getStore().addGrant(scope, itemKey, wanted);
      setEmail("");
    }, "Could not add the user.");
  };

  return (
    <div className="grid gap-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-faint">Who can see it</div>
      {grants.length > 0 ? (
        <div className="flex flex-col gap-1">
          {grants.map((granted) => (
            <div key={granted} className="flex items-center justify-between rounded bg-surface-2 px-2 py-1">
              <span className="truncate font-mono text-[12px]">{granted}</span>
              <button
                type="button"
                onClick={() => void run(() => getStore().removeGrant(scope, itemKey, granted), "Could not remove the user.")}
                disabled={busy}
                className="text-text-faint hover:text-crit"
                aria-label={`Remove ${granted}`}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11.5px] text-text-dim">No one yet — only admins can see it.</p>
      )}
      <div className="flex gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              add();
            }
          }}
          placeholder="user@example.com"
          className="font-mono"
        />
        <Button size="sm" variant="outline" onClick={add} disabled={busy || !email.trim()}>
          Add
        </Button>
      </div>
      <p className="text-[11px] text-text-dim">The user needs a wiki account to be added.</p>
      {error && <p className="text-[12px] text-crit">{error}</p>}
    </div>
  );
}
