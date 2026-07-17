import { useEffect, useState } from "react";
import { getStore } from "./store";
import { emptyProjectMeta, type ProjectMeta, type RootMeta } from "./shared";

/** Locks, ordering and folders for a project. Defaults apply until it loads. */
export function useProjectMeta(project: string): ProjectMeta {
  const [meta, setMeta] = useState<ProjectMeta>(emptyProjectMeta);

  useEffect(() => {
    // An empty project would resolve to the root meta file, which holds project
    // slugs rather than page paths — not the same thing.
    if (!project) {
      setMeta(emptyProjectMeta());
      return;
    }
    let cancelled = false;
    getStore()
      .getMeta(project)
      .then((loaded) => {
        if (!cancelled) {
          setMeta(loaded);
        }
      })
      .catch(() => {
        /* no meta yet — defaults apply */
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  return meta;
}

/** Locks and ordering for the project list. */
export function useRootMeta(): [RootMeta, (meta: RootMeta) => void] {
  const [meta, setMeta] = useState<RootMeta>({ order: {}, private: [] });

  useEffect(() => {
    let cancelled = false;
    getStore()
      .getRootMeta()
      .then((loaded) => {
        if (!cancelled) {
          setMeta(loaded);
        }
      })
      .catch(() => {
        /* no meta yet — defaults apply */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return [meta, setMeta];
}
