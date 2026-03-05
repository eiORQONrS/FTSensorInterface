#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os, sys, time, signal, threading, shutil, socket, subprocess, urllib.request, re
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial

# ========================= CONFIG =========================
PROJECT_DIR   = os.path.abspath(".")
HTTP_HOST     = "127.0.0.1"
HTTP_PORT     = 8000
HTTP_MAX_PORT = 8010

OPEN_PAGE     = "main.html"
FTSCRIPT      = os.path.join(PROJECT_DIR, "FTSensor.py")

WS_HOST       = "127.0.0.1"
WS_PORT       = 8765

# Wait WS port LISTENING (does NOT connect), 0 to skip waiting
WAIT_WS_LISTEN_SEC = 6.0

ISOLATE_CHROME= True
LOG_RING_SIZE = 300

# Optional: shutdown when Chrome window (launched by us) closes
AUTO_EXIT_ON_BROWSER_CLOSE = False

# NEW: auto-exit if no websocket clients for N seconds (based on FTSensor stdout "clients=0")
NO_CLIENT_EXIT_SEC = 5.0   # set 0 to disable
# ==========================================================

def ts(): return time.strftime("%H:%M:%S")
def log(msg): print(f"[{ts()}] {msg}", flush=True)

def is_tcp_open(host: str, port: int, timeout: float = 0.25) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0

def find_chrome():
    p = os.environ.get("CHROME_PATH")
    if p and os.path.exists(p): return p
    if sys.platform.startswith("win"):
        cands=[]
        for key in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
            root = os.environ.get(key)
            if root: cands.append(os.path.join(root,"Google","Chrome","Application","chrome.exe"))
        local = os.environ.get("LOCALAPPDATA")
        if local: cands.append(os.path.join(local,"Google","Chrome","Application","chrome.exe"))
        for c in cands:
            if os.path.exists(c): return c
        w = shutil.which("chrome") or shutil.which("google-chrome")
        if w: return w
    if sys.platform=="darwin":
        app="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        if os.path.exists(app): return app
        w = shutil.which("google-chrome") or shutil.which("chromium")
        if w: return w
    return shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chrome")

def kill_listener_on_port_windows(port: int):
    if not sys.platform.startswith("win"): return
    try:
        out = subprocess.check_output(
            ["cmd","/c",f"netstat -ano | findstr :{port} | findstr LISTENING"],
            text=True, encoding="utf-8", errors="replace"
        )
    except subprocess.CalledProcessError:
        return
    pids=set()
    for line in out.splitlines():
        parts=line.split()
        if parts:
            pid=parts[-1]
            if pid.isdigit(): pids.add(pid)
    for pid in pids:
        log(f"[WS] Port {port} occupied by PID {pid}; taskkill …")
        try:
            subprocess.run(["taskkill","/PID",pid,"/T","/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.3)
        except Exception as e:
            log(f"[WS] taskkill failed for {pid}: {e}")

# ----------------- No-cache HTTP -----------------
class NoCacheHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Cache-Control","no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma","no-cache")
        self.send_header("Expires","0")
        super().end_headers()

    def do_GET(self):
        try:
            if self.path in ("/", "/index.html"):
                self.path = "/main.html"
            return super().do_GET()
        except Exception as e:
            try:
                sys.stderr.write(f"[HTTP] do_GET error: {e!r} path={self.path}\n")
            except Exception:
                pass
            try:
                self.send_error(500, "Server error")
            except Exception:
                pass

    def log_message(self, format, *args):
        try:
            sys.stderr.write('[HTTP] %s\n' % (format % args))
        except Exception:
            pass

def start_http(root_dir: str, host: str, start_port: int, max_port: int):
    Handler = partial(NoCacheHandler, directory=root_dir)
    srv=None; chosen=None
    for p in range(start_port, max_port+1):
        try:
            srv = ThreadingHTTPServer((host,p), Handler)
            srv.daemon_threads = True
            chosen = p
            break
        except OSError:
            log(f"[HTTP] Port {p} occupied; trying next…")
    if srv is None:
        raise RuntimeError("No free HTTP port in range.")
    th = threading.Thread(
        target=lambda:(log(f"[HTTP] No-cache server at http://{host}:{chosen}/ (dir={root_dir})"),
                       srv.serve_forever(poll_interval=0.2)),
        name="HTTP", daemon=True
    )
    th.start()

    # wait reachability
    t0=time.time()
    while time.time()-t0<6.0:
        if is_tcp_open(host, chosen): break
        time.sleep(0.1)
    else:
        raise RuntimeError("HTTP failed to become reachable.")
    return srv, th, chosen

# ----------------- FTSensor supervisor -----------------
class Ring:
    def __init__(self, n): self.n=n; self.buf=[]
    def add(self, s):
        self.buf.append(s.rstrip())
        if len(self.buf)>self.n: self.buf.pop(0)
    def dump(self): return "\n".join(self.buf)

class FTSupervisor:
    # Parse lines like: "[INFO] sent=xxx msgs/s, clients=0"
    _RE_CLIENTS = re.compile(r"\bclients\s*=\s*(\d+)\b")

    def __init__(self, py_exec, script_path, args=None):
        self.py_exec=py_exec; self.script=script_path; self.args=args or []
        self.proc=None; self.thread=None; self.stop=False
        self.ring=Ring(LOG_RING_SIZE); self.restart_count=0; self.lock=threading.Lock()

        # NEW: client tracking (based on stdout)
        self.last_clients: int | None = None
        self.last_nonzero_client_t = time.perf_counter()  # initialized now
        self.last_client_line_t = 0.0

    def _run_once(self):
        creationflags=0
        if sys.platform.startswith("win"):
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        cmd=[self.py_exec, self.script]+self.args
        log(f"[FT] Starting: {' '.join(cmd)}")
        self.proc=subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
            encoding="utf-8", errors="replace",
            creationflags=creationflags
        )
        assert self.proc.stdout is not None

        # Reset tracking on each start
        self.last_clients = None
        self.last_nonzero_client_t = time.perf_counter()
        self.last_client_line_t = 0.0

        for line in self.proc.stdout:
            self.ring.add(line)
            print(f"[FT] {line.rstrip()}")

            # NEW: parse clients=#
            m = self._RE_CLIENTS.search(line)
            if m:
                try:
                    c = int(m.group(1))
                    self.last_clients = c
                    self.last_client_line_t = time.perf_counter()
                    if c > 0:
                        self.last_nonzero_client_t = self.last_client_line_t
                except Exception:
                    pass

            if self.stop:
                break

        code=self.proc.wait()
        log(f"[FT] exited with code {code}")
        return code

    def _loop(self):
        backoff=1.0
        while not self.stop:
            code=self._run_once()
            if self.stop: break

            # If FT exited normally, don't spam-restart forever.
            if code == 0:
                backoff = 1.0
                time.sleep(0.2)
                continue

            log("-------- FTSensor last output (ring) --------")
            print(self.ring.dump())
            log("-------- end ring --------")
            self.restart_count+=1
            log(f"[FT] Restarting (#{self.restart_count}) in {backoff:.1f}s …")
            t0=time.time()
            while not self.stop and time.time()-t0<backoff:
                time.sleep(0.1)
            backoff=min(backoff*1.8, 10.0)

    def start(self):
        self.thread=threading.Thread(target=self._loop, name="FTSupervisor", daemon=True)
        self.thread.start()

    def terminate(self):
        self.stop=True
        with self.lock:
            if self.proc and self.proc.poll() is None:
                try:
                    if sys.platform.startswith("win"):
                        self.proc.terminate()
                        try: self.proc.wait(timeout=2)
                        except Exception: pass
                        if self.proc.poll() is None:
                            subprocess.run(["taskkill","/PID",str(self.proc.pid),"/T","/F"],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    else:
                        self.proc.terminate()
                except Exception:
                    pass
        if self.thread:
            try: self.thread.join(timeout=3)
            except Exception: pass

# ----------------- browser & probes -----------------
def open_chrome(url, isolated=True):
    exe=find_chrome()
    if not exe:
        import webbrowser
        webbrowser.open_new_tab(url)
        log("[BROWSER] Fallback default browser (cannot track PID).")
        return None

    if isolated:
        base=os.path.join(PROJECT_DIR,".chrome_sandbox")
        os.makedirs(base, exist_ok=True)
        args=[exe,
              f"--user-data-dir={base}",
              "--disable-extensions","--no-first-run",
              "--disk-cache-size=1","--media-cache-size=1",
              "--disable-component-update","--disable-features=Translate",
              "--new-window", url]
    else:
        args=[exe,"--new-window",url]

    log(f"[BROWSER] Launch: {' '.join(args[:3])} ...")
    return subprocess.Popen(args)

def quick_probe(url: str, timeout=2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            _ = r.read(64)
        return True
    except Exception:
        return False

# ----------------- main -----------------
def main():
    if not os.path.isdir(PROJECT_DIR):
        log(f"[HTTP] ERROR: directory not found: {PROJECT_DIR}")
        sys.exit(1)
    os.chdir(PROJECT_DIR)

    kill_listener_on_port_windows(WS_PORT)

    try:
        http_srv, http_thr, http_port = start_http(PROJECT_DIR, HTTP_HOST, HTTP_PORT, HTTP_MAX_PORT)
    except Exception as e:
        log(f"[HTTP] ERROR: {e}")
        sys.exit(1)

    py_exec=sys.executable
    fts=FTSupervisor(py_exec, FTSCRIPT, args=[])
    fts.start()

    # (optional) wait WS port listening WITHOUT connecting
    if WAIT_WS_LISTEN_SEC > 0:
        log(f"[WS] Waiting port {WS_PORT} LISTENING (<= {WAIT_WS_LISTEN_SEC:.0f}s)…")
        t0=time.time()
        while time.time()-t0 < WAIT_WS_LISTEN_SEC:
            if is_tcp_open(WS_HOST, WS_PORT, timeout=0.2):
                log("[WS] Port is listening.")
                break
            time.sleep(0.2)

    http_url=f"http://{HTTP_HOST}:{http_port}/main.html?ts={int(time.time())}"

    chrome_proc=None
    if quick_probe(http_url):
        chrome_proc=open_chrome(http_url, isolated=ISOLATE_CHROME)
    else:
        local = os.path.join(PROJECT_DIR, "main.html")
        file_url = 'file:///' + local.replace('\\','/')
        log(f"[HTTP] probe failed, fallback to file URL: {file_url}")
        chrome_proc=open_chrome(file_url, isolated=False)

    shutdown_called=False
    def shutdown(signum=None, frame=None):
        nonlocal shutdown_called
        if shutdown_called: return
        shutdown_called=True
        log("Shutting down…")
        try: fts.terminate()
        except Exception: pass
        try: http_srv.shutdown()
        except Exception: pass
        try:
            if http_thr.is_alive(): http_thr.join(timeout=3)
        except Exception: pass
        log("Clean exit.")
        os._exit(0)

    try:
        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)
    except Exception:
        pass

    try:
        while True:
            time.sleep(0.25)

            # optional: close with browser (only if we have a PID)
            if AUTO_EXIT_ON_BROWSER_CLOSE and chrome_proc is not None:
                if chrome_proc.poll() is not None:
                    log("[BROWSER] Chrome closed. Auto shutdown.")
                    shutdown()

            # NEW: auto-exit if no websocket clients for N seconds (based on stdout clients=0)
            if NO_CLIENT_EXIT_SEC > 0:
                # only start counting after we've seen at least one "clients=#" line
                if fts.last_clients is not None:
                    now = time.perf_counter()
                    if fts.last_clients == 0:
                        idle = now - fts.last_nonzero_client_t
                        if idle >= NO_CLIENT_EXIT_SEC:
                            log(f"[WS] clients=0 for {idle:.1f}s (>= {NO_CLIENT_EXIT_SEC:.1f}s) -> shutdown")
                            shutdown()
                    else:
                        # non-zero client, ensure baseline is fresh
                        pass

            # If FT process ended, shutdown
            p = fts.proc
            if p is not None and p.poll() is not None:
                log(f"[FT] process ended (code={p.returncode}) -> shutdown")
                shutdown()

    except KeyboardInterrupt:
        shutdown()

if __name__=="__main__":
    main()