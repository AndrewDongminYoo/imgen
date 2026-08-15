# imgen

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
| `i` or `/` | focus the prompt; `enter` sends, `shift+enter` adds a line |
| `j`/`k`    | move through the gallery                                   |
| `f`        | hide the gallery and fill the screen                       |
| `v`        | paste the clipboard image as a reference for the next prompt |
| `V`        | clear the attached references                              |
| `c`        | copy the selected image to the clipboard                   |
| `s`        | save the selected image into the current directory         |
| `o`        | open it in the system viewer                               |
| `r`        | run the last prompt again                                  |
| `esc`      | cancel a running generation                                |
| `q`        | quit                                                       |

## Reference images

`v` reads the image on the clipboard and attaches it to the next prompt, which reaches Codex
through `codex exec -i`.
Pasted images are written to `~/.codex/attachments/<session>/image-N.png`, the same place and the
same naming Codex uses for images pasted into one of its own sessions.

Reading and writing pasteboard images goes through `osascript` and the `«class PNGf»` pasteboard
type, so there is no `pngpaste` or other Homebrew helper to install.

A generation is a full Codex agent turn: it takes minutes and costs tokens, so the run is spawned
rather than awaited — `esc` kills the child at any point.
While it runs you get a spinner, the elapsed seconds, and the last line Codex printed.
There is no percentage because the turn does not report one; motion and Codex's own output are the
honest signals.

## Terminals

The preview quality is a property of your terminal, not of this tool.
`imgen` prints which protocol it resolved in the header.

| Protocol | Meaning                                      |
| -------- | -------------------------------------------- |
| `kitty`  | true pixels — verified in Warp                |
| `sixel`  | true pixels                                   |
| `blocks` | half-block approximation, the universal fallback |

Run `bun run dev/protocol-probe.tsx` in any terminal to see what it reports there.
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
