"""Run a command under a real pty, capture what it draws, then send keys."""

import errno
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

cols, rows = 120, 40

# Marks the point in the stream where the last key had been pressed, so a caller can judge what
# was drawn afterwards rather than guessing at frame boundaries.
KEYS_SENT = b"\x00PTYRUN-KEYS-SENT\x00"
keys = sys.argv[1] if len(sys.argv) > 1 else ""
wait = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
cmd = sys.argv[3:]

primary, secondary = pty.openpty()
fcntl.ioctl(secondary, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

proc = subprocess.Popen(
    cmd, stdin=secondary, stdout=secondary, stderr=secondary, close_fds=True
)
os.close(secondary)

chunks, deadline, sent = [], time.time() + wait, False
while time.time() < deadline:
    ready, _, _ = select.select([primary], [], [], 0.2)
    if ready:
        try:
            data = os.read(primary, 65536)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise
        if not data:
            break
        chunks.append(data)
    # Give the app time to fetch and draw, then press one key at a time --
    # writing several bytes at once arrives as a single batched `input` string.
    if keys and not sent and time.time() > deadline - wait / 2:
        for ch in keys:
            os.write(primary, ch.encode())
            time.sleep(0.06)
        sent = True
        chunks.append(KEYS_SENT)

proc.terminate()
try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    proc.kill()

raw = b"".join(chunks).decode("utf8", "replace")

# PTYRUN_RAW leaves the escape sequences in, which anything judging what was *drawn* needs.
# OpenTUI repaints only the cells that changed, each after an absolute cursor move, so stripping
# the sequences concatenates text that was never adjacent on screen — the path in the status line
# comes back as one 60-character run of its own UUIDs.
if os.environ.get("PTYRUN_RAW"):
    sys.stdout.write(raw)
    raise SystemExit(0)

clean = re.sub(r"\x1b\][^\x07]*\x07", "", raw.replace(KEYS_SENT.decode(), ""))
clean = re.sub(r"\x1b[\[\]][0-9;?]*[a-zA-Z]", "", clean)
clean = re.sub(r"\x1b[=>()][0-9A-Za-z]?", "", clean)
sys.stdout.write(clean)
