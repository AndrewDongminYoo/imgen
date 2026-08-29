import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { dirname } from "node:path";

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

function configPathIsWritable(path: string): boolean {
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
