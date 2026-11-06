#!/usr/bin/env python3
"""The live test's driver: it runs every case against a started run.

    python3 test/live/live.py <run folder> [case ...]

run.sh starts the world (two private displays, server.py, the agent Chromium
with the receiver, the operator Chromium with a copy of the sender) and then
calls this. It drives each Chromium with xdotool on its own display, talks to
the stub daemon through server.py's control socket, and reads the server's
event log (requests, page reports, receiver answers and events).

It prints and writes names, counts and pass/fail only: never a cookie value or
a storage value, test values included.
"""

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# The page area starts below the tab strip and the toolbar (Chromium 156,
# 1280x900 window at 0,0, no window manager).
PAGE_TOP = 87

# The scope of every tab that the harness opens (server.py: LIVE_SCOPE). tabs.create and
# windows.create take it as their second arg (C10).
SCOPE = "live"


class Ctl:
    def __init__(self, path: str) -> None:
        self.path = path

    def __call__(self, **req: object) -> object:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(300)
        s.connect(self.path)
        with s:
            f = s.makefile("rwb")
            f.write(json.dumps(req).encode() + b"\n")
            f.flush()
            return json.loads(f.readline())

    def mark(self) -> int:
        return self(op="mark")["seq"]

    def wait(self, since: int, timeout: float = 10.0, **match: object) -> dict | None:
        ev = self(op="wait", since=since, match=match, timeout=timeout)
        return None if ev.get("timeout") else ev

    def events(self, since: int) -> list[dict]:
        return self(op="events", since=since)


class Screen:
    """One Chromium on its own private display."""

    def __init__(self, name: str, display: int, xauth: str, shots: str) -> None:
        self.name = name
        self.env = {"DISPLAY": ":%d" % display, "XAUTHORITY": xauth, "PATH": "/usr/bin:/bin", "HOME": os.path.dirname(xauth)}
        self.shots = shots
        self.count = 0

    def xdo(self, *args: object) -> str:
        r = subprocess.run(["xdotool", *map(str, args)], env=self.env, capture_output=True, text=True, timeout=30)
        return r.stdout.strip()

    def key(self, *keys: str) -> None:
        for k in keys:
            self.xdo("key", "--clearmodifiers", k)
            time.sleep(0.15)

    def type(self, text: str) -> None:
        self.xdo("type", "--delay", "15", text)

    def goto(self, url: str) -> None:
        self.key("ctrl+l")
        time.sleep(0.3)
        self.type(url)
        time.sleep(0.2)
        self.key("Delete")  # drop an inline autocompletion
        self.key("Return")

    def click(self, x: int, y: int) -> None:
        self.xdo("mousemove", x, y)
        time.sleep(0.1)
        self.xdo("click", 1)

    def shot(self, label: str) -> str:
        self.count += 1
        path = os.path.join(self.shots, "%s-%s-%02d-%s.png" % (time.strftime("%H%M%S"), self.name, self.count, label))
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1280x900",
                        "-i", self.env["DISPLAY"], "-frames:v", "1", path], env=self.env, check=False, timeout=30)
        return path


class Results:
    def __init__(self, run: str) -> None:
        self.path = os.path.join(run, "results.json")
        self.rows: list[dict] = []
        if os.path.exists(self.path):  # a run driven case by case keeps one table
            with open(self.path, encoding="utf-8") as f:
                self.rows = json.load(f)

    def add(self, case: str, ok: bool, how: str, **detail: object) -> bool:
        row = {"case": case, "result": "pass" if ok else "FAIL", "how": how, "detail": detail}
        self.rows.append(row)
        print("%-4s %s  %s" % (row["result"], case, json.dumps(detail, sort_keys=True)), flush=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self.rows, f, indent=1, sort_keys=True)
        return ok


def http(method: str, url: str, headers: dict, body: bytes | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {}


class Live:
    def __init__(self, run: str) -> None:
        with open(os.path.join(run, "env.json"), encoding="utf-8") as f:
            self.env = json.load(f)
        self.run = run
        self.port = self.env["port"]
        self.ctl = Ctl(os.path.join(self.env.get("sockets", run), "ctl.sock"))
        shots = os.path.join(run, "shots")
        self.agent = Screen("agent", self.env["agent"]["display"], self.env["agent"]["xauth"], shots)
        self.op = Screen("operator", self.env["operator"]["display"], self.env["operator"]["xauth"], shots)
        self.r = Results(run)
        self.box = "http://box.localhost:%d" % self.port
        self.sender_origin = "chrome-extension://" + self.env["sender_id"]
        self.rid_op: str | None = None
        saved = os.path.join(run, "operator-report")
        if os.path.exists(saved):
            with open(saved, encoding="utf-8") as f:
                self.rid_op = f.read().strip() or None

    def site(self, name: str, path: str) -> str:
        return "http://www.%s.localhost:%d%s" % (name, self.port, path)

    def allow(self, domains: list[str]) -> dict:
        return self.ctl(op="allow", domains=domains)

    # -- bridge helpers (C10, through the stub daemon's channel bridge)

    def bridge(self, call: str, *args: object, wait: int | None = None) -> dict:
        return self.ctl(op="bridge", call=call, args=list(args), wait=wait)

    def cdp(self, tab: int, method: str, params: dict | None = None) -> dict:
        return self.bridge("debugger.sendCommand", {"tabId": tab}, method, params or {})

    def new_tab(self, url: str, attach: bool = True) -> int:
        """tabs.create opens about:blank only (C10). A tab at a URL is a blank tab that the
        driver attaches to and sends Page.navigate to."""
        tab = (self.bridge("tabs.create", {"url": "about:blank", "active": True}, SCOPE).get("data") or {}).get("id")
        if attach:
            self.bridge("debugger.attach", tab)
            if url != "about:blank":
                self.cdp(tab, "Page.navigate", {"url": url})
        return tab

    def close_tab(self, tab: int | None) -> None:
        if tab is not None:
            self.bridge("tabs.remove", tab)

    # -- operator helpers

    def popup(self) -> int:
        """Open the sender's popup on the operator's active tab; wait for its users."""
        m = self.ctl.mark()
        self.op.key("Escape")
        self.op.key("ctrl+shift+u")
        self.ctl.wait(m, 10, kind="req", host="box.localhost", path="/api/browser/targets")
        time.sleep(1.0)
        return m

    def popup_send(self, label: str, dialog: bool = True) -> None:
        """Press the popup's Send, then Allow in Chrome's permission dialog."""
        self.popup()
        self.op.shot(label + "-popup")
        self.op.key("Tab", "Tab", "Tab", "Tab", "Return")
        if dialog:
            time.sleep(1.5)
            self.op.shot(label + "-permission")
            self.op.key("Tab", "Return")

    def agent_tab(self) -> None:
        """Open a new tab in the agent Chromium that the driver types into. A tab that starts at
        chrome://newtab/ (Ctrl+T), that no page and no bridge op opened, has the operator mark
        (C10), and the list of the set_scopes `operator` field. A tab of no scope and no mark has no
        list, so its navigations fail closed (C5). An import or an allowlist change closes the
        driver's tab, so each case starts with a new one."""
        self.agent.key("ctrl+t")
        time.sleep(1.0)

    # -- the cases

    def link(self) -> None:
        ok = self.ctl(op="wait_hello", timeout=60).get("ok")
        st = self.ctl(op="daemon_state")
        self.r.add("receiver links up and says hello", bool(ok), "stub daemon socket: link event, then hello",
                   version=st.get("hello"))
        self.r.add('the hello says features ["scopes"]', st.get("features") == ["scopes"],
                   "stub daemon socket: the hello's features", features=st.get("features"))
        self.agent_tab()
        ping = self.ctl(op="ping")
        self.r.add("ping", ping.get("ok") is True and ping.get("data") == {}, "C4 ping through host.py", secs=ping.get("secs"))

    def stub_refusals(self) -> None:
        status, _ = http("GET", self.box + "/login", {})
        req = urllib.request.Request(self.box + "/login")
        with urllib.request.urlopen(req, timeout=10) as r:
            set_cookie = r.headers.get("Set-Cookie") or ""
        cookie = set_cookie.split(";", 1)[0]  # the made-up login token; never printed
        good = {"Origin": self.sender_origin, "Cookie": cookie}
        wrong = "chrome-extension://" + "a" * 32
        checks = [
            ("targets without the login cookie", "GET", "/api/browser/targets", {"Origin": self.sender_origin}, None, 401),
            ("targets with a wrong Origin", "GET", "/api/browser/targets", {"Origin": wrong, "Cookie": cookie}, None, 403),
            ("targets from a web page Origin", "GET", "/api/browser/targets",
             {"Origin": "http://www.s1.localhost:%d" % self.port, "Cookie": cookie}, None, 403),
            ("send with a wrong Origin", "POST", "/api/browser/send?user=tester", {"Origin": wrong, "Cookie": cookie}, b"{}", 403),
            ("send from a web page Origin", "POST", "/api/browser/send?user=tester",
             {"Origin": "http://www.s1.localhost:%d" % self.port, "Cookie": cookie}, b"{}", 403),
            ("send without the login cookie", "POST", "/api/browser/send?user=tester", {"Origin": self.sender_origin}, b"{}", 401),
            ("send with an Authorization header", "POST", "/api/browser/send?user=tester",
             dict(good, Authorization="Bearer made-up"), b"{}", 403),
            ("send of 33,554,433 bytes", "POST", "/api/browser/send?user=tester", good, b"x" * 33554433, 413),
        ]
        m = self.ctl.mark()
        for name, method, path, headers, body, want in checks:
            got, _ = http(method, self.box + path, headers, body)
            self.r.add("stub box refuses: " + name, got == want, "direct HTTP request to the stub box", status=got, want=want)
        sends = [e for e in self.ctl.events(m) if e["kind"] == "daemon-request"]
        self.r.add("no refused request reaches the daemon", not sends, "stub daemon request log", daemon_requests=len(sends))

    def static_block(self) -> None:
        m = self.ctl.mark()
        self.agent.goto(self.site("s1", "/target?via=static"))
        ev = self.ctl.wait(m, 10, kind="blocked", host="www.s1.localhost")
        time.sleep(1.0)
        seen = [e for e in self.ctl.events(m) if e["kind"] == "req" and e["host"] == "www.s1.localhost"]
        self.agent.shot("static-block")
        self.r.add("static rule blocks a top-level navigation before any allowlist", ev is not None and not seen,
                   "receiver blocked event; server request log", blocked=bool(ev), server_requests=len(seen))

    def agent_old_state(self) -> None:
        a = self.allow(["s1.localhost"])
        self.r.add("set_scopes [s1.localhost]", a.get("ok") is True and (a.get("data") or {}).get("rules") == 2,
                   "receiver answer", data=a.get("data"), error=a.get("error"))
        m = self.ctl.mark()
        self.agent.goto(self.site("s1", "/agent-old"))
        ev = self.ctl.wait(m, 20, kind="page", page_kind="agent-old-done", host="www.s1.localhost")
        self.r.add("agent signs in on its own first (old state to replace)", ev is not None, "page log of the agent tab")

    def add_box(self) -> None:
        self.op.goto("chrome-extension://%s/options.html" % self.env["sender_id"])
        time.sleep(1.5)
        self.op.key("Tab")
        self.op.type(self.box)
        self.op.key("Return")
        time.sleep(1.5)
        self.op.shot("options-permission")
        self.op.key("Tab", "Return")
        time.sleep(1.0)
        self.op.shot("options-added")

    def operator_setup(self) -> None:
        m = self.ctl.mark()
        self.op.goto(self.site("s1", "/setup"))
        done = self.ctl.wait(m, 30, kind="page", page_kind="setup-done", host="www.s1.localhost")
        rep = self.ctl.wait(m, 30, kind="report", host="www.s1.localhost")
        self.rid_op = rep["rid"] if rep else None
        with open(os.path.join(self.run, "operator-report"), "w", encoding="utf-8") as f:
            f.write(self.rid_op or "")
        summary = (rep or {}).get("summary") or {}
        self.r.add("operator site writes every state kind", bool(done and rep),
                   "page log and the report page's first script (operator side)",
                   nav_cookies=len(summary.get("nav_cookie") or []), sub_cookies=len(summary.get("sub_cookie") or []),
                   local=len(summary.get("local") or []), session=len(summary.get("session") or []),
                   idb=summary.get("idb"), caches=summary.get("caches"))

    def popup_before_login(self) -> None:
        m = self.popup()
        self.op.shot("popup-before-login")
        reqs = [e for e in self.ctl.events(m) if e["kind"] == "req" and e["path"] == "/api/browser/targets"]
        last = reqs[-1] if reqs else {}
        self.r.add("popup before the box login: targets answered 401", last.get("status") == 401,
                   "server request log; screenshot of the popup's note", origin=last.get("origin"),
                   site=last.get("site"), cookies=last.get("cookies"))
        self.op.key("Escape")

    def box_login(self) -> None:
        m = self.ctl.mark()
        self.op.key("ctrl+t")
        time.sleep(0.5)
        self.op.goto(self.box + "/login")
        ev = self.ctl.wait(m, 10, kind="req", host="box.localhost", path="/login")
        time.sleep(0.5)
        self.op.key("ctrl+w")
        time.sleep(0.5)
        self.r.add("operator logs in to the stub box", bool(ev and ev.get("status") == 200), "server request log")

    def send_s1(self) -> None:
        m = self.ctl.mark()
        self.popup_send("s1")
        send = self.ctl.wait(m, 150, kind="box-send")
        targets = [e for e in self.ctl.events(m) if e["kind"] == "req" and e["path"] == "/api/browser/targets"]
        post = [e for e in self.ctl.events(m) if e["kind"] == "req" and e["path"] == "/api/browser/send"]
        self.op.shot("s1-after-send")
        t = targets[-1] if targets else {}
        p = post[-1] if post else {}
        self.r.add("popup lists the box's user (targets 200 with the login cookie)",
                   t.get("status") == 200 and "aw_test_login" in (t.get("cookies") or []),
                   "server request log (the GET carries no Origin: see C9 note)", origin=t.get("origin"),
                   site=t.get("site"), cookies=t.get("cookies"))
        self.r.add("send POST carries the sender Origin and the login cookie",
                   p.get("origin") == self.sender_origin and "aw_test_login" in (p.get("cookies") or []) and p.get("status") == 200,
                   "server request log", origin=p.get("origin"), cookies=p.get("cookies"), status=p.get("status"),
                   bytes=p.get("bytes"))
        if not send:
            self.r.add("send of s1.localhost imports", False, "box-send event", error="no send arrived")
            return
        payload = send.get("payload") or {}
        counts = send.get("counts") or {}
        cookies = payload.get("cookies") or []
        records = sum(n for d in payload.get("idb") or [] for n in d["stores"].values())
        want = {
            "cookies_set": len(cookies), "local": payload.get("local"), "session": payload.get("session"),
            "idb_databases": len(payload.get("idb") or []), "idb_records": records - 1,
            "cache_entries": sum((payload.get("caches") or {}).values()),
        }
        # The partitioned cookie of an http *.localhost site is its own row
        # (contract C6's https:// URL rule; see the README).
        errors = counts.get("errors") or []
        part_failed = "cookie c_part: not set" in errors
        want["cookies_set"] -= 1 if part_failed else 0
        got = {k: counts.get(k) for k in want}
        self.part_failed = part_failed
        self.r.add("send of s1.localhost: 11 cookie kinds in the payload", sorted(c["name"] for c in cookies) == sorted([
            "c_hostonly", "c_httponly", "c_secure", "c_strict", "c_lax", "c_none", "c_maxage", "c_domain", "c_path",
            "c_part", "__Host-c_prefix"]) and any(c.get("partitioned") for c in cookies),
                   "box-send payload summary (names and attributes)", cookies=[c["name"] for c in cookies],
                   domain=payload.get("domain"))
        self.r.add("receiver counts match the payload", send.get("status") == 200 and got == want,
                   "import answer vs the payload summary (the CryptoKey record is the one unsupported value)",
                   got=got, want=want, cookies_removed=counts.get("cookies_removed"), tabs_closed=counts.get("tabs_closed"),
                   errors=counts.get("errors"), secs=send.get("secs"))
        self.r.add("old agent cookies of the domain removed (O19)", counts.get("cookies_removed") == 3,
                   "import answer: cookies_removed", cookies_removed=counts.get("cookies_removed"))
        self.r.add("import closes the agent's tab of the origin", counts.get("tabs_closed") == 1,
                   "import answer: tabs_closed", tabs_closed=counts.get("tabs_closed"))
        self.r.add("unsupported value reported by name",
                   [e for e in errors if e != "cookie c_part: not set"] == ["idb kinds/kv: 1 records skipped"],
                   "import answer: errors", errors=errors)
        rep = self.ctl.wait(m, 30, kind="report", host="www.s1.localhost")
        restore = [e for e in self.ctl.events(m) if e["kind"] in ("restore-seen",)
                   or (e["kind"] == "req" and e["path"].startswith("/__agentwatch_restore_"))]
        self.r.add("the site never sees the restore page", not restore, "server request log", requests=len(restore))
        if not rep or not self.rid_op:
            self.r.add("agent's first script sees the sent state", False, "report page", error="no agent report")
            return
        self.compare_s1(rep["rid"])

    def compare_s1(self, rid_agent: str) -> None:
        c = self.ctl(op="compare", a=self.rid_op, b=rid_agent)
        clean = lambda d: not [n for n in d["missing"] if n != "c_part"] and not d["extra"] and not d["differ"]  # noqa: E731
        seen = [area for area in ("nav_cookie", "doc_cookie") if "c_part" not in c[area]["missing"]]
        self.r.add("partitioned cookie (CHIPS) of an http *.localhost site moves", len(seen) == 2,
                   "Cookie header and document.cookie on the agent side; import errors",
                   import_error=getattr(self, "part_failed", None))
        for area, label in (("nav_cookie", "Cookie header of the first request"), ("sub_cookie", "Cookie header on /sub (Path)"),
                            ("doc_cookie", "document.cookie at the first script"), ("local", "localStorage at the first script"),
                            ("session", "sessionStorage at the first script")):
            d = c[area]
            self.r.add("agent sees the same " + area + " (c_part: own row)" * area.endswith("cookie"),
                       clean(d) and len(d["names"]) > 0,
                       label + ", operator report vs agent report", names=d["names"], missing=d["missing"],
                       extra=d["extra"], differ=d["differ"])
        idb = c["idb"]
        ok = not idb["missing"] and not idb["extra"]
        detail = {}
        for name, d in idb["databases"].items():
            for sn, s in d["stores"].items():
                want_missing = [{"key": "cryptokey", "kind": "CryptoKey"}] if (name, sn) == ("kinds", "kv") else []
                good = s["schema_same"] and s["missing"] == want_missing and not s["extra"] and not s["differ"]
                ok = ok and good and d["version"][0] == d["version"][1] and not d["missing_stores"] and not d["extra_stores"]
                detail["%s/%s" % (name, sn)] = {"records": s["records"], "same": s["same"], "missing": s["missing"],
                                                "extra": s["extra"], "differ": s["differ"]}
        self.r.add("agent sees the same IndexedDB (schema, versions, every C3 kind; the CryptoKey left out)", ok,
                   "IndexedDB read at the first script, operator vs agent", databases=sorted(idb["databases"]),
                   extra_databases=idb["extra"], stores=detail)
        ca = c["caches"]
        ok = not ca["missing"] and not ca["extra"] and all(clean(x) for x in ca["caches"].values())
        self.r.add("agent sees the same Cache Storage", ok, "caches read at the first script, operator vs agent",
                   caches={n: x["names"] for n, x in ca["caches"].items()}, extra=ca["extra"])
        self.r.add("old agent page storage gone (O19)",
                   "agent_old" not in c["local"]["extra"] and not c["session"]["extra"] and "agent-old-db" not in idb["extra"]
                   and "agent-cache" not in ca["extra"] and "c_agent_old" not in c["nav_cookie"]["extra"],
                   "agent report: no agent_old key, agent-old-db, agent-cache or c_agent_old", page_errors=c["page_errors"])

    def nav_cases(self) -> None:
        clicks = {"link": (300, PAGE_TOP + 70), "blank": (300, PAGE_TOP + 220), "popup": (300, PAGE_TOP + 370)}
        tabs: dict[str, object] = {}
        for case in ("link", "script", "form", "meta", "redirect", "blank", "popup"):
            m = self.ctl.mark()
            self.agent.goto(self.site("s1", "/nav?case=" + case))
            sub = self.ctl.wait(m, 20, kind="page", page_kind="subresources", nav_case=case)
            if case in clicks:
                time.sleep(0.5)
                self.agent.click(*clicks[case])
            blocked = self.ctl.wait(m, 10, kind="blocked", host="www.off.localhost")
            time.sleep(1.5)
            evs = self.ctl.events(m)
            leaked = [e for e in evs if e["kind"] == "req" and e["host"] == "www.off.localhost" and e["path"] == "/target"]
            subreqs = sorted({"%s %s" % (e["path"], e.get("dest")) for e in evs if e["kind"] == "req"
                              and e["host"] in ("www.off.localhost", "www.off2.localhost") and e["path"] != "/target"})
            frames = sorted({e.get("via") for e in evs if e["kind"] == "page" and e.get("page_kind") == "frame-load"})
            hop = [e for e in evs if e["kind"] == "req" and e["host"] == "www.s1.localhost" and e["path"] in ("/redirect", "/meta")]
            tabs[case] = blocked.get("tab") if blocked else None
            subs_ok = bool(sub) and all(sub.get(k) is True for k in ("img", "fetch", "script", "frame", "frame_nav"))
            first_hop = case not in ("meta", "redirect") or bool(hop)
            if case == "blank":
                self.agent.shot("nav-blank")
            self.r.add("O13 %s to an off-list host is blocked" % case, bool(blocked) and not leaked and first_hop,
                       "receiver blocked event; server log has no request for the target",
                       blocked_host=blocked.get("host") if blocked else None, target_requests=len(leaked),
                       first_hop=[e["path"] + " " + str(e.get("status")) for e in hop])
            self.r.add("O13 %s page: off-list frames and subresources load" % case, subs_ok and frames == ["frame", "framenav"],
                       "page log (img, fetch, script, frame, frame navigation) and server log",
                       subresources={k: (sub or {}).get(k) for k in ("img", "fetch", "script", "frame", "frame_nav")},
                       frame_loads=frames, requests=subreqs)
        self.agent.shot("nav-done")
        same = tabs["link"] is not None and all(tabs[c] == tabs["link"] for c in ("script", "form", "meta", "redirect"))
        new = all(tabs[c] is not None and tabs[c] != tabs["link"] for c in ("blank", "popup")) and tabs["blank"] != tabs["popup"]
        self.r.add("O13 blank and popup open new tabs, and those are blocked too", same and new,
                   "tab ids of the blocked events", tabs=tabs)

    def allowlist_change(self) -> None:
        base = sorted(set(self.ctl(op="daemon_state")["allow"]))
        a0 = self.allow(base)
        self.r.add("set_scopes with the same list closes tabs left on blocked pages", a0.get("ok") is True,
                   "receiver answer", data=a0.get("data"))
        a1 = self.allow(base + ["s2.localhost"])
        m = self.ctl.mark()
        self.agent.key("ctrl+t")
        time.sleep(0.5)
        self.agent.goto(self.site("s2", "/page?via=s2tab"))
        loaded = self.ctl.wait(m, 15, kind="page", page_kind="page-load", host="www.s2.localhost")
        time.sleep(1.0)
        self.agent.shot("s2-open")
        m2 = self.ctl.mark()
        a2 = self.allow(base)
        hidden = self.ctl.wait(m2, 10, kind="page", page_kind="pagehide", host="www.s2.localhost")
        self.agent.shot("s2-closed")
        self.r.add("allowlist change closes the off-list tab",
                   bool(loaded) and (a1.get("data") or {}).get("closed") == 0 and (a2.get("data") or {}).get("closed") == 1
                   and bool(hidden), "receiver answers (closed) and the s2 page's pagehide beacon",
                   add_s2=a1.get("data"), remove_s2=a2.get("data"), s2_loaded=bool(loaded), pagehide=bool(hidden))

    def service_worker(self) -> None:
        base = sorted(set(self.ctl(op="daemon_state")["allow"]))
        self.allow(base + ["sw.localhost"])
        m = self.ctl.mark()
        self.agent.goto(self.site("sw", "/sw"))
        ready = self.ctl.wait(m, 20, kind="page", page_kind="sw-ready", host="www.sw.localhost")
        m1 = self.ctl.mark()
        self.agent.goto(self.site("sw", "/sw-plain"))
        answered = self.ctl.wait(m1, 15, kind="page", page_kind="sw-page", host="www.sw.localhost")
        direct = [e for e in self.ctl.events(m1) if e["kind"] == "req" and e["path"] == "/sw-plain"]
        self.r.add("agent's service worker answers the site's navigations", bool(ready and answered) and not direct,
                   "page log (sw-ready, sw-page); the server never saw /sw-plain", controlled=(ready or {}).get("controlled"))
        m2 = self.ctl.mark()
        self.op.goto(self.site("sw", "/sw-plain"))
        self.ctl.wait(m2, 15, kind="page", page_kind="sw-plain-done", host="www.sw.localhost")
        m3 = self.ctl.mark()
        self.popup_send("sw")
        send = self.ctl.wait(m3, 150, kind="box-send")
        after = self.ctl.wait(m3, 20, kind="page", page_kind="sw-page", host="www.sw.localhost")
        evs = self.ctl.events(m3)
        sw_restore = [e for e in evs if e["kind"] == "page" and e.get("page_kind") == "sw-fetch" and e.get("restore")]
        counts = (send or {}).get("counts") or {}
        self.r.add("import bypasses the site's service worker (Network.setBypassServiceWorker)",
                   bool(send) and send.get("status") == 200 and counts.get("local") == 1 and not sw_restore,
                   "import answer; the worker's own log never shows the restore URL",
                   status=(send or {}).get("status"), local=counts.get("local"), tabs_closed=counts.get("tabs_closed"),
                   errors=counts.get("errors"), worker_saw_restore=len(sw_restore),
                   page_after=(after or {}).get("local"))

    def sw_removed(self) -> None:
        """A removed host's service worker and a link to that host (final review I1).

        The worker of www.sw.localhost registers while sw.localhost is on the
        list, the tab moves to an allowed page with a link to the sw host, the
        list drops sw.localhost, and the driver clicks the link. The block
        holds only if the navigation fails with ERR_BLOCKED_BY_CLIENT (a
        `blocked` event) and the worker never answers it (no sw-fetch or
        sw-page log, no request for the page).
        """
        keep = sorted(set(self.ctl(op="daemon_state")["allow"]) - {"sw.localhost"} | {"s1.localhost"})
        # The service_worker case left a registered worker, which would answer /sw
        # with its own page and keep the registering script from running. Dropping
        # the host first makes the receiver remove every worker (a list shrink).
        self.allow(keep)
        a0 = self.allow(sorted(set(keep) | {"sw.localhost"}))
        m = self.ctl.mark()
        self.agent.goto(self.site("sw", "/sw"))
        ready = self.ctl.wait(m, 20, kind="page", page_kind="sw-ready", host="www.sw.localhost")
        m1 = self.ctl.mark()
        self.agent.goto(self.site("sw", "/sw-plain?via=listed"))
        answered = self.ctl.wait(m1, 15, kind="page", page_kind="sw-page", host="www.sw.localhost")
        m2 = self.ctl.mark()
        self.agent.goto(self.site("s1", "/link?to=" + urllib.parse.quote(self.site("sw", "/sw-plain?via=removed"), safe="")))
        link_ready = self.ctl.wait(m2, 15, kind="page", page_kind="link-ready", host="www.s1.localhost")
        a1 = self.allow(keep)
        time.sleep(1.0)
        m3 = self.ctl.mark()
        self.agent.click(300, PAGE_TOP + 70)
        blocked = self.ctl.wait(m3, 10, kind="blocked", host="www.sw.localhost")
        time.sleep(2.0)
        evs = self.ctl.events(m3)
        worker = [e.get("page_kind") for e in evs if e["kind"] == "page" and e["host"] == "www.sw.localhost"
                  and e.get("page_kind") in ("sw-fetch", "sw-page")]
        direct = [e["path"] for e in evs if e["kind"] == "req" and e["host"] == "www.sw.localhost" and e["path"] != "/__log"]
        self.agent.shot("sw-removed-click")
        setup = bool(a0.get("ok") and ready and answered and link_ready and a1.get("ok"))
        self.r.add("setup: the worker answers while listed; the list then drops its host", setup,
                   "page log (sw-ready, sw-page, link-ready); receiver answers",
                   controlled=(ready or {}).get("controlled"), add=a0.get("data"), remove=a1.get("data"))
        self.r.add("a removed host's service worker does not answer a link navigation (the block holds)",
                   setup and bool(blocked) and not worker and not direct,
                   "receiver blocked event; the worker's own log; server request log",
                   blocked=bool(blocked), worker_logs=worker, requests=direct)

    def big(self, mib: int) -> None:
        name = "big%d" % mib
        m = self.ctl.mark()
        self.op.goto(self.site(name, "/big-setup?mib=%d" % mib))
        self.ctl.wait(m, 120, kind="page", page_kind="big-setup-done", host="www.%s.localhost" % name)
        self.ctl.wait(m, 120, kind="page", page_kind="big-report", host="www.%s.localhost" % name)
        m1 = self.ctl.mark()
        self.popup_send(name)
        if mib <= 32:
            send = self.ctl.wait(m1, 280, kind="box-send")
            rep = self.ctl.wait(m1, 120, kind="page", page_kind="big-report", host="www.%s.localhost" % name)
            counts = (send or {}).get("counts") or {}
            dbs = (rep or {}).get("dbs") or {}
            self.r.add("a %d MiB send imports" % mib,
                       bool(send) and send.get("status") == 200 and counts.get("idb_records") == mib
                       and dbs.get(name) == {"records": mib, "chars": mib * 1048576},
                       "box-send (bytes, import answer) and the agent page's IndexedDB count",
                       bytes=(send or {}).get("bytes"), idb_records=counts.get("idb_records"), errors=counts.get("errors"),
                       secs=(send or {}).get("secs"), agent_page=dbs.get(name))
            return
        time.sleep(30)
        posts = [e for e in self.ctl.events(m1) if e["kind"] == "req" and e["path"] == "/api/browser/send"]
        self.popup()
        shot = self.op.shot(name + "-refused")
        self.r.add("a %d MiB send is refused in the sender, naming the database" % mib, not posts,
                   "server log has no send POST; screenshot of the popup's text (read by eye)",
                   posts=len(posts), screenshot=os.path.basename(shot))
        self.op.key("Escape")

    # -- agent mode (C10, and the DNR rules 3 to 5 of C5)

    def bridge_info(self) -> None:
        r = self.bridge("bridge.info")
        d = r.get("data") or {}
        self.r.add("bridge.info answers on channel bridge", r.get("ok") is True and d.get("bridge") == 1
                   and d.get("id") == self.env["receiver_id"], "stub daemon's bridge request",
                   version=d.get("version"), full_version=d.get("fullVersion"))

    def nav_header(self) -> None:
        """Rule 5: a top-level navigation that the agent package starts sends Sec-Fetch-Site: none."""
        tab = self.new_tab("about:blank")
        m = self.ctl.mark()
        self.cdp(tab, "Page.navigate", {"url": self.site("s1", "/p/hdr-navigate")})
        nav = self.ctl.wait(m, 10, kind="req", path="/p/hdr-navigate")
        self.ctl.wait(m, 10, kind="page", page_kind="page-load", page="/p/hdr-navigate")
        m1 = self.ctl.mark()
        self.cdp(tab, "Runtime.evaluate", {"expression": "location.href = '/p/hdr-script'", "userGesture": True})
        script = self.ctl.wait(m1, 10, kind="req", path="/p/hdr-script")
        self.ctl.wait(m1, 10, kind="page", page_kind="page-load", page="/p/hdr-script")
        m3 = self.ctl.mark()
        self.cdp(tab, "Page.navigate", {"url": self.site("off", "/p/hdr-off")})
        blocked = self.ctl.wait(m3, 10, kind="blocked", host="www.off.localhost")
        time.sleep(1.0)
        leaked = [e for e in self.ctl.events(m3) if e["kind"] == "req" and e["host"] == "www.off.localhost"]
        self.close_tab(tab)
        # Plain http to a host that is not localhost: Chrome sends no Sec-Fetch-*
        # header there, and rule 5 must add none.
        base = sorted(set(self.ctl(op="daemon_state")["allow"]))
        self.allow(base + ["plain.test"])
        plain_tab = self.new_tab("about:blank")
        m4 = self.ctl.mark()
        self.cdp(plain_tab, "Page.navigate", {"url": "http://www.plain.test:%d/p/hdr-plain" % self.port})
        plain = self.ctl.wait(m4, 10, kind="req", path="/p/hdr-plain")
        self.ctl.wait(m4, 10, kind="page", page_kind="page-load", page="/p/hdr-plain")
        self.cdp(plain_tab, "Runtime.evaluate", {"expression": "location.href = '/p/hdr-plain-script'", "userGesture": True})
        plain_script = self.ctl.wait(m4, 10, kind="req", path="/p/hdr-plain-script")
        self.close_tab(plain_tab)
        self.allow(base)
        fetch_meta = lambda e: [e.get(k) for k in ("site", "user", "dest", "mode")] if e else None  # noqa: E731
        self.r.add("plain http to a host that is not localhost: no Sec-Fetch-* header, also with rule 5",
                   bool(plain) and bool(plain_script) and fetch_meta(plain) == [None] * 4 and fetch_meta(plain_script) == [None] * 4,
                   "server request log: Sec-Fetch-Site, -User, -Dest, -Mode", navigate=fetch_meta(plain), script=fetch_meta(plain_script))
        hdr = lambda e: [e.get("site"), e.get("user")] if e else None  # noqa: E731
        self.r.add("a Page.navigate sends Sec-Fetch-Site none and ?1, as a typed URL (rule 5)", hdr(nav) == ["none", "?1"],
                   "server request log: Sec-Fetch-Site, Sec-Fetch-User", navigate=hdr(nav))
        self.r.add("a page script's navigation keeps its own Sec-Fetch-Site (rule 5 names the extension only)",
                   hdr(script) == ["same-origin", "?1"], "server request log", script=hdr(script))
        self.r.add("a Page.navigate to an off-list host is still blocked (rule 1 holds under rule 5)",
                   bool(blocked) and not leaked, "receiver blocked event; server log has no request for the host",
                   blocked=bool(blocked), requests=len(leaked))

    def frame_rule(self) -> None:
        """Rules 3 and 4: no frame, <object> or <embed> document loads in a tab whose top-level page is not on the list."""
        kinds = [h + "-" + t for h in ("off", "s1") for t in ("iframe", "object", "embed")]

        def frames(via: str, doc: str = "document") -> str:
            return ("for (const h of ['off', 's1']) for (const [t, a] of [['iframe', 'src'], ['object', 'data'], ['embed', 'src']]) {"
                    " const e = %s.createElement(t); e[a] = 'http://www.' + h + '.localhost:%d/f/%s-' + h + '-' + t;"
                    " %s.body.append(e); }") % (doc, self.port, via, doc)

        def loaded(m: int, via: str) -> list[str]:
            pre = "/f/%s-" % via
            return sorted(e["path"][len(pre):] for e in self.ctl.events(m) if e["kind"] == "req" and e["path"].startswith(pre))

        tab = self.new_tab("about:blank")
        m = self.ctl.mark()
        self.cdp(tab, "Runtime.evaluate", {"expression": frames("blank")})
        time.sleep(2.0)
        blank = loaded(m, "blank")
        self.cdp(tab, "Page.navigate", {"url": self.site("s1", "/p/frame-top")})
        self.ctl.wait(m, 10, kind="page", page_kind="page-load", page="/p/frame-top")
        m1 = self.ctl.mark()
        self.cdp(tab, "Runtime.evaluate", {"expression": frames("listed")})
        for k in kinds:
            self.ctl.wait(m1, 10, kind="req", path="/f/listed-" + k)
        listed = loaded(m1, "listed")
        # Measured, not a contract case: an about:blank popup of the allowlisted page.
        m2 = self.ctl.mark()
        self.cdp(tab, "Runtime.evaluate", {"expression": "(() => { const w = window.open(''); %s })()" % frames("popup", "w.document"),
                                           "userGesture": True})
        time.sleep(2.0)
        popup = loaded(m2, "popup")
        pop = self.ctl.wait(m2, 1, kind="bridge-ev", ev="tabs.onCreated")
        self.close_tab((pop or {}).get("tab"))
        self.close_tab(tab)
        self.agent.shot("frame-rule")
        self.r.add("no frame, <object> or <embed> loads under an about:blank top page, from any host (rules 3 and 4)", blank == [],
                   "server request log", requests=blank)
        self.r.add("frames, <object> and <embed> of an allowlisted top page load from any host (rule 4, O11)",
                   listed == sorted(kinds), "server request log", requests=listed, about_blank_popup=popup)

    def hold(self) -> None:
        """C10's hold of a new tab, measured: each kind of new tab, many times.

        The release comes DELAY s after tabs.onCreated. A trial's first
        document request is caught when it reaches the server after the
        release, and missed when it reaches the server before MISS_S after
        the event: it left before the hold's Fetch was on. A request between
        the two passed a hold that was on, and fails the case.
        """
        n = int(os.environ.get("HOLD_TRIALS", "10"))
        delay, miss_s = 1.0, 0.1
        m0 = self.ctl.mark()
        opener = self.new_tab(self.site("s1", "/p/hold-opener"))
        # The opener's page and its tabs.onCreated come before the eager attach goes on, so that no
        # event of the opener counts as the event of a trial.
        self.ctl.wait(m0, 10, kind="page", page_kind="page-load", page="/p/hold-opener")
        time.sleep(1.0)
        on = self.bridge("bridge.attachNew", True)
        evaluate = lambda js: self.cdp(opener, "Runtime.evaluate", {"expression": js, "userGesture": True})  # noqa: E731
        ways = {
            "about:blank, then Page.navigate": lambda url: self.bridge("tabs.create", {"url": "about:blank", "active": True}, SCOPE),
            "window.open": lambda url: evaluate("void window.open(%s)" % json.dumps(url)),
            "link _blank": lambda url: evaluate("(() => { const a = document.createElement('a'); a.href = %s; a.target = '_blank'; "
                                                "document.body.append(a); a.click(); a.remove(); })()" % json.dumps(url)),
        }

        def trial(way: str, name: str, release: bool = True, client: bool = False, redirect: bool = False,
                  frame: bool = False) -> dict:
            final = ("/pf/" if frame else "/p/") + name
            first = "/redirect" if redirect else final
            url = self.site("s1", "/redirect?to=" + final if redirect else final)
            m = self.ctl.mark()
            t0 = time.time()
            ways[way](url)
            ev = self.ctl.wait(m, 10, kind="bridge-ev", ev="tabs.onCreated") or {}
            tab = ev.get("tab")
            if way.startswith("about:blank"):
                # A client's navigation before its runIfWaitingForDebugger: Page.navigate
                # answers only after the request, so it goes in its own thread.
                threading.Thread(target=self.cdp, args=(tab, "Page.navigate", {"url": url}), daemon=True).start()
            time.sleep(delay)
            if client:
                self.cdp(tab, "Fetch.enable", {"patterns": [{"urlPattern": "*", "resourceType": "Document"}]})
            t_rel = time.time()
            if release:
                self.bridge("bridge.release", tab)
            forwarded = None
            if client:
                forwarded = self.ctl.wait(m, 2, kind="bridge-ev", ev="debugger.onEvent", method="Fetch.requestPaused", tab=tab)
                if forwarded:
                    time.sleep(0.5)
                    t_rel = time.time()  # the client's continue is the release here
                    self.cdp(tab, "Fetch.continueRequest", {"requestId": forwarded["request_id"]})
            req = self.ctl.wait(m, 10, kind="req", path=first)
            page = self.ctl.wait(m, 10, kind="page", page_kind="page-load", page=final)
            framed = self.ctl.wait(m, 10, kind="req", path="/f/" + name) if frame else None
            evs = self.ctl.events(m)
            pauses = [e for e in evs if e["kind"] == "bridge-ev" and e.get("method") == "Fetch.requestPaused"]
            at = req["ts"] - ev["ts"] if req and ev else None
            row = {"way": way, "attached": ev.get("attached"), "held": ev.get("held"), "error": ev.get("error"),
                   "event_ms": round((ev["ts"] - t0) * 1000) if ev else None,
                   "event_to_req_ms": round(at * 1000) if at is not None else None,
                   "caught": bool(req) and req["ts"] >= t_rel, "missed": at is not None and at < miss_s,
                   "release_to_req_ms": round((req["ts"] - t_rel) * 1000) if req else None,
                   "loaded": bool(page), "relay_pauses": [e.get("path") for e in pauses],
                   "forwarded": (forwarded or {}).get("path"),
                   "frame_before_release": bool(framed) and framed["ts"] < t_rel if frame else None}
            if client:
                self.cdp(tab, "Fetch.disable")
            self.close_tab(tab)
            time.sleep(0.3)
            return row

        rows = [trial(way, "hold-%d-%d" % (w, i)) for i in range(n) for w, way in enumerate(ways)]
        fallback = [trial("window.open", "hold-max-%d" % i, release=False) for i in range(5)]
        fallback += [trial("about:blank, then Page.navigate", "hold-max-blank-%d" % i, release=False) for i in range(2)]
        client = [trial("window.open", "hold-client-%d" % i, client=True) for i in range(5)]
        redirect = [trial("window.open", "hold-redirect-%d" % i, redirect=True) for i in range(5)]
        framed = [trial("about:blank, then Page.navigate", "hold-frame-%d" % i, frame=True) for i in range(3)]
        self.bridge("bridge.attachNew", False)
        off = [trial("window.open", "hold-off-%d" % i, release=False) for i in range(3)]
        self.close_tab(opener)
        with open(os.path.join(self.run, "hold.json"), "w", encoding="utf-8") as f:
            json.dump({"rows": rows, "fallback": fallback, "client": client, "redirect": redirect, "framed": framed, "off": off},
                      f, indent=1)

        def stats(xs: list) -> list:
            xs = sorted(x for x in xs if x is not None)
            return [xs[0], xs[len(xs) // 2], xs[-1]] if xs else []

        def sound(r: dict) -> bool:  # caught or missed, never passed through a hold that was on
            return (r["caught"] or r["missed"]) and r["loaded"]

        caught = {way: "%d of %d" % (sum(1 for r in rows if r["way"] == way and r["caught"]), n) for way in ways}
        self.r.add("bridge.attachNew [true] answers null", on.get("ok") is True and on.get("data") is None, "bridge answer")
        self.r.add("eager attach: each new tab is attached and held (tabs.onCreated)",
                   all(r["attached"] is True and r["held"] is True for r in rows), "bridge tabs.onCreated events",
                   event_ms_min_median_max={way: stats([r["event_ms"] for r in rows if r["way"] == way]) for way in ways})
        self.r.add("the hold keeps a first document request that starts after it until bridge.release; the page then loads",
                   all(sound(r) and not r["relay_pauses"] for r in rows)
                   and all(r["caught"] for r in rows if r["way"].startswith("about:blank")),
                   "server request time against tabs.onCreated and the release; page log; no hold event reached the relay",
                   caught=caught, release_to_req_ms=stats([r["release_to_req_ms"] for r in rows if r["caught"]]))
        self.r.add("HOLD_MAX_MS: a hold with no release ends after 5 s", all(
                   r["missed"] or (r["event_to_req_ms"] is not None and 4700 <= r["event_to_req_ms"] <= 5800 and r["loaded"])
                   for r in fallback) and any(not r["missed"] for r in fallback),
                   "server request time against tabs.onCreated", event_to_req_ms=[r["event_to_req_ms"] for r in fallback])
        self.r.add("a client's Fetch.enable during the hold: the held request's Fetch.requestPaused reaches the relay, "
                   "and the client continues it", all(sound(r) and (r["missed"] or r["forwarded"] == "/p/" + "hold-client-%d" % i)
                                                      for i, r in enumerate(client)) and any(r["forwarded"] for r in client),
                   "bridge debugger.onEvent; server request time against the client's continue",
                   forwarded=[r["forwarded"] for r in client], release_to_req_ms=[r["release_to_req_ms"] for r in client])
        self.r.add("a held request that redirects loads after the release", all(sound(r) for r in redirect)
                   and any(r["caught"] for r in redirect), "server request time; page log",
                   release_to_req_ms=[r["release_to_req_ms"] for r in redirect])
        self.r.add("a page with a frame, held at its first request, loads with its frame after the release",
                   all(r["caught"] and r["loaded"] and r["frame_before_release"] is False for r in framed),
                   "the page's and the frame's request time at the server against the release",
                   frame_before_release=[r["frame_before_release"] for r in framed], caught=[r["caught"] for r in framed])
        self.r.add("bridge.attachNew [false]: a new tab is neither attached nor held", all(
                   r["attached"] is False and r["held"] is False and r["loaded"] for r in off),
                   "bridge tabs.onCreated events", event_to_req_ms=[r["event_to_req_ms"] for r in off])

    def hold_import(self) -> None:
        """The eager attach never attaches the import's restore tab (C10)."""
        self.bridge("bridge.attachNew", True)
        state = {"v": 1, "domain": "s1.localhost", "origin": "http://www.s1.localhost:%d" % self.port,
                 "url": self.site("s1", "/p/after-import"), "cookies": [],
                 "storage": {"local": {"made_up": "1"}, "session": {}, "idb": [], "caches": []}}
        m = self.ctl.mark()
        res = self.ctl(op="import", state=state)
        self.ctl.wait(m, 10, kind="page", page_kind="page-load", page="/p/after-import")
        time.sleep(1.0)
        evs = self.ctl.events(m)
        created = [e for e in evs if e["kind"] == "bridge-ev" and e["ev"] == "tabs.onCreated"]
        restore = [e for e in created if e.get("active")]
        rtab = restore[0]["tab"] if restore else None
        onev = [e for e in evs if e["kind"] == "bridge-ev" and e["ev"] == "debugger.onEvent" and e.get("tab") == rtab]
        self.bridge("bridge.attachNew", False)
        for e in created:
            if e.get("held"):
                self.bridge("bridge.release", e["tab"])
        counts = res.get("data") or {}
        self.r.add("an import with the eager attach on: the restore tab is neither attached nor held, and the import succeeds",
                   res.get("ok") is True and counts.get("local") == 1 and len(restore) == 1 and restore[0].get("attached") is False
                   and restore[0].get("held") is False and not onev,
                   "import answer; bridge tabs.onCreated events; no debugger event of the restore tab reached the relay",
                   import_ok=res.get("ok"), error=res.get("error"), local=counts.get("local"),
                   created=[[e.get("tab"), e.get("active"), e.get("attached"), e.get("held")] for e in created],
                   restore_debugger_events=len(onev))


CASES = ["link", "stub_refusals", "static_block", "agent_old_state", "add_box", "operator_setup", "popup_before_login",
         "box_login", "send_s1", "nav_cases", "allowlist_change", "service_worker", "sw_removed", "big30", "big33",
         "bridge_info", "nav_header", "frame_rule", "hold", "hold_import"]


def main() -> int:
    run = sys.argv[1]
    names = sys.argv[2:] or CASES
    live = Live(run)
    for name in names:
        print("== " + name, flush=True)
        if name != "link":
            live.agent_tab()
        if name.startswith("big"):
            live.big(int(name[3:]))
        else:
            getattr(live, name)()
    failed = [r for r in live.r.rows if r["result"] != "pass"]
    print("%d checks, %d failed" % (len(live.r.rows), len(failed)), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
