#!/usr/bin/env bun
import { createCliRenderer, resolveImageRenderProtocol } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { execFile } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import * as React from "react";

import type { TextareaRenderable } from "@opentui/core";

import { loadConfig } from "./config.ts";
import { enhance, type EnhanceRun } from "./enhance.ts";
import { generate, type Run } from "./generate.ts";
import {
  attachFile,
  copyImageToClipboard,
  pasteImageFromClipboard,
} from "./clipboard.ts";
import { listShots, type Shot } from "./library.ts";

const ACCENT = "#8B5CF6";
const MUTED = "#9CA3AF";
const ERROR = "#EF4444";
const OK = "#10B981";
const WARN = "#F59E0B";

/** Braille spinner; a Codex turn reports no percentage, so motion is the honest signal. */
const SPINNER = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const TICK_MS = 90;

/** alt+return arrives as a bare `return` whose sequence is prefixed with this. */
const ESC = "\u001b";

/**
 * Set IMGEN_KEY_LOG to a path to record what this terminal actually delivers, in the real app.
 *
 * Which key reaches an application, and what the editor then does with it, varies by terminal
 * and cannot be learned from a pty — every attempt to settle it that way here was wrong. This
 * is how to answer it from the terminal you actually use.
 */
const KEY_LOG = process.env.IMGEN_KEY_LOG;

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
  const [ticks, setTicks] = React.useState(0);
  const [activity, setActivity] = React.useState("");
  const [references, setReferences] = React.useState<string[]>([]);
  const [full, setFull] = React.useState(false);
  const [promptGeneration, setPromptGeneration] = React.useState(0);
  const run = React.useRef<Run | null>(null);
  const rewrite = React.useRef<EnhanceRun | null>(null);
  const [enhancing, setEnhancing] = React.useState(false);
  const config = React.useMemo(loadConfig, []);

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
  const chromeRows = 12 + (typing ? 4 : 0) + (references.length > 0 ? 7 : 0);
  const listRows = Math.max(3, height - chromeRows);
  const windowStart = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), shots.length - listRows));

  // One timer drives both the spinner frame and the elapsed seconds, so a multi-minute turn
  // never looks like a hang.
  React.useEffect(() => {
    if (status.kind !== "generating" && !enhancing) return;
    const timer = setInterval(() => setTicks((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [status, enhancing]);

  const start = React.useCallback((description: string) => {
    if (!description.trim()) return;
    setLastPrompt(description);
    setStatus({ kind: "generating", startedAt: Date.now() });
    setTicks(0);
    setActivity("");

    const current = generate(description, { references, onActivity: setActivity });
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
  }, [renderer, references]);

  const addReference = React.useCallback((path: string) => {
    setReferences((prev) => [...prev, path]);
    setStatus({ kind: "note", text: `attached ${basename(path)}`, tone: "ok" });
  }, []);

  /**
   * Cmd+V never reaches an application as a key — the terminal turns it into a paste, and what
   * it puts in that paste varies. A pasted file path is copied in; anything else defers to
   * reading the pasteboard directly, which gets the image whatever the terminal did with it.
   */
  usePaste((event) => {
    const text = new TextDecoder().decode(event.bytes).trim();
    if (/\.(png|jpe?g|gif|webp)$/i.test(text) && existsSync(text)) {
      return addReference(attachFile(text));
    }

    // Any other text belongs to the editor — attaching the clipboard image alongside it would
    // be a surprise. An image-only clipboard is the case that arrives with nothing to paste.
    if (text) return;

    void pasteImageFromClipboard()
      .then(addReference)
      .catch(() => {
        /* nothing on the pasteboard we can use */
      });
  });

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
    if (KEY_LOG) {
      const seen = key;
      setTimeout(() => {
        appendFileSync(
          KEY_LOG,
          `name=${seen.name} shift=${seen.shift} ctrl=${seen.ctrl} option=${seen.option} ` +
            `seq=${JSON.stringify(seen.sequence)} buffer=${JSON.stringify(
              editor.current?.editBuffer.getText() ?? null,
            )}\n`,
        );
      }, 40);
    }
    if (typing) {
      // Enter is handled here rather than through the element's own submit callback: the JSX
      // `input` intrinsic merges with React's HTML input, so `onSubmit` types as a DOM handler.
      if (key.name === "escape") {
        rewrite.current?.cancel();
        rewrite.current = null;
        setTyping(false);
      }
      if (key.name === "tab" && !enhancing) {
        const draft = editor.current?.editBuffer.getText().trim() ?? "";
        if (!draft) return;
        setEnhancing(true);
        setStatus({ kind: "note", text: "asking Codex to flesh out the draft\u2026", tone: "ok" });
        const current = enhance(draft, config.style);
        rewrite.current = current;
        current.done
          .then((text) => {
            editor.current?.editBuffer.setText(text);
            setStatus({ kind: "note", text: "draft filled in \u2014 read it, edit it, then enter to generate", tone: "ok" });
          })
          .catch((error: Error) => {
            if (error.message !== "cancelled") {
              setStatus({ kind: "note", text: error.message, tone: "error" });
            }
          })
          .finally(() => {
            rewrite.current = null;
            setEnhancing(false);
          });
        return;
      }
      // A new line is any modified return: shift and ctrl arrive as flags where the kitty
      // keyboard protocol is on, alt+return as a bare `return` carrying an escape prefix in its
      // sequence. opencode also binds ctrl+j, which is left out here — it needs a second branch
      // because the two terminal families disagree on whether it is a `linefeed` or a modified
      // letter, and shift+return and alt+return already cover the same need.
      if (
        key.name === "return" &&
        (key.shift || key.ctrl || key.meta || key.option || key.sequence.startsWith(ESC))
      ) {
        editor.current?.editBuffer.newLine();
        return;
      }
      if (key.name === "return") {
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
        // Exiting straight from here would skip OpenTUI's teardown, and the terminal keeps
        // whatever the renderer turned on: mouse reporting (1000/1002/1003/1006) keeps writing
        // coordinates into the next shell prompt, the alternate screen never flips back, and
        // the cursor stays hidden.
        renderer.destroy();
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
      case "c":
        if (selected) {
          void copyImageToClipboard(selected.path)
            .then(() => setStatus({ kind: "note", text: "copied to clipboard", tone: "ok" }))
            .catch((e: Error) => setStatus({ kind: "note", text: e.message, tone: "error" }));
        }
        return;
      // `name` is always the unshifted key, so a `case "V"` never matches and shift+V fell
      // through to the paste above — attaching another copy instead of clearing.
      case "v":
        if (key.shift) {
          if (references.length === 0) return;
          setReferences([]);
          return setStatus({ kind: "note", text: "removed all reference images", tone: "ok" });
        }
        void pasteImageFromClipboard()
          .then(addReference)
          .catch((e: Error) => setStatus({ kind: "note", text: e.message, tone: "error" }));
        return;
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
      {/* Label above rather than beside: sharing a row with a flexGrow textarea put the editor
          at column zero on top of the label, and pinned it to a single line. */}
      <box flexDirection="column" marginTop={1}>
        <text fg={typing ? ACCENT : MUTED}>
          {typing
            ? enhancing
              ? `${SPINNER[ticks % SPINNER.length]} Codex is fleshing out the draft — esc cancels`
              : "prompt — enter generates · tab lets Codex flesh out the draft · shift/option+enter new line · esc cancels"
            : "prompt"}
        </text>
        <textarea
          key={promptGeneration}
          ref={editor}
          width="100%"
          height={typing ? 5 : 1}
          minHeight={typing ? 5 : 1}
          focused={typing}
          wrapMode="word"
          placeholder="describe the image — rough is fine, tab fills in the rest"
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
          <box flexDirection="column">
            <text fg={ACCENT}>
              {`${SPINNER[ticks % SPINNER.length]} generating… ${Math.floor(
                (Date.now() - status.startedAt) / 1000,
              )}s — esc cancels`}
            </text>
            {/* Codex reports no percentage, so its own last line is the closest thing to one. */}
            {activity ? <text fg={MUTED}>{activity.slice(0, 110)}</text> : null}
          </box>
        ) : null}
        {status.kind === "note" ? (
          <text fg={status.tone === "ok" ? OK : ERROR}>{status.text}</text>
        ) : null}
        {status.kind === "idle" && selected ? (
          <text fg={MUTED}>{`${(selected.bytes / 1_048_576).toFixed(1)} MB · ${selected.path}`}</text>
        ) : null}
        {/* Thumbnails rather than a count: the whole point of a reference is what it looks like,
            and a line of green text does not tell you which image you attached. */}
        {references.length > 0 ? (
          <box flexDirection="column" marginTop={1}>
            <text fg={WARN}>
              {`references — sent with the next prompt · shift+V removes ${
                references.length === 1 ? "it" : "all " + references.length
              }`}
            </text>
            <box flexDirection="row" gap={1} height={5}>
              {references.map((path) => (
                <box key={path} width={14} height={5} border borderColor={WARN}>
                  <image flexGrow={1} width="100%" source={path} fit="fit" />
                </box>
              ))}
            </box>
          </box>
        ) : null}
        <text fg={MUTED}>
          i prompt · j/k move · f fullscreen · ⌘V/v attach ref · c copy · s save · o open · r reroll
          · q quit
        </text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
