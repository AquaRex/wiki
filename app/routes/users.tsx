import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Crown, EyeOff, Pencil, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Avatar } from "~/components/wiki/avatar";
import { useAuth } from "~/lib/auth";
import { getStore, type GrantRow, type WikiUser } from "~/lib/store";
import { wikiConfig } from "~/wiki.config";

export function meta() {
  return [{ title: `Users · ${wikiConfig.siteName}` }];
}

/** A date as "12 Jun 2026", or a dash when there isn't one. */
function when(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
}

function RoleBadge({ user }: { user: WikiUser }) {
  if (user.isOwner) {
    return (
      <span className="tag on inline-flex items-center gap-1">
        <Crown className="size-3" /> owner
      </span>
    );
  }
  if (user.isAdmin) {
    return (
      <span className="tag inline-flex items-center gap-1 text-waccent">
        <Pencil className="size-3" /> can edit
      </span>
    );
  }
  return (
    <span className="tag inline-flex items-center gap-1">
      <UserRound className="size-3" /> read only
    </span>
  );
}

export default function Users() {
  const { signedIn, email: currentEmail } = useAuth();
  const [users, setUsers] = useState<WikiUser[] | null>(null);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const store = getStore();
      const [list, allGrants] = await Promise.all([store.listUsers(), store.listAllGrants()]);
      setUsers(list);
      setGrants(allGrants);
      setDenied(false);
    } catch {
      // The RPCs refuse anyone but the owner, so a failure here IS the answer.
      setDenied(true);
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    if (signedIn) {
      void load();
    } else {
      setDenied(true);
      setUsers([]);
    }
  }, [signedIn, load]);

  const run = async (key: string, action: () => Promise<void>, failure: string) => {
    setBusy(key);
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : failure);
    } finally {
      setBusy("");
    }
  };

  const toggleAdmin = (user: WikiUser) =>
    run(user.email, () => getStore().setUserAdmin(user.email, !user.isAdmin), "Could not change access.");

  const remove = (user: WikiUser) => {
    if (
      !confirm(
        `Delete the account ${user.email}?\n\n` +
          "Pages they wrote stay in the wiki, including any they hid — those keep their owner and stay hidden.\n\n" +
          "This cannot be undone."
      )
    ) {
      return;
    }
    return run(user.email, () => getStore().deleteUser(user.email), "Could not delete the user.");
  };

  const grantsFor = (email: string) => grants.filter((g) => g.email.toLowerCase() === email.toLowerCase());

  return (
    <div className="mx-auto min-h-screen w-full max-w-[1000px] px-6 py-14">
      {/* The same shield that fronts the sign-in card, so the administration
          side of the wiki reads as one place. */}
      <div className="flex flex-col items-center text-center">
        <ShieldCheck className="size-16 text-waccent" strokeWidth={1.25} />
        <div className="eyebrow mt-4 !text-[11px]">{wikiConfig.siteName} · Administration</div>
        <h1 className="hero-title mt-2 font-heading">Users</h1>
      </div>
      <p className="hero-lede mt-4 text-center">
        Accounts are created in the Supabase dashboard. Everyone starts read-only — signing in grants nothing on
        its own. Give someone <span className="text-waccent">can edit</span> to let them write, and use a hidden
        item's own access panel to share it with them.
      </p>

      {denied ? (
        <div className="mt-10 rounded-lg border border-border bg-surface p-8 text-center text-text-dim">
          <ShieldCheck className="mx-auto mb-3 size-8 text-text-faint" />
          Only the wiki owner can manage users.
          <p className="mt-4">
            <Link to="/" className="font-mono text-[11.5px] uppercase tracking-wider text-waccent hover:underline">
              ← Back to the wiki
            </Link>
          </p>
        </div>
      ) : (
        <>
          {error && <p className="mt-6 text-sm text-crit">{error}</p>}
          <div className="mt-8 flex flex-col gap-3">
            {users === null && <div className="text-[13px] text-text-faint">Loading…</div>}
            {users?.map((user) => {
              const own = grantsFor(user.email);
              const isMe = user.email.toLowerCase() === (currentEmail ?? "").toLowerCase();
              return (
                <div key={user.email} className="rounded-lg border border-border bg-surface p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={user.displayName} size={38} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* Their name opens what they've written and changed. */}
                          <Link
                            to={`/admin/users/${encodeURIComponent(user.email)}`}
                            className="font-heading text-[16px] font-bold hover:text-waccent"
                          >
                            {user.displayName}
                          </Link>
                          <RoleBadge user={user} />
                          {isMe && (
                            <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-faint">you</span>
                          )}
                        </div>
                        <div className="mt-1 font-mono text-[11.5px] text-text-faint">
                          {user.email} · joined {when(user.created)} · last seen {when(user.lastSignIn)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* The owner's own rights aren't editable — there would be
                          no way back if they were switched off. */}
                      {!user.isOwner && (
                        <>
                          <Button
                            size="sm"
                            variant={user.isAdmin ? "default" : "outline"}
                            disabled={busy === user.email}
                            onClick={() => toggleAdmin(user)}
                            className="gap-1.5 font-mono text-[11px] uppercase tracking-wider"
                          >
                            <Pencil className="size-3.5" />
                            {user.isAdmin ? "Can edit" : "Read only"}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={busy === user.email}
                            onClick={() => remove(user)}
                            title={`Delete ${user.email}`}
                            aria-label={`Delete ${user.email}`}
                            className="text-text-faint hover:text-crit"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {own.length > 0 && (
                    <div className="mt-4 border-t border-border pt-3">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-text-faint">
                        Hidden items shared with them
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {own.map((grant) => (
                          <span
                            key={`${grant.scope}·${grant.key}`}
                            className="tag inline-flex items-center gap-1.5"
                            title={`${grant.scope}: ${grant.key}`}
                          >
                            <EyeOff className="size-3 text-text-faint" />
                            {grant.key}
                            <button
                              type="button"
                              disabled={busy === user.email}
                              onClick={() =>
                                run(
                                  user.email,
                                  () => getStore().removeGrant(grant.scope, grant.key, user.email),
                                  "Could not revoke the grant."
                                )
                              }
                              aria-label={`Revoke ${grant.key}`}
                              className="text-text-faint hover:text-crit"
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-10">
            <Link to="/" className="font-mono text-[11.5px] uppercase tracking-wider text-text-faint hover:text-waccent">
              ← Back to the wiki
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
