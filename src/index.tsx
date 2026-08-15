#!/usr/bin/env bun
import { createCliRenderer, resolveImageRenderProtocol } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { execFile } from "node:child_process";
import { copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as React from "react";

import type { TextareaRenderable } from "@opentui/core";

import { generate, type Run } from "./generate.ts";
import { listShots, type Shot } from "./library.ts";

const ACCENT = "#8B5CF6";
const MUTED = "#9CA3AF";
const ERROR = "#EF4444";
const OK = "#10B981";
const WARN = "#F59E0B";

const shortName = (shot: Shot): string => basename(shot.path).replace(/^exec-/, "").slice(0, 12);

/** At most three characters: a longer stamp pushes the gallery row past its column and wraps. */
function ago(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

const GALLERY_WIDTH = 22;

/** Fixed-width and hard-truncated, because a wrapped row desynchronises every row beneath it. */
function galleryLabel(shot: Shot, focused: boolean): string {
  return `${focused ? "\u25B8" : " "} ${shortName(shot)} ${ago(shot.createdAt)}`.slice(
    0,
    GALLERY_WIDTH - 2,
  );
}

type Status =
  | { kind: "idle" }
  | { kind: "generating"; startedAt: number }
  | { kind: "note"; text: string; tone: "ok" | "error" };

function App() {
  const renderer = useRenderer();
  const [shots, setShots] = React.useState<Shot[]>(() => listShots());
  const [cursor, setCursor] = React.useState(0);
  const [typing, setTyping] = React.useState(false);
  const editor = React.useRef<TextareaRenderable | null>(null);
  const [lastPrompt, setLastPrompt] = React.useState("");
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const [elapsed, setElapsed] = React.useState(0);
  const [full, setFull] = React.useState(false);
  const [promptGeneration, setPromptGeneration] = React.useState(0);
  const run = React.useRef<Run | null>(null);

  const protocol = resolveImageRenderProtocol("auto", renderer.capabilities, true);
  const selected: Shot | undefined = shots[Math.min(cursor, shots.length - 1)];

  /**
   * The gallery is a window onto the library, not the whole of it.
   *
   * Rendering a fixed number of rows while letting the cursor run to the end of a 186-image
   * library does two bad things at once: the cursor walks off the bottom of what is drawn, and
   * the overflowing list scrolls the terminal — which cuts the in-flight kitty escape sequence
   * carrying the preview, so the rest of the image arrives as visible base64 text.
   */
  const { height } = useTerminalDimensions();
  const listRows = Math.max(3, height - 12);
  const windowStart = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), shots.length - listRows));

  // Elapsed counter, so a multi-minute turn never looks like a hang.
  React.useEffect(() => {
    if (status.kind !== "generating") return;
    const started = status.startedAt;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [status]);

  const start = React.useCallback((description: string) => {
    if (!description.trim()) return;
    setLastPrompt(description);
    setStatus({ kind: "generating", startedAt: Date.now() });
    setElapsed(0);

    const current = generate(description);
    run.current = current;
    current.done
      .then((produced) => {
        setShots(listShots());
        setCursor(0);
        renderer.requestRender();
        setStatus({
          kind: "note",
          text: `${produced.length} image${produced.length === 1 ? "" : "s"} generated`,
          tone: "ok",
        });
      })
      .catch((error: Error) => {
        setStatus({ kind: "note", text: error.message.split("\n")[0] ?? "failed", tone: "error" });
      })
      .finally(() => {
        run.current = null;
      });
  }, [renderer]);

  const save = React.useCallback(() => {
    if (!selected) return;
    const dest = join(process.cwd(), basename(selected.path));
    try {
      copyFileSync(selected.path, dest);
      setStatus({ kind: "note", text: `saved ${dest}`, tone: "ok" });
    } catch (error) {
      setStatus({ kind: "note", text: (error as Error).message, tone: "error" });
    }
  }, [selected]);

  useKeyboard((key) => {
    if (typing) {
      // Enter is handled here rather than through the element's own submit callback: the JSX
      // `input` intrinsic merges with React's HTML input, so `onSubmit` types as a DOM handler.
      if (key.name === "escape") setTyping(false);
      if (key.name === "return" && !key.shift) {
        // The editor is uncontrolled, so its text is read off the buffer and cleared by
        // remounting; mirroring every keystroke into React state would redraw the image too.
        const description = editor.current?.editBuffer.getText() ?? "";
        setTyping(false);
        setPromptGeneration((n) => n + 1);
        start(description);
      }
      return; // the focused input owns every other key
    }

    switch (key.name) {
      case "q":
        return process.exit(0);
      case "i":
      case "/":
        return setTyping(true);
      case "j":
      case "down":
        return setCursor((c) => Math.min(c + 1, shots.length - 1));
      case "k":
      case "up":
        return setCursor((c) => Math.max(c - 1, 0));
      case "f":
        return setFull((v) => !v);
      case "s":
        return save();
      case "o":
        if (selected) execFile("open", [selected.path], () => {});
        return;
      case "r":
        if (lastPrompt && status.kind !== "generating") start(lastPrompt);
        return;
      case "escape":
        if (run.current) {
          run.current.cancel();
          setStatus({ kind: "note", text: "cancelled", tone: "error" });
        }
        return;
      default:
        return;
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} padding={1}>
      <box flexDirection="row" gap={1}>
        <text fg={ACCENT}>imgen</text>
        <text fg={MUTED}>{`${shots.length} images · ${protocol}`}</text>
        {protocol === "blocks" ? (
          <text fg={WARN}>no pixel protocol — previews are coarse</text>
        ) : null}
      </box>

      {/* A textarea rather than an input: image prompts are paragraphs, and a single line both
          caps the length and hides everything past the right edge while you are writing it. */}
      <box flexDirection="row" gap={1} marginTop={1}>
        <text fg={typing ? ACCENT : MUTED}>prompt</text>
        <textarea
          key={promptGeneration}
          ref={editor}
          flexGrow={1}
          height={typing ? 6 : 1}
          focused={typing}
          wrapMode="word"
          placeholder="describe the image — enter sends, shift+enter adds a line"
        />
      </box>

      <box flexDirection="row" flexGrow={1} marginTop={1} gap={1}>
        {full ? null : (
          <box flexDirection="column" width={GALLERY_WIDTH} height={listRows} overflow="hidden">
            {shots.slice(windowStart, windowStart + listRows).map((shot, offset) => {
              const index = windowStart + offset;
              return (
                <text key={shot.path} fg={index === cursor ? ACCENT : MUTED}>
                  {galleryLabel(shot, index === cursor)}
                </text>
              );
            })}
            {shots.length === 0 ? <text fg={MUTED}>nothing generated yet</text> : null}
          </box>
        )}

        {/* The image has no intrinsic size, so without flexGrow it collapses to a thumbnail in
            the corner of a full-size box. `fit` then scales within whatever it was given. */}
        <box flexGrow={1} border borderColor={MUTED}>
          {selected ? (
            <image flexGrow={1} width="100%" source={selected.path} fit="fit" />
          ) : (
            <text fg={MUTED}>no image</text>
          )}
        </box>
      </box>

      <box flexDirection="column" marginTop={1}>
        {status.kind === "generating" ? (
          <text fg={ACCENT}>{`generating… ${elapsed}s — esc cancels`}</text>
        ) : null}
        {status.kind === "note" ? (
          <text fg={status.tone === "ok" ? OK : ERROR}>{status.text}</text>
        ) : null}
        {status.kind === "idle" && selected ? (
          <text fg={MUTED}>{`${(selected.bytes / 1_048_576).toFixed(1)} MB · ${selected.path}`}</text>
        ) : null}
        <text fg={MUTED}>i prompt · j/k move · f fullscreen · s save here · o open · r reroll · q quit</text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
