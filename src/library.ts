import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Codex writes every generated image here, one directory per agent session. */
export const LIBRARY = join(homedir(), ".codex", "generated_images");

export interface Shot {
  path: string;
  session: string;
  createdAt: number;
  bytes: number;
}

/** Every generated image, newest first. */
export function listShots(root: string = LIBRARY): Shot[] {
  const shots: Shot[] = [];

  let sessions: string[];
  try {
    sessions = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return shots; // nothing generated on this machine yet
  }

  for (const session of sessions) {
    let files: string[];
    try {
      files = readdirSync(join(root, session));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".png")) continue;
      const path = join(root, session, file);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      shots.push({ path, session, createdAt: stat.mtimeMs, bytes: stat.size });
    }
  }

  return shots.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Identifies a run's output by diffing the library around it.
 *
 * Reading the newest file instead would be wrong twice over: a single run can emit several
 * images into one session directory, and with a library this large a run that produced nothing
 * would silently hand back somebody else's earlier picture.
 */
export function snapshot(root: string = LIBRARY): Set<string> {
  return new Set(listShots(root).map((s) => s.path));
}

export function newSince(before: Set<string>, root: string = LIBRARY): Shot[] {
  return listShots(root)
    .filter((s) => !before.has(s.path))
    .sort((a, b) => a.createdAt - b.createdAt);
}
