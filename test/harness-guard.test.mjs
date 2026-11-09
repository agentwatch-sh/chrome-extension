// The live harnesses' guard (board ab-v16.78; test/live/harness_guard.py, the same file as agent-browser's): stand-in
// drivers start the guard as run.sh (a shell, its pid files) and workers.py (Python, start_guard) do, then stand-in
// processes (an "Xvfb", a "Chromium" with a child, a "server"). After a kill -9 of the driver, ps must find none of
// them within GONE_MS. A second harness waits for the lock until the first harness's processes are gone; its wait has a
// limit; a run of `run.sh up` alone ends at `down` (a SIGTERM to its guard) or at its limit. Each test has a lock file
// of its own (HARNESS_LOCK), never the real one. Linux only (the guard is).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
async function upRun(dir, name, pidDir = "pids") {
  const run = join(dir, name);
  mkdirSync(join(run, pidDir), { recursive: true });
  mkdirSync(join(run, "logs"), { recursive: true });
  const answer = execFileSync("python3", ["-I", "-B", GUARD, "--name", name, "--driver", "0", "--limit", "60", "--pid-dir", join(run, pidDir), "--log", join(run, "logs/guard.log")],
    { env: { ...process.env, HARNESS_LOCK: join(dir, "harness.lock") }, encoding: "utf8" }).trim();
  const guard = Number(answer.split(" ")[1]);
  writeFileSync(join(run, "guard.pid"), `${guard}\n`);
  const x = spawn("sleep", ["604"], { stdio: "ignore", detached: true });
  x.unref();
  writeFileSync(join(run, pidDir, "xvfb.160"), `${x.pid}\n`);
  await sleep(1200); // the guard reads the pid folder every 0.5 s
  return { run, guard, pid: x.pid };
}

test("run.sh down stops the run only through its live guard, and signals nothing when the guard is gone (a pid file can name a reused pid)", { skip }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ce-guard-")));
  const pids = [];
  try {
    // A live guard: down sends it SIGTERM and waits; the guard stops the run's process.
    const u = await upRun(dir, "live");
    pids.push(u.guard, u.pid);
    // The up-alone guard keeps no pipe of its caller (its stderr is the run's log) and no inherited fd.
    assert.equal(readlinkSync(`/proc/${u.guard}/fd/2`), join(u.run, "logs/guard.log"));
    // CDPATH offers a different folder with the same name. down must use the caller's relative run.
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(join(elsewhere, "live"), { recursive: true });
    writeFileSync(join(elsewhere, "live/guard.pid"), `${u.guard}\n`);
    // A relative path with a trailing / names the same run: down finds its live guard.
    const r = spawnSync("/bin/sh", [RUN_SH, "down", "live/"], { cwd: dir, env: { ...process.env, CDPATH: elsewhere }, encoding: "utf8", timeout: 40_000 });
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
    // guard.pid names the live guard of another run whose pid folder only starts with this run's (<run>/pids2): the
    // argv must match as whole fields, so down signals nothing, and that guard still runs.
    const b = await upRun(dir, "prefix", "pids2");
    pids.push(b.guard, b.pid);
    const s3 = spawnSync("/bin/sh", [RUN_SH, "down", b.run], { encoding: "utf8", timeout: 40_000 });
    assert.match(s3.stderr, /the guard already stopped the run .*prefix: down signals nothing/);
    assert.deepEqual(running([b.guard, b.pid]).sort(), [b.guard, b.pid].sort(), "the other run's guard and process still run");
    process.kill(b.guard, "SIGTERM");
    assert.deepEqual(await goneWithin([b.guard, b.pid], GONE_MS), []);
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});

/** run.sh all's end (board ab-v16.89): the script is the guard's driver, the live run fails (exit 1, as 74 of 75
 *  checks), and the EXIT trap runs run.sh's own down in the driver. The run's processes: an "Xvfb" (a pid file), a
 *  process that only the guard's records of the driver's tree name, and a "Chromium" (a pid file) with a helper; at its
 *  SIGTERM the Chromium starts one more child, which only the guard's look at the children of recorded processes
 *  finds. down's sleep 0.1 lasts 1 s here, longer than the guard's 0.5 s poll, so the guard's next look at the
 *  driver's tree after the SIGTERM surely finds it. */
function allModeEnd(down) {
  return `#!/bin/sh
set -eu
answer=$(python3 -I -B "${GUARD}" --name "$NAME" --driver $$ --pid-dir "$RUN/pids" --log "$RUN/guard.log") || true
case "$answer" in locked\\ * | nested\\ *) ;; *) echo "$answer" >&2; exit 2 ;; esac
echo "$answer" | cut -d' ' -f2 > "$RUN/guard.pid"
sleep 609 & echo $! > "$RUN/pids/xvfb"
sleep 610 & echo $! > "$RUN/tree"
sh -c 'trap "sleep 611 & echo \\$! > \\"\\$RUN/late\\"; wait" TERM; sleep 608 & echo $! > "$RUN/helper"; wait' & echo $! > "$RUN/pids/chromium"
${down}
sleep() { if [ "$1" = 0.1 ]; then command sleep 1; else command sleep "$@"; fi; }
trap 'down "$RUN"' EXIT
sleep 1.5
exit 1
`;
}

test("run.sh all's down in the driver's EXIT trap keeps the live run's own exit code: the guard stops the run, and no process of down", { skip }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ce-guard-")));
  const run = join(dir, "all");
  const pids = [];
  const pidOf = (file) => { try { return Number(readFileSync(join(run, file), "utf8")); } catch { return 0; } };
  try {
    mkdirSync(join(run, "pids"), { recursive: true });
    const sh = readFileSync(RUN_SH, "utf8");
    const down = `${/^say\(\) \{.*\}$/m.exec(sh)[0]}\n${sh.slice(sh.indexOf("\nguard_of() {"), sh.indexOf('\ncase "${1:-all}" in'))}`;
    assert.match(down, /\ndown\(\) \{[^]*sleep 0\.1\n/, "run.sh's down, with its sleep 0.1");
    writeFileSync(join(dir, "driver.sh"), allModeEnd(down), { mode: 0o755 });
    const child = spawn("/bin/sh", [join(dir, "driver.sh")], {
      env: { ...process.env, HARNESS_LOCK: join(dir, "harness.lock"), HARNESS_GUARD_HELD: "", NAME: "all", RUN: run },
      stdio: ["ignore", "ignore", "pipe"],
    });
    own.push(child.pid);
    let err = "";
    child.stderr.on("data", (b) => { err += b; });
    const code = await Promise.race([new Promise((r) => child.once("exit", (c, s) => r(c ?? s))), new Promise((r) => setTimeout(r, 40_000, "still running after 40 s").unref())]);
    const [guard, xvfb, tree, chromium, helper, late] = ["guard.pid", "pids/xvfb", "tree", "pids/chromium", "helper", "late"].map(pidOf);
    const all = [guard, xvfb, tree, chromium, helper, late].filter(Boolean);
    pids.push(...all);
    const log = () => { try { return readFileSync(join(run, "guard.log"), "utf8"); } catch { return ""; } };
    assert.equal(code, 1, `the live run's own exit code, not 143 of a killed sleep of down: ${err}${log()}`);
    assert.match(err, new RegExp(`run\\.sh: stopped the processes of ${run} \\(through its guard ${guard}\\)`));
    assert.deepEqual(running(all), [], `down returned after the guard and every process of the run were gone: ${log()}`);
    assert.ok(late > 0, "the Chromium started its late child at its SIGTERM");
    const stopped = /the guard got SIGTERM; it stops (\d+) processes of the harness: (.*)/.exec(log());
    assert.ok(stopped, log());
    assert.deepEqual([stopped[1], stopped[2].split(", ").map((x) => Number(x.split(" ")[1])).sort()], ["4", [xvfb, tree, chromium, helper].sort()], `only the run's processes: ${log()}`);
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

test("workers.py refuses a reserved DISPLAY_N before it makes its run folder", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-guard-"));
  try {
    // Stand-ins first on PATH and CHROMIUM=/bin/false: if the refusal let the display through, the run would start
    // only this fake Xvfb (it notes its call) and no Chromium, never a real Xvfb on the reserved display.
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/Xvfb"), `#!/bin/sh\necho "$*" >> "${join(dir, "xvfb.calls")}"\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(dir, "bin/npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const port = String(20000 + (process.pid % 20000));
    for (const n of ["90", "147", "0"]) {
      const run = join(dir, `run-${n}`);
      const r = spawnSync("python3", [join(LIVE, "workers.py"), run, port], {
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CHROMIUM: "/bin/false", DISPLAY_N: n, HARNESS_LOCK: join(dir, "harness.lock") },
        encoding: "utf8", timeout: 30_000,
      });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, new RegExp(`^DISPLAY_N names :${n}, a reserved display \\(0, 90, 147, 190, 191, 192`));
      assert.equal(existsSync(run), false);
    }
    assert.equal(existsSync(join(dir, "harness.lock")), false, "no lock taken");
    assert.equal(existsSync(join(dir, "xvfb.calls")), false, "no Xvfb started");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run.sh down signals no process whose argv has --pid-dir <run>/pids but no harness_guard.py field", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-guard-"));
  const run = join(dir, "run");
  mkdirSync(join(run, "pids"), { recursive: true });
  const other = spawn("python3", ["-c", "import time; time.sleep(60)", "--pid-dir", join(run, "pids")], { stdio: "ignore", detached: true });
  other.unref();
  try {
    await sleep(300);
    writeFileSync(join(run, "guard.pid"), `${other.pid}\n`);
    const r = spawnSync("/bin/sh", [RUN_SH, "down", run], { encoding: "utf8", timeout: 40_000 });
    assert.match(r.stderr, /the guard already stopped the run .*: down signals nothing/);
    await sleep(300);
    assert.deepEqual(running([other.pid]), [other.pid], "the process with the look-alike argv still runs");
  } finally { stopOwn([other.pid]); rmSync(dir, { recursive: true, force: true }); }
});

test("a pid-file guard started with stdin, stdout and stderr closed still holds the lock", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-guard-"));
  const pids = [];
  try {
    mkdirSync(join(dir, "pids"));
    const env = { ...process.env, HARNESS_LOCK: join(dir, "harness.lock") };
    // A second run of this user has the same guard name. It must keep its own lock and receive no signal.
    const decoyDir = join(dir, "other");
    mkdirSync(join(decoyDir, "pids"), { recursive: true });
    const decoy = Number(execFileSync("python3", ["-I", "-B", GUARD, "--name", "closed", "--driver", "0", "--limit", "60", "--pid-dir", join(decoyDir, "pids"), "--log", join(decoyDir, "guard.log")],
      { env: { ...env, HARNESS_LOCK: join(decoyDir, "harness.lock") }, encoding: "utf8" }).trim().split(" ")[1]);
    pids.push(decoy);
    // As `run.sh up <&-`: the caller's fd 0 is closed (and 1 and 2 too here); the guard's pid goes to a file.
    spawnSync("/bin/sh", ["-c", `python3 -I -B "${GUARD}" --name closed --driver 0 --limit 60 --pid-dir "${join(dir, "pids")}" --log "${join(dir, "guard.log")}" <&- 1>&- 2>&- &
      sleep 1.5; ps -o pid=,args= -u "$(id -u)" | grep -F -- "--log ${join(dir, "guard.log")}" | grep -v grep | awk '{print $1}' > "${join(dir, "guard.pid")}"`], { env, encoding: "utf8", timeout: 20_000 });
    const ownRows = execFileSync("ps", ["-e", "-o", "pid="], { encoding: "utf8" }).split("\n");
    for (const row of ownRows) {
      const pid = Number(row.trim().split(/\s+/)[0]);
      try { if (readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(join(dir, "guard.log"))) pids.push(pid); } catch { /* ended */ }
    }
    const guard = Number(readFileSync(join(dir, "guard.pid"), "utf8").trim().split("\n")[0]);
    assert.ok(guard > 0, "the guard runs");
    // Validate ownership before recording or signalling the selected pid, also when this test fails.
    assert.ok(readFileSync(`/proc/${guard}/cmdline`, "utf8").split("\0").includes(join(dir, "guard.log")), "the selected guard belongs to this run");
    assert.notEqual(guard, decoy, "the other run's guard is untouched");
    pids.push(guard);
    const second = spawnSync("python3", ["-I", "-B", GUARD, "--name", "second", "--driver", String(process.pid), "--wait", "1"], { env, encoding: "utf8", timeout: 20_000 });
    assert.match(second.stdout, /^refused the harness lock .* is still held after 1 s/, `the first guard still holds the lock: ${second.stdout}`);
    process.kill(guard, "SIGTERM");
    assert.deepEqual(await goneWithin([guard], GONE_MS), []);
    assert.deepEqual(running([decoy]), [decoy], "the other run keeps its guard");
  } finally { stopOwn(pids); rmSync(dir, { recursive: true, force: true }); }
});
