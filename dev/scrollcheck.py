"""Walk the cursor far past the first screen of the gallery and assert nothing breaks.

Two failures are checked, both seen for real:
  1. the cursor marker leaves the drawn list, so there is nothing selected on screen
  2. the overflowing list scrolls the terminal, cutting the kitty escape sequence that carries
     the preview, and the remainder of the image lands as visible base64 text

    python3 dev/scrollcheck.py bun run src/index.tsx
"""

import os
import re
import subprocess
import sys

PRESSES = 30
KEYS_SENT = "\x00PTYRUN-KEYS-SENT\x00"

out = subprocess.run(
    [sys.executable, "dev/ptyrun.py", "j" * PRESSES, "22", *sys.argv[1:]],
    capture_output=True,
    text=True,
    check=False,
    # Raw, with the escape sequences left in. Stripping them is what makes this check lie:
    # OpenTUI redraws only changed cells, each after an absolute cursor move, so text that is
    # far apart on screen ends up adjacent in the stripped stream. The status line's path is
    # enough on its own — its two UUIDs reassemble into a 60-character alphanumeric run that
    # reads exactly like a cut base64 payload, on every run, from the first commit onward.
    env={**os.environ, "PTYRUN_RAW": "1"},
).stdout

# Only what was drawn after the last keypress. Splitting on redraws of the header was a guess at
# where a frame ended; with incremental repainting there are no frames to find.
final = out.split(KEYS_SENT)[-1]

leaks = [m for m in re.findall(r"[A-Za-z0-9+/]{60,}", final) if not m.isdigit()]
has_cursor = "▸" in final

print(f"cursor marker visible after {PRESSES} presses: {has_cursor}")
print(f"base64 leak runs after the last keypress: {len(leaks)}")
if leaks:
    print(f"  first leak: {leaks[0][:70]}…")

sys.exit(0 if has_cursor and not leaks else 1)
