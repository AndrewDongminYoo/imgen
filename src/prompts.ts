import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  /** References that were attached to the same generation, in their original order. */
  references?: string[];
  /** Epoch ms, so a future cleanup can drop records for images that no longer exist. */
  at: number;
}

export type PromptIndex = Record<string, PromptRecord>;

export interface GenerationProvenance {
  prompt: string;
  references?: string[];
}

export function loadPrompts(path: string = PROMPTS_PATH): PromptIndex {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // `null` parses cleanly and then throws on the first property read, which happens inside the
    // gallery's initial state — the app would not start. Anything that is not a plain object is
    // not an index, so it degrades the same way a syntax error does.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as PromptIndex;
  } catch {
    // Losing the labels is a worse day, not a broken app: the gallery still lists every image.
    return {};
  }
}

/** Attributes one run's prompt to every image it produced; a run can emit several. */
export function recordPrompt(
  paths: string[],
  provenance: string | GenerationProvenance,
  path: string = PROMPTS_PATH,
): PromptIndex {
  const index = loadPrompts(path);
  const at = Date.now();
  const record =
    typeof provenance === "string"
      ? { prompt: provenance, references: [] }
      : { prompt: provenance.prompt, references: provenance.references ?? [] };
  for (const image of paths) index[image] = { ...record, at };

  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return index;
}
