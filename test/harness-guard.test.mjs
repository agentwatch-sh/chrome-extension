// The live harnesses' guard (board ab-v16.78; test/live/harness_guard.py, the same file as agent-browser's): stand-in
// drivers start the guard as run.sh (a shell, its pid files) and workers.py (Python, start_guard) do, then stand-in
// processes (an "Xvfb", a "Chromium" with a child, a "server"). After a kill -9 of the driver, ps must find none of
// them within GONE_MS. A second harness waits for the lock until the first harness's processes are gone; its wait has a
// limit; a run of `run.sh up` alone ends at `down` (a SIGTERM to its guard) or at its limit. Each test has a lock file
// of its own (HARNESS_LOCK), never the real one. Linux only (the guard is).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = fileURLToPath(new URL("./live/", import.meta.url));
const GUARD = join(LIVE, "harness_guard.py");
/** The time that ps may still show a process of the harness after the driver's kill -9. */
const GONE_MS = 10_000;
const skip = process.platform !== "linux" ? "the guard is Linux only" : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** run.sh's form: the guard with --driver $$ and --pid-dir, then the stand-ins with a pid file each. */
const SHELL_DRIVER = `#!/bin/sh
set -eu
# GUARD_ARGS: run.sh's up alone (--driver 0 --limit N); else the script is the driver, as in run.sh's all mode.
if [ -n "\${GUARD_ARGS:-}" ]; then set -- $GUARD_ARGS; else set -- --driver $$; fi
answer=$(python3 -I -B "${GUARD}" --name "$NAME" "$@" --pid-dir "$RUN/pids") || true
case "$answer" in locked\\ * | nested\\ *) ;; *) echo "$answer" >&2; exit 2 ;; esac
echo "$answer" | cut -d' ' -f2 > "$RUN/guard.pid"
sleep 600 & echo $! > "$RUN/pids/xvfb"
sh -c 'sleep 600 & exec sleep 601' & echo $! > "$RUN/pids/chromium"
sleep 602 & echo $! > "$RUN/pids/server"
sleep 1.5
echo ready
wait
`;

/** workers.py's form: start_guard(), then the stand-ins through subprocess, each given to track(). */
const PY_DRIVER = `
import os, subprocess, sys, time, json
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(LIVE)})
from harness_guard import start_guard
t0 = time.time()
g = start_guard(os.environ["NAME"])
waited = time.time() - t0
x = subprocess.Popen(["sleep", "600"]); g.track(x.pid, "Xvfb")
c = subprocess.Popen(["sh", "-c", "sleep 600 & exec sleep 601"], start_new_session=True); g.track(c.pid, "Chromium")
s = subprocess.Popen(["sleep", "602"])
time.sleep(1.5)
print(json.dumps({"guard": g.pid, "mode": g.mode, "waitedMs": int(waited * 1000), "pids": [x.pid, c.pid, s.pid]}), flush=True)
time.sleep(600)
`;

const own = [];
function start(kind, dir, name, env = {}) {
  const run = join(dir, name);
  mkdirSync(join(run, "pids"), { recursive: true });
  const file = join(dir, kind === "sh" ? "driver.sh" : "driver.py");
  writeFileSync(file, kind === "sh" ? SHELL_DRIVER : PY_DRIVER, { mode: 0o755 });
  const child = spawn(kind === "sh" ? "/bin/sh" : "python3", [file], {
    env: { ...process.env, HARNESS_LOCK: join(dir, "harness.lock"), HARNESS_GUARD_HELD: "", NAME: name, RUN: run, GUARD_ARGS: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  own.push(child.pid);
  let out = "", err = "";
  child.stderr.on("data", (b) => { err += b; });
  const ready = new Promise((resolve) => child.stdout.on("data", (b) => {
    out += b;
    const line = out.split("\n").find((l) => l === "ready" || l.startsWith("{"));
    if (line) resolve(line === "ready" ? { pids: ["xvfb", "chromium", "server"].map((n) => Number(readFileSync(join(run, "pids", n), "utf8"))), guard: Number(readFileSync(join(run, "guard.pid"), "utf8")) } : JSON.parse(line));
  }));
  const exited = new Promise((r) => child.once("exit", (c) => r(c)));
  return { child, run, ready, exited, stderr: () => err };
}

/** The pids of `pids` that ps still shows, with their children (a zombie has ended). */
function running(pids) {
  const ps = execFileSync("ps", ["-e", "-o", "pid=,ppid=,stat="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/));
  const all = new Set(pids);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of ps) if (all.has(Number(ppid)) && !all.has(Number(pid))) { all.add(Number(pid)); grew = true; }
  }
  return ps.filter(([pid, , stat]) => all.has(Number(pid)) && !stat.startsWith("Z")).map(([pid]) => Number(pid));
}
async function goneWithin(pids, ms) {
  const t0 = Date.now();
  let left = running(pids);
  while (left.length && Date.now() - t0 < ms) { await sleep(100); left = running(pids); }
  return left;
}
/** True when `log()` matches `re` within `ms`: the guard's last lines can reach the pipe just before it ends. */
async function logged(log, re, ms = 3000) {
  const t0 = Date.now();
  while (!re.test(log()) && Date.now() - t0 < ms) await sleep(50);
  return re.test(log());
}
/** The test's own cleanup: only its stand-in drivers and the pids that they reported. */
function stopOwn(pids) { for (const p of running([...own.splice(0), ...pids])) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } }

for (const kind of ["sh", "py"]) {
  const form = kind === "sh" ? "run.sh's form (a shell driver, pid files)" : "workers.py's form (start_guard, track)";
  test(`${form}: after a kill -9 of the driver, ps finds no process of the harness within 10 s, and the lock is free`, { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-guard-"));
    const pids = [];
    try {
      const d = start(kind, dir, "kill9");
      const i = await d.ready;
      pids.push(...i.pids, i.guard);
      assert.ok(running(i.pids).length >= 4, "the stand-ins run (the Chromium with its child)");
      d.child.kill("SIGKILL");
      assert.deepEqual(await goneWithin(i.pids, GONE_MS), [], `left after the driver's kill -9; guard's log: ${d.stderr()}`);
      assert.ok(await logged(d.stderr, /harness-guard: kill9: the driver \d+ (ended \(its pipe closed\)|is gone); it stops \d+ processes of the harness: .*xvfb \d+/i), d.stderr());
      assert.deepEqual(await goneWithin([i.guard], 3000), [], "the guard ended");
      const next = start("py", dir, "next");
      const j = await next.ready;
      pids.push(...j.pids, j.guard);
      assert.equal(j.mode, "locked");
      assert.doesNotMatch(next.stderr(), /waits for the harness lock/);
      next.child.kill("SIGKILL");
      assert.deepEqual(await goneWithin([...j.pids, j.guard], GONE_MS), []);
    } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("a second harness waits for the lock, with a log line, until the first harness's processes are gone; the wait has a limit", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-guard-"));
  const pids = [];
  try {
    const a = start("sh", dir, "first");
    const i = await a.ready;
    pids.push(...i.pids, i.guard);
    // The limit: one second, then exit 2, and nothing started.
    const late = start("py", dir, "late", { HARNESS_LOCK_WAIT: "1" });
    assert.equal(await Promise.race([late.exited, sleep(15_000).then(() => "still running after 15 s")]), 2);
    assert.ok(await logged(late.stderr, /late: the harness lock .*harness\.lock is still held after 1 s \(guard=\d+ driver=\d+ name=first since=\S+\); the harness starts nothing/), late.stderr());
    // The wait: a log line, nothing started until the first harness's processes are gone.
    const b = start("py", dir, "second", { HARNESS_LOCK_WAIT: "30" });
    let started = 0;
    void b.ready.then((j) => { started = Date.now(); pids.push(...j.pids, j.guard); });
    await sleep(2500);
    assert.equal(started, 0, "the second harness started nothing while the first one ran");
    assert.ok(await logged(b.stderr, /harness-guard: second: waits for the harness lock .*harness\.lock \(guard=\d+ driver=\d+ name=first since=\S+\); it waits at most 30 s \(HARNESS_LOCK_WAIT\)/), b.stderr());
    a.child.kill("SIGKILL");
    const j = await b.ready;
    assert.deepEqual(running(i.pids), [], "the first harness's processes are gone");
    assert.ok(await logged(b.stderr, /harness-guard: second: has the harness lock after \d+ s/), b.stderr());
    b.child.kill("SIGKILL");
    assert.deepEqual(await goneWithin([...j.pids, j.guard], GONE_MS), []);
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("run.sh up alone: the run lives after its script, and ends at down (a SIGTERM to its guard) or at LIVE_UP_LIMIT", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-guard-"));
  const pids = [];
  try {
    // down: the script ends at once (as `up` does), the run stays, and a SIGTERM to its guard ends the run.
    const u = start("sh", dir, "up", { GUARD_ARGS: "--driver 0 --limit 60" });
    const i = await u.ready;
    pids.push(...i.pids, i.guard);
    u.child.kill("SIGKILL");
    await sleep(1500);
    assert.equal(running(i.pids).length >= 4, true, "the run of up stays after its script");
    process.kill(i.guard, "SIGTERM");
    assert.deepEqual(await goneWithin([...i.pids, i.guard], GONE_MS), [], u.stderr());
    assert.ok(await logged(u.stderr, /harness-guard: up: the guard got SIGTERM; it stops \d+ processes of the harness/), u.stderr());
    // The limit: the run ends by itself.
    const l = start("sh", dir, "limit", { GUARD_ARGS: "--driver 0 --limit 3" });
    const j = await l.ready;
    pids.push(...j.pids, j.guard);
    l.child.kill("SIGKILL");
    assert.deepEqual(await goneWithin([...j.pids, j.guard], 3000 + GONE_MS), [], l.stderr());
    assert.ok(await logged(l.stderr, /harness-guard: limit: the run reached its limit of 3 s; it stops/), l.stderr());
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("run.sh and workers.py take the harness guard before their Xvfb, and give it each process that they start", () => {
  const sh = readFileSync(join(LIVE, "run.sh"), "utf8");
  const up = sh.slice(sh.indexOf("\nup() {"), sh.indexOf("\ndown() {"));
  assert.ok(up.indexOf("harness_guard.py") > 0 && up.indexOf("harness_guard.py") < up.indexOf("start_xvfb "), "run.sh: the guard before start_xvfb");
  assert.match(up, /--pid-dir "\$run\/pids"/);
  assert.match(sh, /echo \$! >"\$1\/pids\/xvfb\.\$2"/);
  assert.match(sh, /echo \$! >"\$run\/pids\/chromium-\$name"/);
  assert.match(sh, /all\)\n\s+run=\$\(up all\)/, "the all mode's driver is the script");
  const py = readFileSync(join(LIVE, "workers.py"), "utf8");
  const st = py.slice(py.indexOf("\ndef start():"), py.indexOf("\ndef stop():"));
  assert.ok(st.indexOf("start_guard(") > 0 && st.indexOf("start_guard(") < st.indexOf('subprocess.Popen(["Xvfb"'), "workers.py: the guard before its Xvfb");
  assert.match(st, /GUARD\.track\(xvfb\.pid, "Xvfb"\)/);
  assert.match(st, /GUARD\.track\(chrome\.pid, "Chromium"\)/);
});
