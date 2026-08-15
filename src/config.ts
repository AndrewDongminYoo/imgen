import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  /**
   * Standing art direction, appended to every prompt rewrite.
   *
   * Free text rather than a schema of palette/lighting/camera fields: the model already reads
   * "flat vector, muted palette, no text" as one instruction, and a schema would only be a
   * worse way of writing the same sentence.
   */
  style: string | null;
}

export const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "imgen",
  "config.json",
);

const DEFAULTS: Config = { style: null };

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>) };
  } catch {
    // A broken config should not stop the app starting; the style is a preference, not a key.
    return DEFAULTS;
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
