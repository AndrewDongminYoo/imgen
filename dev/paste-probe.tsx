/**
 * Shows exactly what this terminal delivers on a paste.
 *
 * Run it, then press ⌘V with an image on the clipboard, and again with text. The point is to
 * see whether an image paste arrives as binary bytes, as a path, as text plus an image, or as
 * nothing at all — which decides how the real handler must branch. Capability like this cannot
 * be read from another process's pty, so it has to run in the terminal you actually use.
 *
 *   bun run dev/paste-probe.tsx
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot, usePaste } from "@opentui/react";
import * as React from "react";

interface Seen {
  index: number;
  kind: string;
  mimeType: string;
  byteLength: number;
  preview: string;
  looksLikePath: boolean;
  isPngMagic: boolean;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function Probe() {
  const [events, setEvents] = React.useState<Seen[]>([]);

  usePaste((event) => {
    const bytes = event.bytes;
    const text = new TextDecoder().decode(bytes);
    setEvents((prev) => [
      ...prev,
      {
        index: prev.length + 1,
        kind: event.metadata?.kind ?? "(none)",
        mimeType: event.metadata?.mimeType ?? "(none)",
        byteLength: bytes.length,
        // Printable prefix only — binary would otherwise scribble over the screen.
        preview: text.slice(0, 90).replace(/[^\x20-\x7E]/g, "·"),
        looksLikePath: /\.(png|jpe?g|gif|webp)$/i.test(text.trim()),
        isPngMagic: PNG_MAGIC.every((b, i) => bytes[i] === b),
      },
    ]);
  });

  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <text fg="#8B5CF6">imgen — paste probe</text>
      <text fg="#9CA3AF">
        Press ⌘V with an image on the clipboard, then again with plain text. ctrl-c to quit.
      </text>
      <text fg="#9CA3AF">{`TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "(unset)"}`}</text>

      {events.length === 0 ? (
        <text fg="#F59E0B">waiting for a paste…</text>
      ) : (
        events.map((e) => (
          <box key={e.index} flexDirection="column" marginTop={1}>
            <text fg="#10B981">{`paste #${e.index}`}</text>
            <text>{`  kind         ${e.kind}`}</text>
            <text>{`  mimeType     ${e.mimeType}`}</text>
            <text>{`  bytes        ${e.byteLength}`}</text>
            <text>{`  PNG header   ${e.isPngMagic}`}</text>
            <text>{`  image path   ${e.looksLikePath}`}</text>
            <text>{`  text         ${e.preview || "(empty)"}`}</text>
          </box>
        ))
      )}
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<Probe />);
