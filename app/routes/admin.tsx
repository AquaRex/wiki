import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ShieldCheck } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useAuth } from "~/lib/auth";
import { getStore } from "~/lib/store";
import { wikiConfig } from "~/wiki.config";

export function meta() {
  return [{ title: `Sign in · ${wikiConfig.siteName}` }];
}

export default function Admin() {
  const { editUnlocked, email: currentEmail, signIn, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const to = searchParams.get("to") || "/";

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
    getStore().invalidate();
    navigate(to);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-8 shadow-lg">
        <div className="eyebrow mb-4 !text-[11px]">{wikiConfig.siteName} · Account</div>
        <div className="mb-1 flex items-center gap-2 font-heading text-xl font-bold">
          <ShieldCheck className="size-4 text-waccent" /> Wiki editing
        </div>
        {editUnlocked ? (
          <>
            <p className="mb-6 text-sm text-text-dim">
              Signed in as <span className="font-mono text-[12.5px] text-waccent">{currentEmail}</span>.
            </p>
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
          </>
        ) : (
          <>
            <p className="mb-6 text-sm text-text-dim">
              Sign in to edit the wiki and read private pages.
            </p>
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
