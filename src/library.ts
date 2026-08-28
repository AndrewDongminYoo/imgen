import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CONFIG_PATH } from "./config.ts";
import { loadPrompts, type PromptIndex } from "./prompts.ts";

/** Codex writes every generated image here, one directory per agent session. */
export const LIBRARY = join(homedir(), ".codex", "generated_images");
/** imgen copies its requested outputs here, outside Codex-owned storage. */
export const IMGEN_LIBRARY = join(dirname(CONFIG_PATH), "images");

export interface Shot {
  path: string;
  session: string;
  createdAt: number;
  bytes: number;
  /** What imgen was asked for, when imgen is what made it. Absent for everything older. */
  prompt?: string;
  /** References sent with imgen's generation, when provenance is available. */
  references?: string[];
}

/** Every generated image, newest first. */
export function listShots(root: string | string[] | undefined = undefined, prompts: PromptIndex = loadPrompts()): Shot[] {
  const shots: Shot[] = [];
  const roots = root === undefined ? [IMGEN_LIBRARY, LIBRARY] : Array.isArray(root) ? root : [root];

  for (const libraryRoot of roots) {
    let sessions: string[];
    try {
      sessions = readdirSync(libraryRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const session of sessions) {
      let files: string[];
      try {
        files = readdirSync(join(libraryRoot, session));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".png")) continue;
        const path = join(libraryRoot, session, file);
        const stat = statSync(path, { throwIfNoEntry: false });
        if (!stat) continue;
        const provenance = prompts[path];
        const references = provenance?.references;
        const hasOnlyStringReferences = Array.isArray(references) && references.every((reference) => typeof reference === "string");
        shots.push({
          path,
          session,
          createdAt: stat.mtimeMs,
          bytes: stat.size,
          prompt: provenance?.prompt,
          references: hasOnlyStringReferences ? references : [],
        });
      }
    }
  }

  return shots.sort((a, b) => b.createdAt - a.createdAt);
}

export function persistOutput(source: string, root: string = IMGEN_LIBRARY): Shot {
  const session = `imgen-${randomUUID()}`;
  const path = join(root, session, "out.png");
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(source, path);
  const stat = statSync(path);
  return { path, session, createdAt: stat.mtimeMs, bytes: stat.size, references: [] };
}

/**
 * Narrows the gallery to the images whose prompt contains `query`.
 *
 * An unlabelled image cannot match anything, so filtering hides the library imgen did not make.
 * That is the point — an empty query is not a filter and gives all of them back.
 */
export function filterShots(shots: Shot[], query: string): Shot[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return shots;
  return shots.filter((shot) => shot.prompt?.toLowerCase().includes(needle));
}
