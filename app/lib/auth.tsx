import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { getStore } from "./store";

interface AuthState {
  /** True when a Supabase session exists — grants read access to private rows. */
  signedIn: boolean;
  /**
   * Whether the signed-in user has turned editing ON. Edit is a toggle, separate
   * from being signed in, so a signed-in user can preview restricted pages
   * read-only without dropping their session.
   */
  editMode: boolean;
  setEditMode(on: boolean): void;
  /** True when the account may write at all. A signed-in reader may not. */
  canEdit: boolean;
  /** Editing is allowed only when the account may write AND edit mode is on. */
  editUnlocked: boolean;
  /** A signed-in user may read private content. */
  privateUnlocked: boolean;
  email: string | null;
  /** The account's own Display Name, falling back to the part before the @. */
  displayName: string;
  ready: boolean;
  signIn(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
  /** Updates this account's own name and/or password. Returns an error message. */
  updateAccount(changes: { displayName?: string; password?: string }): Promise<string | null>;
}

/** Up to two initials for the avatar — "Thomas Hetland" becomes "TH". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

const AuthContext = createContext<AuthState>({
  signedIn: false,
  editMode: false,
  setEditMode: () => {},
  canEdit: false,
  editUnlocked: false,
  privateUnlocked: false,
  email: null,
  displayName: "",
  ready: false,
  signIn: async () => "Auth is not ready.",
  signOut: async () => {},
  updateAccount: async () => "Auth is not ready.",
});

export function useAuth() {
  return useContext(AuthContext);
}

const EDIT_MODE_KEY = "wiki-edit-mode";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // Persisted so a page reload keeps you in the same mode you left.
  const [editMode, setEditModeState] = useState(false);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(EDIT_MODE_KEY) === "1") {
      setEditModeState(true);
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      // The page cache depends on who's asking (a locked body is sent to signed-in
      // users, withheld from anonymous ones), so drop it on any sign-in/out so the
      // next read reflects the new identity.
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
        getStore().invalidate();
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const setEditMode = (on: boolean) => {
    setEditModeState(on);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(EDIT_MODE_KEY, on ? "1" : "0");
    }
  };

  /** Returns an error message, or null on success. */
  const signIn = async (email: string, password: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    // Leaving the account also leaves edit mode — a signed-out user can't edit.
    setEditMode(false);
  };

  /**
   * Changing your OWN name or password needs no elevated rights — Supabase lets
   * a session update its own user — so this works for a read-only account too.
   */
  const updateAccount = async (changes: { displayName?: string; password?: string }): Promise<string | null> => {
    const payload: { password?: string; data?: Record<string, string> } = {};
    if (changes.password) {
      payload.password = changes.password;
    }
    if (changes.displayName !== undefined) {
      payload.data = { display_name: changes.displayName };
    }
    const { data, error } = await supabase.auth.updateUser(payload);
    if (error) {
      return error.message;
    }
    if (data.user) {
      setSession((prev) => (prev ? { ...prev, user: data.user } : prev));
    }
    // A name change rewrites every byline this account appears in.
    getStore().invalidate();
    return null;
  };

  const signedIn = Boolean(session);
  const email = session?.user.email ?? null;
  const metaName = (session?.user.user_metadata?.display_name as string | undefined) ?? "";
  const displayName = metaName.trim() || (email ? email.split("@")[0] : "");

  // Signing in is not permission to write — an account has to be an admin. The
  // policies enforce this; asking here only stops the interface offering an
  // edit that would be refused.
  useEffect(() => {
    if (!signedIn) {
      setCanEdit(false);
      return;
    }
    let cancelled = false;
    getStore()
      .isAdmin()
      .then((admin) => {
        if (!cancelled) {
          setCanEdit(admin);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  return (
    <AuthContext.Provider
      value={{
        signedIn,
        editMode,
        setEditMode,
        canEdit,
        editUnlocked: signedIn && canEdit && editMode,
        privateUnlocked: signedIn,
        email,
        displayName,
        ready,
        signIn,
        signOut,
        updateAccount,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
