import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { enhanceInstruction } from "./enhance.ts";
import { buildPrompt } from "./generate.ts";
import { listShots, newSince, snapshot } from "./library.ts";

function fakeLibrary(): string {
  return mkdtempSync(join(tmpdir(), "imgen-lib-"));
}

function addShot(root: string, session: string, name: string, bytes = 8): string {
  mkdirSync(join(root, session), { recursive: true });
  const path = join(root, session, name);
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
}

test("listShots returns every png across sessions, newest first", () => {
  const root = fakeLibrary();
  const old = addShot(root, "s1", "exec-a.png");
  const recent = addShot(root, "s2", "exec-b.png");
  addShot(root, "s2", "notes.txt");

  // mtime resolution is coarse enough that same-tick writes can tie; set them apart explicitly.
  const { utimesSync } = require("node:fs") as typeof import("node:fs");
  utimesSync(old, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
  utimesSync(recent, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

  const shots = listShots(root);
  expect(shots.map((s) => s.path)).toEqual([recent, old]);
  expect(shots.every((s) => s.path.endsWith(".png"))).toBe(true);
});

test("listShots survives a library that does not exist", () => {
  expect(listShots(join(tmpdir(), "imgen-definitely-absent"))).toEqual([]);
});

test("newSince reports only what a run added, never a pre-existing image", () => {
  const root = fakeLibrary();
  addShot(root, "old-session", "exec-before.png");

  const before = snapshot(root);
  expect(before.size).toBe(1);

  // A single run can drop several images into one session directory.
  const first = addShot(root, "new-session", "exec-1.png");
  const second = addShot(root, "new-session", "exec-2.png");

  const produced = newSince(before, root);
  expect(produced.map((s) => s.path).sort()).toEqual([first, second].sort());
});

test("a run that produces nothing reports nothing rather than the newest existing image", () => {
  const root = fakeLibrary();
  addShot(root, "old-session", "exec-before.png");

  const before = snapshot(root);
  expect(newSince(before, root)).toEqual([]);
});

test("buildPrompt names the tool, the output, and forbids side work", () => {
  const prompt = buildPrompt("a red fox on a bicycle");

  expect(prompt).toContain("a red fox on a bicycle");
  expect(prompt).toContain("image generation");
  expect(prompt).toContain("out.png");
  // Without this the agent starts editing files in the working directory it was handed.
  expect(prompt).toContain("Do not do anything else");
});

test("buildPrompt tells the agent about attached references only when there are some", () => {
  expect(buildPrompt("a fox")).not.toContain("reference");

  const withOne = buildPrompt("a fox", ["/tmp/a.png"]);
  expect(withOne).toContain("1 attached image as visual reference");

  const withTwo = buildPrompt("a fox", ["/tmp/a.png", "/tmp/b.png"]);
  expect(withTwo).toContain("2 attached images as visual reference");
});

// Round-trips a real image through the macOS pasteboard, which means clobbering whatever the
// user had copied — opt in with IMGEN_CLIPBOARD_TEST=1 rather than running it by default.
test.skipIf(!process.env.IMGEN_CLIPBOARD_TEST || process.platform !== "darwin")(
  "an image survives a trip through the clipboard",
  async () => {
    const { copyImageToClipboard, pasteImageFromClipboard } = await import("./clipboard.ts");
    const { listShots } = await import("./library.ts");

    const source = listShots()[0];
    if (!source) return; // nothing generated on this machine to round-trip

    await copyImageToClipboard(source.path);
    const pasted = await pasteImageFromClipboard();

    const { statSync } = await import("node:fs");
    expect(statSync(pasted).size).toBe(source.bytes);
    expect(pasted).toContain("/.codex/attachments/");
  },
);

test("enhanceInstruction keeps the draft, forbids lettering, and honours a standing style", () => {
  const plain = enhanceInstruction("a fox on a bicycle", null);
  expect(plain).toContain("a fox on a bicycle");
  expect(plain).toContain("no lettering or text");
  expect(plain).toContain("prompt.txt");
  expect(plain).not.toContain("standing style preference");

  const styled = enhanceInstruction("a fox", "flat vector, muted palette");
  expect(styled).toContain("standing style preference: flat vector, muted palette");
});
