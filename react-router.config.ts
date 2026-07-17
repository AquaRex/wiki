import type { Config } from "@react-router/dev/config";

const isStaticBuild = process.env.WIKI_TARGET === "pages";

export default {
  // The GitHub Pages build is a fully static SPA; local dev runs the server.
  ssr: !isStaticBuild,
  basename: process.env.WIKI_BASE ?? "/",
} satisfies Config;
