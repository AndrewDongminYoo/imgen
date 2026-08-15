#!/usr/bin/env bun
import { createCliRenderer, resolveImageRenderProtocol } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { execFile } from "node:child_process";
import { copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as React from "react";

import { generate, type Run } from "./generate.ts";
import { listShots, type Shot } from "./library.ts";

const ACCENT = "#8B5CF6";
const MUTED = "#9CA3AF";
const ERROR = "#EF4444";
const OK = "#10B981";
const WARN = "#F59E0B";

const shortName = (shot: Shot): string => basename(shot.path).replace(/^exec-/, "").slice(0, 12);

function ago(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
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
  const [prompt, setPrompt] = React.useState("");
  const [lastPrompt, setLastPrompt] = React.useState("");
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const [elapsed, setElapsed] = React.useState(0);
  const run = React.useRef<Run | null>(null);

  const protocol = resolveImageRenderProtocol("auto", renderer.capabilities, true);
  const selected: Shot | undefined = shots[Math.min(cursor, shots.length - 1)];

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
  }, []);

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
      if (key.name === "return") {
        setTyping(false);
        const description = prompt;
        setPrompt("");
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

      <box flexDirection="row" gap={1} marginTop={1}>
        <text fg={typing ? ACCENT : MUTED}>prompt</text>
        <input
          flexGrow={1}
          focused={typing}
          value={prompt}
          placeholder="describe the image, then press enter"
          onInput={setPrompt}
        />
      </box>

      <box flexDirection="row" flexGrow={1} marginTop={1} gap={1}>
        <box flexDirection="column" width={22}>
          {shots.slice(0, 24).map((shot, index) => (
            <text key={shot.path} fg={index === cursor ? ACCENT : MUTED}>
              {`${index === cursor ? "▸" : " "} ${shortName(shot)} ${ago(shot.createdAt)}`}
            </text>
          ))}
          {shots.length === 0 ? <text fg={MUTED}>nothing generated yet</text> : null}
        </box>

        <box flexGrow={1} border borderColor={MUTED}>
          {selected ? <image source={selected.path} fit="fit" /> : <text fg={MUTED}>no image</text>}
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
        <text fg={MUTED}>i prompt · j/k move · s save here · o open · r reroll · q quit</text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
