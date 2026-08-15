# ![imgen](assets/banner.png)

A terminal browser and generator for the images the Codex CLI makes.

Type a description, watch the candidate appear in the terminal at full size, keep it or roll again.
Every image Codex has ever generated on this machine is already in the gallery.

Built with [OpenTUI](https://github.com/sst/opentui).

## Why it exists

Codex has no `imagegen` subcommand — the image tool only runs inside an agent turn, so generating
one image from a script means a whole headless `codex exec`.
That is fine for a single asset and miserable for the thing you actually do, which is generate a
few candidates and look at them.
`imgen` keeps the loop in one place: prompt, preview, re-roll, save.

## Install

```bash
bun install
bun link          # exposes `imgen` on PATH
```

Requires the [Codex CLI](https://github.com/openai/codex), authenticated, with its image tool
enabled — `codex features list` should show `image_generation stable true`.

## Use

```bash
imgen
```

| Key        | Action                                                     |
| ---------- | ---------------------------------------------------------- |
| `i` or `/` | focus the prompt; `enter` generates                        |
| `tab`      | let Codex flesh out the draft — composition, light, style  |
| `ctrl+J`   | new line in the prompt (`shift+enter` where the terminal reports it) |
| `j`/`k`    | move through the gallery                                   |
| `f`        | hide the gallery and fill the screen                       |
| `⌘V`       | attach the image on the clipboard as a reference           |
| `v`        | the same thing, for terminals that swallow `⌘V`            |
| `shift+V`  | remove every attached reference                            |
| `c`        | copy the selected image to the clipboard                   |
| `s`        | save the selected image into the current directory         |
| `o`        | open it in the system viewer                               |
| `r`        | run the last prompt again                                  |
| `esc`      | cancel a running generation                                |
| `q`        | quit                                                       |

## Fleshing out a prompt

`tab` in the prompt hands your draft to Codex and asks it to decide what you left open —
composition and framing, lighting, colour, medium, mood, aspect ratio — while keeping your
subject exactly as written. It also asks for no lettering, which these models render badly.

The result replaces the draft **in the editor**, not in a generation. Read it, edit it, then
press enter. A rewrite that quietly became the prompt would be worse than no rewrite.

```log
a fox on a bicycle
  ↓ tab
Flat vector illustration of a fox on a bicycle, shown in a side-on full-body view riding along
a gently curved park path … muted sage grass, dusty blue sky, warm terracotta path … with no
lettering, text, logos, or watermarks.
```

A rewrite is its own Codex turn, so it is not instant — 36s for the example above. `esc` stops
it.

### Why ctrl+J for a new line

`shift+enter` is only distinguishable from `enter` where the terminal speaks the kitty keyboard
protocol; plain terminals send the same byte for both, and `option+enter` arrives with no
modifier at all. `ctrl+J` comes through as its own key everywhere, so it is the one that always
works. `shift+enter` is accepted too, wherever it survives the trip.

### Standing style

`~/.config/imgen/config.json`:

```json
{
  "style": "flat vector, muted palette, no gradients"
}
```

Free text, appended to every rewrite, and `null` by default.
It is one string rather than a schema of palette and lighting and camera fields because the model
already reads a sentence as an instruction, and the schema would only be a worse way to write it.

## Reference images

`⌘V` attaches the image on the clipboard to the next prompt, which reaches Codex through
`codex exec -i`. Attached references are drawn as thumbnails above the status line, so what is
going with the prompt is visible rather than counted.

`⌘V` never arrives as a keypress — the terminal turns it into a paste — and what it puts in that
paste varies, so three routes are handled.

| What the terminal sends | Route |
| ----------------------- | ------ |
| the path of an image file, as text | copied in |
| anything else | the pasteboard is read directly, by mime type |

Pasted *text* stops at the prompt editor, so writing a prompt while an image happens to be
copied never attaches it by accident.

The pasteboard read is OpenTUI's native clipboard, asked for `image/png`, `image/tiff` or
`image/jpeg` — so it does not depend on the terminal forwarding anything, and it is not
macOS-only. `osascript` remains as a fallback for the documented `unsupported` status.

Measured in Warp: copying a file in Finder pastes its full path, and copying image data pastes
an empty string. `v` triggers the pasteboard read explicitly if your terminal does something
else again with `⌘V`.

`bun run probe:paste` prints what your terminal actually sends.
Pasted images are written to `~/.codex/attachments/<session>/image-N.png`, the same place and the
same naming Codex uses for images pasted into one of its own sessions.

Writing an image *to* the pasteboard (`c`) still goes through `osascript` and the `«class PNGf»`
type, which the native clipboard does not cover. Either way there is no `pngpaste` or other
Homebrew helper to install.

A generation is a full Codex agent turn: it takes minutes and costs tokens, so the run is spawned
rather than awaited — `esc` kills the child at any point.
While it runs you get a spinner, the elapsed seconds, and the last line Codex printed.
There is no percentage because the turn does not report one; motion and Codex's own output are the
honest signals.

## Terminals

The preview quality is a property of your terminal, not of this tool.
`imgen` prints which protocol it resolved in the header.

| Protocol | Meaning                                          | Seen in                    |
| -------- | ------------------------------------------------ | -------------------------- |
| `kitty`  | true pixels                                      | Warp                       |
| `sixel`  | true pixels                                      | —                          |
| `blocks` | half-block approximation, the universal fallback | VS Code integrated terminal |

**A terminal without a pixel protocol is a supported terminal, not a degraded one.**
`blocks` draws the image with half-block characters and 24-bit colour, which is coarse but
perfectly enough to tell candidates apart, pick one, and re-roll — the loop this tool exists for.
Nothing is disabled: the gallery, reference thumbnails, generation and saving all behave the
same, and the header says `blocks` so you know why the preview looks the way it does.

![imgen running in the VS Code integrated terminal](assets/vscode.png)

Run `bun run probe:protocol` in any terminal to see what it reports there.
This has to be run in the terminal itself: capability detection is a query the emulator answers,
so asking from another process's pty always comes back `blocks`.

## How a run is identified

Codex writes every image under `~/.codex/generated_images/<session>/`.
`imgen` snapshots that directory before launching and diffs it afterwards.

Reading the newest file instead would be wrong twice over: one run can emit several images into a
single session directory, and against a library of any size a run that produced nothing would hand
back an unrelated earlier picture instead of reporting the failure.

## Development

```bash
bun test
bunx tsc --noEmit
python3 dev/measure.py bun run src/index.tsx   # compare preview size between layouts
```

`dev/ptyrun.py` runs the app under a real pty and prints what it drew, which is the only way to see
a TUI from a script. `dev/quitcheck.py` measures how long a quit key takes to actually exit.

## Notes

This wraps the Codex CLI (Apache-2.0); it does not bundle or redistribute it, and it uses your own
Codex authentication. Generated images are subject to OpenAI's usage policies.
