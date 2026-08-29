import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { expect, test } from "bun:test";

import { enhanceInstruction } from "./enhance.ts";
import { buildPrompt } from "./generate.ts";
import { filterShots, listShots } from "./library.ts";
import { loadPrompts, recordPrompt, type PromptIndex } from "./prompts.ts";
import { rerollOptions } from "./reroll.ts";

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

test("listShots combines imgen and Codex libraries", () => {
  const codexRoot = fakeLibrary();
  const imgenRoot = fakeLibrary();
  const codexShot = addShot(codexRoot, "codex-session", "exec-codex.png");
  const imgenShot = addShot(imgenRoot, "imgen-session", "out.png");

  const { utimesSync } = require("node:fs") as typeof import("node:fs");
  utimesSync(codexShot, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
  utimesSync(imgenShot, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

  expect(listShots([codexRoot, imgenRoot]).map((shot) => shot.path)).toEqual([imgenShot, codexShot]);
});

function fakeIndexPath(): string {
  return join(mkdtempSync(join(tmpdir(), "imgen-prompts-")), "prompts.json");
}

function fakeCodex(body: string): { bin: string; cwdLog: string } {
  const bin = mkdtempSync(join(tmpdir(), "imgen-codex-bin-"));
  const cwdLog = join(bin, "cwd.log");
  const executable = join(bin, "codex");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s' "$PWD" > "$IMGEN_TEST_CWD_LOG"\n${body}\n`,
  );
  chmodSync(executable, 0o755);
  return { bin, cwdLog };
}

async function withFakeCodex<T>(body: string, run: (cwdLog: string) => Promise<T>): Promise<T> {
  const { bin, cwdLog } = fakeCodex(body);
  const originalPath = process.env.PATH;
  const originalCwdLog = process.env.IMGEN_TEST_CWD_LOG;
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  process.env.IMGEN_TEST_CWD_LOG = cwdLog;
  try {
    return await run(cwdLog);
  } finally {
    process.env.PATH = originalPath;
    if (originalCwdLog === undefined) delete process.env.IMGEN_TEST_CWD_LOG;
    else process.env.IMGEN_TEST_CWD_LOG = originalCwdLog;
  }
}

test("doctor reports the installed Codex, enabled image generation, and a usable config path", async () => {
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable true\\n" ;; esac',
    async () => {
      const { runDoctor } = await import("./doctor.ts");
      const configPath = join(mkdtempSync(join(tmpdir(), "imgen-doctor-config-")), "imgen", "config.json");

      expect(runDoctor(configPath)).toEqual({
        ok: true,
        checks: [
          { name: "Codex CLI", ok: true, detail: "codex-cli test 1.0.0" },
          { name: "image_generation", ok: true, detail: "stable" },
          { name: "Config path", ok: true, detail: configPath },
        ],
      });
    },
  );
});

test("doctor reports a disabled image generation feature", async () => {
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable false\\n" ;; esac',
    async () => {
      const { runDoctor } = await import("./doctor.ts");
      const configPath = join(mkdtempSync(join(tmpdir(), "imgen-doctor-config-")), "imgen", "config.json");

      expect(runDoctor(configPath)).toEqual({
        ok: false,
        checks: [
          { name: "Codex CLI", ok: true, detail: "codex-cli test 1.0.0" },
          { name: "image_generation", ok: false, detail: "disabled" },
          { name: "Config path", ok: true, detail: configPath },
        ],
      });
    },
  );
});

test("doctor reports every failed check when Codex is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgen-doctor-no-codex-"));
  const originalPath = process.env.PATH;
  process.env.PATH = join(root, "missing-bin");
  try {
    const { runDoctor } = await import("./doctor.ts");
    const configPath = join(mkdtempSync(join(tmpdir(), "imgen-doctor-config-")), "imgen", "config.json");

    expect(runDoctor(configPath)).toEqual({
      ok: false,
      checks: [
        { name: "Codex CLI", ok: false, detail: "not installed" },
        { name: "image_generation", ok: false, detail: "not checked" },
        { name: "Config path", ok: true, detail: configPath },
      ],
    });
  } finally {
    process.env.PATH = originalPath;
  }
});

test("doctor rejects an existing config file without write access", async () => {
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable true\\n" ;; esac',
    async () => {
      const configPath = join(mkdtempSync(join(tmpdir(), "imgen-doctor-config-")), "config.json");
      writeFileSync(configPath, "{}");
      chmodSync(configPath, 0o400);
      try {
        const { runDoctor } = await import("./doctor.ts");
        const report = runDoctor(configPath);

        expect(report.ok).toBe(false);
        expect(report.checks.find((check) => check.name === "Config path")).toEqual({
          name: "Config path",
          ok: false,
          detail: configPath,
        });
      } finally {
        chmodSync(configPath, 0o600);
      }
    },
  );
});

test("doctor accepts a dangling config symlink when its target can be created", async () => {
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable true\\n" ;; esac',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "imgen-doctor-config-"));
      const configPath = join(directory, "config.json");
      const targetPath = join(directory, "target.json");
      symlinkSync("target.json", configPath);
      const { runDoctor } = await import("./doctor.ts");
      const report = runDoctor(configPath);

      expect(report.checks.find((check) => check.name === "Config path")).toEqual({
        name: "Config path",
        ok: true,
        detail: configPath,
      });
      writeFileSync(configPath, "{}");
      expect(readFileSync(targetPath, "utf8")).toBe("{}");
    },
  );
});

test("doctor rejects a dangling config symlink without a writable target directory", async () => {
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable true\\n" ;; esac',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "imgen-doctor-config-"));
      const configPath = join(directory, "config.json");
      symlinkSync("missing/target.json", configPath);
      const { runDoctor } = await import("./doctor.ts");
      const report = runDoctor(configPath);

      expect(report.checks.find((check) => check.name === "Config path")).toEqual({
        name: "Config path",
        ok: false,
        detail: configPath,
      });
      expect(() => writeFileSync(configPath, "{}")).toThrow();
    },
  );
});

test("doctor preserves unresolved dangling symlink target components", async () => {
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable true\\n" ;; esac',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "imgen-doctor-config-"));
      const configPath = join(directory, "config.json");
      symlinkSync("missing/../target.json", configPath);
      const { runDoctor } = await import("./doctor.ts");
      const report = runDoctor(configPath);

      expect(report.checks.find((check) => check.name === "Config path")).toEqual({
        name: "Config path",
        ok: false,
        detail: configPath,
      });
      expect(() => writeFileSync(configPath, "{}")).toThrow();
    },
  );
});

test("doctor rejects a dangling config symlink that requires a directory", async () => {
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable true\\n" ;; esac',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "imgen-doctor-config-"));
      const configPath = join(directory, "config.json");
      symlinkSync("missing/", configPath);
      const { runDoctor } = await import("./doctor.ts");
      const report = runDoctor(configPath);

      expect(report.checks.find((check) => check.name === "Config path")).toEqual({
        name: "Config path",
        ok: false,
        detail: configPath,
      });
      expect(() => writeFileSync(configPath, "{}")).toThrow();
    },
  );
});

test("doctor accepts a dangling config symlink ending in a backslash on POSIX", async () => {
  if (process.platform === "win32") return;
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable true\\n" ;; esac',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "imgen-doctor-config-"));
      const configPath = join(directory, "config.json");
      const targetPath = join(directory, "target\\");
      symlinkSync("target\\", configPath);
      const { runDoctor } = await import("./doctor.ts");
      const report = runDoctor(configPath);

      expect(report.checks.find((check) => check.name === "Config path")).toEqual({
        name: "Config path",
        ok: true,
        detail: configPath,
      });
      writeFileSync(configPath, "{}");
      expect(readFileSync(targetPath, "utf8")).toBe("{}");
    },
  );
});

test("doctor rejects a chained config symlink without a writable final target directory", async () => {
  await withFakeCodex(
    'case "$1" in --version) printf "codex-cli test 1.0.0\\n" ;; features) printf "image_generation stable true\\n" ;; esac',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "imgen-doctor-config-"));
      const configPath = join(directory, "config.json");
      const firstTarget = join(directory, "first-target.json");
      symlinkSync("first-target.json", configPath);
      symlinkSync("missing/target.json", firstTarget);
      const { runDoctor } = await import("./doctor.ts");
      const report = runDoctor(configPath);

      expect(report.checks.find((check) => check.name === "Config path")).toEqual({
        name: "Config path",
        ok: false,
        detail: configPath,
      });
      expect(() => writeFileSync(configPath, "{}")).toThrow();
    },
  );
});

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

function killTestProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

test("saveImage keeps an existing file and adds a suffix to the new image", async () => {
  const { saveImage } = await import("./save.ts");
  const sourceDir = mkdtempSync(join(tmpdir(), "imgen-source-"));
  const destinationDir = mkdtempSync(join(tmpdir(), "imgen-destination-"));
  const source = join(sourceDir, "exec-image.png");
  const existing = join(destinationDir, "exec-image.png");
  writeFileSync(source, "new image");
  writeFileSync(existing, "existing image");

  const saved = saveImage(source, destinationDir);

  expect(basename(saved)).toBe("exec-image-1.png");
  expect(readFileSync(saved, "utf8")).toBe("new image");
  expect(readFileSync(existing, "utf8")).toBe("existing image");
});

test("generate removes its temporary workspace when Codex exits without an image", async () => {
  await withFakeCodex("exit 0", async (cwdLog) => {
    const { generate } = await import("./generate.ts");

    await expect(generate("a red fox").done).rejects.toThrow("codex exited 0 without producing an image");

    expect(existsSync(readFileSync(cwdLog, "utf8"))).toBe(false);
  });
});

test("generate persists each concurrent requested output", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "imgen-output-"));
  await withFakeCodex(
    'case "$*" in *"a red fox"*) printf "fox" > out.png ;; *"a blue heron"*) printf "heron" > out.png ;; esac',
    async () => {
      const { generate } = await import("./generate.ts");
      try {
        const produced = await Promise.all([
          generate("a red fox", { outputDir: outputRoot }).done,
          generate("a blue heron", { outputDir: outputRoot }).done,
        ]);

        expect(produced.flat().map((shot) => readFileSync(shot.path, "utf8")).sort()).toEqual([
          "fox",
          "heron",
        ]);
      } finally {
        rmSync(outputRoot, { recursive: true, force: true });
      }
    },
  );
});

test("generate removes its temporary workspace after cancellation", async () => {
  await withFakeCodex("while :; do :; done", async (cwdLog) => {
    const { generate } = await import("./generate.ts");
    const run = generate("a red fox");
    await waitForFile(cwdLog);

    run.cancel();

    await expect(run.done).rejects.toThrow("cancelled");
    expect(existsSync(readFileSync(cwdLog, "utf8"))).toBe(false);
  });
});

test("generate stops descendants when cancellation escalates", async () => {
  await withFakeCodex(
    "trap '' TERM\n(trap '' TERM\nsleep 30) </dev/null >/dev/null 2>&1 &\nprintf '%s' \"$!\" > \"$IMGEN_TEST_CWD_LOG.background\"\nwhile :; do :; done",
    async (cwdLog) => {
      const { generate } = await import("./generate.ts");
      const run = generate("a red fox");
      await waitForFile(cwdLog);
      const backgroundPidPath = `${cwdLog}.background`;
      await waitForFile(backgroundPidPath);
      const backgroundPid = Number(readFileSync(backgroundPidPath, "utf8"));

      try {
        const started = Date.now();
        run.cancel();

        await expect(run.done).rejects.toThrow("cancelled");
        expect(Date.now() - started).toBeLessThan(1_500);
        await waitForProcessExit(backgroundPid);
        expect(existsSync(readFileSync(cwdLog, "utf8"))).toBe(false);
      } finally {
        killTestProcess(backgroundPid);
      }
    },
  );
});

test("generate keeps escalation armed after the direct child exits", async () => {
  await withFakeCodex(
    "(trap '' TERM\nsleep 30) </dev/null >/dev/null 2>&1 &\nprintf '%s' \"$!\" > \"$IMGEN_TEST_CWD_LOG.background\"\nwhile :; do :; done",
    async (cwdLog) => {
      const { generate } = await import("./generate.ts");
      const run = generate("a red fox");
      await waitForFile(cwdLog);
      const backgroundPidPath = `${cwdLog}.background`;
      await waitForFile(backgroundPidPath);
      const backgroundPid = Number(readFileSync(backgroundPidPath, "utf8"));

      try {
        run.cancel();

        await expect(run.done).rejects.toThrow("cancelled");
        await waitForProcessExit(backgroundPid);
      } finally {
        killTestProcess(backgroundPid);
      }
    },
  );
});

test("generate removes its temporary workspace when Codex cannot start", async () => {
  const root = mkdtempSync(join(tmpdir(), "imgen-no-codex-"));
  const originalPath = process.env.PATH;
  const originalTmpdir = process.env.TMPDIR;
  process.env.PATH = join(root, "missing-bin");
  process.env.TMPDIR = root;
  try {
    const { generate } = await import("./generate.ts");

    await expect(generate("a red fox").done).rejects.toThrow();

    expect(readdirSync(root)).toEqual([]);
  } finally {
    process.env.PATH = originalPath;
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
});

test("enhance removes its temporary workspace when Codex produces no prompt", async () => {
  await withFakeCodex("exit 0", async (cwdLog) => {
    const { enhance } = await import("./enhance.ts");

    await expect(enhance("a red fox", null).done).rejects.toThrow("codex produced no rewritten prompt");

    expect(existsSync(readFileSync(cwdLog, "utf8"))).toBe(false);
  });
});

test("enhance removes its temporary workspace after cancellation", async () => {
  await withFakeCodex("while :; do :; done", async (cwdLog) => {
    const { enhance } = await import("./enhance.ts");
    const run = enhance("a red fox", null);
    await waitForFile(cwdLog);

    run.cancel();

    await expect(run.done).rejects.toThrow("cancelled");
    expect(existsSync(readFileSync(cwdLog, "utf8"))).toBe(false);
  });
});

test("enhance stops descendants when cancellation escalates", async () => {
  await withFakeCodex(
    "trap '' TERM\n(trap '' TERM\nsleep 30) </dev/null >/dev/null 2>&1 &\nprintf '%s' \"$!\" > \"$IMGEN_TEST_CWD_LOG.background\"\nwhile :; do :; done",
    async (cwdLog) => {
      const { enhance } = await import("./enhance.ts");
      const run = enhance("a red fox", null);
      await waitForFile(cwdLog);
      const backgroundPidPath = `${cwdLog}.background`;
      await waitForFile(backgroundPidPath);
      const backgroundPid = Number(readFileSync(backgroundPidPath, "utf8"));

      try {
        const started = Date.now();
        run.cancel();

        await expect(run.done).rejects.toThrow("cancelled");
        expect(Date.now() - started).toBeLessThan(1_500);
        await waitForProcessExit(backgroundPid);
        expect(existsSync(readFileSync(cwdLog, "utf8"))).toBe(false);
      } finally {
        killTestProcess(backgroundPid);
      }
    },
  );
});

test("enhance keeps escalation armed after the direct child exits", async () => {
  await withFakeCodex(
    "(trap '' TERM\nsleep 30) </dev/null >/dev/null 2>&1 &\nprintf '%s' \"$!\" > \"$IMGEN_TEST_CWD_LOG.background\"\nwhile :; do :; done",
    async (cwdLog) => {
      const { enhance } = await import("./enhance.ts");
      const run = enhance("a red fox", null);
      await waitForFile(cwdLog);
      const backgroundPidPath = `${cwdLog}.background`;
      await waitForFile(backgroundPidPath);
      const backgroundPid = Number(readFileSync(backgroundPidPath, "utf8"));

      try {
        run.cancel();

        await expect(run.done).rejects.toThrow("cancelled");
        await waitForProcessExit(backgroundPid);
      } finally {
        killTestProcess(backgroundPid);
      }
    },
  );
});

test("recordPrompt survives a round trip and keeps what earlier runs wrote", () => {
  const index = fakeIndexPath();
  expect(loadPrompts(index)).toEqual({});

  recordPrompt(["/lib/a.png", "/lib/b.png"], "a red fox", index);
  recordPrompt(["/lib/c.png"], "a blue heron", index);

  const stored = loadPrompts(index);
  expect(Object.keys(stored).sort()).toEqual(["/lib/a.png", "/lib/b.png", "/lib/c.png"]);
  // Both images of one run carry that run's prompt — the run is what has a prompt, not the file.
  expect(stored["/lib/a.png"]?.prompt).toBe("a red fox");
  expect(stored["/lib/b.png"]?.prompt).toBe("a red fox");
  expect(stored["/lib/c.png"]?.prompt).toBe("a blue heron");
});

test("recordPrompt keeps the reference images that informed a generation", () => {
  const index = fakeIndexPath();

  recordPrompt(["/lib/a.png"], {
    prompt: "a red fox",
    references: ["/attachments/fox.png"],
  }, index);

  const stored = loadPrompts(index);
  expect(stored["/lib/a.png"]?.prompt).toBe("a red fox");
  expect(stored["/lib/a.png"]?.references).toEqual(["/attachments/fox.png"]);
});

test("recordPrompt preserves the existing prompt storage mode", () => {
  const index = fakeIndexPath();
  writeFileSync(index, "{}", { mode: 0o600 });
  chmodSync(index, 0o600);

  recordPrompt(["/lib/a.png"], "a red fox", index);

  expect(statSync(index).mode & 0o777).toBe(0o600);
});

test("recordPrompt creates private prompt storage", () => {
  const index = fakeIndexPath();

  recordPrompt(["/lib/a.png"], "a red fox", index);

  expect(statSync(index).mode & 0o777).toBe(0o600);
});

test("loadPrompts keeps legacy records that have no references", () => {
  const index = fakeIndexPath();
  writeFileSync(
    index,
    JSON.stringify({ "/lib/a.png": { prompt: "a red fox", at: 1 } }),
  );

  expect(loadPrompts(index)).toEqual({ "/lib/a.png": { prompt: "a red fox", at: 1 } });
});

test("a corrupt index reads as empty rather than stopping the app", () => {
  const index = fakeIndexPath();
  writeFileSync(index, "{ not json");
  expect(loadPrompts(index)).toEqual({});

  // `null` is the dangerous one: it parses, and the first property read then throws inside the
  // gallery's initial state, so the app would fail to start rather than lose its labels.
  for (const valid of ["null", "[]", "42", '"a string"']) {
    writeFileSync(index, valid);
    expect(loadPrompts(index)).toEqual({});
  }
});

test("listShots carries the recorded prompt, and nothing for images it never made", () => {
  const root = fakeLibrary();
  const mine = addShot(root, "s1", "exec-mine.png");
  addShot(root, "s1", "exec-someone-elses.png");

  const shots = listShots(root, { [mine]: { prompt: "a red fox", at: 1 } });
  expect(shots.find((s) => s.path === mine)?.prompt).toBe("a red fox");
  // The 197 images Codex made before imgen existed have no prompt and must still list.
  expect(shots.find((s) => s.path !== mine)?.prompt).toBeUndefined();
  expect(shots).toHaveLength(2);
});

test("listShots carries the reference images recorded for an image", () => {
  const root = fakeLibrary();
  const mine = addShot(root, "s1", "exec-mine.png");
  const prompts = {
    [mine]: {
      prompt: "a red fox",
      at: 1,
      references: ["/attachments/fox.png"],
    },
  } as PromptIndex;

  const shot = listShots(root, prompts).find((candidate) => candidate.path === mine);

  expect(shot?.references).toEqual(["/attachments/fox.png"]);
});

test("listShots normalizes invalid persisted references before reroll", () => {
  const root = fakeLibrary();
  const mine = addShot(root, "s1", "exec-mine.png");
  const index = fakeIndexPath();
  writeFileSync(
    index,
    JSON.stringify({ [mine]: { prompt: "a red fox", at: 1, references: "/attachments/fox.png" } }),
  );

  const shot = listShots(root, loadPrompts(index)).find((candidate) => candidate.path === mine);

  expect(shot?.references).toEqual([]);
});

test("listShots normalizes persisted references that contain non-strings before reroll", () => {
  const root = fakeLibrary();
  const mine = addShot(root, "s1", "exec-mine.png");
  const index = fakeIndexPath();
  writeFileSync(
    index,
    JSON.stringify({ [mine]: { prompt: "a red fox", at: 1, references: [null] } }),
  );

  const shot = listShots(root, loadPrompts(index)).find((candidate) => candidate.path === mine);

  expect(shot?.references).toEqual([]);
});

test("reroll uses current references when the selected image has no provenance", () => {
  expect(rerollOptions({ references: [] }, "a red fox", ["/attachments/fox.png"])).toEqual({
    description: "a red fox",
    references: ["/attachments/fox.png"],
  });
});

test("filterShots matches the prompt case-insensitively and drops the unlabelled", () => {
  const shots = [
    { path: "/a.png", session: "s", createdAt: 3, bytes: 1, prompt: "A Red Fox on a bicycle" },
    { path: "/b.png", session: "s", createdAt: 2, bytes: 1, prompt: "a blue heron" },
    { path: "/c.png", session: "s", createdAt: 1, bytes: 1 },
  ];

  expect(filterShots(shots, "red").map((s) => s.path)).toEqual(["/a.png"]);
  expect(filterShots(shots, "RED").map((s) => s.path)).toEqual(["/a.png"]);
  expect(filterShots(shots, "a").map((s) => s.path)).toEqual(["/a.png", "/b.png"]);
  // An empty query is not a filter — it is the whole library, unlabelled images included.
  expect(filterShots(shots, "")).toHaveLength(3);
  expect(filterShots(shots, "zebra")).toHaveLength(0);
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

// Same opt-in as above: writing text to the clipboard clobbers whatever the user had copied.
test.skipIf(!process.env.IMGEN_CLIPBOARD_TEST)("a path goes onto the clipboard as text", async () => {
  const { createHostClipboard } = await import("@opentui/core");
  const { copyTextToClipboard } = await import("./clipboard.ts");

  const path = "/tmp/imgen-clipboard-check.png";
  await copyTextToClipboard(path);

  const result = await createHostClipboard().read({ preferredTypes: ["text/plain"] });
  if (result.status !== "read") throw new Error(`clipboard read ${result.status}`);
  expect(new TextDecoder().decode(result.representation.bytes)).toBe(path);
});

test("enhanceInstruction keeps the draft, forbids lettering, and honours a standing style", () => {
  const plain = enhanceInstruction("a fox on a bicycle", null);
  expect(plain).toContain("a fox on a bicycle");
  expect(plain).toContain("no lettering or text");
  expect(plain).toContain("prompt.txt");
  expect(plain).not.toContain("standing style preference");

  const styled = enhanceInstruction("a fox", "flat vector, muted palette");
  expect(styled).toContain("standing style preference: flat vector, muted palette");
});
