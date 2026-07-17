// Builds the static GitHub Pages bundle into build/client.
// Usage: npm run build:pages  (optionally set WIKI_BASE, default "/wiki/")
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const base = process.env.WIKI_BASE ?? "/wiki/";

execSync("npx react-router build", {
  stdio: "inherit",
  env: {
    ...process.env,
    WIKI_TARGET: "pages",
    WIKI_BASE: base,
    VITE_WIKI_BACKEND: "github",
  },
});

const clientDir = path.resolve("build/client");
// GitHub Pages serves 404.html for unknown URLs — copying the SPA shell there
// makes deep links like /Enemies/TheHunter work.
fs.copyFileSync(path.join(clientDir, "index.html"), path.join(clientDir, "404.html"));
fs.writeFileSync(path.join(clientDir, ".nojekyll"), "");

console.log(`\nStatic wiki built in build/client (base: ${base})`);
