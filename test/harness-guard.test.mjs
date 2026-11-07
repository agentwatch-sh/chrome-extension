// The live harnesses' guard (board ab-v16.78; test/live/harness_guard.py, the same file as agent-browser's): stand-in
// drivers start the guard as run.sh (a shell, its pid files) and workers.py (Python, start_guard) do, then stand-in
// processes (an "Xvfb", a "Chromium" with a child, a "server"). After a kill -9 of the driver, ps must find none of
// them within GONE_MS. A second harness waits for the lock until the first harness's processes are gone; its wait has a
// limit; a run of `run.sh up` alone ends at `down` (a SIGTERM to its guard) or at its limit. Each test has a lock file
// of its own (HARNESS_LOCK), never the real one. Linux only (the guard is).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
answer=$(python3 -I -B "${GUARD}" --name "$NAME" "$@" --pid-dir "$RUN/pids" --log "$RUN/guard.log") || true
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
  // The pid-file form's guard writes its lines after the lock into the run's log (run.sh: <run>/logs/guard.log).
  const log = () => { try { return readFileSync(join(run, "guard.log"), "utf8"); } catch { return ""; } };
  return { child, run, ready, exited, stderr: () => err + log() };
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

const RUN_SH = join(LIVE, "run.sh");

test("run.sh never takes a reserved display (0, 90, 147, 190-192), whatever LIVE_DISPLAY is: run.sh displays", { skip }, () => {
  const sh = readFileSync(RUN_SH, "utf8");
  const py = readFileSync(GUARD, "utf8");
  const list = (src, re) => (re.exec(src)?.[1] ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
  assert.deepEqual(list(sh, /^RESERVED_DISPLAYS="([^"]*)"/m), list(py, /^RESERVED_DISPLAYS = \(([^)]*)\)/m), "run.sh keeps harness_guard.py's list");
  const reserved = list(py, /^RESERVED_DISPLAYS = \(([^)]*)\)/m);
  assert.deepEqual(reserved, [0, 90, 147, 190, 191, 192]);
  const taken = (env) => spawnSync("/bin/sh", [RUN_SH, "displays"], { env: { ...process.env, ...env }, encoding: "utf8" });
  for (const from of ["0", "89", "90", "146", "147", "", "abc", "089"]) {
    const r = taken(from === "" ? {} : { LIVE_DISPLAY: from });
    assert.equal(r.status, 0, r.stderr);
    const [a, o] = r.stdout.trim().split(" ").map(Number);
    for (const d of [a, o]) assert.ok(d >= 1 && d <= 189 && !reserved.includes(d), `LIVE_DISPLAY=${from}: :${d}`);
    assert.ok(o > a);
    if (/^\d+$/.test(from) && Number(from) >= 1) assert.ok(a >= Number(from), `LIVE_DISPLAY=${from}: from it on (:${a})`);
  }
  // Past 189 there is no display: 190-192 are reserved too.
  assert.notEqual(taken({ LIVE_DISPLAY: "189" }).status, 0);
});

/** A run folder of run.sh up alone: its live guard (the pid-file form, no driver) and one stand-in process. */
async function upRun(dir, name) {
  const run = join(dir, name);
  mkdirSync(join(run, "pids"), { recursive: true });
  mkdirSync(join(run, "logs"));
  const answer = execFileSync("python3", ["-I", "-B", GUARD, "--name", name, "--driver", "0", "--limit", "60", "--pid-dir", join(run, "pids"), "--log", join(run, "logs/guard.log")],
    { env: { ...process.env, HARNESS_LOCK: join(dir, "harness.lock") }, encoding: "utf8" }).trim();
  const guard = Number(answer.split(" ")[1]);
  writeFileSync(join(run, "guard.pid"), `${guard}\n`);
  const x = spawn("sleep", ["604"], { stdio: "ignore", detached: true });
  x.unref();
  writeFileSync(join(run, "pids/xvfb.160"), `${x.pid}\n`);
  await sleep(1200); // the guard reads the pid folder every 0.5 s
  return { run, guard, pid: x.pid };
}

test("run.sh down stops the run only through its live guard, and signals nothing when the guard is gone (a pid file can name a reused pid)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-guard-"));
  const pids = [];
  try {
    // A live guard: down sends it SIGTERM and waits; the guard stops the run's process.
    const u = await upRun(dir, "live");
    pids.push(u.guard, u.pid);
    // The up-alone guard keeps no pipe of its caller (its stderr is the run's log) and no inherited fd.
    assert.equal(readlinkSync(`/proc/${u.guard}/fd/2`), join(u.run, "logs/guard.log"));
    const r = spawnSync("/bin/sh", [RUN_SH, "down", u.run], { encoding: "utf8", timeout: 40_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`run\\.sh: stopped the processes of ${u.run} \\(through its guard ${u.guard}\\)`));
    assert.deepEqual(running([u.pid, u.guard]), [], "down returned after the guard and the run's process were gone");
    assert.match(readFileSync(join(u.run, "logs/guard.log"), "utf8"), /the guard got SIGTERM; it stops 1 processes of the harness: xvfb\.160 \d+/);
    // The guard is gone (it stopped the run at its limit, say), and a pid file now names another process: down
    // must signal nothing.
    const stale = join(dir, "stale");
    mkdirSync(join(stale, "pids"), { recursive: true });
    const other = spawn("sleep", ["605"], { stdio: "ignore", detached: true });
    other.unref();
    pids.push(other.pid);
    writeFileSync(join(stale, "pids/chromium-agent"), `${other.pid}\n`);
    writeFileSync(join(stale, "guard.pid"), `${u.guard}\n`);
    const s2 = spawnSync("/bin/sh", [RUN_SH, "down", stale], { encoding: "utf8", timeout: 40_000 });
    assert.equal(s2.status, 0, s2.stderr);
    assert.match(s2.stderr, new RegExp(`run\\.sh: the guard already stopped the run ${stale}: down signals nothing`));
    await sleep(500);
    assert.deepEqual(running([other.pid]), [other.pid], "the process that a stale pid file names still runs");
    // No guard.pid at all: nothing started, nothing to signal.
    const none = join(dir, "none");
    mkdirSync(join(none, "pids"), { recursive: true });
    writeFileSync(join(none, "pids/server"), `${other.pid}\n`);
    assert.match(spawnSync("/bin/sh", [RUN_SH, "down", none], { encoding: "utf8" }).stderr, /has no guard\.pid .*: down signals nothing/);
    assert.deepEqual(running([other.pid]), [other.pid]);
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

test("a record whose pid another process took since (another start time) gets no signal; a record with its own start time does", { skip }, () => {
  const r = spawnSync("python3", ["-I", "-B", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(LIVE)})
import argparse, subprocess, harness_guard as h
a = argparse.Namespace(name="stale", driver=0, pid_dir=None, channel_fd=0, limit=0, wait=1)
for start_delta in (1, 0):
    p = subprocess.Popen(["sleep", "30"])
    g = h.Guard(a)
    g.rec[p.pid] = [h.stat_of(p.pid)[1] + start_delta, "x", None]  # no pidfd: the start-time check alone
    g.reason = "the test"
    g.stop()
    print("alive" if p.poll() is None else "stopped")
    p.kill(); p.wait()
`], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["alive", "stopped"], r.stderr);
});
