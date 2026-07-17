import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

interface AuthState {
  /** A signed-in user may edit. Enforced by RLS, not by this flag. */
  editUnlocked: boolean;
  /** A signed-in user may read private content. Same account, same check. */
  privateUnlocked: boolean;
  email: string | null;
  ready: boolean;
  signIn(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState>({
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  /** Returns an error message, or null on success. */
  const signIn = async (email: string, password: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const signedIn = Boolean(session);

  return (
    <AuthContext.Provider
      value={{
        editUnlocked: signedIn,
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
