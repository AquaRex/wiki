import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

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
  /** Editing is allowed only when signed in AND edit mode is on. */
  editUnlocked: boolean;
  /** A signed-in user may read private content. */
  privateUnlocked: boolean;
  email: string | null;
  ready: boolean;
  signIn(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState>({
  signedIn: false,
  editMode: false,
  setEditMode: () => {},
  editUnlocked: false,
  privateUnlocked: false,
  email: null,
  ready: false,
  signIn: async () => "Auth is not ready.",
  signOut: async () => {},
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

  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(EDIT_MODE_KEY) === "1") {
      setEditModeState(true);
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
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

  const signedIn = Boolean(session);

  return (
    <AuthContext.Provider
      value={{
        signedIn,
        editMode,
        setEditMode,
        editUnlocked: signedIn && editMode,
        privateUnlocked: signedIn,
        email: session?.user.email ?? null,
        ready,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
