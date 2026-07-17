// Updates the Guides/Writing-Pages reference so it documents every feature.
//
// Usage (PowerShell):
//   $env:SUPABASE_SECRET_KEY = "sb_secret_..."
//   node scripts/update-guide.mjs
//
// Idempotent: blocks are matched by id, so re-running replaces rather than
// appends. The secret key is read from the environment, never from a file.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "https://hchyekrxubzuqrnlckpm.supabase.co";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SECRET_KEY) {
  console.error('SUPABASE_SECRET_KEY is not set.\n  $env:SUPABASE_SECRET_KEY = "sb_secret_..."');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });

/** Boxes block — rewritten for the current directive set. */
const BOXES = `## Boxes and structures
^ The building blocks of a good page

Everything below is a fenced *directive*: a line starting with \`:::type\`, the content, then a closing \`:::\` line. Directives nest — a box can hold another box.

### Callout

The headline box: an accent rule, a label, and a larger opening paragraph. Use it once at the top of a page to state the core idea.

:::callout The label
Written as \`:::callout The label\` — the first paragraph is set larger, so lead with the point.

Supporting detail follows at normal size.
:::

### Quote box

:::quote
Written as \`:::quote\`. A bordered box with no accent rule, for displayed material that isn't code — quotations, diagrams, worked examples. Unlike a code block it **wraps** instead of scrolling, and all formatting works inside.
:::

### Note

:::note Worth knowing
Written as \`:::note Label\` — a quiet aside for context and caveats.
:::

### Boxes with an icon

:::error
**Written as \`:::error\`.** For mistakes and traps — things that break saves or kill players.
:::

:::warn
**Written as \`:::warn\`.** For risky-but-survivable warnings.
:::

:::good
**Written as \`:::good\`.** For confirmed-safe advice and best practice.
:::

:::tips
**Written as \`:::tips\`.** For something helpful that isn't obvious.
:::`;

/** New block: the three tone forms, private variables, code highlighting. */
const TONES = `## Colour and emphasis
^ Three depths of the same idea

The same five tones — \`error\`, \`warn\`, \`good\`, \`tips\`, \`muted\` — work at three levels. The number of colons decides how much visual weight the point carries.

| Form | Weight | Use |
| --- | --- | --- |
| \`:error text\` | Colours the words only | A phrase inside a sentence |
| \`::error\` … \`::\` | A coloured rule beside the text | A remark worth setting apart |
| \`:::error\` … \`:::\` | A full box with an icon | A point the reader must not miss |

### Inline

One colon colours the rest of the line and nothing else, so it composes with everything: :error this is wrong, :good this is right, :muted and this is a quiet remark. It combines freely with other formatting — :error **bold inside a red run** and :warn ==an accented term== both work.

### Line

Two colons open a region that runs until a bare \`::\` closes it:

::warn
Written as \`::warn\` on its own line, then \`::\` to close. The rule carries the meaning, so the text stays black and readable at length — better than a box when the remark is a paragraph rather than a warning.
::

A one-liner needs no terminator: \`::tips Something short\` ends at its own line.

::tips Written as \`::tips Something short\` — one line, no closing marker.
::

### Code

A fence with \`\`\`\`csharp:File.cs\`\`\`\` sets the language and the filename bar. Keywords take the accent colour and comments recede:

\`\`\`csharp:EnemyAI.cs · the shared machinery
public abstract class EnemyAI : NetworkBehaviour {
    public NavMeshAgent agent;
    public float AIIntervalTime = 0.2f;       // decisions run at 5 Hz, not per frame

    public virtual void DoAIInterval() { ... }  // the brain tick (subclass overrides)
}
\`\`\`

Code blocks scroll sideways rather than wrapping, because a broken line of code is a lie. When you want displayed text that wraps instead, use \`:::quote\`.

### Private variables

A third field marks a definition page-local: {{def:array.length=X||private}} is written \`{{def:array.length=X||private}}\`. It renders and links on this page like any other, but stays out of the shared **All variables** index — for names too generic to belong project-wide.`;

async function run() {
  const { data, error } = await db
    .from("pages")
    .select("blocks")
    .eq("project_slug", "Guides")
    .eq("rel", "Writing-Pages")
    .single();
  if (error) {
    throw new Error(error.message);
  }

  const blocks = data.blocks;
  const boxesIndex = blocks.findIndex((b) => b.text.startsWith("## Boxes and structures"));
  if (boxesIndex === -1) {
    throw new Error("Could not find the 'Boxes and structures' block to replace.");
  }
  blocks[boxesIndex].text = BOXES;

  // Insert the tones block right after boxes, replacing it if already present.
  const tonesId = "b1a2c3d4t1";
  const existing = blocks.findIndex((b) => b.id === tonesId);
  if (existing === -1) {
    blocks.splice(boxesIndex + 1, 0, { id: tonesId, text: TONES });
  } else {
    blocks[existing].text = TONES;
  }

  const { error: saveError } = await db
    .from("pages")
    .update({ blocks, updated_at: new Date().toISOString() })
    .eq("project_slug", "Guides")
    .eq("rel", "Writing-Pages");
  if (saveError) {
    throw new Error(saveError.message);
  }

  console.log(`Updated Writing pages — ${blocks.length} blocks.`);
  console.log("  rewrote: Boxes and structures (quote box, :::tips, :::error rename)");
  console.log("  added:   Colour and emphasis (:tone / ::tone / :::tone, code highlighting, private vars)");
}

run().catch((e) => {
  console.error(`Failed: ${e.message}`);
  process.exit(1);
});
