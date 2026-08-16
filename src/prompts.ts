import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_PATH } from "./config.ts";

/**
 * What made each image, keyed by its path.
 *
 * It lives beside the config rather than inside `~/.codex/generated_images/`, because that tree
 * is Codex's: it names the files, it may clean them up, and a stray sidecar there would be
 * imgen writing into another tool's storage.
 *
 * Only imgen's own runs are recorded. Reconstructing the prompt behind the images Codex made
 * before this existed was measured and rejected — the session rollout survives for most of them
 * (19 of 20 sampled), but `session_index.json` names none of the 62 library sessions, and the
 * image tool is reached differently from one session to the next, so there is no one shape to
 * parse. Recording from here on is exact; excavating backwards would be a guess.
 */
export const PROMPTS_PATH = join(dirname(CONFIG_PATH), "prompts.json");

export interface PromptRecord {
  prompt: string;
  /** Epoch ms, so a future cleanup can drop records for images that no longer exist. */
  at: number;
}

export type PromptIndex = Record<string, PromptRecord>;

export function loadPrompts(path: string = PROMPTS_PATH): PromptIndex {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PromptIndex;
  } catch {
    // Losing the labels is a worse day, not a broken app: the gallery still lists every image.
    return {};
  }
}

/** Attributes one run's prompt to every image it produced; a run can emit several. */
export function recordPrompt(
  paths: string[],
  prompt: string,
  path: string = PROMPTS_PATH,
): PromptIndex {
  const index = loadPrompts(path);
  const at = Date.now();
  for (const image of paths) index[image] = { prompt, at };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
  return index;
}
