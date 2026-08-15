import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

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
