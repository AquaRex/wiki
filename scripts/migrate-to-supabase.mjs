// One-time migration of content/pages/*.json into Supabase.
//
// Usage (PowerShell):
//   $env:SUPABASE_SECRET_KEY = "sb_secret_..."
//   npm run migrate
//
// The secret key carries BYPASSRLS, so it is read from the environment and
// never written to a file. Re-running is safe: rows are upserted by their
// natural key, not duplicated.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "https://hchyekrxubzuqrnlckpm.supabase.co";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SECRET_KEY) {
  console.error("SUPABASE_SECRET_KEY is not set.\n");
  console.error('  PowerShell:  $env:SUPABASE_SECRET_KEY = "sb_secret_..."');
  console.error("  Then:        npm run migrate");
  process.exit(1);
}
if (!SECRET_KEY.startsWith("sb_secret_")) {
  console.error("SUPABASE_SECRET_KEY should be the new secret key (sb_secret_...).");
  console.error("The legacy service_role JWT still works but cannot be revoked — use a secret key.");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });

const PAGES_DIR = path.resolve("content/pages");
const isMeta = (name) => name.startsWith("_");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Every page file under content/pages, as { project, rel, data }. */
function collectPages() {
  const out = [];
  const walk = (dir, segments) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, entry.name]);
      } else if (entry.name.endsWith(".json") && !isMeta(entry.name)) {
        const rel = [...segments, entry.name.slice(0, -5)];
        if (rel.length < 2) {
          continue; // a page must live under a project folder
        }
        out.push({
          project: rel[0],
          rel: rel.slice(1).join("/"),
          data: readJson(path.join(dir, entry.name)),
        });
      }
    }
  };
  walk(PAGES_DIR, []);
  return out;
}

function readMeta(project) {
  const file = path.join(PAGES_DIR, project, "_meta.json");
  if (!fs.existsSync(file)) {
    return { order: {}, private: [], folders: [] };
  }
  const data = readJson(file);
  return { order: data.order ?? {}, private: data.private ?? [], folders: data.folders ?? [] };
}

/** A lock on a folder covers everything beneath it. */
function isLocked(privateRels, rel) {
  return privateRels.some((locked) => {
    const low = locked.toLowerCase();
    const target = rel.toLowerCase();
    return target === low || target.startsWith(low + "/");
  });
}

async function run() {
  const pages = collectPages();
  const projects = [...new Set(pages.map((p) => p.project))].sort();
  console.log(`Found ${pages.length} pages across ${projects.length} projects.\n`);

  for (const [index, project] of projects.entries()) {
    const meta = readMeta(project);
    const home = pages.find((p) => p.project === project && p.rel.toLowerCase() === "home");

    const { error: projectError } = await db.from("projects").upsert(
      {
        slug: project,
        title: home?.data.title ?? project.replace(/-/g, " "),
        lede: home?.data.lede ?? "",
        is_private: false,
        sort_order: index,
      },
      { onConflict: "slug" }
    );
    if (projectError) {
      throw new Error(`projects/${project}: ${projectError.message}`);
    }

    const folders = meta.folders.map((rel) => ({
      project_slug: project,
      rel,
      is_private: isLocked(meta.private, rel),
      sort_order: meta.order[rel] ?? 0,
    }));
    if (folders.length > 0) {
      const { error } = await db.from("folders").upsert(folders, { onConflict: "project_slug,rel" });
      if (error) {
        throw new Error(`folders/${project}: ${error.message}`);
      }
    }

    const rows = pages
      .filter((p) => p.project === project)
      .map((p) => ({
        project_slug: project,
        rel: p.rel,
        title: p.data.title ?? p.rel.split("/").pop(),
        eyebrow: p.data.eyebrow ?? "",
        lede: p.data.lede ?? "",
        tags: p.data.tags ?? [],
        blocks: p.data.blocks ?? [],
        is_private: isLocked(meta.private, p.rel),
        sort_order: meta.order[p.rel] ?? 0,
        updated_at: p.data.updated || new Date().toISOString(),
      }));

    const { error: pageError } = await db.from("pages").upsert(rows, { onConflict: "project_slug,rel" });
    if (pageError) {
      throw new Error(`pages/${project}: ${pageError.message}`);
    }

    const locked = rows.filter((r) => r.is_private).length;
    console.log(`  ${project}: ${rows.length} pages, ${folders.length} folders, ${locked} private`);
  }

  console.log("\nDone. Verify in the Supabase table editor, then disable the legacy API keys.");
}

run().catch((e) => {
  console.error(`\nMigration failed: ${e.message}`);
  process.exit(1);
});
