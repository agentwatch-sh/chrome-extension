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
import time
import urllib.error
import urllib.request

# The page area starts below the tab strip and the toolbar (Chromium 156,
# 1280x900 window at 0,0, no window manager).
PAGE_TOP = 87


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
        self.ctl = Ctl(os.path.join(run, "ctl.sock"))
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

    # -- the cases

    def link(self) -> None:
        ok = self.ctl(op="wait_hello", timeout=60).get("ok")
        st = self.ctl(op="daemon_state")
        self.r.add("receiver links up and says hello", bool(ok), "stub daemon socket: link event, then hello",
                   version=st.get("hello"))
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
        self.r.add("set_allowlist [s1.localhost]", a.get("ok") is True and (a.get("data") or {}).get("rules") == 1,
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
        self.r.add("set_allowlist with the same list closes tabs left on blocked pages", a0.get("ok") is True,
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


CASES = ["link", "stub_refusals", "static_block", "agent_old_state", "add_box", "operator_setup", "popup_before_login",
         "box_login", "send_s1", "nav_cases", "allowlist_change", "service_worker", "big30", "big33"]


def main() -> int:
    run = sys.argv[1]
    names = sys.argv[2:] or CASES
    live = Live(run)
    for name in names:
        print("== " + name, flush=True)
        if name.startswith("big"):
            live.big(int(name[3:]))
        else:
            getattr(live, name)()
    failed = [r for r in live.r.rows if r["result"] != "pass"]
    print("%d checks, %d failed" % (len(live.r.rows), len(failed)), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
