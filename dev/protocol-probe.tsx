/**
 * Reports how this terminal will render images, and draws one to prove it.
 *
 * Run it in every terminal you might use — the answer is a property of the terminal emulator,
 * so it cannot be determined from another process's pty.
 *
 *   bun run dev/protocol-probe.ts [path/to/image.png]
 */
import { createCliRenderer, resolveImageRenderProtocol } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function anyExistingImage(): string | null {
  const root = join(homedir(), ".codex", "generated_images");
  try {
    for (const session of readdirSync(root)) {
      const png = readdirSync(join(root, session)).find((f) => f.endsWith(".png"));
      if (png) return join(root, session, png);
    }
  } catch {
    /* nothing generated yet */
  }
  return null;
}

const source = process.argv[2] ?? anyExistingImage();
const renderer = await createCliRenderer();
const caps = renderer.capabilities;
const resolved = resolveImageRenderProtocol("auto", caps, true);

const rows: [string, string][] = [
  ["TERM_PROGRAM", process.env.TERM_PROGRAM ?? "(unset)"],
  ["TERM", process.env.TERM ?? "(unset)"],
  ["kitty_graphics", String(caps?.kitty_graphics ?? "unknown")],
  ["sixel", String(caps?.sixel ?? "unknown")],
  ["resolved protocol", resolved],
  ["sample", source ?? "(none found)"],
];

function Probe() {
  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <text fg="#8B5CF6">imgen — terminal image capability probe</text>
      {rows.map(([key, value]) => (
        <text key={key}>
          {key.padEnd(18)}
          {value}
        </text>
      ))}
      <text fg={resolved === "blocks" ? "#F59E0B" : "#10B981"}>
        {resolved === "blocks"
          ? "blocks: no pixel protocol here, previews will be coarse half-block art"
          : `${resolved}: true pixel preview available`}
      </text>
      {source ? (
        <box flexGrow={1} marginTop={1}>
          <image source={source} fit="fit" />
        </box>
      ) : (
        <text fg="#9CA3AF">no image to draw — generate one first</text>
      )}
      <text fg="#9CA3AF">ctrl-c to quit</text>
    </box>
  );
}

createRoot(renderer).render(<Probe />);
