#!/usr/bin/env bun
import { version } from "../package.json";

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

import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";

import { loadConfig } from "./config.ts";
import { enhance, type EnhanceRun } from "./enhance.ts";
import { generate, type Run } from "./generate.ts";
import {
  attachFile,
  copyImageToClipboard,
  copyTextToClipboard,
  pasteImageFromClipboard,
} from "./clipboard.ts";
import { filterShots, listShots, type Shot } from "./library.ts";
import { recordPrompt } from "./prompts.ts";

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
 *
 * It logs which mode owned the key as well, because the modes that swallow everything they do
 * not claim look identical from outside to a key that never arrived: once esc fails to land,
 * the prompt keeps every key after it and the app reads as frozen. `typing=true` on a key you
 * expected the gallery to handle is that, and it separates the app from the terminal at a
 * glance. Seen once in Warp, not reproducible, and gone after focus left the window and
 * returned — OpenTUI maps kitty code 27 to `escape`, so nothing here was dropping it.
 */
const KEY_LOG = process.env.IMGEN_KEY_LOG;

/** A prompt is a paragraph and carries newlines; one raw would desynchronise every row beneath. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** What the image is, when that is known — a hex filename tells you nothing about the picture. */
const shortName = (shot: Shot): string =>
  (shot.prompt ? oneLine(shot.prompt) : basename(shot.path).replace(/^exec-/, "")).slice(0, 22);

/** At most three characters: a longer stamp pushes the gallery row past its column and wraps. */
function ago(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

const GALLERY_WIDTH = 32;

/** Rows the prompt reader takes out of the preview; the image keeps the rest. */
const READER_ROWS = 10;

/** Fixed-width and hard-truncated, because a wrapped row desynchronises every row beneath it. */
function galleryLabel(shot: Shot, focused: boolean): string {
  return `${focused ? "\u25B8" : " "} ${shortName(shot)} ${ago(shot.createdAt)}`.slice(
    0,
    GALLERY_WIDTH - 2,
  );
}

/**
 * Only what to tell the user, never what is happening.
 *
 * A run's progress lives in `runningSince` instead, because the two have different lifetimes:
 * a note is transient and anything may write one — including a refusal fired mid-run — while
 * the progress indicator has to survive until the child exits.
 */
type Status = { kind: "idle" } | { kind: "note"; text: string; tone: "ok" | "error" };

function App() {
  const renderer = useRenderer();
  const [shots, setShots] = React.useState<Shot[]>(() => listShots());
  const [cursor, setCursor] = React.useState(0);
  const [typing, setTyping] = React.useState(false);
  const editor = React.useRef<TextareaRenderable | null>(null);
  const [lastPrompt, setLastPrompt] = React.useState("");
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const [runningSince, setRunningSince] = React.useState<number | null>(null);
  const [ticks, setTicks] = React.useState(0);
  const [activity, setActivity] = React.useState("");
  const [references, setReferences] = React.useState<string[]>([]);
  const [full, setFull] = React.useState(false);
  const [promptGeneration, setPromptGeneration] = React.useState(0);
  // The query stays applied after enter so j/k work again; `filtering` is only about who owns
  // the keystrokes. esc clears both.
  const [filter, setFilter] = React.useState("");
  const [filtering, setFiltering] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const reader = React.useRef<ScrollBoxRenderable | null>(null);
  const run = React.useRef<Run | null>(null);
  const rewrite = React.useRef<EnhanceRun | null>(null);
  const [enhancing, setEnhancing] = React.useState(false);
  const config = React.useMemo(loadConfig, []);

  const protocol = resolveImageRenderProtocol("auto", renderer.capabilities, true);
  // Everything below navigates the filtered view; `shots` is only the source it is drawn from.
  const visible = React.useMemo(() => filterShots(shots, filter), [shots, filter]);
  const selected: Shot | undefined = visible[Math.min(cursor, visible.length - 1)];

  /**
   * The gallery is a window onto the library, not the whole of it.
   *
   * Rendering a fixed number of rows while letting the cursor run to the end of a 186-image
   * library does two bad things at once: the cursor walks off the bottom of what is drawn, and
   * the overflowing list scrolls the terminal — which cuts the in-flight kitty escape sequence
   * carrying the preview, so the rest of the image arrives as visible base64 text.
   */
  const { height } = useTerminalDimensions();
  const showFilter = filtering || filter !== "";
  const chromeRows =
    12 + (typing ? 4 : 0) + (references.length > 0 ? 7 : 0) + (showFilter ? 1 : 0);
  const listRows = Math.max(3, height - chromeRows);
  const windowStart = Math.max(
    0,
    Math.min(cursor - Math.floor(listRows / 2), visible.length - listRows),
  );

  // One timer drives both the spinner frame and the elapsed seconds, so a multi-minute turn
  // never looks like a hang.
  React.useEffect(() => {
    if (runningSince === null && !enhancing) return;
    const timer = setInterval(() => setTicks((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [runningSince, enhancing]);

  /**
   * Returns whether the description was consumed, so a caller holding a draft can keep it.
   *
   * A second run must not start over the first: overwriting `run.current` orphans the child,
   * which keeps running and billing while `esc` reaches only the newer one.
   */
  const start = React.useCallback((description: string): boolean => {
    if (!description.trim()) return false;
    if (run.current) {
      setStatus({
        kind: "note",
        text: "a generation is already running — esc cancels it",
        tone: "error",
      });
      return false;
    }
    setLastPrompt(description);
    setStatus({ kind: "idle" }); // drop whatever the last run said; this one has its own answer
    setRunningSince(Date.now());
    setTicks(0);
    setActivity("");

    const current = generate(description, { references, onActivity: setActivity });
    run.current = current;
    current.done
      .then((produced) => {
        // Recorded before the library is re-read, so the join picks the new labels up at once.
        recordPrompt(produced.map((shot) => shot.path), description);
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
        // A cancelled run has already had its say, and a superseded one is not the news.
        if (run.current !== current) return;
        setStatus({ kind: "note", text: error.message.split("\n")[0] ?? "failed", tone: "error" });
      })
      .finally(() => {
        // Only if this run still owns the slot: a cancelled run's close event arrives late, and
        // clearing unconditionally would drop the handle of whatever was started after it and
        // stop the successor's progress indicator halfway through.
        if (run.current !== current) return;
        run.current = null;
        setRunningSince(null);
      });
    return true;
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
          `name=${seen.name} typing=${typing} filtering=${filtering} reading=${reading} ` +
            `filter=${JSON.stringify(filter)} shift=${seen.shift} ctrl=${seen.ctrl} option=${seen.option} ` +
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
        // Clearing the editor before the run is accepted would throw the draft away on refusal.
        // A blank draft is not a refusal — there is nothing to keep, so enter closes the editor
        // as it always did.
        if (description.trim() && !start(description)) return;
        setTyping(false);
        setPromptGeneration((n) => n + 1);
      }
      return; // the focused input owns every other key
    }

    /**
     * The query is typed straight into state rather than through a focused input.
     *
     * A second editable element would need its own focus handling and its own branch here, for
     * one line of text with no wrapping and no cursor — the manual version is the smaller one.
     */
    if (filtering) {
      if (key.name === "escape") {
        setFilter("");
        setFiltering(false);
        return;
      }
      if (key.name === "return") {
        setFiltering(false); // applied and still showing; j/k navigate what is left
        return;
      }
      if (key.name === "backspace") {
        setFilter((q) => q.slice(0, -1));
        setCursor(0);
        return;
      }
      // Printable characters only, read off the sequence: `name` reports "space" for a space and
      // nothing usable for punctuation.
      if (key.sequence.length === 1 && key.sequence >= " " && key.sequence <= "~") {
        setFilter((q) => q + key.sequence);
        setCursor(0);
      }
      return;
    }

    /**
     * While the prompt is open, j/k scroll it instead of walking the gallery — moving the
     * selection under an open reader would swap the text out from under the line being read.
     * Everything else still applies to the selected image, so q, s, c and p keep working.
     */
    if (reading) {
      if (key.name === "escape" || key.name === "return") return setReading(false);
      if (key.name === "j" || key.name === "down") return void reader.current?.scrollBy(2);
      if (key.name === "k" || key.name === "up") return void reader.current?.scrollBy(-2);
      // c copies what you are looking at, which in here is the text rather than the picture.
      if (key.name === "c" && selected?.prompt) {
        void copyTextToClipboard(selected.prompt)
          .then(() => setStatus({ kind: "note", text: "prompt copied to clipboard", tone: "ok" }))
          .catch((e: Error) => setStatus({ kind: "note", text: e.message, tone: "error" }));
        return;
      }
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
        return setTyping(true);
      case "return":
        // Inspecting what is selected is what enter means everywhere else, and it was unbound.
        if (!selected?.prompt) {
          return setStatus({
            kind: "note",
            text: "no prompt recorded — imgen only knows the ones it generated",
            tone: "error",
          });
        }
        return setReading(true);
      case "/":
        return setFiltering(true); // keeps the current query, so `/` refines rather than restarts
      case "j":
      case "down":
        // Clamped at zero as well as at the end: a filter matching nothing makes the upper bound
        // -1, and a negative cursor survives the filter being cleared, leaving the gallery with
        // nothing selected and every image action silently doing nothing.
        return setCursor((c) => Math.max(0, Math.min(c + 1, visible.length - 1)));
      case "k":
      case "up":
        return setCursor((c) => Math.max(c - 1, 0));
      case "f":
        return setFull((v) => !v);
      case "s":
        return save();
      case "c":
        if (!selected) return;
        void copyImageToClipboard(selected.path)
          .then(() => setStatus({ kind: "note", text: "image copied to clipboard", tone: "ok" }))
          .catch((e: Error) => setStatus({ kind: "note", text: e.message, tone: "error" }));
        return;
      case "p":
        if (!selected) return;
        void copyTextToClipboard(selected.path)
          .then(() => setStatus({ kind: "note", text: "path copied to clipboard", tone: "ok" }))
          .catch((e: Error) => setStatus({ kind: "note", text: e.message, tone: "error" }));
        return;
      case "x":
        if (references.length === 0) return;
        setReferences([]);
        return setStatus({ kind: "note", text: "removed all reference images", tone: "ok" });
      case "v":
        void pasteImageFromClipboard()
          .then(addReference)
          .catch((e: Error) => setStatus({ kind: "note", text: e.message, tone: "error" }));
        return;
      case "o":
        if (selected) execFile("open", [selected.path], () => {});
        return;
      case "r": {
        // Roll the selected image's own prompt again — "this one, differently" is what r is for
        // once the gallery knows what made each picture. Falls back to the session's last.
        const again = selected?.prompt ?? lastPrompt;
        if (again) start(again);
        return;
      }
      case "escape":
        if (run.current) {
          // Released here rather than when the child's close event lands: SIGTERM can take a
          // while, or be ignored outright, and until the slot is free no new run may start.
          run.current.cancel();
          run.current = null;
          setRunningSince(null);
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
        <text fg={MUTED}>
          {`${visible.length === shots.length ? shots.length : `${visible.length}/${shots.length}`} images · ${protocol}`}
        </text>
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

      {/* Only images imgen made carry a prompt, so a filter necessarily hides the rest of the
          library. Saying so beats an empty gallery that looks like a bug. */}
      {showFilter ? (
        <text fg={filtering ? ACCENT : WARN}>
          {`filter /${filter}${filtering ? "█" : ""} — ${visible.length} of ${shots.length}, only what imgen generated · ${
            filtering ? "enter applies · esc clears" : "/ refines · esc in / clears"
          }`}
        </text>
      ) : null}

      <box flexDirection="row" flexGrow={1} marginTop={1} gap={1}>
        {full ? null : (
          <box flexDirection="column" width={GALLERY_WIDTH} height={listRows} overflow="hidden">
            {visible.slice(windowStart, windowStart + listRows).map((shot, offset) => {
              const index = windowStart + offset;
              return (
                <text key={shot.path} fg={index === cursor ? ACCENT : MUTED}>
                  {galleryLabel(shot, index === cursor)}
                </text>
              );
            })}
            {visible.length === 0 ? (
              <text fg={MUTED}>{filter ? "nothing matches" : "nothing generated yet"}</text>
            ) : null}
          </box>
        )}

        <box flexGrow={1} flexDirection="column" gap={1}>
          {/* The image has no intrinsic size, so without flexGrow it collapses to a thumbnail in
              the corner of a full-size box. `fit` then scales within whatever it was given. */}
          <box flexGrow={1} border borderColor={MUTED}>
            {selected ? (
              <image flexGrow={1} width="100%" source={selected.path} fit="fit" />
            ) : (
              <text fg={MUTED}>no image</text>
            )}
          </box>

          {/* Beside the image rather than over it: a kitty placement is drawn by the terminal,
              not into the cell grid, so what wins where text overlaps it is the emulator's call
              and cannot be settled from here. Splitting the pane looks the same everywhere. */}
          {reading && selected?.prompt ? (
            <box height={READER_ROWS} border borderColor={ACCENT} flexDirection="column">
              <text fg={ACCENT}>prompt — j/k scroll · c copies it · enter or esc closes</text>
              <scrollbox ref={reader} flexGrow={1}>
                <text fg={MUTED}>{selected.prompt}</text>
              </scrollbox>
            </box>
          ) : null}
        </box>
      </box>

      <box flexDirection="column" marginTop={1}>
        {runningSince !== null ? (
          <box flexDirection="column">
            <text fg={ACCENT}>
              {`${SPINNER[ticks % SPINNER.length]} generating… ${Math.floor(
                (Date.now() - runningSince) / 1000,
              )}s — esc cancels`}
            </text>
            {/* Codex reports no percentage, so its own last line is the closest thing to one. */}
            {activity ? <text fg={MUTED}>{activity.slice(0, 110)}</text> : null}
          </box>
        ) : null}
        {status.kind === "note" ? (
          <text fg={status.tone === "ok" ? OK : ERROR}>{status.text}</text>
        ) : null}
        {/* `chromeRows` leaves this box three lines, which a run already fills with the spinner,
            Codex's activity, and any note. The path is what gives way — it is the one of the
            four that is still on screen a keypress later.

            The path and not the prompt, because enter opens the prompt in full: a paragraph
            squeezed onto this line was neither readable nor reliably present, since a note
            replaces the row and nothing ever sets one back to idle. */}
        {status.kind === "idle" && runningSince === null && selected ? (
          <text fg={MUTED}>
            {`${(selected.bytes / 1_048_576).toFixed(1)} MB · ${selected.path}`.slice(0, 110)}
          </text>
        ) : null}
        {/* Thumbnails rather than a count: the whole point of a reference is what it looks like,
            and a line of green text does not tell you which image you attached. */}
        {references.length > 0 ? (
          <box flexDirection="column" marginTop={1}>
            <text fg={WARN}>
              {`references — sent with the next prompt · x removes ${
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
          {/* No ⌘V here: it is a paste gesture, not a key this app binds, and the capital reads
              as another uppercase binding. README documents it; v does the same thing. */}
          i prompt · enter read prompt · / filter · j/k move · f fullscreen · v attach ref ·
          x drop refs · c copy · p copy path · s save · o open · r reroll · q quit
        </text>
      </box>
    </box>
  );
}

// This returns before the renderer is created: createCliRenderer() takes exclusive ownership of
// stdin and stdout, so a flag answered after it would be answered onto a screen the TUI has
// already claimed. The number comes from package.json rather than being restated here, so it
// cannot drift from the release it is cut against; Bun bundles the import into the binary.
if (process.argv.includes("--version")) {
  process.stdout.write(`imgen ${version}\n`);
  process.exit(0);
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
