import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ShieldCheck, Users } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useAuth } from "~/lib/auth";
import { getStore } from "~/lib/store";
import { wikiConfig } from "~/wiki.config";

export function meta() {
  return [{ title: `Sign in · ${wikiConfig.siteName}` }];
}

const REMEMBERED_EMAIL_KEY = "wiki-remembered-email";

export default function Admin() {
  const { signedIn, isOwner, email: currentEmail, signIn, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const to = searchParams.get("to") || "/";

  // Prefill the last-used email (never the password) so returning is one click.
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(REMEMBERED_EMAIL_KEY) : null;
    if (saved) {
      setEmail(saved);
    } else {
      setRemember(false);
    }
  }, []);

  const submit = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError("");
    const message = await signIn(email, password);
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    // Your session already persists across reloads; remembering the email means
    // that even after a real sign-out you don't have to retype it.
    if (typeof window !== "undefined") {
      if (remember) {
        window.localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
      } else {
        window.localStorage.removeItem(REMEMBERED_EMAIL_KEY);
      }
    }
    getStore().invalidate();
    navigate(to);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-8 shadow-lg">
        {/* The shield carries the whole message — a card this plain doesn't
            need a heading or a paragraph explaining what signing in is for. */}
        <div className="mb-6 flex justify-center">
          <ShieldCheck className="size-16 text-waccent" strokeWidth={1.25} />
        </div>
        {signedIn ? (
          <>
            <p className="mb-6 text-sm text-text-dim">
              Signed in as <span className="font-mono text-[12.5px] text-waccent">{currentEmail}</span>. Use the
              <span className="text-waccent"> Edit</span> toggle in the sidebar to start editing.
            </p>
            <div className="grid gap-2">
              {isOwner && (
                <Button variant="outline" className="w-full gap-1.5" render={<Link to="/admin/users" />}>
                  <Users className="size-3.5" /> Manage users
                </Button>
              )}
              <Button
                variant="outline"
                className="w-full"
                onClick={async () => {
                  await signOut();
                  getStore().invalidate();
                  navigate(to);
                }}
              >
                Sign out
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="email" className="text-[12px] text-text-dim">
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      submit();
                    }
                  }}
                  placeholder="you@example.com"
                  className="font-mono"
                  autoFocus
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="password" className="text-[12px] text-text-dim">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      submit();
                    }
                  }}
                  placeholder="••••••••"
                  className="font-mono"
                />
              </div>
              <label className="flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-text-dim">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="size-3.5 accent-[var(--waccent)]"
                />
                Remember my email on this device
              </label>
              {error && <p className="text-sm text-crit">{error}</p>}
              <Button onClick={submit} className="w-full" disabled={busy || !email || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </div>
          </>
        )}
        <p className="mt-6 text-center">
          <Link to="/" className="font-mono text-[11.5px] uppercase tracking-wider text-text-faint hover:text-waccent">
            ← Back to the wiki
          </Link>
        </p>
      </div>
    </div>
  );
}
