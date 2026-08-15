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
            time.sleep(0.4)
        sent = True

proc.terminate()
try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    proc.kill()

raw = b"".join(chunks).decode("utf8", "replace")
clean = re.sub(r"\x1b\][^\x07]*\x07", "", raw)
clean = re.sub(r"\x1b[\[\]][0-9;?]*[a-zA-Z]", "", clean)
clean = re.sub(r"\x1b[=>()][0-9A-Za-z]?", "", clean)
sys.stdout.write(clean)
