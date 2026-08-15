import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 3 * 60 * 1000;
const OUTPUT_FILE = "prompt.txt";

/**
 * Art direction the model would otherwise leave to chance, plus whatever standing taste the
 * config carries. Deliberately general — the subject stays the user's, only the direction is
 * filled in.
 */
export function enhanceInstruction(draft: string, style: string | null): string {
  return [
    "You are rewriting a prompt for an image generation model. Do not generate an image.",
    "",
    "Draft prompt:",
    draft,
    "",
    "Rewrite it as a single vivid paragraph that keeps the subject exactly as given and decides",
    "what the draft left open: composition and framing, lighting, colour, medium or rendering",
    "style, mood, and the aspect ratio if it is not square.",
    "",
    "Rules:",
    "- Keep the subject. Add direction, never a different idea.",
    "- Ask for no lettering or text in the image, which these models render badly.",
    "- Concrete visual nouns over adjectives like 'beautiful' or 'high quality'.",
    "- English, one paragraph, no bullet points, no preamble.",
    style ? `- Follow this standing style preference: ${style}` : "",
    "",
    // Reading a file beats parsing stdout: `codex exec` interleaves its own chatter with the
    // answer, and the last-line heuristic breaks the moment it says anything afterwards.
    `Write the rewritten prompt alone into ${OUTPUT_FILE} in the current working directory.`,
    "Write nothing else to that file, and do not modify anything else.",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface EnhanceRun {
  done: Promise<string>;
  cancel: () => void;
}

/** Rewrites a draft prompt through a Codex turn; the caller keeps the handle so esc can stop it. */
export function enhance(draft: string, style: string | null): EnhanceRun {
  const cwd = mkdtempSync(join(tmpdir(), "imgen-enhance-"));
  const child = spawn(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      enhanceInstruction(draft, style),
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

  let cancelled = false;
  child.stdout?.resume();
  child.stderr?.resume();

  const timer = setTimeout(() => {
    cancelled = true;
    child.kill("SIGKILL");
  }, TIMEOUT_MS);

  const done = new Promise<string>((resolve, reject) => {
    child.on("error", (error) =>
      reject(
        (error as { code?: string }).code === "ENOENT"
          ? new Error("codex is not installed")
          : error,
      ),
    );
    child.on("close", () => {
      clearTimeout(timer);
      if (cancelled) return reject(new Error("cancelled"));
      try {
        const text = readFileSync(join(cwd, OUTPUT_FILE), "utf8").trim();
        return text ? resolve(text) : reject(new Error("the rewrite came back empty"));
      } catch {
        reject(new Error("codex produced no rewritten prompt"));
      }
    });
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
    },
  };
}
