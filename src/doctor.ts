import { spawnSync } from "node:child_process";
import { accessSync, constants, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { CONFIG_PATH } from "./config.ts";

export interface DoctorCheck {
  name: "Codex CLI" | "image_generation" | "Config path";
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

function runCodex(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("codex", args, { encoding: "utf8" });
  if (result.error) {
    return {
      ok: false,
      output: (result.error as NodeJS.ErrnoException).code === "ENOENT" ? "not installed" : result.error.message,
    };
  }
  if (result.status !== 0) return { ok: false, output: result.stderr.trim() || `exited ${result.status ?? "unknown"}` };
  return { ok: true, output: result.stdout.trim() };
}

function danglingSymlinkTarget(path: string): string | null | undefined {
  let target = path;
  let followed = false;
  while (true) {
    try {
      const link = readlinkSync(target);
      target = isAbsolute(link) ? link : `${dirname(target)}/${link}`;
      followed = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return followed ? target : null;
      return undefined;
    }
  }
}

function configPathIsWritable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  const symlinkTarget = danglingSymlinkTarget(path);
  if (symlinkTarget === undefined) return false;
  if (symlinkTarget !== null) {
    if (symlinkTarget.endsWith("/") || (process.platform === "win32" && symlinkTarget.endsWith("\\"))) return false;
    try {
      const targetDirectory = dirname(symlinkTarget);
      if (!statSync(targetDirectory).isDirectory()) return false;
      accessSync(targetDirectory, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  let directory = dirname(path);
  while (true) {
    try {
      if (!statSync(directory).isDirectory()) return false;
      accessSync(directory, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  }
}

export function runDoctor(configPath = CONFIG_PATH): DoctorReport {
  const version = runCodex(["--version"]);
  const features = version.ok ? runCodex(["features", "list"]) : null;
  const imageGenerationEnabled = Boolean(features?.ok && /^image_generation\s+stable\s+true\s*$/m.test(features.output));
  const configPathWritable = configPathIsWritable(configPath);
  const checks: DoctorCheck[] = [
    { name: "Codex CLI", ok: version.ok, detail: version.output || "installed" },
    {
      name: "image_generation",
      ok: imageGenerationEnabled,
      detail: imageGenerationEnabled ? "stable" : features?.ok ? "disabled" : features?.output ?? "not checked",
    },
    { name: "Config path", ok: configPathWritable, detail: configPath },
  ];

  return { ok: checks.every((check) => check.ok), checks };
}
