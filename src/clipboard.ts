import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Codex keeps images pasted into a session here, one directory per session, numbered
 * `image-1.png` upward. Pasted references go in the same place and follow the same naming.
 */
export const ATTACHMENTS = join(homedir(), ".codex", "attachments");

/** One directory for this run of imgen, created lazily so an unused session leaves nothing. */
let sessionDir: string | null = null;

function attachmentDir(): string {
  if (!sessionDir) {
    sessionDir = join(ATTACHMENTS, randomUUID());
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function nextImagePath(dir: string): string {
  const used = readdirSync(dir)
    .map((name) => /^image-(\d+)\.png$/.exec(name)?.[1])
    .map((n) => (n ? Number.parseInt(n, 10) : 0));
  return join(dir, `image-${Math.max(0, ...used) + 1}.png`);
}

/**
 * macOS carries images on the pasteboard as `«class PNGf»`, which osascript can read and write
 * directly — no `pngpaste` or other Homebrew helper required.
 */
export async function copyImageToClipboard(path: string): Promise<void> {
  await run("osascript", [
    "-e",
    `set the clipboard to (read (POSIX file ${JSON.stringify(path)}) as «class PNGf»)`,
  ]);
}

/** Writes the clipboard image into this session's attachment directory and returns its path. */
export async function pasteImageFromClipboard(): Promise<string> {
  const dest = nextImagePath(attachmentDir());
  await run("osascript", [
    "-e",
    `set f to (open for access (POSIX file ${JSON.stringify(dest)}) with write permission)`,
    "-e",
    "set eof f to 0",
    "-e",
    "write (the clipboard as «class PNGf») to f",
    "-e",
    "close access f",
  ]);

  // osascript reports success even when the pasteboard held no image, leaving an empty file.
  const stat = statSync(dest, { throwIfNoEntry: false });
  if (!stat || stat.size === 0) throw new Error("no image on the clipboard");
  return dest;
}
