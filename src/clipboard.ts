import { createHostClipboard, type HostClipboardService } from "@opentui/core";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

/** Stores bytes a terminal handed over directly, for the ones that forward binary pastes. */
export function attachBytes(bytes: Uint8Array): string {
  const dest = nextImagePath(attachmentDir());
  writeFileSync(dest, bytes);
  return dest;
}

/** Copies an image that already exists on disk into this session's attachments. */
export function attachFile(source: string): string {
  const dest = nextImagePath(attachmentDir());
  copyFileSync(source, dest);
  return dest;
}

/** Created once — the backend owns a native service, so a per-call instance would be wasteful. */
let host: HostClipboardService | null = null;

function hostClipboard(): HostClipboardService {
  host ??= createHostClipboard({ maxReadBytes: 64 * 1024 * 1024 });
  return host;
}

/**
 * Writes the clipboard image into this session's attachment directory and returns its path.
 *
 * OpenTUI reads the pasteboard natively and by mime type, which beats shelling out: no temp
 * file, no macOS-only `osascript`, and the format comes back named. The osascript path stays
 * as a fallback for the documented `unsupported` status.
 */
export async function pasteImageFromClipboard(): Promise<string> {
  const result = await hostClipboard().read({
    preferredTypes: ["image/png", "image/tiff", "image/jpeg"],
  });

  if (result.status === "read" && result.representation.mimeType.startsWith("image/")) {
    return attachBytes(result.representation.bytes);
  }
  if (result.status === "empty") throw new Error("no image on the clipboard");
  if (result.status === "failed") throw result.error;

  return pasteImageViaOsascript();
}

async function pasteImageViaOsascript(): Promise<string> {
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
