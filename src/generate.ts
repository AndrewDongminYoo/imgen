import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newSince, type Shot, snapshot } from "./library.ts";

const CANCEL_GRACE_MS = 1_000;

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  const target = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(target, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * There is no `codex imagegen` subcommand — the image tool only runs inside an agent turn, so a
 * generation is a headless `codex exec` whose prompt asks for exactly one thing and nothing else.
 */
export function buildPrompt(description: string, references: string[] = []): string {
  return [
    `Use your built-in image generation (imagegen) tool to create: ${description}.`,
    references.length > 0
      ? `Use the ${references.length} attached image${references.length === 1 ? "" : "s"} as visual reference.`
      : "",
    "Save the final image file into the current working directory as out.png.",
    "Do not do anything else.",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface Run {
  /** Resolves with whatever landed in the library, or rejects if the run failed or was cancelled. */
  done: Promise<Shot[]>;
  cancel: () => void;
}

export interface GenerateOptions {
  /** Reference images, passed through `codex exec -i`. */
  references?: string[];
  /** Called with each line Codex prints, so the UI can show what the turn is doing. */
  onActivity?: (line: string) => void;
}

/**
 * A turn costs real money and takes minutes, so the child is spawned rather than awaited: the
 * caller keeps the handle and can cancel, and stdin is closed because piped stdin is otherwise
 * appended to the prompt and the run hangs waiting for more.
 */
export function generate(description: string, options: GenerateOptions = {}): Run {
  const before = snapshot();
  const cwd = mkdtempSync(join(tmpdir(), "imgen-"));
  const cleanup = () => rmSync(cwd, { recursive: true, force: true });

  const references = options.references ?? [];
  const child = spawn(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      ...references.flatMap((path) => ["-i", path]),
      buildPrompt(description, references),
    ],
    { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );

  let cancelled = false;
  let cancellationTimer: ReturnType<typeof setTimeout> | null = null;
  const clearCancellationTimer = () => {
    if (cancellationTimer === null) return;
    clearTimeout(cancellationTimer);
    cancellationTimer = null;
  };
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // Drain stdout either way — a chatty run that fills the pipe buffer would otherwise block —
  // and surface the last line as progress, since the turn reports no percentage of its own.
  let carry = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    if (!options.onActivity) return;
    carry += chunk.toString();
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text) options.onActivity(text);
    }
  });
  child.stdout?.resume();

  const done = new Promise<Shot[]>((resolve, reject) => {
    child.on("error", (error) => {
      if (!cancelled) clearCancellationTimer();
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (!cancelled) clearCancellationTimer();
      try {
        if (cancelled) return reject(new Error("cancelled"));

        const produced = newSince(before);
        if (produced.length > 0) return resolve(produced);

        const tail = stderr.trim().split("\n").slice(-3).join("\n");
        reject(new Error(`codex exited ${code} without producing an image${tail ? `\n${tail}` : ""}`));
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    });
  });

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      signalProcessGroup(child.pid, "SIGTERM");
      cancellationTimer = setTimeout(() => {
        cancellationTimer = null;
        signalProcessGroup(child.pid, "SIGKILL");
      }, CANCEL_GRACE_MS);
    },
  };
}
