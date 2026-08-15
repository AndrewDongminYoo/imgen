"""Walk the cursor far past the first screen of the gallery and assert nothing breaks.

Two failures are checked, both seen for real:
  1. the cursor marker leaves the drawn list, so there is nothing selected on screen
  2. the overflowing list scrolls the terminal, cutting the kitty escape sequence that carries
     the preview, and the remainder of the image lands as visible base64 text

    python3 dev/scrollcheck.py bun run src/index.tsx
"""

import re
import subprocess
import sys

PRESSES = 30

out = subprocess.run(
    [sys.executable, "dev/ptyrun.py", "j" * PRESSES, "22", *sys.argv[1:]],
    capture_output=True,
    text=True,
    check=False,
).stdout

clean = re.sub(r"\x1b[^a-zA-Z]*[a-zA-Z]", "", out)
frames = [f for f in clean.split("imgen ") if f.strip()]
final = frames[-1] if frames else clean

leaks = [m for m in re.findall(r"[A-Za-z0-9+/]{60,}", final) if not m.isdigit()]
has_cursor = "▸" in final

print(f"cursor marker visible after {PRESSES} presses: {has_cursor}")
print(f"base64 leak runs in final frame: {len(leaks)}")
if leaks:
    print(f"  first leak: {leaks[0][:70]}…")

sys.exit(0 if has_cursor and not leaks else 1)
