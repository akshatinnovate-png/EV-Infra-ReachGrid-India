#!/usr/bin/env python3
"""Serve ReachGrid India locally.

    python3 serve.py            # http://localhost:5050
    python3 serve.py 7000       # any port you like
If the port is busy, the next free one is used.
"""
import functools, http.server, os, socket, sys, webbrowser

port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 5050))
root = os.path.dirname(os.path.abspath(__file__))
for p in range(port, port + 50):
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", p)) != 0:
            port = p
            break
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
url = f"http://localhost:{port}"
print(f"ReachGrid India running at {url}  (Ctrl+C to stop)")
if "--no-open" not in sys.argv:
    try: webbrowser.open(url)
    except Exception: pass
with http.server.ThreadingHTTPServer(("", port), handler) as srv:
    try: srv.serve_forever()
    except KeyboardInterrupt: print("\nStopped.")
