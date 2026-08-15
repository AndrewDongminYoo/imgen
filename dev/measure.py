"""Measure how much of the screen the image preview actually occupies.

Renders the app under a pty, strips ANSI, and reports the bounding box of the
half-block glyphs the `blocks` protocol draws with. Gives a number to compare
layout changes against instead of eyeballing them.

    python3 dev/measure.py bun run src/index.tsx
"""

import re
import subprocess
import sys

BLOCKS = set("▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟")

out = subprocess.run(
    [sys.executable, "dev/ptyrun.py", "", "10", *sys.argv[1:]],
    capture_output=True,
    text=True,
    check=False,
).stdout

# ptyrun already strips ANSI; drop the capability-negotiation preamble too.
clean = re.sub(r"\x1b[^a-zA-Z]*[a-zA-Z]", "", out)
lines = clean.split("\n")

rows = [i for i, line in enumerate(lines) if sum(ch in BLOCKS for ch in line) > 3]
if not rows:
    print("no image glyphs found — preview did not render")
    sys.exit(1)

widths = [sum(ch in BLOCKS for ch in lines[i]) for i in rows]
print(f"widest row: {max(widths)} cells")
print(f"total glyph cells: {sum(widths)}")
# Deliberately not a percentage of the screen: the capture spans several redraw frames, so the
# total counts the same cell more than once. Use it to compare two layouts, not to size one.
