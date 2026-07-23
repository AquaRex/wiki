import { useState } from "react";
import { Link, useLocation } from "react-router";
import { useTheme } from "next-themes";
import { Grid2x2, Moon, Sun, Pencil, LogOut, Plus, Braces, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
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
  const [menuOpen, setMenuOpen] = useState(false);
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
          {/* One evenly spaced row of same-sized icons. It used to be split
              left/right around a wide Edit button that no longer exists. */}
          <div className="flex items-center gap-1">
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
              <div className="flex items-center gap-1">
                {/* A reader has no edit toggle — the database would refuse the
                    write, so offering it would only produce an error. */}
                {canEdit && (
                  <Button
                    variant={editMode ? "default" : "ghost"}
                    size="icon"
                    onClick={() => setEditMode(!editMode)}
                    // One pen among the other icons; whether it is filled says
                    // which mode you're in, and the badge below spells it out.
                    className={editMode ? "" : "text-text-faint hover:text-foreground"}
                    title={editMode ? "Switch to preview (read-only)" : "Turn editing on"}
                    aria-label={editMode ? "Switch to preview" : "Turn editing on"}
                    aria-pressed={editMode}
                  >
                    <Pencil className="size-4" />
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
                {/* Everything about you behind one avatar: the account page and
                    signing out. Two rarely-used buttons in the footer row read
                    as clutter next to the ones you press all the time. */}
                <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                  {/* size-10 on the trigger matches the icon buttons beside it,
                      so the row keeps one rhythm instead of the avatar sitting
                      tighter than everything else. */}
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        title={displayName}
                        aria-label="Your account"
                        className="flex size-10 items-center justify-center rounded-md hover:bg-surface-2"
                      >
                        <Avatar name={displayName} size={26} className="transition-opacity hover:opacity-80" />
                      </button>
                    }
                  />
                  <PopoverContent align="end" side="top" className="w-56 gap-1 p-1.5">
                    <div className="flex items-center gap-2 border-b border-border px-2 pb-2 pt-1">
                      <Avatar name={displayName} size={30} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium">{displayName}</span>
                        <span className="block font-mono text-[10.5px] text-text-faint">
                          {isOwner ? "Owner" : canEdit ? "Can edit" : "Read only"}
                        </span>
                      </span>
                    </div>
                    <Link
                      to="/account"
                      onClick={() => setMenuOpen(false)}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-surface-2 hover:text-waccent"
                    >
                      <UserRound className="size-3.5 text-text-faint" /> Your profile
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        void signOut();
                      }}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 hover:text-crit"
                    >
                      <LogOut className="size-3.5 text-text-faint" /> Sign out
                    </button>
                  </PopoverContent>
                </Popover>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                render={<Link to={`/admin?to=${encodeURIComponent(location.pathname)}`} />}
                className="ml-auto gap-1.5 font-mono text-[11px] uppercase tracking-wider text-text-faint"
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
