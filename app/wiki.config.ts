/**
 * Content lives in Supabase; GitHub Pages serves only the static shell.
 *
 * The publishable key is meant to ship in the browser bundle — row level
 * security is what protects the data, not the key. The secret key must never
 * appear here: it carries BYPASSRLS and is only ever read from the environment
 * by scripts/migrate-to-supabase.mjs.
 */
export const wikiConfig = {
  supabase: {
    url: import.meta.env.VITE_SUPABASE_URL || "https://hchyekrxubzuqrnlckpm.supabase.co",
    publishableKey:
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      "sb_publishable_UiCkyECkgYY8WVUCSJIg5A_zdNVid9U",
  },

  siteName: "WIKI",
  siteTagline: "project documentation",
};
