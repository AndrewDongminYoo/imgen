# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Task            | Command                            |
| --------------- | ---------------------------------- |
| run             | `bun run src/index.tsx`            |
| watch           | `bun run dev`                      |
| tests           | `bun test`                         |
| one test        | `bun test -t "<name substring>"`   |
| typecheck       | `bun run typecheck`                |
| compiled binary | `bun run build` → `dist/imgen`     |

`bun test` and `bun run typecheck` are the whole gate — there is no trunk config and no lint script, only a `cspell.json` for spelling.

The two clipboard tests are skipped by default.
Opt in with `IMGEN_CLIPBOARD_TEST=1 bun test` — the run overwrites whatever the operator had copied, so ask first.
Only the image round-trip is additionally macOS-gated; the text write goes through OpenTUI and is not.

## Architecture

A single-screen React TUI on OpenTUI.

**Every operation that costs money is a `codex exec` child process.**
Two spawn sites, same shape:

- `generate.ts` — asks Codex's imagegen tool for an image.
- `enhance.ts` — asks Codex to rewrite a draft prompt. The answer comes back through a file (`prompt.txt` in a temp cwd) because `codex exec` interleaves its own chatter with the answer on stdout, so a last-line heuristic breaks.

Both return a handle (`{ done, cancel }`) rather than a bare promise: a turn takes minutes and `esc` has to kill it mid-flight.
Both spawn with `stdio: ["ignore", …]` — piped stdin is appended to the prompt and the run hangs waiting for more.

**A run's output is identified by diffing the library, never by reading the newest file.**
`library.ts` snapshots `~/.codex/generated_images/` before the spawn and diffs afterwards (`snapshot` / `newSince`).
One run can emit several images into one session directory, and a run that produced nothing must report the failure rather than hand back an unrelated earlier picture.
`src/core.test.ts` pins both cases.

`index.tsx` holds the whole UI and all key handling in one `useKeyboard`.
The `typing` branch returns early — a focused editor owns every key that branch does not claim.
Attaching a reference is the exception: ⌘V never arrives as a key at all, so it lands in a separate `usePaste` handler that branches on the pasted *text*, not on any metadata.
Read the `warp-paste-shapes` memory before changing that branch — the shapes in it are measured, not inferred.
The textarea is uncontrolled: its text is read off `editor.current.editBuffer` and cleared by remounting through `key={promptGeneration}`, because mirroring keystrokes into React state would redraw the image on every character.

`clipboard.ts` writes attachments to `~/.codex/attachments/<session>/image-N.png`, the same layout Codex uses for images pasted into its own sessions.

## Constraints that the code alone does not explain

- **`q` must call `renderer.destroy()` before `process.exit`.** Skipping OpenTUI's teardown leaves mouse reporting (1000/1002/1003/1006), the alternate screen, and the hidden cursor set in the operator's shell.
- **The gallery renders a window sized from terminal height, not the whole list.** An overflowing list scrolls the terminal, which cuts the in-flight kitty escape sequence carrying the preview and dumps the remainder as visible base64 text. `python3 dev/scrollcheck.py bun run src/index.tsx` asserts both that failure and the cursor walking off the drawn rows.
- **New line binds every modified return, and `ctrl+J` deliberately none.** Which of them reaches an application varies by terminal; README §"New lines" owns the measurements. `IMGEN_KEY_LOG=/path/to/log` records what the real terminal delivers alongside what the editor did with it.

## Verifying anything that touches the terminal

`dev/ptyrun.py` is the only way to see the TUI from a script, but the far end of that pty is a Python loop, not a terminal emulator — so it answers every capability query negatively, and three conclusions drawn from it so far were all wrong.
Read the `opentui-verification-limits` memory before quoting it for anything.

Use the harness for layout, flow, and exit behaviour.
For image protocol, paste shape, or clipboard, run a probe in the actual terminal (`bun run probe:protocol`, `bun run probe:paste`, `bun run probe:key`) and state which of the two produced the claim.
