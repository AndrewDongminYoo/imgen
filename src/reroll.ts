import type { Shot } from "./library.ts";

export interface RerollOptions {
  description: string;
  references: string[];
}

export function rerollOptions(
  selected: Pick<Shot, "prompt" | "references"> | undefined,
  lastPrompt: string,
  currentReferences: string[],
): RerollOptions {
  if (selected?.prompt !== undefined) {
    return { description: selected.prompt, references: selected.references ?? [] };
  }
  return { description: lastPrompt, references: currentReferences };
}
