import fcntl, os, pty, select, struct, subprocess, sys, termios, time
primary, secondary = pty.openpty()
fcntl.ioctl(secondary, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
p = subprocess.Popen(sys.argv[2:], stdin=secondary, stdout=secondary, stderr=secondary)
os.close(secondary)
t0 = time.time()
while time.time() - t0 < 6:
    r, _, _ = select.select([primary], [], [], 0.2)
    if r:
        try: os.read(primary, 65536)
        except OSError: break
os.write(primary, sys.argv[1].encode())
for _ in range(50):                      # up to 5s for a clean exit
    if p.poll() is not None:
        print(f"EXITED cleanly, code={p.returncode}, after {time.time()-t0-6:.1f}s")
        sys.exit(0)
    try: 
        r, _, _ = select.select([primary], [], [], 0.1)
        if r: os.read(primary, 65536)
    except OSError: break
    time.sleep(0.1)
print("DID NOT EXIT after 5s -> quit key is broken")
p.kill()
