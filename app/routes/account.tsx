import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Check, Crown, Pencil, UserRound } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Avatar } from "~/components/wiki/avatar";
import { useAuth } from "~/lib/auth";
import { getStore } from "~/lib/store";
import { wikiConfig } from "~/wiki.config";

export function meta() {
  return [{ title: `Your account · ${wikiConfig.siteName}` }];
}

/*
 * A user's own account: their name and their password, and nothing else.
 * Permissions are not shown as anything they can change, and no editing history
 * is here — this page is about the account, not about the wiki.
 */
export default function Account() {
  const { signedIn, ready, email, displayName, canEdit, updateAccount } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(displayName);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isOwner, setIsOwner] = useState(false);
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setName(displayName);
  }, [displayName]);

  useEffect(() => {
    if (ready && !signedIn) {
      navigate("/admin?to=/account", { replace: true });
    }
  }, [ready, signedIn, navigate]);

  useEffect(() => {
    if (signedIn) {
      getStore()
        .isOwner()
        .then(setIsOwner)
        .catch(() => setIsOwner(false));
    }
  }, [signedIn]);

  const saveName = async () => {
    const wanted = name.trim();
    if (!wanted || wanted === displayName) {
      return;
    }
    setBusy("name");
    setError("");
    const message = await updateAccount({ displayName: wanted });
    setBusy("");
    if (message) {
      setError(message);
      return;
    }
    setSaved("Name updated — it now appears on everything you've written.");
  };

  const savePassword = async () => {
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy("password");
    setError("");
    const message = await updateAccount({ password });
    setBusy("");
    if (message) {
      setError(message);
      return;
    }
    setPassword("");
    setConfirmPassword("");
    setSaved("Password changed.");
  };

  const role = isOwner ? "Owner" : canEdit ? "Can edit" : "Read only";
  const RoleIcon = isOwner ? Crown : canEdit ? Pencil : UserRound;

  return (
    <div className="mx-auto min-h-screen w-full max-w-[640px] px-6 py-14">
      <div className="eyebrow !text-[11px]">{wikiConfig.siteName} · Account</div>

      <div className="mt-6 flex items-center gap-4">
        <Avatar name={displayName || email || "?"} size={64} />
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-bold">{displayName}</h1>
          <div className="mt-1 font-mono text-[12px] text-text-faint">{email}</div>
          <div className="mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-text-dim">
            <RoleIcon className="size-3.5" /> {role}
          </div>
        </div>
      </div>

      {(saved || error) && (
        <p className={`mt-6 text-sm ${error ? "text-crit" : "text-waccent"}`}>
          {error || (
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-3.5" /> {saved}
            </span>
          )}
        </p>
      )}

      <section className="mt-10 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-heading text-[15px] font-bold">Display name</h2>
        <p className="mt-1 text-[13px] text-text-dim">
          How you're credited on pages you create and edit.
        </p>
        <div className="mt-4 flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void saveName();
              }
            }}
            placeholder="Your name"
          />
          <Button onClick={saveName} disabled={busy === "name" || !name.trim() || name.trim() === displayName}>
            Save
          </Button>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-heading text-[15px] font-bold">Password</h2>
        <p className="mt-1 text-[13px] text-text-dim">
          Changing it here signs out nothing — you stay signed in on this device.
        </p>
        <div className="mt-4 grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="new-password" className="text-[12px] text-text-dim">
              New password
            </Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-password" className="text-[12px] text-text-dim">
              Repeat it
            </Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void savePassword();
                }
              }}
              placeholder="••••••••"
              className="font-mono"
            />
          </div>
          <Button
            onClick={savePassword}
            disabled={busy === "password" || !password || !confirmPassword}
            className="justify-self-start"
          >
            Change password
          </Button>
        </div>
      </section>

      <p className="mt-10">
        <Link to="/" className="font-mono text-[11.5px] uppercase tracking-wider text-text-faint hover:text-waccent">
          ← Back to the wiki
        </Link>
      </p>
    </div>
  );
}
