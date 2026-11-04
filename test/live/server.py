#!/usr/bin/env python3
"""The live test's local world: test sites, a stub box and a stub daemon.

Stdlib only. Everything listens on the loopback or on two Unix sockets in the
sockets folder (`--sockets`, default the run folder; run.sh gives a short one,
because a socket path holds at most 107 bytes):

- HTTP on 127.0.0.1:<port>, routed by the Host header. `box.localhost` is the
  stub box (the gateway's two extension routes, contract C9). Every other
  `*.localhost` host is a test site.
- The stub daemon on `<sockets>/daemon.sock` (0600). The native host (host.py)
  connects to it, and it speaks contract C4 to the receiver: channel main, and
  channel bridge (C10) for the driver's bridge requests.
- A control socket `<sockets>/ctl.sock` (0600) for the driver (live.py): one JSON
  request line in, one JSON answer line out.

No log line holds a cookie value or a storage value, test values included.
The request log keeps cookie names only. A page's report (with values) stays in
memory, and the comparison of two reports names keys only.
"""

import argparse
import base64
import html
import json
import os
import secrets
import socket
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PART_BYTES = 700000
MAX_SEND_BYTES = 33554432
LOGIN_COOKIE = "aw_test_login"
BOX_HOST = "box.localhost"
USER = "tester"
DAEMON_TIMEOUT = {"import": 120.0}
DEFAULT_DAEMON_TIMEOUT = 10.0


# ---------------------------------------------------------------- events


class Events:
    """Every observation of the run, in order. Names and counts only."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._items: list[dict] = []
        self._cv = threading.Condition()

    def add(self, kind: str, **fields: object) -> dict:
        with self._cv:
            ev = {"seq": len(self._items) + 1, "ts": round(time.time(), 3), "kind": kind, **fields}
            self._items.append(ev)
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(ev, sort_keys=True) + "\n")
            self._cv.notify_all()
            return ev

    def mark(self) -> int:
        with self._cv:
            return len(self._items)

    def since(self, seq: int) -> list[dict]:
        with self._cv:
            return list(self._items[seq:])

    def wait(self, since: int, match: dict, timeout: float) -> dict | None:
        deadline = time.time() + timeout
        with self._cv:
            at = since
            while True:
                for ev in self._items[at:]:
                    if all(ev.get(k) == v for k, v in match.items()):
                        return ev
                at = len(self._items)
                left = deadline - time.time()
                if left <= 0:
                    return None
                self._cv.wait(timeout=min(left, 0.5))


# ---------------------------------------------------------------- stub daemon


class StubDaemon:
    """Contract C4 on the daemon side: parts out, results and events in."""

    def __init__(self, path: str, events: Events) -> None:
        self.path = path
        self.events = events
        self.allow: list[str] = []
        self._cv = threading.Condition()
        self._conn: socket.socket | None = None
        self._hello: str | None = None
        self._results: dict[tuple[str, str], dict] = {}  # (channel, id) -> res
        self._one = threading.Lock()  # one main request at a time (C4)
        self._write = threading.Lock()  # the parts of one request go in one go
        self._next = 0

    def serve(self) -> None:
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            srv.bind(self.path)
        finally:
            os.umask(old)
        os.chmod(self.path, 0o600)
        srv.listen(4)
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=self._read, args=(conn,), daemon=True).start()

    def _read(self, conn: socket.socket) -> None:
        with self._cv:
            if self._conn is not None:
                try:
                    self._conn.close()
                except OSError:
                    pass
            self._conn = conn
            self._hello = None
        self.events.add("link", up=True)
        buf = b""
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        self._message(line)
        except OSError:
            pass
        with self._cv:
            if self._conn is conn:
                self._conn = None
                self._hello = None
            self._cv.notify_all()
        self.events.add("link", up=False)

    def _message(self, line: bytes) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            self.events.add("daemon-bad-line", bytes=len(line))
            return
        t = msg.get("t") if isinstance(msg, dict) else None
        if t == "hello":
            with self._cv:
                self._hello = str(msg.get("version"))
                self._cv.notify_all()
            self.events.add("hello", v=msg.get("v"), version=msg.get("version"), channels=msg.get("channels"))
        elif t == "res":
            with self._cv:
                self._results[(str(msg.get("ch") or "main"), str(msg.get("id")))] = msg
                self._cv.notify_all()
        elif t == "ev" and msg.get("ch") == "bridge":
            self.events.add("bridge-ev", **_ev_summary(msg))
        elif t == "blocked":
            self.events.add("blocked", tab=msg.get("tab"), host=msg.get("host"))
        else:
            self.events.add("daemon-unknown", t=str(t))

    def state(self) -> dict:
        with self._cv:
            return {"connected": self._conn is not None, "hello": self._hello, "allow": list(self.allow)}

    def wait_hello(self, timeout: float) -> bool:
        deadline = time.time() + timeout
        with self._cv:
            while self._conn is None or self._hello is None:
                left = deadline - time.time()
                if left <= 0:
                    return False
                self._cv.wait(timeout=min(left, 0.5))
            return True

    def request(self, op: str, timeout: float | None = None, **fields: object) -> dict:
        """Send one main request as C4 parts and wait for its result."""
        wait = timeout if timeout is not None else DAEMON_TIMEOUT.get(op, DEFAULT_DAEMON_TIMEOUT)
        with self._one:
            return self._call("main", "r", op, wait, fields)

    def bridge(self, op: str, args: list, wait: int | None = None) -> dict:
        """Send one bridge request (C10) and wait for its result. Bridge
        requests run at the same time, also beside a main request."""
        fields: dict = {"args": args}
        if wait is not None:
            fields["wait"] = wait
        return self._call("bridge", "b", op, (wait or 30000) / 1000 + 2, fields)

    def _call(self, ch: str, prefix: str, op: str, wait: float, fields: dict) -> dict:
        if not self.wait_hello(10.0):
            return {"ok": False, "error": "no link"}
        with self._cv:
            self._next += 1
            rid = "%s%d" % (prefix, self._next)
            conn = self._conn
        body = json.dumps({"t": "req", "id": rid, "op": op, **fields}, separators=(",", ":"), ensure_ascii=False)
        data = body.encode("utf-8")
        slices = [data[i:i + PART_BYTES] for i in range(0, len(data), PART_BYTES)]
        named = {"ch": ch} if ch != "main" else {}
        started = time.time()
        try:
            with self._write:
                for seq, sl in enumerate(slices):
                    part = {"t": "part", **named, "id": rid, "seq": seq, "n": len(slices),
                            "b64": base64.b64encode(sl).decode("ascii")}
                    conn.sendall(json.dumps(part, separators=(",", ":")).encode("ascii") + b"\n")
        except (OSError, AttributeError):
            return {"ok": False, "error": "send failed"}
        deadline = started + wait
        kind = "daemon-request" if ch == "main" else "bridge-request"
        with self._cv:
            while (ch, rid) not in self._results:
                left = deadline - time.time()
                if left <= 0:
                    self.events.add(kind, op=op, id=rid, parts=len(slices), bytes=len(data), ok=False, error="timeout")
                    return {"ok": False, "error": "timeout"}
                self._cv.wait(timeout=min(left, 0.5))
            res = self._results.pop((ch, rid))
        out = {"ok": bool(res.get("ok")), "secs": round(time.time() - started, 3)}
        if res.get("ok"):
            out["data"] = res.get("data")
        else:
            out["error"] = str(res.get("error"))
        # A bridge result can hold page content: the log keeps the op and the outcome only.
        summary = _summary_data(op, out.get("data")) if ch == "main" else None
        self.events.add(kind, op=op, id=rid, parts=len(slices), bytes=len(data), ok=out["ok"],
                        error=out.get("error"), secs=out["secs"], data=summary)
        return out

    def set_allowlist(self, domains: list[str]) -> dict:
        self.allow = sorted(set(domains))
        return self.request("set_allowlist", domains=self.allow)


def _summary_data(op: str, data: object) -> object:
    # Import and allowlist results hold counts and "<name>: <reason>" errors only.
    return data if op in ("ping", "set_allowlist", "import") else None


def _path(url: object) -> str | None:
    return urllib.parse.urlsplit(url).path if isinstance(url, str) and url else None


def _ev_summary(msg: dict) -> dict:
    """A bridge event's name, tab and outcome; of a paused request its id and
    path. Never a header, a body or other params."""
    ev = msg.get("ev")
    out: dict = {"ev": ev}
    if ev == "debugger.onEvent":
        src, params = msg.get("source") or {}, msg.get("params") or {}
        out.update(tab=src.get("tabId"), method=msg.get("method"), session="sessionId" in src)
        if msg.get("method") == "Fetch.requestPaused":
            out.update(request_id=params.get("requestId"), path=_path((params.get("request") or {}).get("url")))
    elif ev == "tabs.onCreated":
        tab = msg.get("tab") or {}
        out.update(tab=tab.get("id"), opener=tab.get("openerTabId"), active=tab.get("active"),
                   path=_path(tab.get("pendingUrl") or tab.get("url")),
                   attached=msg.get("attached"), held=msg.get("held"), error=msg.get("error"))
    elif ev == "debugger.onDetach":
        out.update(tab=(msg.get("source") or {}).get("tabId"), reason=msg.get("reason"))
    elif ev in ("tabs.onUpdated", "tabs.onRemoved"):
        out.update(tab=msg.get("tabId"), status=(msg.get("changeInfo") or {}).get("status"))
    elif ev in ("webNavigation.onCreatedNavigationTarget", "webNavigation.onErrorOccurred"):
        d = msg.get("details") or {}
        out.update(tab=d.get("tabId"), source_tab=d.get("sourceTabId"), error=d.get("error"))
    else:
        out.update(tab=msg.get("tabId"))
    return out


# ---------------------------------------------------------------- reports


class Reports:
    """Page reports (values included) kept in memory, never written."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_rid: dict[str, dict] = {}

    def new(self, host: str, path: str, nav_cookie: dict) -> str:
        rid = secrets.token_hex(6)
        with self._lock:
            self._by_rid[rid] = {"host": host, "path": path, "nav_cookie": nav_cookie}
        return rid

    def update(self, rid: str, **parts: object) -> bool:
        with self._lock:
            r = self._by_rid.get(rid)
            if r is None:
                return False
            r.update(parts)
            return True

    def get(self, rid: str) -> dict | None:
        with self._lock:
            r = self._by_rid.get(rid)
            return dict(r) if r is not None else None


def _diff_map(a: dict, b: dict) -> dict:
    ka, kb = set(a), set(b)
    return {
        "names": sorted(ka | kb),
        "same": sorted(k for k in ka & kb if a[k] == b[k]),
        "missing": sorted(ka - kb),
        "extra": sorted(kb - ka),
        "differ": sorted(k for k in ka & kb if a[k] != b[k]),
    }


def _key_label(key_json: str) -> str:
    # A record key as a name: a string key is a test label; other keys show their kind.
    try:
        d = json.loads(key_json)
    except ValueError:
        return "?"
    if isinstance(d, list) and len(d) == 2 and d[0] == "string":
        return d[1]
    return "<%s key>" % (d[0] if isinstance(d, list) and d else "?")


def _value_kind(value_json: str) -> str:
    try:
        d = json.loads(value_json)
    except ValueError:
        return "?"
    return str(d[0]) if isinstance(d, list) and d else "?"


def _first_diff(x: object, y: object, path: str = "") -> dict | None:
    """Where two value descriptors (the report page's desc()) first differ.

    It names the path (property names, indexes) and the kinds, never a value.
    """
    kx = x[0] if isinstance(x, list) and x else "?"
    ky = y[0] if isinstance(y, list) and y else "?"
    at = path or "(top)"
    if kx != ky:
        return {"at": at, "a": kx, "b": ky}
    if kx == "obj":
        nx, ny = [k for k, _ in x[1]], [k for k, _ in y[1]]
        if nx != ny:
            return {"at": at, "a": "keys %s" % nx, "b": "keys %s" % ny}
        for (k, u), (_, v) in zip(x[1], y[1]):
            d = _first_diff(u, v, "%s.%s" % (path, k))
            if d:
                return d
        return None
    if kx in ("arr", "set", "map"):
        if len(x[1]) != len(y[1]):
            return {"at": at, "a": "%s of %d" % (kx, len(x[1])), "b": "%s of %d" % (ky, len(y[1]))}
        for i, (u, v) in enumerate(zip(x[1], y[1])):
            if kx == "map":
                d = _first_diff(u[0], v[0], "%s<key %d>" % (path, i)) or _first_diff(u[1], v[1], "%s<value %d>" % (path, i))
            else:
                d = _first_diff(u, v, "%s[%d]" % (path, i))
            if d:
                return d
        return None
    if x != y:
        return {"at": at, "a": kx, "b": ky, "what": "same kind, other content"}
    return None


def _record_diff(label: str, a_json: str, b_json: str) -> dict:
    try:
        d = _first_diff(json.loads(a_json), json.loads(b_json))
    except ValueError:
        d = None
    return {"key": label, **(d or {})}


def compare_reports(a: dict, b: dict) -> dict:
    """What b (the agent side) holds compared with a (the operator side), by name."""
    out: dict = {}
    for area in ("nav_cookie", "sub_cookie", "doc_cookie", "local", "session"):
        out[area] = _diff_map(a.get(area) or {}, b.get(area) or {})
    idb_a, idb_b = a.get("idb") or {}, b.get("idb") or {}
    idb: dict = {"missing": sorted(set(idb_a) - set(idb_b)), "extra": sorted(set(idb_b) - set(idb_a)), "databases": {}}
    for name in sorted(set(idb_a) & set(idb_b)):
        da, db = idb_a[name], idb_b[name]
        sa, sb = da.get("stores") or {}, db.get("stores") or {}
        d = {"version": [da.get("version"), db.get("version")], "missing_stores": sorted(set(sa) - set(sb)),
             "extra_stores": sorted(set(sb) - set(sa)), "stores": {}}
        for sn in sorted(set(sa) & set(sb)):
            xa, xb = sa[sn], sb[sn]
            schema = all(xa.get(k) == xb.get(k) for k in ("keyPath", "autoIncrement", "indexes"))
            ra = {k: v for k, v in xa.get("records") or []}
            rb = {k: v for k, v in xb.get("records") or []}
            d["stores"][sn] = {
                "schema_same": schema,
                "records": len(ra),
                "same": sum(1 for k in ra if k in rb and ra[k] == rb[k]),
                "missing": [{"key": _key_label(k), "kind": _value_kind(ra[k])} for k in ra if k not in rb],
                "extra": [_key_label(k) for k in rb if k not in ra],
                "differ": [_record_diff(_key_label(k), ra[k], rb[k]) for k in ra if k in rb and ra[k] != rb[k]],
            }
        idb["databases"][name] = d
    out["idb"] = idb
    ca, cb = a.get("caches") or {}, b.get("caches") or {}
    caches: dict = {"missing": sorted(set(ca) - set(cb)), "extra": sorted(set(cb) - set(ca)), "caches": {}}
    for name in sorted(set(ca) & set(cb)):
        caches["caches"][name] = _diff_map(ca[name], cb[name])
    out["caches"] = caches
    out["page_errors"] = [a.get("errors") or [], b.get("errors") or []]
    return out


def report_summary(r: dict) -> dict:
    """Names and counts of one report."""
    idb = r.get("idb") or {}
    return {
        "host": r.get("host"), "path": r.get("path"), "complete": "local" in r,
        "nav_cookie": sorted(r.get("nav_cookie") or {}), "sub_cookie": sorted(r.get("sub_cookie") or {}),
        "doc_cookie": sorted(r.get("doc_cookie") or {}), "local": sorted(r.get("local") or {}),
        "session": sorted(r.get("session") or {}),
        "idb": {n: {"version": d.get("version"),
                    "stores": {s: len(x.get("records") or []) for s, x in (d.get("stores") or {}).items()}}
                for n, d in idb.items()},
        "caches": {n: sorted(e) for n, e in (r.get("caches") or {}).items()},
        "errors": r.get("errors") or [],
    }


# ---------------------------------------------------------------- pages

COMMON_JS = r"""
const awLog = (kind, data) => fetch('/__log', {method: 'POST', keepalive: true,
  body: JSON.stringify(Object.assign({kind: kind, page: location.pathname}, data || {}))}).catch(() => {});
const awReq = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const awDel = (name) => new Promise((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
const awOpen = (name, version, upgrade) => new Promise((resolve, reject) => {
  const r = indexedDB.open(name, version);
  r.onupgradeneeded = () => upgrade(r.result);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const awDone = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
const awClear = async () => {
  localStorage.clear(); sessionStorage.clear();
  for (const info of await indexedDB.databases()) await awDel(info.name);
  for (const name of await caches.keys()) await caches.delete(name);
};
"""

# The operator side's site state: the 11 cookie kinds come from the response
# headers; this script writes every page storage kind, then goes to /report.
# Values are made-up test values. The server never logs them.
SETUP_JS = r"""
(async () => {
  const v = (name) => 'made-up-' + name;
  await awClear();
  localStorage.setItem('ls_plain', v('ls-plain'));
  localStorage.setItem('ls_json', JSON.stringify({a: 1, b: [1, 2]}));
  localStorage.setItem('ls_unicode', 'ü✓ ' + v('ls-unicode'));
  localStorage.setItem('ls_empty', '');
  sessionStorage.setItem('ss_plain', v('ss-plain'));
  sessionStorage.setItem('ss_json', JSON.stringify({s: true}));

  const db = await awOpen('kinds', 3, (db) => {
    db.createObjectStore('kv');
    const items = db.createObjectStore('items', {keyPath: 'id', autoIncrement: true});
    items.createIndex('by_name', 'name', {unique: false});
    items.createIndex('by_code', 'code', {unique: true});
    items.createIndex('tags', 'tags', {multiEntry: true});
    db.createObjectStore('compound', {keyPath: ['a', 'b']});
    db.createObjectStore('auto', {autoIncrement: true});
  });
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 128}, false, ['encrypt', 'decrypt']);
  const buf = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer;
  const values = [
    ['undef', undefined], ['null', null], ['true', true], ['false', false], ['string', v('idb-string')],
    ['number', 42.5], ['nan', NaN], ['inf', Infinity], ['ninf', -Infinity], ['negzero', -0],
    ['bigint', 12345678901234567890n], ['negbig', -42n],
    ['date', new Date(1700000000000)], ['baddate', new Date(NaN)],
    ['blob', new Blob([v('blob')], {type: 'text/plain'})],
    ['file', new File([v('file')], 'notes.txt', {type: 'text/plain', lastModified: 1600000000000})],
    ['ab', new Uint8Array([1, 2, 3, 250]).buffer],
    ['u8', new Uint8Array([9, 8, 7])], ['i16', new Int16Array([-2, 300])], ['f64', new Float64Array([1.5, -0.25])],
    ['u8c', new Uint8ClampedArray([255, 0])], ['big64', new BigInt64Array([-5n, 7n])],
    ['dataview', new DataView(new Uint8Array([4, 5, 6]).buffer)], ['subview', new Uint8Array(buf, 2, 3)],
    ['map', new Map([['m', 1], [2, {x: [1]}]])], ['set', new Set([1, 'two', new Date(5)])],
    ['arr', [1, 'x', , undefined]], ['re', /a+b/gi],
    ['obj', {nested: {d: new Date(1), arr: [1, 'x']}, empty: {}}],
    ['proto', JSON.parse('{"__proto__": {"x": 1}, "y": 2}')],
    ['mixed', {m: new Map([[1, new Set([new Uint8Array([9])])]])}],
    ['cryptokey', key],
  ];
  const otherKeys = [[1, 'num-key'], [-1.5, 'neg-key'], [new Date(1600000000000), 'date-key'],
    [[1, 'two'], 'array-key'], [new Uint8Array([1, 2]).buffer, 'binary-key']];
  const tx = db.transaction(['kv', 'items', 'compound', 'auto'], 'readwrite');
  const kv = tx.objectStore('kv');
  for (const [k, x] of values) kv.put(x, k);
  for (const [k, x] of otherKeys) kv.put(v(x), k);
  const items = tx.objectStore('items');
  items.put({name: 'alpha', code: 'a', tags: ['t1', 't2']});
  items.put({name: 'beta', code: 'b', tags: ['t2']});
  items.put({id: 10, name: 'ten', code: 't', tags: []});
  tx.objectStore('compound').put({a: 1, b: 'x', v: true});
  tx.objectStore('compound').put({a: 2, b: 'y', v: false});
  tx.objectStore('auto').put(v('auto-1'));
  tx.objectStore('auto').put({second: 2});
  await awDone(tx);
  db.close();

  const notes = await awOpen('notes', 1, (db) => db.createObjectStore('notes', {keyPath: 'id'}));
  const tx2 = notes.transaction('notes', 'readwrite');
  tx2.objectStore('notes').put({id: 'n1', text: v('note-1')});
  tx2.objectStore('notes').put({id: 'n2', text: v('note-2')});
  await awDone(tx2);
  notes.close();

  const c1 = await caches.open('v1');
  await c1.put('/cached/a', new Response(v('cache-a'), {headers: {'content-type': 'text/plain'}}));
  await c1.put('/cached/b', new Response(new Uint8Array([0, 255, 1]), {headers: {'content-type': 'application/octet-stream', 'x-test': 'yes'}}));
  const c2 = await caches.open('v2');
  await c2.put('/cached/c', new Response(v('cache-c'), {status: 201, headers: {'content-type': 'text/plain'}}));

  awLog('setup-done', {local: localStorage.length, session: sessionStorage.length,
    kv: values.length + otherKeys.length});
  location.replace('/report');
})().catch((e) => awLog('setup-error', {error: e && e.name}));
"""

# The agent's own earlier state on the site (O19: a send replaces it).
AGENT_OLD_JS = r"""
(async () => {
  const v = (name) => 'made-up-agent-' + name;
  localStorage.setItem('agent_old', v('ls'));
  localStorage.setItem('ls_plain', v('ls-plain'));
  sessionStorage.setItem('agent_old_ss', v('ss'));
  const db = await awOpen('agent-old-db', 1, (db) => db.createObjectStore('s'));
  const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(v('idb'), 'k'); await awDone(tx); db.close();
  const kinds = await awOpen('kinds', 7, (db) => db.createObjectStore('stale'));
  kinds.close();
  const c = await caches.open('agent-cache'); await c.put('/cached/agent', new Response(v('cache')));
  awLog('agent-old-done', {local: localStorage.length});
})().catch((e) => awLog('agent-old-error', {error: e && e.name}));
"""

# The report page's FIRST script: what the page sees before anything else runs.
# The report (values included) goes to the server's memory only.
REPORT_JS = r"""
(async () => {
  const RID = '__RID__';
  const B64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
  const cookieMap = (s) => { const o = {}; if (s) for (const p of s.split('; ')) { const i = p.indexOf('='); if (i >= 0) o[p.slice(0, i)] = p.slice(i + 1); else o[p] = ''; } return o; };
  const area = (a) => { const o = {}; for (let i = 0; i < a.length; i++) { const k = a.key(i); o[k] = a.getItem(k); } return o; };
  const rep = {doc_cookie: cookieMap(document.cookie), local: area(localStorage), session: area(sessionStorage), idb: {}, caches: {}, errors: []};
  async function desc(v) {
    if (v === undefined) return ['undef'];
    if (v === null) return ['null'];
    const t = typeof v;
    if (t === 'boolean' || t === 'string') return [t, v];
    if (t === 'number') return ['number', Object.is(v, -0) ? '-0' : String(v)];
    if (t === 'bigint') return ['bigint', v.toString()];
    if (v instanceof Date) return ['date', String(v.getTime())];
    if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) return ['CryptoKey', v.type, v.extractable, v.algorithm.name, Array.from(v.usages)];
    if (v instanceof File) return ['file', v.name, v.lastModified, v.type, B64(new Uint8Array(await v.arrayBuffer()))];
    if (v instanceof Blob) return ['blob', v.type, B64(new Uint8Array(await v.arrayBuffer()))];
    if (v instanceof ArrayBuffer) return ['ab', B64(new Uint8Array(v))];
    if (ArrayBuffer.isView(v)) return ['view', v.constructor.name, B64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))];
    if (v instanceof RegExp) return ['re', v.source, v.flags];
    if (v instanceof Map) { const a = []; for (const [k, x] of v) a.push([await desc(k), await desc(x)]); return ['map', a]; }
    if (v instanceof Set) { const a = []; for (const x of v) a.push(await desc(x)); return ['set', a]; }
    if (Array.isArray(v)) { const a = []; for (let i = 0; i < v.length; i++) a.push(i in v ? await desc(v[i]) : ['undef']); return ['arr', a]; }
    if (t === 'object') { const a = []; for (const k of Object.keys(v)) a.push([k, await desc(v[k])]); return ['obj', a]; }
    return ['other', Object.prototype.toString.call(v)];
  }
  try {
    for (const info of await indexedDB.databases()) {
      const db = await awReq(indexedDB.open(info.name));
      const d = {version: db.version, stores: {}};
      for (const sn of Array.from(db.objectStoreNames)) {
        const st = db.transaction(sn, 'readonly').objectStore(sn);
        const indexes = Array.from(st.indexNames).map((n) => { const ix = st.index(n); return [n, ix.keyPath, ix.unique, ix.multiEntry]; });
        const keyPath = st.keyPath, autoIncrement = st.autoIncrement;
        const keys = await awReq(st.getAllKeys());
        const vals = await awReq(st.getAll());
        const records = [];
        for (let i = 0; i < keys.length; i++) records.push([JSON.stringify(await desc(keys[i])), JSON.stringify(await desc(vals[i]))]);
        d.stores[sn] = {keyPath, autoIncrement, indexes, records};
      }
      db.close();
      rep.idb[info.name] = d;
    }
  } catch (e) { rep.errors.push('idb: ' + (e && e.name)); }
  try {
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      const entries = {};
      for (const r of await c.keys()) {
        const res = await c.match(r);
        entries[new URL(r.url).pathname] = JSON.stringify([res.status, Array.from(res.headers).sort(), B64(new Uint8Array(await res.arrayBuffer()))]);
      }
      rep.caches[name] = entries;
    }
  } catch (e) { rep.errors.push('caches: ' + (e && e.name)); }
  try { await fetch('/sub/echo?rid=' + RID); } catch (e) { rep.errors.push('sub: ' + (e && e.name)); }
  await fetch('/__report?rid=' + RID, {method: 'POST', body: JSON.stringify(rep)});
})();
"""

# The navigation page (probe section 3 e). Off-list subresources load first;
# then the case named in ?case= runs, or the driver clicks a block.
NAV_HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>nav</title>
<style>body{margin:0;font:28px sans-serif}.blk{position:absolute;left:0;width:560px;height:140px;display:block;
border:2px solid #333;box-sizing:border-box;padding:20px;background:#eef;color:#000;text-align:left;font:inherit}</style>
<script>__COMMON__</script></head><body>
<a id="link" class="blk" style="top:0" href="__OFF__/target?via=link">link</a>
<a id="blank" class="blk" style="top:150px" target="_blank" href="__OFF__/target?via=blank">target=_blank</a>
<button id="popup" class="blk" style="top:300px" onclick="window.open('__OFF__/target?via=popup')">popup</button>
<iframe id="fr" src="__OFF__/frame?via=frame" onload="window.awFrameLoads = (window.awFrameLoads || 0) + 1"
 style="position:absolute;left:600px;top:0;width:500px;height:200px"></iframe>
<img id="im" src="__OFF__/img.png?via=img" style="position:absolute;left:600px;top:220px;width:20px;height:20px">
<script src="__OFF__/s.js?via=subscript"></script>
<script>
(async () => {
  const CASE = new URLSearchParams(location.search).get('case') || '';
  const OFF = '__OFF__', OFF2 = '__OFF2__';
  const img = new Promise((r) => { const i = document.getElementById('im'); if (i.complete) r(i.naturalWidth > 0); else { i.onload = () => r(true); i.onerror = () => r(false); } });
  const api = fetch(OFF + '/api?via=fetch').then((r) => r.text()).then((t) => t === 'api-ok', () => false);
  const fr = document.getElementById('fr');
  const frameLoads = (n) => new Promise((r) => {
    const t0 = Date.now();
    const tick = () => { if ((window.awFrameLoads || 0) >= n) r(true); else if (Date.now() - t0 > 5000) r(false); else setTimeout(tick, 50); };
    tick();
  });
  const first = await frameLoads(1);
  fr.src = OFF2 + '/frame?via=framenav';
  const second = await frameLoads(2);
  awLog('subresources', {nav_case: CASE, img: await img, fetch: await api, script: window.awSubScript === true,
    frame: first, frame_nav: second});
  await new Promise((r) => setTimeout(r, 300));
  if (CASE === 'script') location.href = OFF + '/target?via=script';
  if (CASE === 'form') { const f = document.createElement('form'); f.method = 'POST'; f.action = OFF + '/target?via=form'; document.body.appendChild(f); f.submit(); }
  if (CASE === 'meta') location.href = '/meta?to=' + encodeURIComponent(OFF + '/target?via=meta');
  if (CASE === 'redirect') location.href = '/redirect?to=' + encodeURIComponent(OFF + '/target?via=redirect');
  awLog('nav-ready', {nav_case: CASE});
})();
</script></body></html>"""

FRAME_HTML = r"""<!doctype html><html><head><meta charset="utf-8"><script>__COMMON__</script></head>
<body style="background:#cfc">frame<script>awLog('frame-load', {via: new URLSearchParams(location.search).get('via')});</script></body></html>"""

PAGE_HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>page</title><script>__COMMON__
awLog('page-load', {via: new URLSearchParams(location.search).get('via')});
addEventListener('pagehide', () => navigator.sendBeacon('/__log', JSON.stringify({kind: 'pagehide', page: location.pathname})));
</script></head><body><h1>page __HOST__</h1></body></html>"""

SW_PAGE_HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>sw</title><script>__COMMON__
(async () => {
  await navigator.serviceWorker.register('/sw.js', {scope: '/'});
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, {once: true}));
  awLog('sw-ready', {controlled: !!navigator.serviceWorker.controller});
})().catch((e) => awLog('sw-error', {error: e && e.name}));
</script></head><body>registers a service worker</body></html>"""

# A service worker that answers every navigation with its own page and logs
# the path it saw.
SW_JS = r"""
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  const path = new URL(e.request.url).pathname;
  e.waitUntil(fetch('/__log', {method: 'POST', body: JSON.stringify({kind: 'sw-fetch', page: path,
    restore: path.startsWith('/__agentwatch_restore_')})}).catch(() => {}));
  e.respondWith(new Response('<!doctype html><title>sw page</title><script>fetch("/__log",{method:"POST",' +
    'body:JSON.stringify({kind:"sw-page",page:location.pathname,local:localStorage.length})})</' + 'script>sw page',
    {headers: {'content-type': 'text/html; charset=utf-8'}}));
});
"""

# One big link at the place of the nav page's link block, so the driver
# clicks the same spot. A user's click on a link is a renderer-initiated
# navigation, which a site's service worker may answer.
LINK_HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>link</title>
<style>body{margin:0;font:28px sans-serif}.blk{position:absolute;left:0;top:0;width:560px;height:140px;display:block;
border:2px solid #333;box-sizing:border-box;padding:20px;background:#eef;color:#000}</style>
<script>__COMMON__</script></head><body><a id="link" class="blk" href="__TO__">link</a>
<script>awLog('link-ready', {});</script></body></html>"""

SW_PLAIN_JS = r"""
localStorage.setItem('sw_key', 'made-up-sw');
awLog('sw-plain-done', {local: localStorage.length});
"""

BIG_SETUP_JS = r"""
(async () => {
  const n = __MIB__;
  await awClear();
  const name = 'big' + n;
  const db = await awOpen(name, 1, (db) => db.createObjectStore('chunks'));
  const chunk = 'x'.repeat(1048576);
  for (let i = 0; i < n; i++) {
    const tx = db.transaction('chunks', 'readwrite'); tx.objectStore('chunks').put(chunk, i); await awDone(tx);
  }
  db.close();
  awLog('big-setup-done', {db: name, records: n});
  location.replace('/big-report');
})().catch((e) => awLog('big-setup-error', {error: e && e.name}));
"""

BIG_REPORT_JS = r"""
(async () => {
  const out = {};
  for (const info of await indexedDB.databases()) {
    const db = await awReq(indexedDB.open(info.name));
    let records = 0, chars = 0;
    for (const sn of Array.from(db.objectStoreNames)) {
      const vals = await awReq(db.transaction(sn, 'readonly').objectStore(sn).getAll());
      records += vals.length;
      for (const x of vals) chars += typeof x === 'string' ? x.length : 0;
    }
    db.close();
    out[info.name] = {records, chars};
  }
  awLog('big-report', {dbs: out});
})().catch((e) => awLog('big-report-error', {error: e && e.name}));
"""

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)

COOKIE_KINDS = [
    "c_hostonly=made-up-hostonly; Path=/",
    "c_httponly=made-up-httponly; Path=/; HttpOnly",
    "c_secure=made-up-secure; Path=/; Secure",
    "c_strict=made-up-strict; Path=/; SameSite=Strict",
    "c_lax=made-up-lax; Path=/; SameSite=Lax",
    "c_none=made-up-none; Path=/; SameSite=None; Secure",
    "c_maxage=made-up-maxage; Path=/; Max-Age=86400",
    "c_domain=made-up-domain; Path=/; Domain=__PARENT__",
    "c_path=made-up-path; Path=/sub",
    "c_part=made-up-partitioned; Path=/; Secure; SameSite=None; Partitioned",
    "__Host-c_prefix=made-up-host-prefix; Path=/; Secure",
]

AGENT_OLD_COOKIES = [
    "c_agent_old=made-up-agent-old; Path=/",
    "c_agent_dom=made-up-agent-dom; Path=/; Domain=__PARENT__; Max-Age=86400",
    "c_lax=made-up-agent-lax; Path=/; SameSite=Lax",
]


def html_page(title: str, script: str, body: str = "") -> str:
    return ('<!doctype html><html><head><meta charset="utf-8"><title>%s</title><script>%s</script>'
            "<script>%s</script></head><body>%s</body></html>") % (title, COMMON_JS, script, body)


def cookie_names(header: str | None) -> list[str]:
    return sorted(cookie_map(header))


def cookie_map(header: str | None) -> dict:
    out: dict = {}
    for part in (header or "").split(";"):
        part = part.strip()
        if not part:
            continue
        name, _, value = part.partition("=")
        out[name] = value
    return out


def parent_domain(host: str) -> str:
    labels = host.split(".")
    return ".".join(labels[1:]) if len(labels) > 2 else host


def payload_summary(p: dict) -> dict:
    """Names, attributes and counts of a C2 payload; never a value."""
    st = p.get("storage") or {}
    return {
        "domain": p.get("domain"),
        "origin": p.get("origin"),
        "path": urllib.parse.urlsplit(str(p.get("url") or "")).path,
        "cookies": [{k: c.get(k) for k in ("name", "domain", "hostOnly", "path", "secure", "httpOnly", "sameSite", "session")}
                    | {"partitioned": "partitionKey" in c} for c in p.get("cookies") or []],
        "local": len(st.get("local") or {}),
        "session": len(st.get("session") or {}),
        "idb": [{"name": d.get("name"), "version": d.get("version"),
                 "stores": {s.get("name"): len(s.get("records") or []) for s in d.get("stores") or []}}
                for d in st.get("idb") or []],
        "caches": {c.get("name"): len(c.get("entries") or []) for c in st.get("caches") or []},
    }


# ---------------------------------------------------------------- HTTP


class World:
    def __init__(self, run: str, sockets: str, port: int, sender_id: str) -> None:
        self.run = run
        self.port = port
        self.sender_origin = "chrome-extension://" + sender_id
        self.events = Events(os.path.join(run, "logs", "events.jsonl"))
        self.daemon = StubDaemon(os.path.join(sockets, "daemon.sock"), self.events)
        self.reports = Reports()
        self.logins: set[str] = set()
        self.logins_lock = threading.Lock()

    def off(self, n: str = "off") -> str:
        return "http://www.%s.localhost:%d" % (n, self.port)


def make_handler(world: World) -> type:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:
            pass

        # -- plumbing

        def _send(self, code: int, body: bytes | str, ctype: str = "text/html; charset=utf-8",
                  headers: list[tuple[str, str]] | None = None) -> None:
            b = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            for k, v in headers or []:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(b)
            self._status = code

        def _json(self, code: int, obj: object) -> None:
            self._send(code, json.dumps(obj), "application/json")

        def _log_request(self) -> None:
            # Names only: cookie names and query keys, never their values.
            h = self.headers
            world.events.add(
                "req", m=self.command, host=self.host, path=self.url.path, query_keys=sorted(self.q),
                dest=h.get("Sec-Fetch-Dest"), site=h.get("Sec-Fetch-Site"), mode=h.get("Sec-Fetch-Mode"),
                user=h.get("Sec-Fetch-User"), origin=h.get("Origin"), cookies=cookie_names(h.get("Cookie")),
                status=getattr(self, "_status", None), bytes=getattr(self, "_body_bytes", None))

        def _route(self) -> None:
            # A keep-alive connection reuses this object: reset, and read every
            # request body whole so the next request starts clean.
            self._status = None
            self._body_bytes = None
            self.body = b""
            if self.command == "POST" and self.headers.get("Content-Length") is not None:
                self._body_bytes = int(self.headers["Content-Length"])
                self.body = self.rfile.read(self._body_bytes)
            self.url = urllib.parse.urlsplit(self.path)
            self.host = (self.headers.get("Host") or "").rsplit(":", 1)[0].lower()
            self.q = dict(urllib.parse.parse_qsl(self.url.query))
            try:
                if self.host == BOX_HOST:
                    self._box()
                elif self.host.endswith(".localhost"):
                    self._site()
                else:
                    self._send(404, "unknown host")
            finally:
                if self.url.path not in ("/__log",):
                    self._log_request()

        def do_GET(self) -> None:
            self._route()

        def do_POST(self) -> None:
            self._route()

        # -- the stub box (contract C9, EXTENSION auth)

        def _login_ok(self) -> bool:
            token = cookie_map(self.headers.get("Cookie")).get(LOGIN_COOKIE)
            with world.logins_lock:
                return token is not None and token in world.logins

        def _extension_auth(self, origin_required: bool = True) -> bool:
            # Measured on Chromium 156: an extension's GET to a host it holds a
            # permission for carries no Origin header (Sec-Fetch-Site: none);
            # its POST carries Origin: chrome-extension://<id>. So the GET
            # route refuses a wrong Origin and accepts a missing one.
            origin = self.headers.get("Origin")
            if self.headers.get("Authorization") is not None:
                self._json(403, {"ok": False, "error_code": "forbidden"})
                return False
            if origin != world.sender_origin and (origin_required or origin is not None):
                self._json(403, {"ok": False, "error_code": "forbidden"})
                return False
            if not self._login_ok():
                self._json(401, {"ok": False, "error_code": "unauthorized"})
                return False
            return True

        def _box(self) -> None:
            p = self.url.path
            if self.command == "GET" and p == "/login":
                token = secrets.token_hex(16)
                with world.logins_lock:
                    world.logins.add(token)
                cookie = "%s=%s; Path=/; HttpOnly; SameSite=Lax" % (LOGIN_COOKIE, token)
                return self._send(200, "<!doctype html><title>box login</title><h1>logged in to the test box</h1>",
                                  headers=[("Set-Cookie", cookie)])
            if self.command == "GET" and p == "/api/browser/targets":
                if not self._extension_auth(origin_required=False):
                    return
                return self._json(200, {"ok": True, "data": {"box": "%s:%d" % (BOX_HOST, world.port), "users": [
                    {"name": USER, "supported": True, "running": True, "password_login": True}]}})
            if self.command == "POST" and p == "/api/browser/send":
                return self._box_send()
            self._send(404, "no")

        def _box_send(self) -> None:
            if self._body_bytes is None:
                return self._json(411, {"ok": False, "error_code": "length_required"})
            if not self._extension_auth():
                return
            if self.q.get("user") != USER:
                return self._json(404, {"ok": False, "error_code": "unknown_user"})
            body = self.body
            if len(body) > MAX_SEND_BYTES:
                world.events.add("box-send", status=413, bytes=len(body))
                return self._json(413, {"ok": False, "error_code": "browser_too_large"})
            try:
                payload = json.loads(body)
                domain = payload["domain"]
                if not isinstance(domain, str):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                world.events.add("box-send", status=400, bytes=len(body))
                return self._json(400, {"ok": False, "error_code": "browser_payload_invalid"})
            summary = payload_summary(payload)
            added = domain not in world.daemon.allow
            allow = world.daemon.set_allowlist(world.daemon.allow + [domain])
            if not allow.get("ok"):
                world.events.add("box-send", status=502, bytes=len(body), step="set_allowlist", payload=summary)
                return self._json(502, {"ok": False, "error_code": "browser_import_failed"})
            res = world.daemon.request("import", state=payload)
            if not res.get("ok"):
                world.events.add("box-send", status=502, bytes=len(body), step="import", error=res.get("error"), payload=summary)
                return self._json(502, {"ok": False, "error_code": "browser_import_failed"})
            counts = res.get("data")
            world.events.add("box-send", status=200, bytes=len(body), domain=domain, added=added, counts=counts,
                             secs=res.get("secs"), payload=summary)
            self._json(200, {"ok": True, "data": {"domain": domain, "added_to_allowlist": added, "counts": counts}})

        # -- the test sites

        def _site(self) -> None:
            p, q, host = self.url.path, self.q, self.host
            common = lambda s: s.replace("__COMMON__", COMMON_JS)  # noqa: E731
            if self.command == "POST" and p == "/__log":
                try:
                    obj = json.loads(self.body or b"{}")
                except ValueError:
                    obj = {}
                obj = obj if isinstance(obj, dict) else {}
                # Our pages send names, counts and booleans only; drop anything long.
                fields = {k: v for k, v in obj.items()
                          if k not in ("kind", "seq", "ts", "host", "page_kind") and not (isinstance(v, str) and len(v) > 200)}
                world.events.add("page", **{"page_kind": str(obj.get("kind")), "host": host, **fields})
                return self._send(204, b"")
            if self.command == "POST" and p == "/__report":
                try:
                    rep = json.loads(self.body or b"{}")
                except ValueError:
                    rep = {}
                rid = q.get("rid", "")
                world.reports.update(rid, **{k: rep.get(k) for k in ("doc_cookie", "local", "session", "idb", "caches", "errors")})
                full = world.reports.get(rid)
                world.events.add("report", rid=rid, host=host, summary=report_summary(full) if full else None)
                return self._send(204, b"")
            if p.startswith("/__agentwatch_restore_"):
                world.events.add("restore-seen", host=host)
                return self._send(404, "the site must never see the restore page")
            if p == "/setup":
                hs = [("Set-Cookie", c.replace("__PARENT__", parent_domain(host))) for c in COOKIE_KINDS]
                return self._send(200, html_page("setup", SETUP_JS, "<h1>setup %s</h1>" % host), headers=hs)
            if p == "/agent-old":
                hs = [("Set-Cookie", c.replace("__PARENT__", parent_domain(host))) for c in AGENT_OLD_COOKIES]
                return self._send(200, html_page("agent old", AGENT_OLD_JS, "<h1>agent state %s</h1>" % host), headers=hs)
            if p == "/report":
                rid = world.reports.new(host, p, cookie_map(self.headers.get("Cookie")))
                page = ('<!doctype html><html><head><meta charset="utf-8"><script>%s%s</script><title>report</title>'
                        "</head><body><h1>report %s</h1></body></html>") % (COMMON_JS, REPORT_JS.replace("__RID__", rid), host)
                return self._send(200, page)
            if p == "/sub/echo":
                world.reports.update(q.get("rid", ""), sub_cookie=cookie_map(self.headers.get("Cookie")))
                return self._send(204, b"")
            if p == "/nav":
                page = common(NAV_HTML).replace("__OFF__", world.off()).replace("__OFF2__", world.off("off2"))
                return self._send(200, page)
            # /p/<name> and /f/<name>: a page and a frame whose path names one
            # check, since the request log keeps no query value.
            if p in ("/target", "/page") or p.startswith("/p/"):
                return self._send(200, common(PAGE_HTML).replace("__HOST__", host))
            if p == "/frame" or p.startswith("/f/"):
                return self._send(200, common(FRAME_HTML))
            if p == "/img.png":
                return self._send(200, PNG, "image/png")
            if p == "/s.js":
                return self._send(200, "window.awSubScript = true;", "text/javascript")
            if p == "/api":
                return self._send(200, "api-ok", "text/plain", headers=[("Access-Control-Allow-Origin", "*")])
            if p == "/redirect":
                return self._send(302, b"", "text/plain", headers=[("Location", q.get("to", "/page"))])
            if p == "/meta":
                to = html.escape(q.get("to", "/page"), quote=True)
                return self._send(200, '<!doctype html><meta http-equiv="refresh" content="0;url=%s">meta' % to)
            if p == "/link":
                to = html.escape(q.get("to", "/page"), quote=True)
                return self._send(200, common(LINK_HTML).replace("__TO__", to))
            if p == "/sw":
                return self._send(200, common(SW_PAGE_HTML))
            if p == "/sw.js":
                return self._send(200, SW_JS, "text/javascript")
            if p == "/sw-plain":
                return self._send(200, html_page("sw plain", SW_PLAIN_JS, "<h1>plain page %s</h1>" % host))
            if p == "/big-setup":
                mib = int(q.get("mib", "1"))
                return self._send(200, html_page("big setup", BIG_SETUP_JS.replace("__MIB__", str(mib))))
            if p == "/big-report":
                return self._send(200, html_page("big report", BIG_REPORT_JS))
            self._send(404, "no")

    return Handler


# ---------------------------------------------------------------- control


def serve_control(world: World, path: str) -> None:
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        srv.bind(path)
    finally:
        os.umask(old)
    os.chmod(path, 0o600)
    srv.listen(8)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_control_conn, args=(world, conn), daemon=True).start()


def _control_conn(world: World, conn: socket.socket) -> None:
    with conn:
        f = conn.makefile("rwb")
        line = f.readline()
        try:
            req = json.loads(line)
            out = control(world, req)
        except Exception as e:  # the driver sees the failure; no value is in it
            out = {"error": "%s" % type(e).__name__}
        f.write(json.dumps(out).encode("utf-8") + b"\n")
        f.flush()


def control(world: World, req: dict) -> object:
    op = req.get("op")
    if op == "mark":
        return {"seq": world.events.mark()}
    if op == "events":
        return world.events.since(int(req.get("since", 0)))
    if op == "wait":
        ev = world.events.wait(int(req.get("since", 0)), dict(req.get("match") or {}), float(req.get("timeout", 10)))
        return ev if ev is not None else {"timeout": True}
    if op == "daemon_state":
        return world.daemon.state()
    if op == "wait_hello":
        return {"ok": world.daemon.wait_hello(float(req.get("timeout", 30)))}
    if op == "ping":
        return world.daemon.request("ping")
    if op == "allow":
        return world.daemon.set_allowlist(list(req.get("domains") or []))
    if op == "bridge":
        return world.daemon.bridge(str(req.get("call")), list(req.get("args") or []), req.get("wait"))
    if op == "import":
        return world.daemon.request("import", state=req.get("state"))
    if op == "report":
        r = world.reports.get(str(req.get("rid")))
        return report_summary(r) if r else {"error": "no report"}
    if op == "compare":
        a, b = world.reports.get(str(req.get("a"))), world.reports.get(str(req.get("b")))
        if a is None or b is None:
            return {"error": "no report"}
        return compare_reports(a, b)
    return {"error": "unknown op"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--run", required=True, help="the run folder")
    ap.add_argument("--sockets", help="the folder of the two Unix sockets (default: the run folder)")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--sender-id", required=True)
    args = ap.parse_args()
    sockets = args.sockets or args.run
    world = World(args.run, sockets, args.port, args.sender_id)
    threading.Thread(target=world.daemon.serve, daemon=True).start()
    threading.Thread(target=serve_control, args=(world, os.path.join(sockets, "ctl.sock")), daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(world))
    httpd.daemon_threads = True
    world.events.add("server", port=args.port)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
