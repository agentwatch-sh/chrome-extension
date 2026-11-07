# Live test: both extensions in real Chromium

This test runs the sender and the receiver in two real, headed Chromium
browsers on a Linux box, each on its own private X display. A local stub box
and a local stub daemon stand in for agentwatch. The test sends a site's full
state from the operator's Chromium to the agent's Chromium and checks what the
site's first script sees there. It also checks the scope block (one list, one scope), and it
drives the agent package's bridge (contract C10) through the stub daemon: the
frame rules, the navigation-header rule, and the eager attach with the hold of
a new tab.

It never contacts a real site and never signs in anywhere. All test sites are
`*.localhost` hosts on one local server, and `www.plain.test`, which the agent
Chromium maps to the same loopback server (`--host-resolver-rules`): a plain
`http:` site that is not localhost. All cookie and storage values are
made-up test values, and no log, result or screenshot holds one: the logs keep
names and counts, and the server compares the two sides in memory.

## Requirements

- Linux with `Xvfb`, `xdotool`, `ffmpeg`, `python3` (standard library only)
  and Chromium at `/usr/bin/chromium` (set `CHROMIUM` for another path).
  Google Chrome is not a drop-in `CHROMIUM`: it ignores `--load-extension`
  (measured with Google Chrome 157, review-22 of board ab-v16.34; it installed
  the packed agent 0.2.0 of its tools folder's external file instead). To load
  the unpacked `agent/` there, start it with `--remote-debugging-pipe
  --enable-unsafe-extension-debugging` and send `Extensions.loadUnpacked`
  with the folder's path on the pipe. This harness does not do that; see
  "Run it with Google Chrome 157" below.
- A free loopback port (default 8771; set `LIVE_PORT`) and two free X
  displays in 90 to 189.
- `HOLD_TRIALS` (default 10): the trials of each kind of new tab in the case
  `hold`.

## Run it

```sh
test/live/run.sh                     # start everything, run every case, stop everything
```

Or step by step:

```sh
run=$(test/live/run.sh up)           # start; prints the run folder
test/live/run.sh test "$run"         # every case (or name cases: link send_s1 nav_cases ...)
test/live/run.sh down "$run"         # stop every process of the run
```

Each run makes its own folder `test/live/.run/<stamp>/` (git-ignored). It
holds `results.json`, the screenshots (`shots/`), and the logs (`logs/`:
`events.jsonl` is the server's request log, page logs and the stub daemon's
messages; `host.log` is the native host's log). The two Unix sockets
(`daemon.sock`, `ctl.sock`) are in a short private folder `/tmp/aw-live.XXXXXX`
(0700, named in the run's `env.json`; `<sockets>` below): a socket path holds at
most 107 bytes, so the harness also runs from a checkout with a long path. The script deletes
nothing. Remove `test/live/.run/` by hand when you are done; the system clears
`/tmp`.

Chromium writes `agent/_metadata/` (its indexed DNR ruleset) into the
agent folder that it loads. The folder is git-ignored. Remove it by hand
too if you want a clean tree.

## The per-scope contract in this harness

The receiver (0.3.x) applies `set_scopes`, not `set_allowlist` (C4). The stub daemon keeps the one
list of sites that the cases use and sends it as `{"lists": {"live": <list>}, "scopes": {"live":
"live"}, "default": "live", "operator": "live"}`. So the one list `live` is the list of three kinds
of tab:

- A tab that the harness opens through the bridge: `tabs.create` (and `windows.create`) take the
  scope as their second arg (`SCOPE = "live"` in `live.py`), and a popup of such a tab inherits it.
  `tabs.create` opens `about:blank` only (C10), so `new_tab(url)` creates a blank tab, attaches,
  and sends `Page.navigate`.
- The tab that the driver types into with xdotool in the agent Chromium. A tab of no scope and no
  mark has no list and fails closed (C5). So each case starts with Ctrl+T: a tab that starts at
  `chrome://newtab/` has the operator mark (C10), and the `operator` field gives it the list. An
  import or a list change closes the driver's tab, so the driver opens a new one before each case.
- Any other tab: no list.

The scope rules are two per list (`main_frame`, and `sub_frame` with `object`), so the first
`set_scopes` answers `rules` 2. The receiver's hello must carry `"features": ["scopes"]`; the case
`link` checks it.

Since the receiver no longer lets a client open a tab at a URL, the case `hold` has no row for
`tabs.create` with a URL, and its check of a page with a frame uses a blank tab that the client
navigates (the page and its frame load after the release).

## Run it with Google Chrome 157

`run.sh` loads the receiver with `--load-extension`, which Google Chrome 157 ignores. To load the
unpacked `agent/` of a checkout there (measured by review-22 of board ab-v16.34; `run.sh` does not
do this):

1. Start Chrome with a fresh `--user-data-dir`, `--remote-debugging-pipe`,
   `--enable-unsafe-extension-debugging`, `--no-first-run`, and no `--load-extension`.
   (With the pipe, a stdio pair of file descriptors 3 and 4 replaces the debugging port.)
2. On the pipe (messages end with a NUL byte), send
   `{"id":1,"method":"Extensions.loadUnpacked","params":{"path":"<repo>/agent"}}`.
   The answer holds the extension ID, which is the receiver ID (its manifest `key` fixes it).
3. Chrome also installs the packed agent 0.2.0 from the external file
   `opt/google/chrome/extensions/ifhfjdmdbgbnmllffiadajepajbcdnai.json` of its tools folder in every
   profile. Check that the hello of the receiver says the version of your branch.

Start the stub server, the native host and the driver as `run.sh up` does, and replace only the
Chromium start of the agent. The sender (operator) side stays on Chromium.

## The worker removal of the recorded origins: `workers.py`

`workers.py` is the live check of board task ab-v16.74 (C5, the worker removal of the recorded
origins; the operator's answer ab-214, review-30 and ab-lead's decisions). It repeats the measure of
board task ab-v16.73: a service worker of a host on no list, registered from the operator's marked
tab with `"*"`, answers a navigation of a client-attached tab of scope A with its own page, or with
a cached signed-in page (a made-up cookie). It is one Python file (standard library only) with its
own Xvfb, its own Chromium, a copy of the unpacked agent, `host.py` as the native host, a stub
daemon and the test sites (all `*.localhost`, on two loopback ports), and no relay. It starts only
its own processes and stops only those, by the pids that it recorded.

```sh
DISPLAY_N=142 test/live/workers.py            # run folder test/live/.run/workers-<stamp>, ports 8774 and 8775
test/live/workers.py <run folder> <port>      # or name them (PORT_B: the second port, default port + 1)
```

The cases: `before` (two marked tabs stay on the two hosts: the worker's page commits, the residue),
`after` (both marked tabs leave: no commit, no script, no read, no request), `frame` (a second marked
tab shows the host in a sub-frame: the worker stays; after that page leaves: no commit), `race` (a
client's `Page.navigate` 0, 100 or 300 ms after the leave's request), `error` (a leave for the error
page of a refused connection: review-30 B1), `site` (review-30's probe 2: two origins of one site,
and a frame's partitioned worker under that site; the site rule), `session` (a tab of scope C
registers a worker on C's site; a `set_scopes` ends C's list), `flood` (review-30b B1: two marked
tabs with 600 frames of distinct hosts each; the open page's worker and two listed workers stay; a
list's end during the flood keeps the open page's worker; after the flood the gap after a leave is
still closed; review-30c B1: the guard's times before and during the flood, with limits), `gone`
(the marked tab's next
navigation to the host is a network request) and, with `RESTORE_TRIALS`, C6's restore tab. The
environment: `TRIALS` (20), `CACHE_TRIALS` (10), `CTRL_TRIALS` (5), `AFTER_TRIALS` (20),
`FRAME_TRIALS` (5), `RACE_REPS` (4), `ERROR_TRIALS` (5), `SITE_REPS` (3), `SESSION_TRIALS` (5),
`FLOOD_FRAMES` (600 per tab; 0: no flood), `FLOOD_TRIALS` (5), `FLOOD_NOTICE_MS` (250: the limit
of the blocked notice during the flood), `FLOOD_BLANK_MS` (150: the limit of the worker's page from
commit to `about:blank` during the flood), `CASES` (`flood`: the setup and the case flood only, for
example a timing run of another receiver with `RECEIVER`),
`RESTORE_TRIALS` (0), `READERS` (1: every reader of ab-v16.73; 0: only `Page.enable`), `EAGER`,
`PORT_B`, `CHROMIUM`, `RECEIVER`. The run folder holds `results.json`, `summary.json`, the rows of
each case, the logs, the screenshots and the screencast frames. The script deletes nothing.

Result on taylor (2026-11-06, Chromium 156.0.8078.79, receiver 0.3.5 of the branch
`ab-v16.74-sw-remove` after review-30e, `DISPLAY_N=142`, the defaults): 51 of 51 checks passed.

| Case | Trials | Worker's page committed (seen by the client) | Requests to the host |
| --- | --- | --- | --- |
| before, own-page worker (link and `Page.navigate`) | 40 | 40 | 0 |
| before, cached signed-in page | 20 | 19 (cookie sent in 19) | 0 |
| before, control (no worker) | 10 | 0 | 0 |
| after the leave, own-page worker | 40 | 0 | 0 |
| after the leave, cached signed-in page | 40 | 0 | 0 |
| frame: the host in a second marked tab's frame | 10 | 10 | 0 |
| frame: after that page left | 10 | 0 | 0 |
| race: `Page.navigate` 4 to 17 ms after the leave's request | 4 | 4 | 0 |
| race: 100 ms or 300 ms after it | 8 | 0 | 0 |
| error: after a leave for an error page | 10 | 0 | 0 |
| session: scope C's list in force | 10 | 9 | 0 |
| session: after the `set_scopes` that ended it | 10 | 0 | 0 |
| flood: D's site after the `set_scopes` that ended D's list | 10 | 0 | 0 |
| flood: the open page's host after the flood and the leave | 10 | 0 | 0 |

Every trial ended at `about:blank` with one correct `blocked`. Before the leave, the worker's page
stayed 21 to 52 ms from its commit to `about:blank`; the client read every page that committed (the
title event and its init script). The case `site`: the second marked tab's new frames of
`www.nolist3.localhost` got the frame's worker in 3 of 3 before and 3 of 3 after the first tab left
the other origin of the site; after the second tab left the site too, the next frame went to the
network. The case `flood` (1200 frames in 20 s): the open page's worker, D's listed worker and the
canary on A's list answered before, during the flood and after one more new origin; at D's list end
the open page's worker and the canary stayed (the bound refuses and evicts no recorded origin). The
guard's times (a client's `Page.navigate`, 5 each): before the flood, the blocked notice 22 to 24 ms
after the command and the worker's page 21 to 36 ms from its commit to `about:blank`; during the
flood, 29 to 38 ms and 20 to 30 ms (limits 250 ms and 150 ms). With only `Page.enable`
(`READERS=0 CASES=flood`, review-30c's method), one run after the other, during the flood: this
head 26 to 41 ms and 25 to 59 ms; receiver 0.3.4 (`RECEIVER` = main 8a3b66f's `agent/`) 25 to 34 ms
and 27 to 60 ms. After the leave, the marked tab's next navigation to the host was a network request (no worker).

## What the run sets up

| Piece | What it is |
| --- | --- |
| Two private displays | `Xvfb :N -nolisten tcp -auth <file>`, one for each Chromium. Each auth file (0600) holds one FamilyWild MIT-MAGIC-COOKIE-1 entry from `os.urandom`; the cookie never enters an argv. The script checks that a client without the cookie is refused. |
| The agent Chromium | `--user-data-dir=<run>/agent --no-first-run --no-default-browser-check --password-store=basic --load-extension=<repo>/agent --silent-debugger-extension-api "--host-resolver-rules=MAP www.plain.test 127.0.0.1"`, headed, no remote debugging. Its profile holds the native host manifest `NativeMessagingHosts/sh.agentwatch.browser.json` (allowed origin: the receiver ID), whose `path` is a 0700 wrapper that runs `host.py`. |
| The operator Chromium | A copy of `operator/` in `<run>/sender-copy/`, whose manifest gains a test-only `commands._execute_action` shortcut (Ctrl+Shift+U) so that xdotool can open the popup. The `key` stays, so the ID stays. The committed `operator/` is never changed. |
| `server.py` | One HTTP server on 127.0.0.1, routed by the Host header: the test sites, and the stub box at `box.localhost` (`/login` sets a made-up login cookie; `GET /api/browser/targets`; `POST /api/browser/send` checks `Origin` and the cookie, caps the body at 33,554,432 bytes, then asks the stub daemon to add the domain to the list (`set_scopes`) and to import). The stub daemon listens on `<sockets>/daemon.sock` (0600) and speaks contract C4: it sends each request as parts of 700,000 bytes, one main request at a time. On channel `bridge` it sends the driver's bridge requests (C10) at the same time, and it logs each bridge event by its name, tab and outcome (of a paused request its id and path), never a header, a body or other params. A control socket `<sockets>/ctl.sock` serves the driver. |
| `host.py` | The native messaging host for this test only: Chrome's stdio messages to one NDJSON line each on the stub daemon's socket, and back. After each connect it tells the receiver `{"t":"link","up":true}`. |
| `live.py` | The driver: xdotool on each display, the control socket, and the checks. |

The test sites:

- `www.s1.localhost` `/setup` sets the probe's 11 cookie kinds and writes
  localStorage, sessionStorage, two IndexedDB databases (every C3 value kind,
  in-line, compound, generated and binary keys, unique and multiEntry
  indexes, and a non-extractable `CryptoKey`) and two caches. Then it opens
  `/report`.
- `/report`: its first script reports what it sees (cookies by
  `document.cookie`, by the Cookie header of the page request and of a `/sub`
  request, the storage areas, every IndexedDB record as a typed descriptor,
  every cache entry). The operator side and the agent side each report, and
  the server compares the two by name.
- `/agent-old`: the agent's own earlier state on the site (cookies, storage,
  an IndexedDB database, a newer version of `kinds`, a cache), which a send
  must replace (O19).
- `/nav?case=...`: the navigation cases of the probe (section 3 e) to
  `www.off.localhost`, with an off-list iframe (and a frame navigation to
  `www.off2.localhost`), script, image and fetch on the allowed page.
- `www.sw.localhost`: a service worker that answers every navigation with its
  own page and logs each path that it sees.
- `/link?to=<url>` (on any test site): one big link to `<url>`, at the place of
  the nav page's link block, so the driver clicks the same spot.
- `www.big30.localhost` and `www.big33.localhost`: an IndexedDB database of 30
  or 33 records of 1 MiB each.
- `/p/<name>` and `/f/<name>` (on any test site): a page and a frame whose path
  names one check, because the request log keeps no query value. `/pf/<name>`:
  a page with the one frame `/f/<name>`.

## Results

Run of 2026-11-05 on taylor (Debian 13), Chromium from `/usr/bin/chromium`, `HOLD_TRIALS=10
test/live/run.sh` (`all` mode) in two private Xvfb displays, against the unpacked `agent/` of board
task ab-v16.56's branch (receiver 0.3.3, hello `features ["scopes"]`): **74 checks, 73 passed, 1
failed**. The one failure is the accepted test-site limit (the partitioned cookie of an http
`*.localhost` site, below). Every case runs on the per-scope contract (see "The per-scope contract in
this harness"). Changes against the run of 2026-11-04: the `link` case has one more check (the
hello's features); the first `set_scopes` answers `rules` 2; the case `hold` has no row for
`tabs.create` with a URL (the receiver opens `about:blank` only), and the page with a frame is held
and released as a blank tab that a client navigates. The hold, measured (`hold.json`):

| New tab | Caught | Trigger to `tabs.onCreated` (min, median, max) |
| --- | --- | --- |
| `tabs.create` with `about:blank`, then a client's `Page.navigate` before the release | 10 of 10 | 36, 42, 73 ms |
| `window.open` from an attached page (with `userGesture`) | 10 of 10 | 36, 40, 42 ms |
| a link with `target=_blank` (`noopener`) | 10 of 10 | 117, 127, 153 ms |

The tables below are the earlier runs. They keep the wording of their time (`set_allowlist`, a
`tabs.create` with a URL).

Run of 2026-11-04 on taylor (Debian 13), Chromium 156.0.8078.79, `HOLD_TRIALS=10 test/live/run.sh`
(`all` mode) from a clean run folder, against the agent package of board task ab-v16.17 (stage 2
part B, after its review): **73 checks, 72 passed, 1 failed**. The one failure is the accepted
test-site limit of the earlier runs (the partitioned cookie of an http `*.localhost` site, below).
Every earlier case passed with the frame rules and the navigation-header rule in force; the O13
cases show that a page of an allowlisted site still loads its off-list frame. The new cases:

| Case | Result | How measured |
| --- | --- | --- |
| bridge.info answers on channel bridge | pass | the stub daemon's bridge request: `bridge` 1, the receiver ID |
| plain http to a host that is not localhost: no Sec-Fetch-* header, also with rule 5 | pass | server request log for `www.plain.test`: no `Sec-Fetch-Site`, `-User`, `-Dest` or `-Mode`, for a `Page.navigate` and a page script's navigation |
| a Page.navigate sends Sec-Fetch-Site none and ?1, as a typed URL (rule 5) | pass | server request log (a `tabs.create` with a URL sends `none` and no `Sec-Fetch-User`) |
| a page script's navigation keeps its own Sec-Fetch-Site | pass | server request log: `same-origin`, `?1` |
| a Page.navigate to an off-list host is still blocked (rule 1 under rule 5) | pass | receiver `blocked` event; no request for the host |
| no frame, `<object>` or `<embed>` loads under an about:blank top page, from any host (rules 3 and 4) | pass | server request log: no request of the six (each kind from an off-list and an allowlisted host) |
| frames, `<object>` and `<embed>` of an allowlisted top page load from any host (rule 4, O11) | pass | server request log: all six; an `about:blank` popup of the allowlisted page loads all six too |
| bridge.attachNew [true] answers null | pass | bridge answer |
| eager attach: each new tab is attached and held | pass | `tabs.onCreated`: `attached` and `held` true for all 40 tabs |
| the hold keeps a first request that starts after it until bridge.release; the page then loads | pass | the request's time at the server against `tabs.onCreated` and the release; page log; no hold event reached the relay |
| HOLD_MAX_MS: a hold with no release ends after 5 s | pass | 4992 to 5003 ms from `tabs.onCreated` to the request (7 tabs) |
| a client's Fetch.enable during the hold: the held request's Fetch.requestPaused reaches the relay; the client continues it | pass | bridge `debugger.onEvent` (5 of 5); the request 4 to 6 ms after the client's `Fetch.continueRequest` |
| a held request that redirects loads after the release | pass | server request time; page log (5 of 5) |
| a frame of a page that the hold missed loads at once, not at the release | pass | 3 of 3 `tabs.create` with a URL of a page with a frame: the frame's request came before the release |
| bridge.attachNew [false]: a new tab is neither attached nor held | pass | `tabs.onCreated`; the request 14 to 20 ms after the event |
| an import with the eager attach on: the restore tab is neither attached nor held | pass | import answer (ok); `tabs.onCreated` of the restore tab; no debugger event of it reached the relay |

The hold, measured (`hold.json` in the run folder). Each trial opens one new tab with the eager
attach on, waits 1 s after `tabs.onCreated`, and sends `bridge.release`. A first request that reached
the server after the release was held ("caught"). One that reached it before 100 ms after the event
had left before the hold was on ("missed"). Any other time would mean a request passed a hold that
was on; none did.

| New tab | Caught | Trigger to `tabs.onCreated` (min, median, max) |
| --- | --- | --- |
| `tabs.create` with `about:blank`, then a client's `Page.navigate` before the release | 10 of 10 | 32, 38, 67 ms |
| `window.open` from an attached page (with `userGesture`) | 9 of 10; 24 of 25 with the trials of the other hold checks | 24, 28, 60 ms |
| a link with `target=_blank` (`noopener`) | 0 of 10 | 33, 37, 135 ms |
| `tabs.create` with a URL | 0 of 10 | 26, 31, 70 ms |

A caught request reached the server 4 to 15 ms (median 5) after the release. The two runs before
the review fixes caught `window.open` 23 and 24 of 25, links 0 of 10 and `tabs.create` with a URL 0
of 10. With the receiver's own timestamps (a scratch build, not committed): Chrome creates the first
request about 5 to 10 ms after `tabs.onCreated` reaches the worker; the attach takes 3 to 6 ms for a
`window.open` popup and 10 to 20 ms for a `noopener` popup; `tabs.create` starts its request before
the event. While the hold's `Fetch.enable` waited for the attach's answer, `window.open` was caught
8 of 18 times; now `Fetch.enable` goes right behind the attach. The opener's own
`Target.setAutoAttach` with `waitForDebuggerOnStart` does not attach a popup (measured: no
`Target.attachedToTarget`).

Run of 2026-11-01 on taylor (Debian 13), Chromium 156.0.8078.73, `test/live/run.sh` (`all` mode) from a
clean run folder, against head `33d0b74` after the fix wave plus the harness fix below: **57 checks,
56 passed, 1 failed**. The one failure is an accepted test-site limit (see below). The 55-check run
earlier the same day had the same failure. The two checks of the new `sw_removed` case and the
checks of `big30` and `big33` are in this run; the table lists each case once.

Harness fix in this re-run: `sw_removed` ran after `service_worker`, whose worker was still
registered, so that worker answered `/sw` with its own page and the registering script never ran
(setup check failed with `controlled: null`). The case now drops `sw.localhost` first, which makes the
receiver remove every worker. The block itself held in the failing run (a `blocked` event).

| Case | Result | How measured |
| --- | --- | --- |
| receiver links up and says hello | pass | stub daemon socket: link event, then hello |
| ping | pass | C4 ping through host.py |
| stub box refuses: targets without the login cookie | pass | direct HTTP request to the stub box |
| stub box refuses: targets with a wrong Origin | pass | direct HTTP request to the stub box |
| stub box refuses: targets from a web page Origin | pass | direct HTTP request to the stub box |
| stub box refuses: send with a wrong Origin | pass | direct HTTP request to the stub box |
| stub box refuses: send from a web page Origin | pass | direct HTTP request to the stub box |
| stub box refuses: send without the login cookie | pass | direct HTTP request to the stub box |
| stub box refuses: send with an Authorization header | pass | direct HTTP request to the stub box |
| stub box refuses: send of 33,554,433 bytes | pass | direct HTTP request to the stub box |
| no refused request reaches the daemon | pass | stub daemon request log |
| static rule blocks a top-level navigation before any allowlist | pass | receiver blocked event; server request log |
| set_allowlist [s1.localhost] | pass | receiver answer |
| agent signs in on its own first (old state to replace) | pass | page log of the agent tab |
| operator site writes every state kind | pass | page log and the report page's first script (operator side) |
| popup before the box login: targets answered 401 | pass | server request log; screenshot of the popup's note |
| operator logs in to the stub box | pass | server request log |
| popup lists the box's user (targets 200 with the login cookie) | pass | server request log (the GET carries no Origin: see C9 note) |
| send POST carries the sender Origin and the login cookie | pass | server request log |
| send of s1.localhost: 11 cookie kinds in the payload | pass | box-send payload summary (names and attributes) |
| receiver counts match the payload | pass | import answer vs the payload summary (the CryptoKey record is the one unsupported value) |
| old agent cookies of the domain removed (O19) | pass | import answer: cookies_removed |
| import closes the agent's tab of the origin | pass | import answer: tabs_closed |
| unsupported value reported by name | pass | import answer: errors |
| the site never sees the restore page | pass | server request log |
| partitioned cookie (CHIPS) of an http *.localhost site moves | **FAIL** | Cookie header and document.cookie on the agent side; import errors |
| agent sees the same nav_cookie (c_part: own row) | pass | Cookie header of the first request, operator report vs agent report |
| agent sees the same sub_cookie (c_part: own row) | pass | Cookie header on /sub (Path), operator report vs agent report |
| agent sees the same doc_cookie (c_part: own row) | pass | document.cookie at the first script, operator report vs agent report |
| agent sees the same local | pass | localStorage at the first script, operator report vs agent report |
| agent sees the same session | pass | sessionStorage at the first script, operator report vs agent report |
| agent sees the same IndexedDB (schema, versions, every C3 kind; the CryptoKey left out) | pass | IndexedDB read at the first script, operator vs agent |
| agent sees the same Cache Storage | pass | caches read at the first script, operator vs agent |
| old agent page storage gone (O19) | pass | agent report: no agent_old key, agent-old-db, agent-cache or c_agent_old |
| O13 link to an off-list host is blocked | pass | receiver blocked event; server log has no request for the target |
| O13 link page: off-list frames and subresources load | pass | page log (img, fetch, script, frame, frame navigation) and server log |
| O13 script to an off-list host is blocked | pass | receiver blocked event; server log has no request for the target |
| O13 script page: off-list frames and subresources load | pass | page log (img, fetch, script, frame, frame navigation) and server log |
| O13 form to an off-list host is blocked | pass | receiver blocked event; server log has no request for the target |
| O13 form page: off-list frames and subresources load | pass | page log (img, fetch, script, frame, frame navigation) and server log |
| O13 meta to an off-list host is blocked | pass | receiver blocked event; server log has no request for the target |
| O13 meta page: off-list frames and subresources load | pass | page log (img, fetch, script, frame, frame navigation) and server log |
| O13 redirect to an off-list host is blocked | pass | receiver blocked event; server log has no request for the target |
| O13 redirect page: off-list frames and subresources load | pass | page log (img, fetch, script, frame, frame navigation) and server log |
| O13 blank to an off-list host is blocked | pass | receiver blocked event; server log has no request for the target |
| O13 blank page: off-list frames and subresources load | pass | page log (img, fetch, script, frame, frame navigation) and server log |
| O13 popup to an off-list host is blocked | pass | receiver blocked event; server log has no request for the target |
| O13 popup page: off-list frames and subresources load | pass | page log (img, fetch, script, frame, frame navigation) and server log |
| O13 blank and popup open new tabs, and those are blocked too | pass | tab ids of the blocked events |
| set_allowlist with the same list closes tabs left on blocked pages | pass | receiver answer |
| allowlist change closes the off-list tab | pass | receiver answers (closed) and the s2 page's pagehide beacon |
| agent's service worker answers the site's navigations | pass | page log (sw-ready, sw-page); the server never saw /sw-plain |
| import bypasses the site's service worker (Network.setBypassServiceWorker) | pass | import answer; the worker's own log never shows the restore URL |
| sw_removed setup: the worker answers while listed; the list then drops its host | pass | page log (sw-ready, sw-page, link-ready); receiver answers |
| a removed host's service worker does not answer a link navigation (the block holds) | pass | receiver `blocked` event; no worker log; no request for the page |
| a 30 MiB send imports | pass | box-send (bytes, import answer) and the agent page's IndexedDB count |
| a 33 MiB send is refused in the sender, naming the database | pass | server log has no send POST; screenshot of the popup's text (read by eye) |

Final-review case I1 (`sw_removed`), run alone on the same day with `run.sh up`, then the cases
`link sw_removed`, then `run.sh down`. The case lists `sw.localhost`, lets the worker of
`www.sw.localhost` register and answer a navigation, moves the tab to an allowed page
(`www.s1.localhost/link`) with a link to `www.sw.localhost/sw-plain`, drops `sw.localhost` from the
list, and clicks the link:

| Receiver | Result | How measured |
| --- | --- | --- |
| before the fix (head `650d624`) | **FAIL: the removed host's worker answered the link** | no receiver `blocked` event; the worker's own log (`sw-fetch`, `sw-page`); screenshot shows the worker's page at `sw.localhost:8771/sw-plain` |
| with the fix (`browsingData`: every service worker removed when the list loses an entry) | pass | receiver `blocked` event for `www.sw.localhost`; no worker log; no request for the page; screenshot shows "www.sw.localhost is blocked", `ERR_BLOCKED_BY_CLIENT` |

The setup check of the case passed in both runs (the worker controlled the page and answered a
navigation while its host was listed).

Also measured by hand on the same day (`RECEIVER=<folder> test/live/run.sh up`, then the cases `link` and
`static_block`):

| Case | Result | How measured |
| --- | --- | --- |
| Receiver loaded from a read-only folder | **does not load** | Chromium shows "Failed to load extension ... block-main-frame.json: Internal error while parsing rules" and runs with no receiver: no hello, no block (screenshot) |
| Receiver from a read-only folder that already holds `_metadata/` | **does not load** | the same; a fresh profile indexes the ruleset again |

## Findings for the contracts

These need a decision in the agentwatch plan; the extensions keep the
contracts as written.

1. **C9: the extension's GET carries no `Origin`.** Chromium 156 sends no
   `Origin` header on any GET from an extension page to a host that the
   extension holds a permission for (`Sec-Fetch-Site: none`), also with
   `credentials: "include"`, `mode: "cors"` or a custom header. Only the POST
   carries `Origin: chrome-extension://<id>`. So C9's EXTENSION check on
   `GET /api/browser/targets` refuses every real sender with 403. The stub here
   refuses a wrong `Origin` and accepts a missing one on that GET, and the send
   (POST) keeps the exact `Origin` check.
2. **C6: a partitioned cookie of an http `*.localhost` site is not set.** C6
   builds the set URL as `https://` for a Secure cookie. On an http secure
   context (`*.localhost`), the partition key's `topLevelSite` is
   `http://<site>`, and Chromium refuses: "partitionKey has a first party value
   for hasCrossSiteAncestor when the url and the topLevelSite are not first
   party". An `http://` URL works. A real (https) site is not affected, because
   a partitioned cookie is always Secure and its top-level site is then https.
3. **C7: the receiver folder must be writable by the agent's OS user.**
   Chromium writes `_metadata/generated_indexed_rulesets/` into the receiver
   folder at load. From a read-only folder the receiver does not load at all,
   and the agent Chromium runs with no block (see the table). agentwatch must
   keep the folder writable, and treat a missing hello as a failed start.
4. **C6 step 2:** `Network.setBypassServiceWorker` works only after
   `Network.enable` (the receiver now sends both).
5. **C5: a site's service worker answers a navigation before DNR sees it.**
   After its host left the allowlist, a link to that host loaded the worker's
   own page; the static block rule did not stop it (case `sw_removed`). The
   receiver now holds the `browsingData` permission and removes every service
   worker of the profile whenever the list loses an entry (and on the first
   `set_allowlist` after its own worker starts), before it closes the tabs. A
   failed removal fails the `set_allowlist` call.

The live test also found three bugs in the extensions, fixed with unit tests:

- the first send of a site never started, because Chrome closes the popup when
  it shows the permission dialog (the popup now leaves the send in
  `storage.session`; the worker runs it after the grant);
- object values in IndexedDB lost their key order, because Chrome sorts the
  keys of an `executeScript` result (the page read is now one JSON string);
- a site's service worker answered the restore page (see item 4).
