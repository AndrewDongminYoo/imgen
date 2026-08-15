import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newSince, type Shot, snapshot } from "./library.ts";

/**
 * There is no `codex imagegen` subcommand — the image tool only runs inside an agent turn, so a
 * generation is a headless `codex exec` whose prompt asks for exactly one thing and nothing else.
 */
export function buildPrompt(description: string): string {
  return [
    `Use your built-in image generation (imagegen) tool to create: ${description}.`,
    "Save the final image file into the current working directory as out.png.",
    "Do not do anything else.",
  ].join(" ");
}

export interface Run {
  /** Resolves with whatever landed in the library, or rejects if the run failed or was cancelled. */
  done: Promise<Shot[]>;
  cancel: () => void;
}

/**
 * A turn costs real money and takes minutes, so the child is spawned rather than awaited: the
 * caller keeps the handle and can cancel, and stdin is closed because piped stdin is otherwise
 * appended to the prompt and the run hangs waiting for more.
 */
export function generate(description: string): Run {
  const before = snapshot();
  const cwd = mkdtempSync(join(tmpdir(), "imgen-"));

  const child = spawn(
    "codex",
    ["exec", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', buildPrompt(description)],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

  let cancelled = false;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout?.resume(); // drain, or a chatty run fills the pipe buffer and blocks

  const done = new Promise<Shot[]>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (cancelled) return reject(new Error("cancelled"));

      const produced = newSince(before);
      if (produced.length > 0) return resolve(produced);

      const tail = stderr.trim().split("\n").slice(-3).join("\n");
      reject(new Error(`codex exited ${code} without producing an image${tail ? `\n${tail}` : ""}`));
    });
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      child.kill("SIGTERM");
    },
  };
}
