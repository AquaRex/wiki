import { useState } from "react";
import { Link, useLocation } from "react-router";
import { useTheme } from "next-themes";
import { Grid2x2, Moon, Sun, Pencil, Eye, LogOut, Plus, Braces, ShieldCheck } from "lucide-react";
import { Button } from "~/components/ui/button";
import { projectDisplayName, type PageSummary } from "~/lib/shared";
import { useAuth } from "~/lib/auth";
import { useProjectMeta } from "~/lib/meta";
import { wikiConfig } from "~/wiki.config";
import { Avatar } from "./avatar";
import { NewPageDialog } from "./new-page-dialog";
import { SearchBox } from "./search-box";
import { PageTree } from "./page-tree";

export function Shell({
  pages,
  project,
  currentPath,
  children,
}: {
  pages: PageSummary[];
  project: string;
  currentPath: string;
  children: React.ReactNode;
}) {
  const { signedIn, canEdit, isOwner, editMode, setEditMode, editUnlocked, displayName, signOut } = useAuth();
  const meta = useProjectMeta(project);
  const { resolvedTheme, setTheme } = useTheme();
  const location = useLocation();
  const [newPageOpen, setNewPageOpen] = useState(false);
  // Which folder the dialog creates into — "" is the project root, which is what
  // the toolbar button always uses; a folder's context menu sets its own rel.
  const [newPageParent, setNewPageParent] = useState("");

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] flex-col border-r border-border bg-sidebar md:flex">
        <div className="border-b border-border px-4 py-4">
          <Link
            to="/"
            className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint hover:text-waccent"
          >
            <Grid2x2 className="size-3" /> {wikiConfig.siteName} · All projects
          </Link>
          <Link to={`/${project}`} className="mt-2 block">
            <div className="font-heading text-[19px] font-bold uppercase tracking-tight">{projectDisplayName(project)}</div>
          </Link>
          <SearchBox compact project={project} className="mt-3" />
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-text-faint">Index</span>
            {editUnlocked && (
              <button
                type="button"
                onClick={() => {
                  setNewPageParent("");
                  setNewPageOpen(true);
                }}
                className="flex items-center gap-1 rounded font-mono text-[10.5px] font-semibold uppercase tracking-wider text-waccent hover:underline"
              >
                <Plus className="size-3" /> New page
              </button>
            )}
          </div>
          <PageTree
            pages={pages}
            project={project}
            currentPath={currentPath}
            editUnlocked={editUnlocked}
            meta={meta}
            onNewInFolder={(rel) => {
              setNewPageParent(rel);
              setNewPageOpen(true);
            }}
          />
          <div className="mt-4 border-t border-border pt-3">
            <Link
              to={`/${project}/variables`}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13.5px] ${
                location.pathname.endsWith("/variables")
                  ? "bg-accent-soft text-waccent"
                  : "text-text-dim hover:bg-surface-2 hover:text-foreground"
              }`}
            >
              <Braces className="size-3.5 text-text-faint" />
              All variables
            </Link>
          </div>
        </nav>
        <div className="border-t border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
            >
              <Sun className="size-4 dark:hidden" />
              <Moon className="hidden size-4 dark:block" />
            </Button>
            {signedIn ? (
              <div className="flex items-center gap-2">
                {/* A reader has no edit toggle — the database would refuse the
                    write, so offering it would only produce an error. */}
                {canEdit && (
                  <Button
                    variant={editMode ? "default" : "outline"}
                    size="sm"
                    onClick={() => setEditMode(!editMode)}
                    className="gap-1.5 font-mono text-[11px] uppercase tracking-wider"
                    title={editMode ? "Switch to preview (read-only)" : "Turn editing on"}
                  >
                    {editMode ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
                    {editMode ? "Preview" : "Edit"}
                  </Button>
                )}
                {/* The way into administration once signed in — the sign-in
                    card is no longer reachable from here, so the owner needs
                    this to get to user management. */}
                {isOwner && (
                  <Button
                    variant="ghost"
                    size="icon"
                    render={<Link to="/admin/users" />}
                    title="Admin panel"
                    aria-label="Admin panel"
                    className="text-waccent"
                  >
                    <ShieldCheck className="size-4" />
                  </Button>
                )}
                {/* Your own account — name and password, nothing else. */}
                <Link to="/account" title={`${displayName} · your account`} aria-label="Your account">
                  <Avatar name={displayName} size={26} className="transition-opacity hover:opacity-80" />
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => signOut()}
                  title="Sign out"
                  aria-label="Sign out"
                  className="text-text-faint hover:text-foreground"
                >
                  <LogOut className="size-4" />
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                render={<Link to={`/admin?to=${encodeURIComponent(location.pathname)}`} />}
                className="gap-1.5 font-mono text-[11px] uppercase tracking-wider text-text-faint"
              >
                <Pencil className="size-3.5" /> Admin
              </Button>
            )}
          </div>
          {signedIn && canEdit && (
            <div
              className={`mt-2 rounded-md border px-2 py-1 text-center font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] ${
                editMode
                  ? "border-accent-line bg-accent-soft text-waccent"
                  : "border-border bg-surface-2 text-text-dim"
              }`}
            >
              {editMode ? "● Editing enabled" : "Preview · read-only"}
            </div>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 md:ml-[264px]">
        <div className="sticky top-0 z-40 flex justify-center border-b border-border bg-background/85 px-6 py-2.5 backdrop-blur">
          <SearchBox project={project} className="w-full max-w-2xl" />
        </div>
        {children}
      </main>
      <NewPageDialog
        open={newPageOpen}
        onOpenChange={setNewPageOpen}
        parentFolder={newPageParent}
        project={project}
        pages={pages}
        meta={meta}
      />
    </div>
  );
}
