# Protocol and fixed values

Both repositories implement these contracts. Change them only in the agentwatch plan.

C1, C4, C5, C10 and C11 are the exceptions: this file is the master for them. For C4, C10 and C11,
this holds since the two-modes design (agent-browser
`docs/superpowers/specs/2026-11-03-two-modes-playwright-design.md`, sections 4, 8, 11 and 13). The
agentwatch plan's C4 text is older (`"v":1`, no channels). C10 and C11 are only here. They bind three
repositories: this one (the receiver), agent-browser (its relay) and agentwatch (the daemon).

For C1 and C5, this holds since board task ab-v16.24 (aw-lead agreed, mail m7ccc29b, 2026-11-04), on
two conditions. A change of C1 or C5 that agentwatch must follow (an ID, a pin rule, an allowlist
rule) goes to aw-lead by mail, with its commit, before it merges. agentwatch's pins
(`CHROME_EXTENSION_COMMIT`, `CHROME_EXTENSION_RECEIVER_ID`, `AGENT_CRX_PATH`, `AGENT_CRX_SHA256`)
move only in an agentwatch tip, so a chrome-extension merge alone never reaches a box.

The per-scope allowlists (board task ab-v16.23; the design: agent-browser
`docs/superpowers/specs/2026-11-04-per-scope-allowlist-design.md`) are the contract in C4, C5, C6,
C10 and C11 since board task ab-v16.30. This file is the master over that design too: where the two
differ (for example the key's 403 text, or a count in `refused`), this file holds. Each side builds
the rules in a part of the design's section 12: the receiver in parts 1a to 1d (boards ab-v16.31 to
ab-v16.34), the relay in part 2 (ab-v16.35 and ab-v16.36), agentwatch in part 3 (aw-lead). Until its
part merges, a side still does what this file said before ab-v16.30 (main `27543ce`:
`set_allowlist`, one list for the whole agent browser), and this repository's tests run the shared
vectors that the receiver does not meet yet as `todo` tests. There
is no backward compatibility: agentwatch pins both repositories and moves them at once, and it
moves `CHROME_EXTENSION_COMMIT` to a commit with part 1a only together with its part 3 (aw-lead,
mail md2ae63e). The operator's choices of the design's section 13 that are still open (ab-dm6:
choice 1, the scope's key; choice 3, the operator's own tabs) change only the rules that name them.

The orphan-tabs rules (board task ab-v16.41; the design: agent-browser
`docs/superpowers/specs/2026-11-05-orphan-agent-tabs-design.md`, board ab-v16.39) are a part of the
per-scope build. The receiver keeps its tab-to-scope map over a link change, closes the tabs of each
scope with no list at each `set_scopes` (the sweep), and keeps the browser's last window for every
close; the relay takes the tabs of the map back into their scopes at each link up; the daemon names
every live session in its first `set_scopes` on each connection (C4, C5, C6, C10, C11). The receiver
builds them in parts 1a and 1b (boards ab-v16.31 and ab-v16.32), the relay in part 2 (ab-v16.35),
agentwatch in part 3. Today's relay (agent-browser main from its PR #51, before part 2) follows only
the text that names it: the steps of the link up without `bridge.tabScopes` (C10, the daemon and the
relay), and the last-window guard and the readiness of C11.

- Sender extension ID: `bpfkgknpndlpkcffmaaelkfcbpackiip`
- Receiver extension ID: `ifhfjdmdbgbnmllffiadajepajbcdnai`

The sender is the operator package (`operator/`, operator mode). The receiver is the agent package
(`agent/`, agent mode). Both packages come from this one source tree (two-modes design, section 3.1).

### C1. Names and IDs

- Native messaging host name: `sh.agentwatch.browser`.
- Extension IDs: fixed by the manifest `key` of each extension, the base64 DER public key
  (SubjectPublicKeyInfo). The ID is SHA-256 of the DER, first 32 hex digits, `0-9a-f` -> `a-p`
  (`scripts/extension-id.mjs`). Both IDs are recorded here. Task A1 copies them into agentwatch's
  `tools/pins.py`.
- The sender's key: task E1 generated a fresh RSA-2048 key (the private key went through a pipe and was
  never written) and put its public key into `operator/manifest.json`.
- The receiver's key: Chrome's external extensions file takes a packed extension (a CRX), and the key
  that signs the CRX fixes its ID. So board task ab-v16.18 generated a new RSA-2048 key, once, on
  taylor. The working copy of the private key lives only on taylor, in
  `~/.config/agentwatch/browser/agent-extension.pem` (mode 0600, in a 0700 folder); the operator keeps
  a backup in their password manager. The key is never in a repository, a commit, a log, an argv or a
  mail. Its public key is the `key` of
  `agent/manifest.json`, so an unpacked load (`--load-extension`) and the CRX (`npm run pack:agent`,
  see the README) have the same ID. The receiver ID before ab-v16.18 was
  `dofdpnfachcncepdoondkeodcbnhipdc`: E1's key was never kept, so no CRX could have that ID. A lost
  key means a new ID, and every pin of the ID changes again.
- The committed CRX (board task ab-v16.22): `release/agent.crx` holds the packed `agent/` folder of
  the same commit, signed with that key. agentwatch pins a commit of this repository (40-hex), and
  that commit holds the `release/agent.crx` that agentwatch installs; agentwatch never runs the pack
  script and never opens the key. A test checks, without the key, that the committed CRX has this
  ID, a valid signature and exactly the files of `agent/`. agentwatch depends on two rules:
  - Each new content of `agent/` comes with a higher `version` in `agent/manifest.json`: Chrome
    installs an external CRX again only for a higher `external_version`. `release/versions.json` and
    `npm test` enforce this rule. The steps for a change of `agent/` are in the README (The packed
    CRX).
  - agentwatch pins only a commit that chrome-extension `main` reaches. A PR head can still change
    its own unreleased entry of `release/versions.json`.
- The pins of the receiver ID that agentwatch's stage 4 (board ab-v16.7) changes, in agentwatch main
  `4e483512`:
  - `agentwatch/tools/pins.py:32`: `CHROME_EXTENSION_RECEIVER_ID`.
  - `agentwatch/tests/daemon/browser/test_unit.py:40`: `RECEIVER_ID`.
  - `agentwatch/tests/daemon/browser/test_host_files.py:40`: the native host manifest's
    `allowed_origins`.
  - `docs/superpowers/handoff/agent-browser-state.md:99`: a handoff note that names the ID.

  Stage 4 also moves `CHROME_EXTENSION_COMMIT` (`agentwatch/tools/pins.py:30`) to a commit of this
  repository that holds the new `key` and `release/agent.crx`, and pins the SHA-256 of that CRX. A
  change of `agent/` reaches the boxes only after agentwatch moves both pins: the commit and the CRX
  SHA-256.

### C2. The send payload (sender -> gateway -> daemon -> receiver)

UTF-8 JSON, at most 33,554,432 bytes:

```json
{"v": 1, "domain": "example.com", "url": "https://www.example.com/app?x=1",
 "origin": "https://www.example.com",
 "cookies": [{"name": "", "value": "", "domain": "", "hostOnly": true, "path": "/", "secure": true,
              "httpOnly": true, "sameSite": "lax", "session": false, "expirationDate": 1.0,
              "partitionKey": {"topLevelSite": "https://example.com", "hasCrossSiteAncestor": false}}],
 "storage": {"local": {"k": "v"}, "session": {"k": "v"},
             "idb": [{"name": "db", "version": 3, "stores": [{"name": "s", "keyPath": null,
                      "autoIncrement": false, "indexes": [{"name": "i", "keyPath": "a",
                      "unique": false, "multiEntry": true}],
                      "records": [{"key": {"t": "j", "v": 1}, "value": {"t": "obj", "v": {}}}]}]}],
             "caches": [{"name": "c", "entries": [{"url": "https://www.example.com/x", "status": 200,
                         "headers": [["content-type", "text/plain"]], "body": "<base64>"}]}]}}
```

Validity (the sender builds only valid payloads; the daemon refuses others with
`browser_payload_invalid`, naming the field, never a value):

- `v` is 1. `domain` is a normalized allowlist entry (C5 rules). `origin` is `http:` or `https:`, has
  no path, and its host is covered by `domain`. `url` parses and has exactly that origin.
- Each cookie has string `name`, `value`, `domain`, `path`, booleans `hostOnly`, `secure`, `httpOnly`,
  `session`, `sameSite` in `no_restriction|lax|strict|unspecified`, a number `expirationDate` when
  `session` is false, an optional `partitionKey`; its domain without a leading dot is covered by
  `domain`.
- `storage.local` and `storage.session` map strings to strings. `idb` and `caches` have the shapes
  above; `keyPath` is `null`, a string or a list of strings.
- The sender never sends a box's own sign-in: it refuses a send whose `domain` covers the host of a
  saved box, or whose tab host is a box host, before any read, and it leaves out every cookie that a
  saved box host would receive (cookie domain-match). The daemon checks the same with the box hosts
  that the gateway passes.
- Cache Storage entries with status 0 (opaque) are left out by the sender.

### C3. The tagged value encoding (`codec.js`, the probe's `enc`/`dec` plus three fixes)

`{"t":"undef"}`, `{"t":"j","v":<null|boolean|string|finite number other than -0>}`,
`{"t":"num","v":"NaN"|"Infinity"|"-Infinity"|"-0"}`, `{"t":"big","v":"<decimal>"}`,
`{"t":"date","v":<ms or null for an invalid Date>}`,
`{"t":"blob","type":"","v":"<b64>"}` and for a `File` also `"name"` and `"lastModified"`,
`{"t":"ab","v":"<b64>"}`, `{"t":"view","c":"<constructor name>","v":"<b64>"}`,
`{"t":"map","v":[[<enc>,<enc>]]}`, `{"t":"set","v":[<enc>]}`, `{"t":"arr","v":[<enc>]}` (a hole is
`undef`), `{"t":"re","s":"","f":""}`, `{"t":"obj","v":{"key":<enc>}}`,
`{"t":"unsupported","c":"<constructor name>"}`.
The fixes over the probe: `-0` survives; an object key `__proto__` is decoded with
`Object.defineProperty`, never by assignment; `unsupported` carries no value and decoding it throws
`UnsupportedValue`.

### C4. Daemon <-> receiver messages

One JSON object per native message. On the daemon's socket each message is one NDJSON line.

- receiver -> daemon:
  `{"t":"hello","v":2,"version":"<manifest version>","channels":["main","bridge"],"features":["scopes"]}`
  (`features`: the allowlists, below);
  `{"t":"res","id":"<id>","ok":true,"data":{...}}` or `{"t":"res","id":"<id>","ok":false,"error":"<text>"}`
  (a res on the bridge channel also has `"ch":"bridge"`, and its `data` can also be a list or `null`:
  C10);
  `{"t":"blocked","tab":<tab id>,"host":"<host>","scope":"<scope>"}`, with `"scope":null` for a tab of
  no scope (C5);
  on the bridge channel, the events of C10: `{"t":"ev","ch":"bridge","ev":"<event>",...}`, and a
  large res in parts (C10):
  `{"t":"part","ch":"bridge","id":"<id>","seq":<i>,"n":<count>,"b64":"<base64>"}`.
- native host -> receiver: `{"t":"link","up":true}` after each connect to the daemon socket (the
  receiver answers with `hello`).
- daemon -> receiver: only parts,
  `{"t":"part","ch":"<channel>","id":"<id>","seq":<i>,"n":<count>,"b64":"<base64>"}`; `ch` is
  optional (see the channels below). The daemon serializes the request as compact UTF-8 JSON, cuts
  the bytes into slices of `PART_BYTES = 700000` (the last slice may be shorter; an empty request is
  never sent), and sends slice `i` base64-encoded with `seq = i`, `n` = the slice count. The receiver
  joins the decoded slices of one `id` of one channel in `seq` order once all `n` arrived, decodes
  UTF-8 and parses the request.
- Requests (channel `main`): `{"t":"req","id":"<id>","op":"ping"}` -> `{}`;
  `{"t":"req","id":"<id>","op":"set_scopes","lists":{"<list>":["a.example"]},"scopes":{"<scope>":"<list>"},"default":"<list>"}`
  -> `{"rules":<scope rules in force>,"closed":<tabs closed>,"refused":<entries, list names and scopes refused>}`
  (the allowlists, below);
  `{"t":"req","id":"<id>","op":"import","state":<C2 payload>}` ->
  `{"cookies_removed":0,"cookies_set":0,"tabs_closed":0,"local":0,"session":0,"idb_databases":0,"idb_records":0,"cache_entries":0,"errors":["<store or cookie name>: <reason>"]}`.
- Ids are strings. The daemon waits 10 s for `ping` and `set_scopes`, 120 s for `import`.
- A message from the receiver to the daemon is at most `MAX_TO_DAEMON = 8388608` bytes (8 MiB) of
  UTF-8 JSON: one line on the daemon's socket, without its newline. The daemon drops the link at a
  longer line, and that would fail a running import. So the receiver never sends a longer message. A
  res of channel `main` above the limit goes as `{"t":"res","id":"<id>","ok":false,"error":"too large"}`.
  A res of channel `bridge` above the limit goes in parts, up to `MAX_RESULT`; a larger one goes as
  `too large` with its `ch` (C10). Any other message above the limit, and a res whose error is still
  above it, is not sent.

The channels. The link carries two channels. Channel `main` carries the requests above. Channel
`bridge` carries the agent-mode bridge (C10). The receiver implements the channels; the daemon's
side is stage 4 of the two-modes design (agentwatch).

- Each part names its channel in `ch`: `"main"` or `"bridge"`. A part without `ch` is channel `main`,
  so a daemon from before the channels keeps working. A part with any other `ch` is dropped; it
  changes no channel.
- Parts of one channel never interleave: the daemon sends every part of a request before the first
  part of the next request of that channel. Parts of the two channels may interleave, and the daemon
  mixes them on the socket: when both channels have parts to send, it sends them in turn. So a large
  import does not hold a bridge request back on the socket, and a large bridge message does not hold
  a main request back. A part with a new `id` drops an unfinished request of the same channel only,
  and so does a bad part (a bad `seq`, `n` or base64). So a bridge part never drops an import part,
  and a main part never drops a bridge part. An id is unique within its channel; the same id on the
  two channels names two requests.
- The receiver handles the two channels independently. Channel `main` runs one request at a time,
  in arrival order, as before (the daemon sends one main request at a time). Channel `bridge` starts
  each request as soon as its last part arrives: it never waits behind an import (an import can take
  120 s) or behind another bridge request. Each bridge res comes when its request ends, so bridge
  answers can come in any order.
- A res on channel `bridge` has `"ch":"bridge"`. A res on channel `main` has no `ch`, as before. So
  the daemon routes each res to its channel. The daemon ignores a res whose id it does not wait for
  on that channel (for example the late answer to a request from before a reconnect).
- On each `link` up the receiver drops the unfinished parts of both channels: they came from the
  daemon connection that ended.
- The hello says that the receiver knows the channels: `"v":2` and the `channels` list. A daemon
  sends `ch`, and any bridge request, only to a receiver whose latest hello on the connection lists
  `bridge` in `channels`. A hello without `channels` (`"v":1`) comes from an old receiver. An old
  receiver ignores `ch` and joins all parts as one channel: a bridge part would drop an unfinished
  import part, a bridge request would wait behind an import, and its res would have no `ch`. So the
  daemon sends that receiver parts without `ch`, and no bridge request. A daemon from before the
  channels reads only `version` in the hello, and its parts without `ch` are channel `main`.
- C10 defines the bridge's ops, their data, its events, the waits, the result parts up to
  `MAX_RESULT`, and `MAX_BYTES_IN_FLIGHT`, the daemon's limit of bridge request bytes in flight. The receiver sets no bound of its own: it starts each bridge
  request that it gets. A bridge request with an op that the receiver does not know gets
  `{"t":"res","ch":"bridge","id":"<id>","ok":false,"error":"unknown op"}`. The main ops are not
  bridge ops: `ping` on channel `bridge` is an unknown op too. A bridge request never stops or delays
  channel `main`. A receiver before stage 2 of the two-modes design (before version 0.2.0) knows no
  bridge op, so it answers each bridge request with `unknown op`. The agent package from version
  0.2.0 on has the C10 ops and waits (board ab-v16.5).
- The shared vectors: `test/vectors/parts.json` (parts without `ch`) and
  `test/vectors/parts-bridge.json` (parts with `"ch":"bridge"`).

**The allowlists: `set_scopes` (board ab-v16.23).** Each scope (C11) has its own list (the per-scope
design, section 8). `set_scopes` replaced `set_allowlist` in board task ab-v16.30: `set_allowlist`
held one list for the whole agent browser. The request is above. Its fields and its answer:

- `lists` maps a list name to its entries. A list name matches the scope pattern of C11
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`). A list whose name does not match, or whose value is not an
  array, applies as absent: it counts 1 in `refused`, and each entry of its array counts 1 more.
  Each entry of a list that applies follows C5: an entry that is not a normalized entry (a string
  that equals its normalized form) is refused and counts 1, and the other entries of its list
  apply. So an invalid entry never keeps an older, wider rule.
- A valid name (of a list, in `scopes`, `default` and `operator`) is a string that matches the scope
  pattern. A field that must hold a list name and holds a valid name that is not in `lists` gives
  no list, with no count; one that holds neither a valid name nor `null` (nor `"*"` for `operator`)
  counts 1 in `refused` and applies as `null`.
- `scopes` maps a scope to a list name or `null`. A scope with `null`, or whose list is not in
  `lists` (also a list that applies as absent), has no list: it does not fall back to `default`, and
  it counts nothing. A scope that does not match the scope pattern applies as absent and counts 1
  in `refused` (no connection can name it: C11's 404). A scope that matches the pattern but whose
  value is neither a valid name nor `null` applies as `null` and counts 1 in `refused`: it has no
  list and does not fall back to `default`, so a broken entry never gives a session another list.
- Each scope in `scopes` is the scope that agentwatch fixed at the session's launch (C11, the
  socket and the URL): `set_scopes` names only the launch scope (`AGENTWATCH_SESSION_ID`); another
  name of the session is never a scope. A rename changes no scope, and the receiver never moves a
  tab to another scope at a rename.
- `default` is a list name or `null`: the list of a scope that `scopes` does not name. With `null`,
  or a valid name that is not in `lists`, such a scope has no list. A `default` that is neither a
  valid name nor `null` (also a missing one) counts 1 in `refused` and applies as `null`.
- A `lists` or `scopes` that is not an object (also a missing one) applies as an empty object and
  counts 1 in `refused`. A `scopes` that is not an object also makes `default` apply as `null`
  (with no more count): no scope gets the `default` list while the daemon's scopes are not known.
- A name that comes twice in one object: the last one applies, as `JSON.parse` and Python's `json`
  read it. The daemon never sends one.
- With the design's choice 3 (the operator's own tabs), `set_scopes` has one more field,
  `"operator"`: `"*"` (the marked tabs may open any site), a list name (they have that list), or
  `null` (no site; also when the field is absent). C10 gives the mark (each tab's scope). For "every
  repo's sites" agentwatch adds a list of the union to `lists` and names it. Any other value (not
  `"*"`, not `null`, not a string that matches the scope pattern) counts 1 in `refused` and applies
  as `null`; a valid name that is not in `lists` applies as `null` with no count. The daemon's
  `allowlist` line carries the field; the relay ignores it (no connection sees a marked tab).
  These are the same counts as for a value of `scopes` and for `default` (a valid name above).
- The new object replaces the last one in full. The daemon sends it after each `link` up, at each
  change of a list, and when a session (a scope) starts or ends. It waits 10 s for the answer. The
  first one on each connection names every live session (the tabs of a session that ended, below).
- When the answer is `ok: false`, or no answer comes in 10 s, the daemon writes no `allowlist` line,
  sends the object again (agentwatch picks the delay), and shows the error on the Browser page. The
  relay keeps its last line until a new one comes. After an `ok: false` of a failed rule update the
  receiver has failed closed (C5: a failed update removes the scope rules). After an `ok: false` of
  a failed worker removal (C5), and after an answer that came later than 10 s (C10, the bound of a
  `set_scopes` answer), the receiver's new rules are in force, and the relay's last line is older
  than them.
- A send (C2) no longer adds its site to a list: agentwatch decides which list a sent site joins
  (the design's choice 6, asked in ab-dm6; its recommendation: no list).
- The answer comes after the scope rules are in force, the workers are removed (when C5 needs it),
  the tabs are closed (C5: the closing rule and the sweep), and the copy's key removals of the
  sweep have ended (C10, each tab's scope: a lost key removal could bring an old scope back after
  a worker start). `rules` counts the session rules of
  C5 that `set_scopes` writes: the scope rules, and with choice 3 the marked-tab rule. `closed`
  counts the tabs that closed before the answer: a close that did not end in its item's wait (C10,
  removals and the last window) does not count. The answer can come later than the 10 s (C10, the
  bound of a `set_scopes` answer); the daemon then sends the object again, as above.
- The daemon names a session's scope in `scopes` before it gives the session its endpoint:
  `agentwatch browser endpoint` and `agentwatch browser env` wait for the receiver's answer and the
  `allowlist` line that name the scope (C11). Else the session could connect in the moment before
  and get the `default` list, which can be another repo's list. The URL is easy to guess, so with a
  `default` list any scope that `scopes` does not name gets it. An endpoint URL in the session's
  environment at its launch (only when the operator allowed it: C11, the scope's key) cannot wait,
  because a launch never waits for the agent browser: the daemon adds the scope to its map before
  the launch. With `default` `null`, such a session gets the no-list 503 (C11) until an `allowlist`
  line names its scope, and its agent connects again. A limit: with a `default` list, it can
  connect in that moment and get the `default` list.
- At a session's end the daemon writes `end_scope` to the relay (C10) and drops the scope from
  `scopes` in its next `set_scopes` (agentwatch stage 4, B5). So `scopes` holds only the live
  sessions, and the receiver's map cannot grow without bound. With `default` `null` (the design's
  choice 5 a) a dropped scope has no list, so its tabs fail closed, and the receiver then closes
  them (C5, the sweep), also when no relay runs. Only with a `default` list (choice 5 b) does the
  daemon first send the ended scope as `null`, so that it never falls back to the `default` list;
  it drops the `null` entry by rule 3 below. aw-lead prefers choice 5 a, which needs no `null`
  entry (mail mcbd5352), and builds the rest of 5 b only if the operator takes 5 b. The daemon can
  also write an `end_scope` for each alias of the ended session; the relay does nothing for a name
  that is no scope (C10, C11).
- The rollout. The hello's `"features":["scopes"]` says that the receiver speaks `set_scopes`. When
  one side meets the other side's old form, it fails closed, in the named way:
  - A new daemon and an old receiver (its latest hello has no `"scopes"` in `features`): the daemon
    sends the old request `{"t":"req","id":"<id>","op":"set_allowlist","domains":[]}` (the old
    receiver then blocks every site and closes its `http:`/`https:` tabs), writes no `allowlist`
    line to the relay (so the relay admits no connection), and shows this text on the Browser page:
    "The agent browser's extension is too old for the per-repo allowlists. Update it."
  - A new receiver and an old daemon: the receiver answers `set_allowlist` with
    `{"t":"res","id":"<id>","ok":false,"error":"set_allowlist is gone: send set_scopes"}` and
    applies nothing, so no scope rule exists (it removed the old dynamic rules 2 and 4 at its
    start). Every tab is blocked except an import's restore tab and the operator's marked tabs under
    rule 8: rule 8 stays at a link change, so after a rollback of the daemon a marked tab with `"*"`
    can still open any site, until the receiver's worker starts again. The scope rules and the map
    stay at a link change too (C10, each tab's scope), so after such a rollback the tabs of the last
    scopes keep their lists, and nothing closes them, until the worker starts again. An old relay's
    `tabs.create` without the scope arg gets `bad args`.
  - There is no backward compatibility: agentwatch pins both repositories and moves them at once.
- The shared vectors: `test/vectors/scopes.json` (`set_scopes` objects and what applies, for the
  receiver, and for the relay's `allowlist` line of C10 and C11; the sweep of C5) and
  `test/vectors/hello.json` (the hello with `features`, and the `ok:false` answer to
  `set_allowlist`).

**The tabs of a session that ended (board ab-v16.41).** The receiver closes them itself at a
`set_scopes` that gives their scope no list (C5, the sweep), also while no relay runs, and it keeps
its tab-to-scope map over a link drop and a daemon restart (C10, each tab's scope). The reasons and
the measurements: the orphan-tabs design, sections 4, 10, 12 and 15. The daemon's rules for it
(the design's section 15; aw-lead agreed with rules 1 to 5 and declined rule 6, mails m9e1ad35 and
m1c19e2a):

1. The first `set_scopes` on each connection names every live session. After a daemon start the
   daemon sends it only after its first complete read of its sessions: a failed read sends nothing,
   and a good read of zero sessions sends an empty `scopes`. A `scopes` that leaves out a live
   session closes that session's tabs. A session that ended while the link was down, while no relay
   ran, or while the daemon was down is not in it, so its tabs close then, with no `end_scope`.
2. A scope name that comes back. A scope that ended stays out of at least one `set_scopes` that the
   receiver answered `ok` (with a `default` list: is `null` in it) before any `set_scopes` names it
   again. The daemon splits a merged update that holds the end and the launch of one name into two
   `set_scopes`, and sends the second after the `ok` of the first. The reason: the map stays over a
   link drop, so a new session of the same name in the same gap would get the old session's tabs.
   Over a daemon restart the rule needs no daemon memory: no agentwatch session launches while the
   daemon is down (the daemon spawns them; the CLI, the web viewer and cron go through the gateway
   to the daemon), and the first `set_scopes` of rule 1 is answered before a launch's scope enters
   a `set_scopes`.
3. With a `default` list (choice 5 b) only: the daemon drops the `null` entry of an ended scope
   after the receiver answered `ok` to a `set_scopes` that holds it, not after a time and not at the
   next `link` up: else a scope that ended while the link was down falls back to the `default`
   list, and its tabs stay. The `null` entries live in the daemon's memory only. So with 5 b a scope
   that ended while the daemon was down falls back to the `default` list after the restart, and the
   sweep does not close its tabs (a limit; with 5 a it does not exist). A read of the scopes of the
   receiver's map at each link up (`bridge.tabScopes`, C10) would close it; aw-lead builds that only
   if the operator takes 5 b.
4. `end_scope` stays as it is (C10, C11), and the daemon keeps no line for a relay that does not
   run. The sweep is the guarantee; `end_scope` is the fast path.
5. agentwatch documents the gap (its stage 4, B7) until it pins parts 1a, 2 and 3 together. Then the
   note goes.
6. Declined (aw-lead, mail m9e1ad35): the agent unit does not write `"session":
   {"restore_on_startup": 5}` into the profile, because that would override the operator's own
   setting. So with the operator's "Continue where you left off" the pages of an earlier browser run
   open again as tabs of no scope: they fail closed, and the sweep never closes them (C5). If that
   limit ever matters, it is an operator decision.

### C5. The allowlist and the block

- File `CONFIG_DIR/browser/allowlist.json` = `{"allow": ["example.com", ...]}` (agent-browser's
  format; the daemon writes it with `statefiles.write_json`). It stays the list of agent-browser's
  CDP proxy. The lists of agent mode come in `set_scopes` (C4); agentwatch decides where it keeps
  them (the per-scope design, section 8.1).
- An entry is a hostname: trimmed, lowercased, a trailing dot removed, Unicode labels to punycode
  (IDNA), at least two labels, each label 1-63 of `[a-z0-9-]` not starting or ending with `-`, total at
  most 253; no scheme, port, path, `*` or IP address. A pasted URL is refused with the hint "paste the
  host only" (the web viewer strips a URL to its host before it sends). An entry covers itself and
  every subdomain (O10).
- Before parsing, an entry is refused when it holds an ASCII character outside `[A-Za-z0-9.-]`, a
  character of Unicode category C (control, format, unassigned, private use), one of the dots U+3002,
  U+FF0E, U+FF61, or `ß` (U+00DF) or `ς` (U+03C2) ("use the punycode form": JavaScript's URL and
  Python's IDNA map these differently). After IDNA the entry matches `^[a-z0-9.-]+$`. A refusal
  reason never echoes the input; an empty label says "a label is empty".
- Each tab has at most one scope (C10, each tab's scope), and each scope at most one list
  (`set_scopes`, C4: its `scopes` entry when it has one, else `default`). A **tab's list** is its
  scope's list. A marked tab (C10, the operator mark of the design's choice 3) has no scope; its
  list is its `operator` value: `"*"` (any site), a list, or none (`null`: the tab fails closed, as
  a tab with no list). Any other tab of no scope, and a tab whose scope has no list, has no list.
- The DNR rules. The per-scope design's probe measured them (Chromium 156, 2026-11-04), unless a
  rule names another measure.
  - Static rule 1: the receiver's static ruleset `block_main_frame` (`rules/block-main-frame.json`,
    enabled in the manifest): rule id 1, priority 1, `{"type":"block"}`, `resourceTypes:
    ["main_frame"]`. So the block holds from Chromium's first moment, before the service worker
    runs.
  - Static rule 3, the frame rule (two-modes design, sections 7 and 8): the static ruleset
    `block_frames` (`rules/block-frames.json`, enabled in the manifest): rule id 3, priority 1,
    `{"type":"block"}`, `resourceTypes: ["sub_frame", "object"]` (an `<object>` or `<embed>`
    document is type `object`). A CDP client can make a top-level document with no request
    (`about:blank`, `setContent`) and put any host in a frame, an `<object>` or an `<embed>` there;
    rule 3 and the frame rule of each list (below) load such a document only in a tab whose
    top-level domain is on the tab's list. A page of a site on the tab's list still loads them from
    any host (O11). Measured on Chromium 156 with one list for all tabs (before board task
    ab-v16.30): no frame, `<object>` or `<embed>` document loads under an `about:blank` tab, also
    from an allowlisted host; under an allowlisted page all three load, also from an off-list host;
    an `about:blank` popup of an allowlisted page loads them too. Measured with the scope rules:
    under a scope-A page a frame of an off-list host loads; under `about:blank` of a scope-A tab and
    of a tab of no scope, rule 3 blocks it. `topDomains` needs Chrome 141; the receiver's
    `minimum_chrome_version` is 145, a safe minimum.
  - Dynamic rule 5, the navigation-header rule (two-modes design, sections 7 and 8): rule id 5,
    priority 3, `{"type":"modifyHeaders",
    "requestHeaders":[{"header":"sec-fetch-site","operation":"set","value":"none"}]}`,
    `resourceTypes: ["main_frame"]`, `initiatorDomains` = the receiver's own ID (`chrome.runtime.id`),
    `regexFilter` = `^(https://|http://(localhost|[^/:]+\.localhost|127\.[0-9]+\.[0-9]+\.[0-9]+|\[::1\])(:[0-9]+)?/)`.
    Chrome names the extension as the initiator of a top-level request that it starts (a bridge
    `Page.navigate`), so without the rule a `Page.navigate` sends `Sec-Fetch-Site: cross-site`.
    Chrome sends `Sec-Fetch-*` headers only to a potentially trustworthy URL (`https:`, and `http:`
    to `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`), so the `regexFilter` keeps the rule
    to those: a `Sec-Fetch-Site` on another `http:` URL would mark the agent browser. Measured on
    Chromium 156: a `Page.navigate` sends `none` and `Sec-Fetch-User: ?1`, as a typed URL; a page
    script's navigation keeps `same-origin`; a `Page.navigate` to an off-list host is still blocked;
    a `Page.navigate` and a page script's navigation to a plain-`http:` host that is not localhost
    send no `Sec-Fetch-*` header. Chrome applies a `modifyHeaders` rule only above the priority of
    every `allow` rule that matches, so its priority is above the scope rules' (2); measured with a
    scope rule: `Sec-Fetch-Site: none`, 20 of 20. The receiver writes rule 5 at each `set_scopes`,
    in one `updateDynamicRules` call that also removes the dynamic ids 2 and 4.
  - Dynamic rules 2 and 4 are gone. Before board task ab-v16.30 they allowed the one list in every
    tab (rule 2: `requestDomains`, main frames; rule 4: `topDomains`, frames). The receiver removes
    ids 2 and 4, and every session rule, as the first thing that its worker does at its start, and
    removes ids 2 and 4 again at each `set_scopes`: a package before part 1a (board ab-v16.31)
    leaves them in the profile, and dynamic rules stay after a browser restart (measured). Between
    an update of the package and that start, the old rules 2 and 4 still allow the old one list in
    every tab (the upgrade window).
  - The **scope rules** are session rules (`updateSessionRules`). For each list L that has at least
    one entry and is the list of at least one open tab: one rule with priority 2,
    `{"type":"allow"}`, `requestDomains` = L, `resourceTypes: ["main_frame"]`, `tabIds` = the tabs
    whose list is L (marked tabs with `"operator":"<L>"` included); and one rule with priority 2,
    `{"type":"allow"}`, `topDomains` = L, `resourceTypes: ["sub_frame", "object"]`, the same
    `tabIds`. Their ids are 100 and up, two per list; the receiver picks them. A list with no open
    tab whose list it is, or with no entry, has no rule; a list that only marked tabs use has its
    two rules too.
  - The import's rules (C6): session rule id 6, priority 2, `{"type":"allow"}`,
    `requestDomains` = [the import's `domain`], `resourceTypes: ["main_frame"]`, `tabIds` = [the
    restore tab]; and session rule id 7, priority 2, `{"type":"allow"}`, `topDomains` = [the same
    `domain`], `resourceTypes: ["sub_frame", "object"]`, the same `tabIds`. They hold from C6 step 2
    until the restore tab's last navigation (C6, the import's rules).
  - The marked-tab rule (with choice 3 of the design; C10 gives the operator mark): with
    `"operator":"*"`, session rule id 8, priority 2, `{"type":"allow"}`, `resourceTypes:
    ["main_frame", "sub_frame", "object"]`, `tabIds` = the marked tabs, no host condition. No rule 8
    while no tab is marked (DNR refuses an empty `tabIds`). With `"operator":"<list>"`, the marked
    tabs join the `tabIds` of that list's two scope rules. With `null`, they have no rule.
  - Each change is one `updateSessionRules` call, and the changes run one after the other, each from
    the map when it runs. A `set_scopes` replaces every scope rule and rule 8. A tab that gets or
    loses a scope replaces only the two rules of its list (of both lists when it changes lists). A
    tab that gets or loses the mark replaces rule 8 (with `"*"`) or its list's two rules. At each
    disconnect and each new daemon connection the receiver keeps every session rule, the map and the
    marks, and the last `operator` value (C10, what stops a handler; board ab-v16.41): a link drop
    or a daemon restart does not take a live session's tabs out of their lists, and the next
    `set_scopes` replaces the scope rules and rule 8 in full. At its worker's start every session
    rule goes (rules 6, 7 and 8 too). The reason: a page can navigate by itself while the link is
    down (a redirect, the callback of a sign-in, a `meta refresh`); with its rules kept it stays
    under its own list, with them removed it would fail closed and show an error page.
  - A failed `updateSessionRules` (the rule limit, a Chrome error) fails closed: the receiver
    removes every scope rule and rule 8 with a remove-only call and keeps the map and the marks, so
    the tabs of every scope are blocked until the next update that succeeds; that next update is a
    full replace from the map. A failed `set_scopes` answers `ok: false` after the tabs close (the
    closing rule runs with the new lists). If the remove-only call fails too, old rules can stay in
    force: the guard below still judges each navigation by the new lists of the map, the closing
    rule still runs, and every later change is a full replace until one succeeds.
- So a tab of no list matches no allow rule and fails closed. Session rules go at a browser restart
  and at an extension reload or update (measured: none left after a restart). Until the first
  `set_scopes` after the worker's start, every main frame and every frame is blocked, except the
  restore tab of an import (rules 6 and 7).
- DNR decides when a request starts, before the hold's `Fetch` pause (measured: a request of a tab
  with no rule was blocked at once, 10 of 10, and never paused). So a tab's rule must be in force
  before its first request; C10 says how (each tab's scope).
- The limits (measured): at most 5000 session rules (`MAX_NUMBER_OF_SESSION_RULES`; the 5001st is
  refused with "Session rule count exceeded."). A rule took 100,000 entries and 10,000 tab ids. At
  two rules per list, about 2,490 lists can be in use at once.
- The worker removal. A site's service worker answers a navigation to its host before DNR sees it
  (measured on Chromium 156: a link to a host that had left the list loaded the worker's page; the
  guard below gives the measures per scope). So the receiver calls `browsingData.remove({},
  {serviceWorkers: true})` (permission `browsingData`) after the rule update and before the tabs
  close, at the first `set_scopes` after its worker starts, and in one case only after that: a
  scope has a list in the last and in the new `set_scopes` (its `scopes` entry, else the `default`
  list), and the new list lacks an entry of the old one. A new scope, a scope that leaves the map,
  and a scope whose new list is none (an ended session's `null`, a list that is gone) do not remove
  the workers: their tabs are blocked and close, so no tab of them can reach a worker. The
  `operator` value counts as one more scope's list: a change from `"*"` to a list, or a list that
  loses an entry, removes the workers too. The entries count, not the list names; "the last" is the
  last `set_scopes` that applied in full. A failed removal fails the call (`ok: false`) after the
  tabs closed; the next call removes again.
- The closing rule: on each `set_scopes` the receiver closes every tab whose `http:`/`https:` host
  its list does not cover; for a marked tab, its `operator` value counts (with `"*"` it never
  closes; with a list name, that list; with `null` no list, so its `http:`/`https:` page closes);
  for a tab of no scope, the union of the lists counts, except for a tab of the orphan set (the
  sweep, below), which has no list (so an unmarked operator's tab and the page
  of a finished import stay while a list covers them). It never closes the restore tab of a running
  import. A window closes with its last tab, except the browser's last window: there the receiver
  first opens `about:blank`, so that Chrome does not end. (With one window per page, agent-browser
  PR #44, an `about:blank` in place of each closed page would leave an empty window for each.) In
  the per-scope build its closes run in the receiver's one removal queue, by the receiver's close
  (`Target.closeTarget`, no `beforeunload`), with the window rule and the pending closes of C10
  (removals and the last window; board ab-v16.41).
- The sweep (board ab-v16.41; the orphan-tabs design, section 4): on each applied `set_scopes` the
  receiver also closes every tab whose scope the new object gives no list (its `scopes` entry is
  `null` or names a list that is not in `lists`, or it has no entry and `default` gives no list),
  whatever its URL, `about:blank` too. It is a part of the closing rule: the same `tabs.query`, the
  same removal queue and window rule (C10), the same count in `closed`, before the answer, also when
  the rule update fails. With `default` `null` that is every tab of a session that ended, also of
  one that ended while the link was down or while no relay ran. A tab of no scope never closes by
  the sweep (C10, each tab's scope: the operator's tabs, an import's restore tab, the `about:blank`
  tab of the window rule, a tab whose entry was lost), except a tab of the orphan set (below). The
  sweep closes a tab with a pending close again, by the receiver's close (C10): a `beforeunload`
  dialog of a client's `Page.close` cannot keep a tab of an ended session in its scope.
  - A tab that the sweep's item does not close leaves its scope at the end of that item. There are
    two cases. (1) Its close failed, or it is still pending when the item ends: for example the
    fallback's `chrome.tabs.remove`, which a `beforeunload` dialog holds (C10); that needs a failed
    attach, a `beforeunload` handler and a user activation of the page. (2) The item's window rule
    failed or came late (C10): then no close starts, and no dialog opens. The tab leaves the map,
    and its key leaves the copy (the answer waits for that removal, C4). The receiver keeps its id
    in the **orphan set**, in memory, until its `tabs.onRemoved`. `bridge.tabScopes` no longer
    lists it, and no session sees it. The relay drops it from its model at its next `allowlist`
    line: the line of that `set_scopes`, or a later one after an `ok: false` or a late answer (C11,
    when a connection ends). So a later session of the same name never gets the tab (C4, rule 2 of
    the tabs of a session that ended). It does not count in `closed`.
  - A tab of the orphan set fails closed: the guard and the closing rule treat it as a tab with no
    list, not by the union of the lists, so no navigation of it loads, and the closing rule closes
    its `http:`/`https:` page. Each later sweep item closes it again by the receiver's close,
    whatever its URL, `about:blank` too. The limits: in case 1 the tab stays open until someone
    accepts the dialog or a later sweep item closes it; after a dismiss the page stays, and the held
    `chrome.tabs.remove` call does not end (measured, C10). After a worker start the orphan set is
    gone: such a tab is then a plain tab of no scope, judged by the union of the lists, and the
    sweep never closes it.
  - An **applied** `set_scopes` is one whose `scopes` and `lists` are objects. At any other the
    receiver sweeps nothing: C4 applies such a field as an empty object, so every scope would have
    no list, and one bad message would close every agent tab. The rest of it applies as C4 says, so
    the tabs fail closed until an applied one comes. "The first applied `set_scopes`" after the
    worker's start is the first such one (a bad first one does not sweep).
  - A new applied object becomes the receiver's last applied `set_scopes`, the reference of C10's
    checks of a new entry, at its rule update, before the sweep's `tabs.query`. So a `tabs.create`
    of a scope that the new object gives no list, during the sweep, gets C10's `no list for this
    scope`.
  - A refused entry follows what applies (C4): a scope whose entry applies as `null`, or whose list
    applies as absent, has no list, and its tabs close. The daemon never sends one.
  - The shared vector: `sweep` in `test/vectors/scopes.json`.
- The guard (the operator's choice 2 of the design can replace it with a block of service workers):
  a site's service worker answers a navigation before DNR sees it, also in a tab of a scope whose
  list lacks the site. Measured: a scope-B tab loaded a scope-A site's worker page, 20 of 20; a
  worker that passes the navigation on (`fetch(event.request)`) loaded the page from the network in
  a scope-B tab, 5 of 5, with no DNR match (in its own scope it loaded too, so no site breaks);
  navigation preload is a `main_frame` request of the tab and was blocked in the scope-B tab, 5 of
  5, for a worker that does not fall back to `fetch()` (one that falls back loads the page as
  above). So at each main-frame `webNavigation.onBeforeNavigate` and `webNavigation.onCommitted` of
  an `http:`/`https:` URL, or a `blob:` URL with such an inner origin, whose host the tab's list
  does not cover (for a tab of no scope: the union of the lists, but every host for a tab of the
  orphan set, the sweep above; for the restore tab: its `domain`; for a marked tab: nothing with
  `"*"`, the named list with a name, every host with `null`), the
  receiver sends the tab to `about:blank` (`tabs.update`) and sends `blocked`. `onCommitted` also
  catches a redirect from a host of the list to a worker's host (a redirect fires no new
  `onBeforeNavigate`). A page's own navigation was stopped before its commit 10 of 10; a page that
  commits runs its scripts until the receiver acts (measured: `tabs.update` answered 50 to 75 ms
  after the navigation started). The relay refuses a client's `Page.navigate` and
  `Target.createTarget` off the scope's list itself (C11, the refusals). The guard stops the page,
  not the request of a worker that passes the navigation on: with both receiver layers on, no page
  of such a worker committed in a scope-B tab (0 of 10), but its request reached the site in 10 of
  10, with the site's cookies, and the site's answer came back to the worker (ab-lead's reviewer).
- `blocked`: a main-frame `webNavigation.onErrorOccurred` with `net::ERR_BLOCKED_BY_CLIENT` sends
  `blocked` (C4) with the host and the tab's scope. One navigation sends at most one `blocked` (the
  guard and `onErrorOccurred` can both see it). C10's retry decides the notice of a popup's first
  request; a retried request that is blocked again sends `blocked` (there is no second retry).
- Stage-2 limit (not handled now): a tab whose back/forward cache holds a page of a removed host may go
  Back to it with no request, so DNR does not block it. The guard's `onCommitted` check also covers
  a page that Chrome restores from the cache and reports there (not measured).

### C6. The restore page (the receiver's import)

1. Close every tab whose origin equals `origin` (they hold the state being replaced, and a page of
   the origin could write a cookie during the swap; C5's rule for the browser's last window applies;
   in the per-scope build these closes, and the closes of the restore tab in step 5, run in the
   removal queue of C10, by the receiver's close and with its window rule). Then (measured: a
   partitioned cookie of an http secure-context test site, `*.localhost`, does not move with this
   URL rule; https sites are not affected) remove every cookie of `domain` and its subdomains
   (`getAll({domain})` and `getAll({domain, partitionKey: {}})`), then `cookies.set` each sent
   cookie (C2 -> set details: `url` = `https://` if secure else `http://`, the domain without a
   leading dot, the path; `domain` only when not `hostOnly`; `expirationDate` only when not
   `session`; `sameSite` and `partitionKey` as sent).
2. `tabs.create({url: "about:blank", active: true})`, the import's rules (below),
   `debugger.attach({tabId}, "1.3")`, `Network.enable`, `Network.setBypassServiceWorker({bypass:
   true})` (measured: the bypass needs the Network domain on), `Fetch.enable({patterns: [{urlPattern:
   R, requestStage: "Request"}]})` with `R = origin + "/__agentwatch_restore_" + <16 hex chars> +
   "__"`, `tabs.update(tabId, {url: R})`; on `Fetch.requestPaused` for `R`: `Fetch.fulfillRequest`
   200, headers `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-store`, body
   `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>agentwatch</title>`.
3. After `webNavigation.onCompleted` for `R` in that tab: `executeScript({files: ["lib/codec.js"]})`,
   then `executeScript({func: replacePageState, args: [JSON.stringify(state.storage), R]})` (one
   JSON string: `executeScript` drops null-valued properties; `R` for the page's own check).
   `replacePageState` clears localStorage, sessionStorage, every IndexedDB database of the origin
   and every cache, then writes the sent ones, and returns counts and errors. It first checks that it runs on the restore page
   (title "agentwatch", no script elements, `location.href === R`) and else touches nothing.
4. `Fetch.disable`, `debugger.detach`, then `executeScript({func: (u) => location.replace(u), args:
   [state.url]})`.
5. Any step that fails: detach, close the restore tab, answer `ok: false` with the step's name. Each
   step has a 20 s deadline, except "write storage", which has 60 s; the whole import has 100 s, and
   each of the two cleanup calls at most 4 s, so an import ends before the link's 115 s answer and
   the daemon's 120 s wait. One import at a time; a second waits.

**The import's rules (board ab-v16.23).** In step 2, after `tabs.create` and before
`tabs.update(tabId, {url: R})`, the receiver adds the import's rules (C5: session rules 6 and 7,
`domain` for the restore tab only, main frames and frames). They allow `domain` whatever the lists
hold, so the restore page and step 4's `location.replace` load. Step 4 starts that navigation in a
timer after its script returns, so the rules cannot go at the end of the step: the receiver removes
them at the restore tab's first main-frame `webNavigation.onCommitted` or `onErrorOccurred` after
step 4 (not matched to `state.url`: a redirect commits another URL), at most 4 s after step 4, and
in every failure cleanup (step 5). The import ends (its answer, and the next import of the queue)
only after the rules are gone, so two imports never share rules 6 and 7; the 4 s fit in the budget
(100 s, plus 4 s, plus two cleanups of 4 s each: 112 s, below 115 s). Until the rules go, C5's guard
judges the tab by `domain`. The restore tab is in no scope; after the import its page stays while a
list covers it (C5's closing rule), and it cannot navigate further or load new frames.

### C9. The two gateway routes, as the sender sees them

The sender calls only these two routes, on the web viewer origin of a box that the operator
added (the sender holds a host permission for it). Both carry the operator's web login cookie
(`credentials: "include"`). The gateway sends no CORS headers: the host permission makes the
answer readable.

| Route | What the sender sends | What the sender reads |
| --- | --- | --- |
| `GET /api/browser/targets` | No body, `redirect: "error"`. Chromium sends **no `Origin`** on this GET (`Sec-Fetch-Site: none`; measured on Chromium 156, 2026-11-01). | 200: `{"box": "<host>", "users": [{"name", "supported", "running", "password_login": bool}]}`, also inside `{"ok": true, "data": ...}`. The popup offers only users with `password_login: true`; one with `supported: false` is greyed out and cannot be chosen ("No agent browser on this box for <user>."). 401 or 403: "Log in to <box> first." |
| `POST /api/browser/send?user=<name>` | The C2 JSON, `Content-Type: application/json`, `redirect: "error"`, at most 33,554,432 bytes (a larger state is refused in the sender, naming the largest database or cache; the page reader stops reading above the limit). Chromium sends `Origin: chrome-extension://bpfkgknpndlpkcffmaaelkfcbpackiip`. | 200: the C4 import counts at `data.counts` (also `counts`, `data` or the top level). 403 with `error_code` `password_login_required`: log in with a password. 401: log in. 413: too large. 409 `browser_unsupported`: no agent browser on that box. `browser_receiver_missing`: "The agent browser on <box host> does not answer. Look at its Browser page." `browser_start_failed`: "... does not start. ..." `browser_disabled`: "The agent browser is turned off on <box host>." `browser_payload_invalid`: "The box refused the send as malformed." `browser_import_failed` (502): "The agent browser on <box host> could not import the site. Look at its Browser page." `browser_config_invalid` (409): "The agent browser settings on <box host> are not valid. ..." For these `browser_*` codes the gateway's `errmsg` follows the fixed text when present. `daemon_disconnected` (503): "The daemon of this user on <box host> is not connected. ..." `user_not_logged_in` (403): "This login on <box host> is not a login of that user. Log in as that user, then send again." (with the login link). `user_required` (400): "This login on <box host> is for several users. Choose a user, then send again." 504 and 524 (Cloudflare's 100 s limit): "The box did not answer in time. The send may still finish: look at its Browser page." Any other status: refused. |

The gateway's check (EXTENSION auth): any `Authorization` header gives 403. A GET or HEAD needs no
`Origin`, but any `Origin` other than `chrome-extension://<sender ID>` gives 403. A POST needs that
exact `Origin`, else 403. Then the login cookie session, else 401. A login without
`password_login_for` gives 403 `{"error_code": "password_login_required"}`.

### C10. The bridge (relay <-> daemon <-> receiver)

In agent mode, a browser model drives the agent Chrome through the receiver. The model is
agent-browser's relay (C11). The bridge is a fixed list of `chrome.*` calls (the ops) and the
`chrome` events that the receiver forwards. The receiver has no CDP logic, except the hold of a new
tab and, in the per-scope build, its removal queue (a client's `Page.close`, and its own close by
`Target.closeTarget`: removals and the last window, below). This file is the master for C10. The
vectors: `test/vectors/bridge.json`.

| Part | Side | Stage of the two-modes design |
| --- | --- | --- |
| The ops, the checks, the events, the receiver's waits, the result parts, the hold, the stop rules | The receiver (this repo: `agent/`) | 2 (board ab-v16.5) |
| The requests and their waits, `MAX_IN_FLIGHT_PER_TAB`, the actions after a timeout, its standard input and output | agent-browser's relay (`agent-browser relay`) | 3 (board ab-v16.6) |
| The parts to the receiver, the join of result parts, `MAX_BYTES_IN_FLIGHT`, the daemon's waits and answers, the lines to the relay, the relay's start and stop | The agentwatch daemon | 4 (board ab-v16.7) |

Two words. A **bridge tab** is a tab that the bridge attached (`debugger.attach` or the eager
attach, below) and did not detach since. The **hold** is a different thing: the receiver holds the
first document request of a new tab (below).

**The path of a message.**

- The relay writes each request as one line of JSON on its standard output. The daemon reads the
  line and sends the request to the receiver in C4 parts on channel `bridge` (`"ch":"bridge"`,
  `PART_BYTES = 700000`).
- The receiver answers each request with one `res` on channel `bridge`: one message, or result parts
  for a large res (below). It sends events as `ev` messages on channel `bridge`. The daemon writes
  each res and each event as one line on the relay's standard input. It changes no field, and it
  writes them in the order in which it read them (a res in parts takes the place of its last part).
- So Chrome's order stays the same from the receiver to the relay. An event that Chrome fires
  before the answer to a command reaches the relay before that answer. There are two exceptions,
  both for a new tab's `tabs.onCreated` (each tab's scope, below): while the eager attach is on,
  the receiver holds the `tabs.onCreated` of a popup whose hold is on; while it is off, the
  receiver sends a new tab's `tabs.onCreated` after the tab's
  `webNavigation.onCreatedNavigationTarget`, or 50 ms late when none comes. Other events of that
  tab then go before its `tabs.onCreated`.

**Requests.** `{"t":"req","id":"<id>","op":"<op>","args":[...],"wait":<ms>}`.

- `id` is a string. It is unique on the bridge channel. The relay picks a random prefix of 8 hex
  digits at its start and counts after it (for example `5f3a9c01-17`). So a late answer to a request
  of an earlier relay never matches a new request.
- `op` is one of the ops below. `args` is the list of the op's arguments, in order. A request
  without `args` has `[]`.
- `wait` is the deadline (below). The relay always sends it.
- The receiver ignores a request field that it does not know.
- The daemon drops a line from the relay that is not a JSON object with `"t":"req"`, a string `id`
  and a string `op`. It logs the line's length only.
- The receiver checks a request in this order. A request that fails a check never reaches Chrome.
  1. The op: else `unknown op`.
  2. The args: their count, then the kind of each arg; else `bad args`.
  3. The wait: else `bad wait`.
  4. The tab: `not an agent tab` or `not attached` (below). For `tabs.create` and
     `windows.create`, the scope: `no list for this scope` (each tab's scope, below).
- The kinds of args:
  - `id`: an integer of 0 or more (a tab, window or download id).
  - `object`: a JSON object. `string`: a string that is not empty. `boolean`: true or false.
  - `target`: `{"tabId":<id>}` or `{"tabId":<id>,"sessionId":"<child session>"}`, with no other key.
  - `contentType`: one of `location`, `notifications`, `camera`, `microphone`, `clipboard`,
    `automaticDownloads`.
  - `scope`: a scope of C11, a string that matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
  - `newTab` (`tabs.create`): an object with `url`, and at most `active` (a boolean), `windowId` and
    `index` (ids). `url` is `about:blank`.
  - `tabUpdate` (`tabs.update`): exactly `{"active":<boolean>}`. A navigation is `Page.navigate`.
  - `newWindow` (`windows.create`): an object with `url` (`about:blank`, one string), and at most
    `focused` (a boolean), `left`, `top`, `width`, `height` (integers) and `state`. It has no
    `tabId`: no op moves a tab to another window.
  - `windowUpdate` (`windows.update`): an object with at least one of `left`, `top`, `width`,
    `height`, `state` and `focused`, and no other key.
  - `contentDetails` (`contentSettings.set`): exactly `primaryPattern` and `setting`. `setting` is
    `allow` or `block`. `primaryPattern` is `<scheme>://<host>/*` or `<scheme>://<host>:<port>/*`.
    `<scheme>` is `http`, `https` or `*`. `<host>` is a host that a list of the receiver's last
    applied `set_scopes` covers (C4, C5: any list, because the receiver does not know which scope
    calls), with or without `*.` before it.
  - A new tab or window opens at `about:blank` only: it makes no request before its scope rule is in
    force (each tab's scope, below). So a bridge op never opens a site, a `chrome:`, `file:` or
    `javascript:` URL, or Chrome's New Tab page. A navigation is `Page.navigate` (C11 checks its URL).
- The tab checks:
  - `not an agent tab`: `debugger.attach`, `debugger.detach`, `tabs.update` and `tabs.remove` of the
    restore tab of a running import (C6); `debugger.attach` of a tab whose `url` or `pendingUrl` is
    in the receiver's own origin (`chrome-extension://<receiver id>/`); and, with the design's
    choice 3 (part 1d), `debugger.attach`, `tabs.update` and `tabs.remove` of a marked tab (each
    tab's scope, below). No connection sees a marked tab, so this check is a second layer.
  - `not attached`: `debugger.sendCommand` for a tab that is not a bridge tab. So a command never
    goes through the import's attachment.

**Answers.** `{"t":"res","ch":"bridge","id":"<id>","ok":true,"data":<result>}` or
`{"t":"res","ch":"bridge","id":"<id>","ok":false,"error":"<text>"}`.

- `data` is the op's result: an object, a list or `null`. It is never left out.
- The receiver's error texts: `unknown op`, `bad args`, `bad wait`, `not an agent tab`,
  `not attached`, `no list for this scope` (`tabs.create`, `windows.create`: each tab's scope,
  below), `timeout`, `too large` (a res above `MAX_RESULT`), and the text of a `chrome.*` error as
  Chrome gives it (for example `No tab with id: 7.`).
- The relay gets exactly one res for each request: the receiver's, or one from the daemon. The
  daemon's answers have the same shape,
  `{"t":"res","ch":"bridge","id":"<id>","ok":false,"error":"<text>"}`, with these texts:
  - `not connected`: no receiver with channel `bridge` is connected. The daemon answers at once.
  - `disconnected`: the link dropped while the request waited or ran.
  - `timeout`: the deadline (below).
  - `too large`: the receiver's result parts announce more than `MAX_RESULT` (n above 32).

**Results in parts.**

- A res whose JSON is at most `MAX_TO_DAEMON = 8388608` bytes (C4) goes as one message.
- A larger res, up to `MAX_RESULT = 134217728` bytes (128 MiB) of UTF-8 JSON, goes in parts. The
  receiver cuts the res's compact UTF-8 JSON into slices of `RESULT_PART_BYTES = 4194304` bytes (the
  last one may be shorter). It sends slice `i` as
  `{"t":"part","ch":"bridge","id":"<id>","seq":<i>,"n":<count>,"b64":"<base64>"}`, as C4's parts
  in the other direction. Each part message is below 6 MiB.
- The receiver sends all parts of one res in one go: no other message comes between them.
- The daemon joins the parts of one id in `seq` order when all `n` arrived. It writes the joined
  bytes, the res, as one line to the relay. A part sequence with n above 32 (more than
  `MAX_RESULT`) gets the daemon's `too large`. When another message comes before the last part, the
  daemon drops the unfinished res, and its request gets the daemon's `timeout`.
- A res above `MAX_RESULT` goes as `too large`. An event never goes in parts (`bridge.tooLarge`,
  below).
- The vector: `resultParts` in `test/vectors/bridge.json` (made with `splitParts` of
  `agent/wire.js`).

**The ops.** An arg name with `?` is optional. The default wait is the deadline of a request without
`wait`.

| Op | Args | Result | Default wait | What the receiver does |
| --- | --- | --- | --- | --- |
| `debugger.attach` | `[tabId]` | `{"already": <bool>}` | `WAIT_DEFAULT_MS` | `chrome.debugger.attach({tabId}, "1.3")`. `already` is true for a bridge tab. A second attach of a tab while one is in flight joins it: both get its answer, the second with `already` true. |
| `debugger.detach` | `[tabId]` | `null` | `WAIT_DEFAULT_MS` | Releases a hold of the tab, then `chrome.debugger.detach({tabId})`. A tab that is not a bridge tab also answers `null`. |
| `debugger.sendCommand` | `[target, method, params?]` | the CDP result | `WAIT_MAX_MS` | `chrome.debugger.sendCommand(target, method, params)`; a missing `params` goes as `{}`. In the per-scope build a `Page.close` on the tab's own session runs in the removal queue (removals and the last window, below). |
| `debugger.getTargets` | `[]` | `[TargetInfo]` | `WAIT_DEFAULT_MS` | `chrome.debugger.getTargets()`. |
| `tabs.create` | `[createProperties, scope]` | `Tab` | `WAIT_DEFAULT_MS` | `chrome.tabs.create(createProperties)`. The new tab gets the scope; the op answers when the tab's scope rule is in force and its key is in the copy (each tab's scope, below). In the per-scope build a scope that the last applied `set_scopes` gives no list gets `no list for this scope`, and no tab. |
| `tabs.get` | `[tabId]` | `Tab` | `WAIT_DEFAULT_MS` | `chrome.tabs.get`. |
| `tabs.query` | `[queryInfo]` | `[Tab]` | `WAIT_DEFAULT_MS` | `chrome.tabs.query`. |
| `tabs.update` | `[tabId, updateProperties]` | `Tab` | `WAIT_DEFAULT_MS` | `chrome.tabs.update`. |
| `tabs.remove` | `[tabId]` | `null` | `WAIT_DEFAULT_MS` | `chrome.tabs.remove`. In the per-scope build: the receiver's close (`Target.closeTarget` through `chrome.debugger`, no `beforeunload`), in the removal queue, with the window rule (removals and the last window, below). |
| `windows.get` | `[windowId, queryOptions?]` | `Window` | `WAIT_DEFAULT_MS` | `chrome.windows.get`. |
| `windows.create` | `[createData, scope]` | `Window` | `WAIT_DEFAULT_MS` | `chrome.windows.create(createData)`. The window's tab gets the scope, as for `tabs.create`, also its error `no list for this scope`. |
| `windows.update` | `[windowId, updateInfo]` | `Window` | `WAIT_DEFAULT_MS` | `chrome.windows.update`. |
| `downloads.search` | `[query]` | `[DownloadItem]` | `WAIT_DEFAULT_MS` | `chrome.downloads.search`. |
| `downloads.cancel` | `[downloadId]` | `null` | `WAIT_DEFAULT_MS` | `chrome.downloads.cancel`. |
| `contentSettings.set` | `[type, details]` | `null` | `WAIT_DEFAULT_MS` | `chrome.contentSettings[type].set(details)`. |
| `contentSettings.clear` | `[type]` | `null` | `WAIT_DEFAULT_MS` | `chrome.contentSettings[type].clear({})`. |
| `bridge.info` | `[]` | an object (below) | `WAIT_DEFAULT_MS` | The receiver's own op. |
| `bridge.attachNew` | `[on]` | `null` | `WAIT_DEFAULT_MS` | Turns the eager attach on or off (the hold, below). |
| `bridge.release` | `[tabId]` | `null` | `WAIT_DEFAULT_MS` | Ends the hold of the tab (below). A tab with no hold also answers `null`. |
| `bridge.tabScopes` | `[]` | `[{"tabId":<id>,"scope":"<scope>"}]` | `WAIT_DEFAULT_MS` | The receiver's own op (board ab-v16.41): every entry of the tab-to-scope map at the moment of the answer (each tab's scope, below). |

- `bridge.tabScopes` answers one item for each tab that has a scope in the map, in no set order: a
  tab of no scope and a marked tab are not in it. The receiver sends its events in Chrome's order,
  so an event that came before the answer is already in it, and each later event applies on top of
  it. The relay calls it at each link up (the daemon and the relay, below). Its key in
  `MAX_IN_FLIGHT_PER_TAB` is the shared key. The vector: its request in `test/vectors/bridge.json`.
- `bridge.info` answers `{"bridge":1,"version":"<manifest version>","id":"<extension id>","userAgent":"<navigator.userAgent>","fullVersion":"<version>"}`.
  `bridge` is the version of this contract, `BRIDGE_VERSION = 1`. `fullVersion` is the version of
  the brand "Google Chrome", else of "Chromium", in `navigator.userAgentData`'s `fullVersionList`;
  it is `""` when neither is there. The relay uses them for `Browser.getVersion`.
- No op changes a list or the entries of a DNR rule, runs the import, or reads or writes page
  storage. `tabs.create` and `windows.create` only put the new tab under its scope's rules (C5).
- No op reads, sets or removes cookies: agent mode gives programs no cookie access (board ab-8mf,
  C11). The import's cookie work stays on channel `main` (C4, C6). A later cookie grant, for a use
  that needs cookie access, can add `cookies.*` ops here.

**Events.** `{"t":"ev","ch":"bridge","ev":"<event>",...}` with the fields below, and no other field.

| Event | Fields | When |
| --- | --- | --- |
| `debugger.onEvent` | `"source"` (`{"tabId":N}` or with `"sessionId"`), `"method"`, `"params"` | For a bridge tab. Never for the hold's own `Fetch` events, never for the import's restore tab. |
| `debugger.onDetach` | `"source"`, `"reason"` | For a bridge tab. |
| `tabs.onCreated` | `"tab"`, `"attached"`, `"held"`, and `"error"` when the eager attach failed | For each new tab. The receiver can hold it for a moment (the hold, and each tab's scope, below). |
| `tabs.onUpdated` | `"tabId"`, `"changeInfo"`, `"tab"` | When `changeInfo` has `url`, `title` or `status`. |
| `tabs.onRemoved` | `"tabId"`, `"removeInfo"` | For each tab. |
| `tabs.onReplaced` | `"addedTabId"`, `"removedTabId"` | For each tab. |
| `webNavigation.onCreatedNavigationTarget` | `"details"` | For each new navigation target. |
| `webNavigation.onErrorOccurred` | `"details"` (only `tabId`, `frameId`, `url`, `error`) | For the main frame only. |
| `downloads.onCreated` | `"item"` | For each download. |
| `downloads.onChanged` | `"delta"` | For each change. |
| `bridge.tabScope` | `"tabId"`, `"scope"` | When the receiver gives a tab a scope itself: a popup (its opener's), a replaced tab (its old one). Before the popup's `tabs.onCreated`, and before the replaced tab's `tabs.onReplaced` (each tab's scope, below). |
| `bridge.tooLarge` | `"of"` (the event), `"tabId"`, and for `debugger.onEvent` `"method"`, `"sessionId"` (of a child session) and `"requestId"` (of a `Fetch` event) | In place of an event above `MAX_TO_DAEMON`. |

- A bridge event never waits, like a res. The receiver sends it at once while the link is up, and
  drops it while the link is down. It never keeps or replays an event. A notice (`blocked`, C4) is
  different: it waits for the next link up. After a link change the relay builds its model again
  from the ops (in the per-scope build from `bridge.tabScopes` and `debugger.getTargets`: the
  daemon and the relay, below), so a lost event does no harm.
- The receiver sends no bridge event on a daemon connection before the first bridge request on that
  connection. So a daemon that does not use the bridge gets no bridge event.
- An event above `MAX_TO_DAEMON` (C4) is not sent. The receiver sends `bridge.tooLarge` in its place.
  Its `tabId` is the tab of the event: `source.tabId`, `tabId`, `addedTabId`, `tab.id` or
  `details.tabId`. A download event names no tab: its `tabId` is -1 (Chrome's `tabs.TAB_ID_NONE`).
  The relay logs the method and gives the client nothing. So that the page never waits for an
  answer that cannot come, the relay then takes a default action on the event's session (`tabId`,
  and `sessionId` when there is one):
  - `Fetch.requestPaused`: `Fetch.continueRequest` with the `requestId`.
  - `Fetch.authRequired`: `Fetch.continueWithAuth` with the `requestId` and
    `{"response":"CancelAuth"}`.
  - `Page.javascriptDialogOpening`: `Page.handleJavaScriptDialog` with `{"accept":false}`.
  - Any other event: no action.

**The order of requests.** The daemon sends the bridge requests in the order in which it read them.
The receiver starts them in the order in which their last parts arrive. It calls Chrome for a
request before it starts the next one: no `await` comes before the `chrome.*` call. So CDP commands
reach Chrome in the order in which the relay sent them. Playwright needs that, for example
`Runtime.enable` before `Runtime.evaluate`. One exception, in the per-scope build: a `Page.close`
waits in the removal queue (removals and the last window, below), and the later
`debugger.sendCommand` requests of the same tab wait until it went to Chrome, so the commands of
that tab still reach Chrome in the relay's order.

**The deadline.**

- Each request carries its wait in `wait`, in ms. A request without `wait` gets its op's default
  wait (the table): `WAIT_MAX_MS = 600000` (10 min) for `debugger.sendCommand`, and
  `WAIT_DEFAULT_MS = 30000` for every other op. A `wait` that is not an integer from 1 to
  `WAIT_MAX_MS` gets `bad wait`.
- A CDP command gets the largest wait because many of them wait on the page, and that is correct. For
  example, a click that opens `confirm()` gets no answer until the dialog closes, and the Playwright
  MCP leaves the dialog open while its model decides. `Runtime.evaluate` and
  `Runtime.callFunctionOn` with `awaitPromise` wait for a promise. So a CDP command fails only after
  10 minutes.
- The relay sends each op's default wait.
- The receiver answers `timeout` when an op runs `wait` ms.
- The daemon counts from when it read the request. A request that waited q ms in the daemon's queue
  (`MAX_BYTES_IN_FLIGHT`, below) goes to the receiver with `wait` minus q. When that is 0 or less,
  the daemon answers `timeout` and does not send the request.
- The daemon answers `timeout` itself when no res came `wait` + `WAIT_SLACK_MS = 2000` ms after it
  read the request. It then ignores the receiver's late res.
- The relay waits for the res: the daemon always sends one.
- The waits of channel `main` stay as in C4 (10 s and 120 s).

**What stops a handler.**

- After a timeout, the receiver drops the op's later result or error. It never sends a second res.
  It cannot stop a `chrome.*` call that started: Chrome runs it to its end.
- After a `debugger.sendCommand` that timed out, the relay acts by the command:
  - A command that waits for a promise does not lead to a detach: `Runtime.evaluate` or
    `Runtime.callFunctionOn` with `"awaitPromise":true`, and `Runtime.awaitPromise`. The relay
    gives the client the timeout error (C11) and leaves the tab as it is. Chrome ends the call when
    the promise settles, or when the page navigates and its context goes. Playwright's
    `waitForFunction` works like this: an abort only sets a flag in the page.
  - Any other command: the relay detaches the tab (`debugger.detach`). That ends the command in
    Chrome: a command in flight at a detach fails (the probe's matrix saw "Detached while handling
    command."). The relay tells the tab's client sessions `Target.detachedFromTarget`, then
    announces the tab again (C11).
- After a `debugger.attach` that timed out, the relay detaches the tab too, because the attach can
  still end later.
- At its worker's start, and at each disconnect (the native port closes) and each new daemon
  connection (a `link` up), the receiver:
  1. drops the answers of the bridge requests that still run, and every bridge request that waits
     in the removal queue or at the gate of a `Page.close` and has not gone to Chrome (in the
     per-scope build: removals and the last window, below);
  2. turns the eager attach off and releases every hold;
  3. detaches every bridge tab, and every tab that `chrome.debugger.getTargets()` reports as
     attached (a worker that started again knows no bridge tabs). It ignores the error of a detach.
     It never detaches the restore tab of a running import: that attachment belongs to channel
     `main`. In the per-scope build it never detaches the attach of a receiver's close that runs:
     the detach of a bridge tab goes into the tab's chain after the close, and a tab whose chain
     runs is not detached (as `reset()` of `agent/attach.js` does today). Measured: a detach before
     the close's command made the command fail (`Debugger is not attached to the tab`), and the tab
     stayed; a detach right after it still closed the tab (review-17b checks E4b and E4a).
  4. at its worker's start only: removes every session rule (rule 8 too; the marks go) and restores
     the tab-to-scope map from its copy (each tab's scope, below; C5). At a disconnect and at a new
     daemon connection it keeps the map, the scope rules, the marks, the last `operator` value and
     rule 8 (board ab-v16.41): a link drop or a daemon restart does not take a live session's tabs
     out of their scopes.
  So no domain state (Fetch, emulation, interception) stays behind, and a long `Runtime.evaluate`
  ends.
- The daemon, at a link drop, answers every bridge request that waits or runs with `disconnected`.
  Then it writes `{"t":"link","up":false}` to the relay, and the relay closes every client
  connection (C11).

**Parts and sizes.**

- A request goes to the receiver in C4 parts with `"ch":"bridge"`. The parts of one bridge request
  never interleave with those of another bridge request. The daemon mixes them with main parts (C4).
  So a large request, for example a file of 50 MB that Playwright sends by buffer, keeps the next
  bridge requests back while its parts go.
- A request is at most `MAX_REQUEST = 134217728` bytes (128 MiB) of UTF-8 JSON. The relay writes no
  longer line (C11 gives the client an error), and the daemon reads the relay's lines up to that
  length.
- A res is at most `MAX_RESULT` (above). An event is at most `MAX_TO_DAEMON`.
- In flight, two limits, so that long waits on one tab never keep another tab back:
  - `MAX_IN_FLIGHT_PER_TAB = 64`, in the relay. The key of a request is its tab: the tab id of
    `debugger.attach`, `debugger.detach`, `debugger.sendCommand` (its `target`), `tabs.get`,
    `tabs.update`, `tabs.remove` and `bridge.release`. Every other op has one shared key. The relay
    keeps at most 64 requests in flight for each key. The next ones of that key wait in the relay,
    in order.
  - `MAX_BYTES_IN_FLIGHT = 268435456` (256 MiB), in the daemon. The daemon sends a request when the
    bytes of the requests in flight (sent and not answered) and its own bytes are at most this, or
    when no request is in flight. The next ones wait in the daemon, in order. This limits the memory
    of the daemon and of the receiver.
- The receiver sets no bound of its own (C4).

**The hold of a new tab.** Measured in stage 2 on Chromium 156 (the live test's case `hold`,
`test/live/README.md`). Chrome starts the first request of many new tabs before an extension can
hold it; the last bullet gives the numbers and what the relay does about it.

- `bridge.attachNew` with `[true]` turns the eager attach on; `[false]` turns it off. It starts off,
  and it goes off at each link change. The relay turns it on while at least one client connection is
  open (C11). The relay sends `bridge.attachNew` with `[false]` when it stops. When a relay restarts
  with no link change, the flag may still be on and the receiver does nothing about it: it keeps
  attaching and holding new tabs, and each hold ends by itself after `HOLD_MAX_MS`, so no tab waits
  for ever. Only a `bridge.attachNew` op or a link change sets the flag. So stage 4 restarts the
  relay only with a link change, or it turns the eager attach off first.
- While it is on, the receiver attaches each new tab in `tabs.onCreated` at once (it becomes a bridge
  tab), and it starts the hold: its own `Fetch.enable` on the tab with the one pattern
  `{"urlPattern":"*","resourceType":"Document","requestStage":"Request"}`, sent right behind the
  attach. The hold keeps each paused document request of the tab's top frame (the `frameId` that is
  the id of the tab's target in `chrome.debugger.getTargets()`; each document request while that
  answer has not come) until the release, so the tab waits as with Chrome's
  `waitForDebuggerOnStart`. A second top-level navigation during the hold waits too. It continues a
  frame's document request at once (for example a frame of a page whose own request left before the
  hold was on). The event comes when the attach and the hold are on, and says
  `"attached":true,"held":true`.
- `held` says that the hold is on, not that it caught a request: a request that Chrome started
  before the hold was on goes to the site at once. `"attached":true,"held":false`: the hold's
  `Fetch.enable` failed, or the relay had attached the tab first. With an `error` (Chrome refused
  the attach), `attached` and `held` are false. A tab whose attachment Chrome ends during the eager
  attach (the tab closed) says `"attached":false,"held":false`, and no `debugger.onDetach` comes for
  it.
- An event of the tab that Chrome fires while the receiver attaches it (for example `tabs.onUpdated`)
  can come before the tab's `tabs.onCreated`. While the eager attach is off, the receiver sends a
  new tab's `tabs.onCreated` after the tab's `webNavigation.onCreatedNavigationTarget` (a popup), or
  50 ms after Chrome's `tabs.onCreated` when none comes (a tab that no page opened): each tab's
  scope, below.
- The receiver never attaches the restore tab of an import. The import sets a flag before it calls
  `tabs.create` for its restore tab, and it clears the flag when it knows that tab's id. A
  `tabs.onCreated` that comes while the flag is set waits until the import knows the id. Then the
  receiver skips the restore tab (`"attached":false`) and attaches the others.
- The receiver also skips a tab of its own origin. Tabs that the operator opens in the live view
  (agentwatch design §5.15) get the operator mark with the design's choice 3 (each tab's scope,
  below), and the receiver skips a marked tab too.
- The relay sends `bridge.release` when the client sends `Runtime.runIfWaitingForDebugger` on that
  tab (it does not wait for the answer: while the hold keeps a tab's first request, Chrome answers
  no command of that tab, and waiting held every popup for 5 s; measured), or before it detaches a
  tab that no connection took. `debugger.detach` releases the
  hold too. The receiver releases a hold itself after `HOLD_MAX_MS = 5000` (from when the hold is
  on), so a tab never waits for a relay that does not answer. When a release waits for the answer of
  a client's `Fetch` command (below) and that answer does not come within `HOLD_FORCE_MS = 2000`,
  the receiver ends the hold anyway.
- One `Fetch` handler serves the tab's session, for the hold and for the client. So a client's
  `Fetch.enable` or `Fetch.disable` on the tab (a `debugger.sendCommand` without a `sessionId`)
  changes the hold:
  - A client's `Fetch.enable` replaces the hold's pattern. From its answer on, the tab's `Fetch`
    events are the client's, and the hold pauses no more requests: a client pattern that does not
    cover documents ends the hold of the tab's later documents. The requests that the hold keeps stay
    paused.
  - A client's `Fetch.disable` continues every paused request at once, also the held ones, and ends
    `Fetch` on the tab. So the hold is over at its answer, and a later release does nothing.
  - While such a client command waits for its answer, a release waits for that answer too. Else the
    hold's `Fetch.disable` could reach Chrome after the client's `Fetch.enable` and end the client's
    `Fetch`.
- A release when no client turned `Fetch` on: the receiver continues the held requests
  (`Fetch.continueRequest`) and ends its own `Fetch` on the tab (`Fetch.disable`). With no client
  `Fetch` command in flight, it sends these calls before it answers any later request, so they
  reach Chrome before the client's next command. Until `Fetch.disable` answers, the receiver
  continues each request that the hold's `Fetch` still pauses (for example a redirect of a held
  request).
- A release when a client turned `Fetch` on for that tab during the hold: the receiver neither
  continues the held requests nor calls `Fetch.disable`. It sends each held request's
  `Fetch.requestPaused` event to the relay, and the client continues the request. So the client's
  routes see the first request too.
- A detach and a link change never give a held request to the relay: the receiver continues every
  held request and calls `Fetch.disable`, because no client takes them.
- The hold's own `Fetch` events never reach the relay, except those `Fetch.requestPaused` events.
- Measured (taylor, Chromium 156 in Xvfb, 2026-11-04): Chrome creates a new tab's first request a
  few ms after `tabs.onCreated` reaches the receiver, and the attach and `Fetch.enable` take 3 to
  20 ms. The hold caught the first document request of:
  - an `about:blank` tab that a client then navigates (`Page.navigate` during the hold): 10 of 10;
  - a `window.open` popup (it starts in the opener's process): 24 of 25 (8 of 18 while the hold's
    `Fetch.enable` waited for the attach's answer);
  - a popup of a `target=_blank` link (`noopener`: a new process, where the attach takes 10 to
    20 ms): 0 of 10;
  - a `tabs.create` with a URL (Chrome starts the request before `tabs.onCreated`): 0 of 10.

  A missed request loads while the client sets up its session, as without the hold; a frame of its
  page loads at once. A held request reached the site 4 to 15 ms (median 5) after `bridge.release`.
  A hold with no release ended 4992 to 5003 ms after `tabs.onCreated`. So the relay opens a tab that
  it must hold at `about:blank`, and navigates it after the release, as Playwright's `newPage` and
  `goto` do. The receiver cannot hold
  the first request of a `noopener` popup.

**The daemon and the relay.**

- The daemon starts the relay with the unit: `agent-browser relay --socket <path>` (C11 gives the
  path), with `--keys` when keys are on (C11, the scope's key). The relay reads the daemon's lines on
  its standard input. It writes its requests on its standard output, and its log on its standard
  error. When its standard input ends, the relay closes every connection, removes its socket and
  exits. The daemon stops the relay that way when the unit stops.
- The daemon's lines to the relay, in addition to the receiver's `res` and `ev`:
  - `{"t":"link","up":true,"version":"<manifest version>"}`: a receiver is connected, and its hello
    lists `bridge`.
  - `{"t":"link","up":false}`: the link dropped. The `disconnected` answers come first.
  - `{"t":"allowlist","lists":{"<list>":["a.example"]},"scopes":{"<scope>":"<list>"},"default":"<list>"}`
    (with `"default":null` when there is none): the object of the `set_scopes` that the receiver
    confirmed (an `ok` answer on the current connection). It comes after each such answer. It also
    carries the `"operator":` field when `set_scopes` has one (the relay ignores it), and with the
    design's choice 1 b `"keys":{"<scope>":"<sha-256 hex of the key>"}` (C11, the scope's key); the
    receiver never sees the keys. The relay applies C4's rules to the line (C11, the scope's list).
  - `{"t":"end_scope","scope":"<scope>"}`: the agentwatch session of that scope ended. The relay
    closes the scope's connections and removes its tabs (C11). The daemon can also write one for
    each alias of the session; the relay does nothing for a name that is no scope.
- At each `link` up, before it admits a connection, the relay runs the **steps of the link up**, in
  this order. The daemon writes the link-up line to each relay that starts while the link is up, so
  they also run at each relay start.
  1. `bridge.info` (C11, before the upgrade). The next steps start after an answer with `bridge` 1
     or more.
  2. In the per-scope build only (part 2, board ab-v16.35; board ab-v16.41): `bridge.tabScopes`.
     When it answers, the relay adds each entry to its model at once: its scope, no owner, not
     attached, not held, no target id yet. Every later event applies at once, on top of it: a
     `tabs.onRemoved` drops an entry, a `bridge.tabScope` adds one. When `bridge.tabScopes` fails or
     times out, the relay logs it and goes on: its model then holds no tab of an earlier link.
  3. `debugger.getTargets`. In the per-scope build the relay gives each entry of step 2 its target
     id, and drops from its model each entry of step 2 whose tab the answer does not list (the tab
     closed). This step changes only the relay's model: the receiver's map keeps an entry until the
     tab's `tabs.onRemoved`. It drops only the entries of step 2: an entry of a later
     `bridge.tabScope` gets its target id as a popup's does (C11). It logs a failed
     `debugger.getTargets` and goes on.
  4. `debugger.detach` for each tab that the answer of step 3 reports attached (`"attached":true`
     and a `tabId`). It ignores the errors of these detaches.

  Today's relay (before part 2) runs steps 1, 3 (the list only) and 4: its model starts with no
  tab. Then it waits for the `allowlist` line, as today. A tab with no target id yet is in no
  client's view (as in the model today). The reasons:
  - The detaches (step 4): a relay that starts with no link change (the daemon restarts a relay
    that ended) finds the tabs of the relay before it still attached, with the domain state of
    their clients, because the receiver's cleanup ("What stops a handler", above) runs only at a
    link change. Measured (board ab-v16.39, Chromium 156): the old client's `Fetch` pattern still
    paused a page's request, and its user-agent override stayed. After the detaches no CDP state of
    an earlier client stays. After a link change the receiver has already detached every bridge
    tab, so each detach answers `null`. The restore tab of a running import answers `not an agent
    tab` and keeps its attachment.
  - The map (step 2): the receiver keeps its map over a link drop and a relay restart (each tab's
    scope, below), so a client of the scope that connects again sees its tabs (C11). Measured
    (board ab-v16.39): without it a new client of the scope saw 0 targets after a link drop and
    after a relay restart, and an `end_scope` then closed no tab. The relay adds the entries at
    step 2, not after step 3: else a `tabs.onRemoved` between the two steps would find no entry,
    and a closed tab would enter the model. An op, not a burst of `bridge.tabScope` events: with an
    op the relay knows when it has the whole map.
  - A limit: a `tabs.create` or `windows.create` of the relay before the link change that ends
    after the answer of step 2 puts its tab into the receiver's map, but the new relay does not
    learn it (the receiver drops the op's answer, "What stops a handler", step 1, and no
    `bridge.tabScope` comes for it). That `about:blank` tab is in no client's view until the next
    link up, and the sweep still closes it at its scope's end (C5).
- No side logs the args, the results or the event params of the bridge: they can contain page
  content and sign-in values. A log line contains an op, a CDP method, a tab id, a size or a time.

**Each tab's scope (board ab-v16.23).** The receiver keeps the scope of each tab, so that each tab is
blocked by its own list (C5; the per-scope design, sections 4 and 5).

- The receiver keeps a map from tab to scope. It sets a tab's scope in these cases only:
  - `tabs.create` with `[createProperties, scope]` and `windows.create` with `[createData, scope]`:
    the second arg is required, of the kind `scope`. The `url` of `newTab` and `newWindow` is
    `about:blank` only (it makes no request), and `windows.create` never moves a tab: `newWindow`
    has no `tabId` (C11: the relay never moves a tab). The receiver first checks the scope (a new
    entry after the sweep, below): a scope with no list gets `no list for this scope`, and no tab.
    Else it creates the tab, sets its scope, and answers when the tab's scope rule (C5) is in force
    and its key is in the copy (the copy, below). It checks the scope again when it writes the
    entry: when a sweep came during the op and the last applied `set_scopes` now gives the scope no
    list, it closes the new tab (in the removal queue, by the receiver's close: removals and the
    last window, below), and the op answers `no list for this scope`. When the rule update fails,
    the receiver closes the new tab in the same way, and the op answers with the error (C5: a failed
    update fails closed).
    Measured: the probe's whole assignment (its rule update and the wait for it, small lists, its
    tabs open) took 11 to 15 ms, and the next `Page.navigate` loaded 20 of 20. Chrome's index cost
    alone grows with the entries of all lists in use (about 46 ms to replace one list's rules with
    20 lists of 1,000 in use).
  - A popup: in `webNavigation.onCreatedNavigationTarget`, the new tab (`tabId`) takes the scope of
    `sourceTabId`, when that tab has one. The receiver sets it in the map in the handler, then
    updates the rules. Measured: `sourceTabId` named the right opener in every popup of every kind,
    also behind a tab of another scope; `chrome.tabs`' `openerTabId` named the active tab instead.
    The receiver never uses `openerTabId`.
  - `tabs.onReplaced`: the added tab takes the removed tab's scope.
  - Every other tab has no scope: the restore tab, the tab that C5's closing rule opens (and every
    `about:blank` tab of the window rule, removals and the last window, below), a tab from before
    the worker's start whose entry the copy does not hold, a tab of the orphan set (C5, the sweep),
    and the operator's own tabs. The sweep never closes a tab of no scope, except a tab of the
    orphan set (C5). The operator's tabs depend on choice 3 of the
    design: with it, a tab that starts at `chrome://newtab/`, that no page opened and that no bridge
    op created gets the **operator mark** (no agent tab starts there: the relay opens `about:blank`
    only and refuses `chrome:` URLs; that a page cannot open a `chrome://` page is Chrome's rule,
    not measured), and a popup of a marked tab is marked too. A marked tab has no scope; C4's
    `operator` field gives what it may open (C5: rule 8 with `"*"`, and C5's guard and closing rule
    skip the tab; a list name: that list). For the retry, a marked tab's list is its `operator` value
    (with `"*"` every host is covered). The mark stays at a link change (it is not a connection's)
    and at `tabs.onReplaced`; it goes at the worker's start (those tabs then fail closed). The
    bridge never attaches, selects or closes a marked tab (`not an agent tab`, the tab checks
    above). Without that build, the operator's tabs fail closed.
  - A tab leaves the map when it closes: in `tabs.onRemoved` the receiver drops the tab's entry and
    sends the event before any other `await` of the handler (the next query of the removal queue
    and the relay then see the tab gone; review-48 X4 measured that the event comes before
    `chrome.tabs.remove` ends, and the rule does not depend only on that). The map stays at each
    disconnect and each new daemon connection (the cleanup of "What stops a handler"), with the
    scope rules, the marks, the last `operator` value and rule 8 (C5; board ab-v16.41): a link drop
    or a daemon restart does not take a live session's tabs out of their scopes. Only a tab's close
    (also by the sweep, C5), a `tabs.onReplaced` (above), the end of a sweep item that did not close
    the tab (C5: the tab joins the orphan set) and the worker's start remove entries.
  - No stale entry: the receiver writes a scope only for a tab that exists. A write of an op or an
    event that started before a link change still applies (the map stays), so a tab that the old
    relay opened keeps its scope: a relay gets it from `bridge.tabScopes` at the next link up after
    the write (the daemon and the relay, above: a limit), and the sweep closes it at its scope's
    end. If the write were dropped, the tab would have no scope: blocked,
    seen by no connection, never closed. So the epoch check of `attach.js` drops only a write for a
    tab that no longer exists, and a write from before the worker's start (that worker is gone).
  - The copy (board ab-v16.41). The receiver keeps a copy of the map in `chrome.storage.session`
    (permission `storage`; its default access level `TRUSTED_CONTEXTS` keeps it from content
    scripts, so a script that the import injects cannot read it), one key per tab: `tab:<id>`, the
    scope as its value. It writes a tab's key at the same time as the rule update of the new entry,
    not before it: `tabs.create` and `windows.create` answer when both ended, and `bridge.tabScope`
    goes as soon as the entry is in the map. It removes the key when the tab leaves the map.
    Measured (board ab-v16.39, Chromium 156): `chrome.storage.session` and a session rule stayed
    over a worker stop, and the area was empty after a browser restart; the receiver before part 1a
    has no `storage` permission (`chrome.storage` is absent). Chrome shows no install warning for
    `storage`. The copy never goes to `chrome.storage.local`: it stays over a browser restart, and
    the tab ids of a new run repeated those of a run that Chrome did not end cleanly (4 of 5 runs
    after SIGKILL, 0 of 5 after SIGTERM), so a new tab could get an old tab's scope. A worker stop
    between a change and the end of its write loses at most that one change: such a tab is a tab
    of no scope after the restart.
  - The restore, at the worker's start, in this order: the receiver removes every session rule
    (C5; rule 8 too, the marks go), reads the copy (`chrome.storage.session.get`), keeps the entries
    of the tabs that exist (`chrome.tabs.query`) and removes the keys of the others, and only then
    connects its native port (its hello, C4). It adds its event listeners at the worker's start,
    before the first `await`, and every handler that reads or writes the map
    (`webNavigation.onCreatedNavigationTarget`, `tabs.onReplaced`, `tabs.onRemoved`, the ops) waits
    for the restore inside. The reason: Chrome starts a stopped worker for an event (measured: a
    new tab started it, and its native port connected 100 to 151 ms later), and that event's
    handler would otherwise read the map before the restore ends. When `chrome.storage.session.get`
    or `chrome.tabs.query` fails, or has not answered in `RESTORE_MAX_MS = 2000` ms, the receiver
    starts with an empty map and connects anyway: the tabs of the copy are then tabs of no scope (a
    limit). The kept tabs fail closed until the next `set_scopes`, which comes soon: a worker's
    start is a link change, and the daemon sends `set_scopes` after each link up (C4).
  - A new entry after the sweep (board ab-v16.41). The receiver checks each new entry against its
    last applied `set_scopes` (C5, the sweep: the last one whose `scopes` and `lists` are objects):
    - `tabs.create` and `windows.create` with a scope that it gives no list answer `ok:false` with
      `no list for this scope`, and create no tab. Before the first applied `set_scopes` after the
      worker's start every scope has no list, so they get this error then too (the relay admits no
      client before its `allowlist` line anyway).
    - A popup or a replaced tab whose scope it gives no list closes at once, in the removal queue
      with the window rule (below), and gets no `bridge.tabScope`. It is in the map until its
      close, so its own popups take its kept entry (below) and close too. Before the first applied
      `set_scopes` after the worker's start such an entry stays (the lists are not known yet), and
      that `set_scopes` sweeps it when its scope has no list.
    - The reason: such a tab gets its scope after the sweep ran (a popup of a tab that the sweep
      closes, a `tabs.create` of a relay that has not handled `end_scope` yet, a `tabs.onReplaced`
      of a tab of such a scope), and no later sweep comes until the next `set_scopes`, which can be
      hours later.
  - The kept entries (board ab-v16.41). The receiver keeps each entry that leaves the map for
    `TOMBSTONE_MS = 10000` ms, in memory (with choice 3, a mark too), also the entry of a popup that
    closed at once (above). A popup whose `sourceTabId` has such an entry takes its scope (or its
    mark), as if the opener were still open, and the check above applies: a popup of a tab that the
    sweep closed a moment before closes too, and a popup of a page that closes itself right after
    `window.open` keeps its scope. A popup whose opener has neither an entry nor a kept entry gets
    no scope: it fails closed, no connection sees it, and the sweep never closes it (C5's closing
    rule closes its `http:`/`https:` page when no list covers its host). When an applied
    `set_scopes` gives a scope a list again, the receiver drops that scope's kept entries, so a
    popup of an old tab never joins a later session of the same name (C4, rule 2 of the tabs of a
    session that ended). Measured (the per-scope probe): `webNavigation.onCreatedNavigationTarget`
    comes 0 to 1 ms after Chrome creates the tab, so 10 s is a wide margin.
- The event `bridge.tabScope` (the event table above), fields `"tabId"`, `"scope"`: sent when the
  receiver sets a scope itself (a popup, a replaced tab), as soon as it is in the map. Not for a tab
  of `tabs.create` or `windows.create`: the relay named that scope. Not for a popup or a replaced
  tab whose scope has no list: it closes at once (a new entry after the sweep, above). Part 1b's
  live test measures the delay of the event with the write of the copy in place: it must still come
  before the popup's `tabs.onCreated`. For a popup it comes before the
  popup's `tabs.onCreated`: `webNavigation.onCreatedNavigationTarget` comes 0 to 1 ms after Chrome
  creates the tab, before the eager attach ends; while the eager attach is off, the receiver sends
  a new tab's `tabs.onCreated` after that event, or after 50 ms when none comes (a tab that no page
  opened). For a replaced tab it comes right before the receiver's `tabs.onReplaced` event, so the
  relay knows the added tab's scope when it swaps the tabs.
- The retry. A popup's first request often starts before its rule is in force (measured: a
  `noopener` popup, a `target=_blank` link and a form with a target in every trial; a popup with an
  opener in a few). DNR blocks it (C5). The trigger: the tab's first main-frame
  `webNavigation.onErrorOccurred` with `net::ERR_BLOCKED_BY_CLIENT`, whose URL's host the tab's list
  covers when the rule update that put the tab under its list ends (a covered host is blocked only
  when its rule was late). The receiver then calls `tabs.reload` on the tab once, at the later of
  the end of that update and the error event plus 50 ms (the error page has committed). Measured:
  the site got one GET; the page saw `history.length` 1, the same `window.opener` as with no block,
  and its `document.referrer`. What the site sees of the retried request differs by the kind of
  popup: for a `target=_blank` link and a `noopener` `window.open`, the same `Sec-Fetch-*` headers
  and `Referer` as with no retry, and `Cache-Control: max-age=0` more (as any reload); for the
  sign-in pattern (`window.open("")`, then the opener sets `location`), which sends no
  `Sec-Fetch-User` with no retry, also `Sec-Fetch-User: ?1`. A one-shot session rule that removes
  `Cache-Control` from the retried request did not remove it (20 of 20, ab-lead's reviewer). A POST
  is not sent again: a form that posts into a new tab fails closed. The `blocked` notice of the
  first request waits for this decision: none for a retried request; one when the list does not
  cover the host, or when the tab gets no scope; one when the retried request is blocked again (a
  second `onErrorOccurred` with `net::ERR_BLOCKED_BY_CLIENT`; no second retry); and one when the
  retry starts no request (a POST that Chrome does not send again). The packed agent has no
  `webRequest` and no `declarativeNetRequestFeedback` permission (`onRuleMatchedDebug` works only
  unpacked), so the signal of "no request" comes from `webNavigation`: no main-frame
  `onBeforeNavigate` of the URL within 1 s of the `tabs.reload`, or an `onErrorOccurred` with
  another error (which one a POST gets is not measured). An `onBeforeNavigate` that comes after the
  1 s gives a false `blocked` notice; the notice does not stop that navigation. "Blocked again" is a
  second `ERR_BLOCKED_BY_CLIENT` of the reload's own navigation, not of a later one.
- How often a popup with an opener needs the retry (it depends on load): in the probe 1 of 60 with
  no hold and 2 of 60 with the hold; in ab-lead's reviewer's runs 3 to 4 of 20 with the hold, 2 of
  10 for the sign-in pattern, and 8 of 10 with one window per page (the plan of agent-browser PR
  #43, the research, before its build in PR #44) behind another window. The time of one assignment
  grows with the tabs open under the rules (the reviewer: median 9 ms with none, 13 ms with 50,
  25 ms with 100).
- The hold stays. The retry's request is a document request of the tab, so the hold keeps it until
  the release, while the hold is still on (`HOLD_MAX_MS`; the retry comes about 70 ms after the
  block). While the eager attach is on, the receiver also holds the `tabs.onCreated` event of a
  popup whose hold is on (`"held":true`; a popup with `"held":false` gets its event when the eager
  attach ends, as above). That hold ends at the first of: the popup's first document request is
  allowed (the hold pauses it); the retry's request is in the hold; the decision to send `blocked`
  (a host off the list, a popup of no scope, a retry that is blocked again, a retry that starts no
  request); a main-frame commit with no network request (a `blob:` URL, a worker's page; not an
  `about:blank` that the opener writes into, which makes no new commit and looks like the first step
  of the sign-in pattern); 50 ms from the moment the popup's rule is in force, with no main-frame
  navigation of the popup started (a later navigation is allowed by the rule and needs no retry;
  this ends the hold of a popup that stays at `about:blank`); `HOLD_MAX_MS` after `tabs.onCreated`.
  The 50 ms timer runs only while the popup has started no main-frame navigation (`about:blank` does
  not count): a navigation that started before the rule (for example a `noopener` popup's, blocked
  at 8 to 21 ms while its rule comes at 15 to 47 ms), or a planned retry (its request comes 62 to 95
  ms after the block), stops the timer, and then only the other conditions end the hold. Chrome
  fires `tabs.onCreated` first, and the receiver holds it; other events of the popup (for example
  `tabs.onUpdated`) go to the relay as they come, and the relay keeps `bridge.tabScope` and drops
  the other events of a tab that it does not know yet. So the held `tabs.onCreated` carries the
  tab's state at its release (the receiver reads the tab again with `tabs.get` then). A popup that
  closes while its event is held gets no `tabs.onCreated`; its `tabs.onRemoved` goes as usual, and
  the relay drops the `bridge.tabScope` that it kept for it. So a client attaches to a popup whose
  real document is still to come, and does not see Chrome's error page as the popup's page through
  CDP (the error page still shows in the window for 60 to 100 ms).

**Removals and the last window (board ab-v16.41).** In the per-scope build the receiver keeps the
browser's last window for every close that it makes or that the relay asks for (the orphan-tabs
design, section 7). Before part 2, today's relay keeps it with today's ops (C11, when a connection
ends).

- The **removal queue**. Every path by which the receiver closes a tab runs in one queue:
  - the `tabs.remove` op (the relay's `end_scope` and `Target.closeTarget`);
  - a client's `Page.close` on the tab's own session (a `debugger.sendCommand` with that method
    and a `target` with no `sessionId`);
  - C5's closing rule and its sweep;
  - the close of a new entry whose scope has no list, and the close of a new tab whose rule update
    failed (`tabs.create`, `windows.create`; each tab's scope, above);
  - the import's closes (C6): the tabs of its origin in step 1, the restore tab in step 5, and a
    restore tab that came after its step's deadline (agent `importer.js`, its failure cleanup).

  One **item** runs at a time: one `tabs.query` with `{}` and the closes of that item. The relay
  asks for no window of its own. A `Page.close` on a child session of the tab (a frame or a worker)
  is no close of the tab: it goes to Chrome at once, with no window rule, as today's relay sends it
  (measured: Chrome refused it on the session of a cross-site frame with `Command can only be
  executed on top-level targets`, and the tab stayed; review-17 check O1).
- The **receiver's close**. For every close of the queue except a client's `Page.close`, the
  receiver sends `Target.closeTarget` with the tab's target id (from `chrome.debugger.getTargets()`)
  through `chrome.debugger.sendCommand` on the tab: on a bridge tab through its attachment, on any
  other tab through an attach for this close only (`chrome.debugger.attach`; it makes no bridge tab:
  no hold, and no event of it goes to the relay). Chrome then closes the tab with no `beforeunload`
  handler and no dialog, also when a dialog is already open (measured, below). The close ends at the
  tab's `tabs.onRemoved`. When the tab closed first, the command answers `Detached while handling
  command.`, and that answer is no error. So a close of the receiver runs no page's `beforeunload`
  handler: an operator's tab that the closing rule or the import's step 1 (C6) closes gets no
  "Leave site?" dialog either.
  - The chain. The receiver's close is one op of the tab's chain of attaches (as `agent/attach.js`
    runs the bridge's attaches and detaches of a tab one after the other). A bridge attach of the tab
    that is in flight ends first, and the close then uses that attachment. A relay's
    `debugger.attach` of the tab that comes during the close's op waits until that op ended. The op
    ends when the command answered, or when the fallback called `chrome.tabs.remove`; the close
    stays pending outside the chain (below), so a held fallback never stops the tab's chain or a
    relay's `debugger.attach`. An attach
    of a second client of the same extension fails (measured: `Another debugger is already attached
    to the tab`, and the first attachment stays and works; review-17b check E3), so the close never
    makes a second one.
  - The fallback: when the attach fails, when `chrome.debugger.getTargets()` fails or lists no target
    for the tab, or when the command fails and the tab stays, the receiver ends its attach for the
    close (only when it made one: never the bridge's attachment) and calls `chrome.tabs.remove`. Its
    limit: a `beforeunload` handler can then hold that close (measured, below). A later item tries
    again; the sweep takes such a tab out of its scope into the orphan set (C5, the sweep).
- The **window rule**. Before an item closes its tabs, the receiver reads every tab (`tabs.query`
  with `{}`). When no tab stays open other than the tabs of the item and the tabs with a pending
  close (below), it first opens an `about:blank` tab, not active and in no scope, in the window of
  the item's last tab, as C5's closing rule does. The query and that tab each have a limit of
  `REMOVAL_WAIT_MS`. When either fails or comes later, the receiver closes no tab of the item, and
  the item ends: `tabs.remove` and `Page.close` answer the error, and the closing rule and the sweep
  count no tab in `closed`. A tab of the closing rule stays, and the next `set_scopes` tries again;
  a tab of the sweep leaves its scope at the end of the item, into the orphan set (C5, the sweep).
- A **pending close**: a close is pending from the moment its item starts it (for the receiver's
  close, from the moment it joins the tab's chain; for a client's `Page.close`, from its send) until
  the tab's `tabs.onRemoved`, or until it fails and the tab stays (after the fallback too). An
  answer that comes after the item's wait counts as any answer: a late `Page.close` answer with no
  error leaves the close pending, and a late error ends it. The window rule counts each tab with a
  pending close as closed until then, however long that takes. The reason: a `beforeunload` handler
  holds a client's `Page.close` (and the fallback's `chrome.tabs.remove`) while its dialog is open,
  and the page closes when the client or the operator accepts the dialog, maybe much later (board
  ab-v16.43: an accept after the wait). Without the rule, a later item counts that tab as another
  tab, removes the only other tab, and the accept then closes the last window. Only the item that
  started a close waits for it (the time limit, below): a later item that closes the tab (also a
  `tabs.remove` or an import's close) closes it again, by the receiver's close, unless that item is
  a client's `Page.close`. After a dismiss the page stays, and the tab stays pending until it
  closes: each later item that would leave it as the only open tab opens one `about:blank` tab that
  was not necessary.
- The time limit. An item starts its closes one after the other, with no wait for one close before
  the next, and then waits until they ended, at most `REMOVAL_WAIT_MS = 2000` ms after it started
  the last one. Then the next item starts. Each close of the item that has not ended stays pending,
  also one that still waits in the tab's chain, or is still in its attach or its
  `chrome.debugger.getTargets()` (the definition above).
  An op still answers when its own call ends, or with `timeout` at its wait (the deadline, above).
- The bound of a `set_scopes` answer. An item ends at most three times `REMOVAL_WAIT_MS` (6 s) after
  it starts (its query, its `about:blank` tab, its wait), and in the normal case after a few ms
  (measured: the receiver's close took 1 to 9 ms). Only a held client `Page.close` (at most
  `REMOVAL_WAIT_MS`) or a Chrome call that does not answer makes an item long. A `set_scopes` answer
  waits for the items before the sweep's item and for that item, so several long items can make it
  later than the daemon's 10 s (C4). The daemon then writes no `allowlist` line for it and sends the
  object again: the relay keeps its last line, the receiver's new rules are in force, and the next
  `set_scopes` sweeps again, also the tabs of the orphan set (C5, the sweep).
- A client's `Page.close` keeps its own semantics: Chrome runs the page's `beforeunload` handler,
  and the receiver answers with Chrome's answer. Each later `debugger.sendCommand` request of the
  tab waits at a gate until that `Page.close` ends: it went to Chrome, the window rule refused it
  (its error), or its deadline passed in the queue (`timeout`; it then never goes to Chrome). The
  gate opens at each of these ends, so the tab's commands keep their order and never wait for a
  `Page.close` that does not go. A `Page.close` of a tab that is already gone gets Chrome's error,
  and the tab is not pending. A `Page.close` of a tab whose scope has no list runs as any other;
  when its dialog holds it, the next sweep closes the tab by the receiver's close.
- At a link change ("What stops a handler", above) the receiver drops every bridge request that
  waits in the queue or at a gate and has not gone to Chrome (a `Page.close`, a `tabs.remove`, the
  commands behind a gate), with no answer: it drops the old link's answers anyway. So no command of
  an old client reaches Chrome after the detaches and goes into the session of a new client. The
  items of the receiver's own closes (the closing rule, the sweep, the import) go on.
- Measured (taylor, Chromium 156; board ab-v16.41 and review-17, two runs each):
  - `chrome.tabs.remove` of a page with a `beforeunload` handler, after a click in the page, with a
    CDP client on the page: the `beforeunload` dialog opened, and the call did not end while the
    dialog was open (3 s). After an accept the tab closed, and `tabs.onRemoved` came 2 ms before
    the call ended. After a dismiss the tab stayed, and the call did not end (3 s).
  - The same with no CDP client on the page: the tab stayed, and the call did not end (3 s). A CDP
    client that attached then got no answer to `Page.enable` in 15 s, and
    `Page.handleJavaScriptDialog` answered `No dialog is showing` (review-17 check N1).
  - `Page.close` of such a page answered in 1 ms, and the tab closed only after the accept.
  - The receiver's close (`Target.closeTarget` through `chrome.debugger`, with an attach for the
    close) closed such a page in 1 to 3 ms with no dialog (review-17 check T2). It also closed such
    a page whose close was already held: by the dialog of a client's `Page.close` (the client saw
    the dialog), and by a `chrome.tabs.remove` call (no CDP client, so the probe saw the held call,
    not the dialog). The command then answered `Detached while handling command.`, `tabs.onRemoved`
    came 3 to 7 ms after the command started, and the held `chrome.tabs.remove` call ended. Through
    the bridge's own attachment the close worked the same, with a dialog open and with none
    (review-17b checks E1 and E2). Chrome's own `Target.closeTarget` (a CDP client's) ran no
    `beforeunload` handler either (review-17 check T1).
  - Before: a removal of the browser's only tab ended Chromium (board ab-v16.39, case F), and so did
    two removals at once of its only two tabs, each of which read two tabs (review-48 check X2b);
    one at a time kept it running (X2).
- The limits: a page's own `window.close()` (also one that a client runs with `Runtime.evaluate`)
  and the operator's close in the live view are outside the queue, so at the same moment as a
  removal they can still end Chromium. The pending closes live in the worker's memory only: after a
  worker start the receiver knows none, so a `Page.close` that a dialog holds over a worker restart
  can still close the last window at a late accept (the case of board ab-v16.43). The orphan set
  lives in memory too (C5, the sweep).
- The limits of a tab that a sweep item does not close (C5, the sweep). In both cases (a close
  that failed or is still pending, for example a fallback that its dialog holds; and a window rule
  that failed or came late, with no close and no dialog) the tab leaves its scope into the orphan
  set, and each later sweep item closes it again. In the first case the tab stays open until
  someone accepts the dialog or a later sweep item closes it; after a dismiss the page stays, and
  the held `chrome.tabs.remove` call does not end (measured, above). After a worker start such a
  tab is a plain tab of no scope.
- The limit of a new entry. A popup or a replaced tab whose scope has no list and whose close does
  not end (a fallback that a dialog holds) stays in its scope until the next applied `set_scopes`;
  that sweep closes it or takes it into the orphan set, before the scope's name can come back (C4,
  rule 2). The chance is near zero: the dialog needs a user activation in a tab that is a few ms
  old.
- The shared vectors: `windowRule` in `test/vectors/bridge.json`, and its request of `tabs.remove`.

### C11. The endpoint (agent-browser's relay)

The relay serves a CDP endpoint for Playwright, the Playwright MCP and agent-browser's own commands.
Behind it the browser model answers the browser-level calls with C10 ops. It sends each page-level
call to `debugger.sendCommand` (two-modes design, sections 4 and 8). On Linux it answers one page
call itself: focus emulation (one window per page, below). This file is the master for C11. The
vectors: `test/vectors/endpoint.json`.

| Part | Side | Stage of the two-modes design |
| --- | --- | --- |
| The socket server, where each call goes, the scope, one connection per tab, the refusals, the cookie marker, the content settings | agent-browser's relay | 3 (board ab-v16.6) |
| The socket path, `browser.control`, `agentwatch browser endpoint` and `env`, `end_scope` | The agentwatch daemon | 4 (board ab-v16.7) |

**The socket and the URL.**

- A Unix socket with mode 0600. The relay makes it at the path that the daemon gives it:
  `/run/user/<uid>/agentwatch/browser-cdp.sock` on Linux, `~/.cache/agentwatch/run/browser-cdp.sock`
  on the Mac. A path is at most 103 bytes. There is no TCP port.
- The URL is `ws+unix://<socket path>:/devtools/browser/<scope>`. Playwright's `connectOverCDP` and
  the Playwright MCP (`PLAYWRIGHT_MCP_CDP_ENDPOINT`) take it as it is (measured). Without keys the
  URL contains no secret. With keys on (the scope's key, below) a client adds the key to the URL's
  query at the connect call, or sends it in a header: the URL with its key is a secret.
- `agentwatch browser endpoint` prints the URL, with the session's scope (below) and no key.
  Without keys, `agentwatch browser env` prints `PLAYWRIGHT_MCP_CDP_ENDPOINT=<url>`; with keys on it
  prints two comment lines and no key (the scope's key, below). With `browser.control: false` there
  is no relay and no socket.
- A scope matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Every agentwatch session name matches it.
  agentwatch picks each session's scope at its launch (the session's name then) and keeps it for
  the session's life, with or without keys: a rename does not change it, and no two live sessions
  share one scope. `agentwatch browser endpoint` and `agentwatch browser env` print that scope, not
  the calling session's current name.
- Without keys, every process of the daemon's OS user that can open the socket may connect, with
  any scope, as with `agentwatch browser` today: the scope is advisory (agent-browser #14). With
  keys on, a connection needs its scope's key (below).

**Before the upgrade.** The relay serves only the WebSocket upgrade of
`GET /devtools/browser/<scope>` (the path: a query does not change it). Its other answers have a
`text/plain` body:

- Another path, or a scope that does not match: 404 `Not found. Connect a CDP client to /devtools/browser/<scope>.`
- A request with an `Origin` header: 403 `A web page cannot connect to the agent browser.`
- With keys on, a request with no valid key, or with a key that does not match its scope's entry:
  403 `The agent browser needs this session's key. A session that started before the key existed has no key; only a new session gets one.`
- The relay is not ready: 503 with one of these bodies.
  - 503 `The agent browser is not ready: its extension is not connected.`
  - 503 `The agent browser is not ready: its extension has not confirmed the allowlist.`
  - 503 `The agent browser is not ready: its extension is too old for agent mode.`
  - 503 `The agent browser is not ready: the allowlist has keys, but the relay was started without --keys.`
- A scope with no list: 503 `The agent browser is not ready: the allowlist has no list for this scope.`
- The relay is ready while the link is up (C10 `link`), an `allowlist` line came after that,
  `bridge.info` answered with `bridge` 1 or more, and the steps of the link up (C10, "The daemon
  and the relay") are done: for today's relay steps 1, 3 and 4 (the detaches); in the per-scope
  build also step 2 (`bridge.tabScopes`) and the target ids of step 3. A receiver before stage 2
  answers `unknown op` to
  `bridge.info`: it is too old. The relay admits a connection of a scope while it is ready and the
  last `allowlist` line gives the scope a list (the scope's list, below). A scope whose list is
  empty is admitted; it can open `about:blank` only. So the endpoint fails closed: no connection
  before the extension confirmed the operator's lists (two-modes design, section 10; per-scope
  design, section 8.4).
- The order of the checks. The relay sends the answer of the first check that fails, at once:
  1. A request with an `Origin` header: its 403.
  2. A path or scope that does not match: the 404.
  3. With keys on, a request with no valid key (the scope's key, below): the key's 403, also while
     the relay is not ready.
  4. The relay is not ready, in this order: the link is down (`its extension is not connected`);
     `bridge.info` answered `unknown op` or `bridge` below 1 (`its extension is too old for agent
     mode`); no `allowlist` line came since the link came up (`its extension has not confirmed the
     allowlist`); `bridge.info` has not answered yet, or the steps of the link up are not done
     (`its extension is not connected`); a relay
     without `--keys` whose last `allowlist` line has a `keys` field (`the allowlist has keys, but
     the relay was started without --keys`).
  5. With keys on, a scope that the last `allowlist` line does not name: the no-list 503.
  6. With keys on, the hash check: a named scope whose `keys` entry does not match the key, or that
     has no entry in `keys` (also a line with no `keys` field), gets the key's 403.
  7. A scope with no list: the no-list 503. With keys on, that is a named scope whose entry is
     `null` (also an entry that applies as `null`, C4) or names a list that is not in `lists`;
     without keys, also a scope that the line does not name while `default` gives no list.

  The relay never holds an upgrade, and no side retries for the client: the client gets the
  answer's text (agent-browser's `src/cdp.ts` passes the body on in its error), and the agent
  connects again. So a just-launched session, whose scope the daemon has not sent yet, gets the
  no-list 503 until an `allowlist` line names its scope. Step 5 shows whether a scope is named. A
  scope is a session's name at its launch, and `agentwatch session list` shows the session names
  anyway (the same names, unless a session was renamed). A session that is live before the deploy
  (it has no key) gets the key's 403 at step 3: fail closed. The shared vector: `upgradeChecks` in
  `test/vectors/endpoint.json`.
- A client message is at most `MAX_REQUEST` bytes (C10). A longer one closes the connection (code
  1009). A command whose bridge request would be longer gets an error (the refusals, below).

**When a connection ends.**

- `Browser.close` ends that connection only. The agent browser keeps running. Close code
  1000, `Browser.close ends this connection; the agent browser keeps running`.
- `end_scope` (C10): the relay closes the scope's connections with
  1000, `The agentwatch session ended`, and removes the scope's tabs. An `end_scope` whose name is
  no scope of the relay (for example a name of the session other than its launch scope,
  `AGENTWATCH_SESSION_ID`; C4) does nothing. agentwatch writes no `end_scope` for a name that is the
  launch scope of another live session: a rename into a former name can make one session's alias
  another session's scope. In the per-scope build the receiver's sweep closes the scope's tabs too,
  at the daemon's next `set_scopes` (C5), also when no relay runs: the sweep is the guarantee,
  `end_scope` the fast path (C4, the tabs of a session that ended).
- The relay never closes the browser's last window. Today's relay (before part 2) keeps it itself,
  as this bullet says; in the per-scope build the receiver keeps it (the last sub-bullet). A tab
  closes by the relay's `tabs.remove` (`end_scope`, `Target.closeTarget`), or by a client's
  `Page.close` on a page session (Playwright's `page.close({ runBeforeUnload: true })`), which the
  relay sends to Chrome. Before each of them the relay sends `tabs.query` with `{}`. When the tab is
  the browser's only tab, it first opens an `about:blank` window that is not focused and in no
  scope, as C5's closing rule opens `about:blank` before it closes the browser's last window. The
  relay does one such query and close at a time, so two closes cannot each find the other's tab and
  together close the last window. `Page.close` answers before its tab closes, so the next query
  waits for the tab's `tabs.onRemoved`, at most 2 s (a `beforeunload` handler can keep the tab
  open); after an error of `Page.close` it does not wait. When the query or the new window fails,
  the relay does not close the tab: `end_scope` leaves it open, and `Target.closeTarget` and
  `Page.close` give the client the error. A page's own `window.close()` is outside the relay: Chrome
  closes that tab itself.
  - Measured (Chromium 156): an `end_scope` that removed the browser's only tab ended Chromium,
    exit 0 (board ab-v16.39). Two removals at once of the browser's only two tabs (two scopes end
    together) each read two tabs, opened no window, and ended Chromium (review-48 check X2b; live
    again in review-51, with the relay's queue removed). A client's `Page.close` of the only tab
    ended Chromium too (review-51).
  - Today's relay (before part 2, so with the ops of agent package 0.2.0) opens the window with
    `windows.create` and `[{"url":"about:blank","focused":false}]`. Its known gap (board
    ab-v16.43): a close that a `beforeunload` dialog holds past the wait (2 s for `Page.close`; the
    30 s deadline for `tabs.remove`, which opens the dialog too and ends only after it: measured,
    C10, removals and the last window) still counts as another tab at the next query, so a later
    accept of the dialog can close the last window. In the per-scope build the pending close and
    the receiver's close of C10 are the rules for it.
  - Today's relay sends a client's `Target.closeTarget` as `tabs.remove`, which runs the page's
    `beforeunload` handler, while Chrome's own `Target.closeTarget` does not (measured: review-17
    checks T1 and the probe of C10). So Playwright's `page.close()` with no `runBeforeUnload` opens
    the dialog of such a page. Playwright with no dialog listener accepts it itself (playwright-core
    1.64.1), and the tab closes after its handler ran. A client with a listener, for example the
    Playwright MCP, must answer the dialog; else the call waits 30 s and fails with the deadline's
    text (not measured). The per-scope build removes this difference: there `tabs.remove` is the
    receiver's close (C10), as Chrome's own command.
  - In the per-scope build `windows.create` needs a scope (C10), which would put the window into
    one. So there the receiver keeps the last window for every close that the relay asks for, and
    this bullet goes (part 2; the orphan-tabs design, board ab-v16.39, sections 7 and 13; board
    ab-v16.41). The relay sends `tabs.remove` for `end_scope` and `Target.closeTarget`, and a
    client's `Page.close` on a page session goes to Chrome as any page call
    (`debugger.sendCommand`). Both run in the receiver's removal queue, with its window rule and its
    pending closes (C10, removals and the last window). `tabs.remove` is the receiver's close there
    (`Target.closeTarget` through `chrome.debugger`: no `beforeunload`, as Chrome's own
    `Target.closeTarget`); only a client's `Page.close` runs the page's `beforeunload` handler. The
    relay keeps no query, window or queue of its own for them; `Target.closeTarget` and `Page.close`
    give the client the receiver's answer (an error of the window rule too). A `Page.close` on a
    child session (a frame or a worker) goes to Chrome as today, with no window rule.
- A link drop (C10 `link` down): every connection closes with
  1011, `The agent browser's link went down`. The model starts again at the next `link` up. In the
  per-scope build it starts with the tabs of the receiver's map (C10, the steps of the link up): a
  scope's tabs stay open over a link drop and over a relay restart, and a client of the scope that
  connects again sees them, free (`context.pages()` after `Target.setAutoAttach`). Its CDP sessions
  do not stay: the receiver's cleanup at a link change, or step 4 at a relay restart, detached the
  tabs (C10). Today's relay starts with no tab: a client that connects again sees none of the tabs
  of before (measured, board ab-v16.39).
- The relay stops: every connection closes with 1001, `The agent browser stopped`.
- At each `allowlist` line, the relay closes every connection of a scope that has no list any more,
  with 1008, `The allowlist has no list for this scope any more`. In the per-scope build, at a line
  whose `scopes` and `lists` are objects, it also drops from its model each tab of a scope that the
  line gives no list: the receiver's sweep has closed those tabs, or taken them out of their scope
  into its orphan set (C5), so a later session of the same name never sees one (C4). A tab that
  still waits for its `bridge.tabScope` (up to `TAB_SCOPE_WAIT_MS`) has no scope yet, and it stays.
  At a line whose `scopes` or `lists` is not an object it drops no tab: the receiver sweeps nothing
  then (C5).
- With keys on, at each `allowlist` line, the relay closes every connection of a scope that still
  has a list (the same list or another one) but whose `keys` entry is gone, or holds another hash
  than at the connection's upgrade (also a line with no `keys` field),
  with 1008, `The key of this session is no longer valid`. The shared vector: `lineCloses` in
  `test/vectors/endpoint.json`.

**Where each call goes.** The model answers the calls of its set (two-modes design, section 4.3) on
the root session and on a browser session (`Target.attachToBrowserTarget`). Every other call there
is refused (`Not available in the agent browser: <method>.`, below). On a page session, the model
answers its calls as in this table, and on Linux also `Emulation.setFocusEmulationEnabled` (below).
Every other call on a page session goes to Chrome (`debugger.sendCommand`), after the refusals
below.

| Method | On the root or a browser session | On a page session |
| --- | --- | --- |
| `Browser.getVersion` | the model | refused |
| `Browser.close` | the model | refused |
| `Browser.setDownloadBehavior` | the model | refused |
| `Browser.cancelDownload` | the model | refused |
| `Browser.grantPermissions` | the model | refused |
| `Browser.resetPermissions` | the model | refused |
| `Browser.getWindowForTarget` | the model | the model (Playwright sends it there) |
| `Browser.getWindowBounds` | the model | the model |
| `Browser.setWindowBounds` | the model | the model |
| `Target.setAutoAttach` | the model | Chrome (the frames and workers of the tab) |
| `Target.setDiscoverTargets` | the model | the model |
| `Target.getTargets` | the model | the model |
| `Target.getTargetInfo` | the model | Chrome without `targetId` (the tab's own info); the model with a `targetId`; on the root with no `targetId`, the model (below) |
| `Target.createTarget` | the model | the model, never Chrome: the tab joins the scope |
| `Target.closeTarget` | the model | the model |
| `Target.activateTarget` | the model | the model |
| `Target.attachToTarget` | the model | the model |
| `Target.detachFromTarget` | the model | the model; Chrome for a child session of the tab (a frame or a worker) |
| `Target.attachToBrowserTarget` | the model | the model |
| `Target.getBrowserContexts` | the model | the model |

- `Target.getTargetInfo` on the root with no `targetId` answers the browser's own target:
  `{"targetInfo":{"targetId":"<id>","type":"browser","title":"","url":"","attached":true,"canAccessOpener":false}}`
  (Playwright's `connectOverCDP` needs it, `crBrowser.ts:90-97`). This is the only place where the
  model names a browser target. `Target.getTargets` and the attach events never report one.
- Every other `Browser.*` or `Target.*` call on a page session is refused, as on the root.
- A page call (for example `Page.navigate`) on the root or a browser session is refused: it names
  no tab.
- `Emulation.setFocusEmulationEnabled` on a page session (also a child session of the tab): on
  Linux the model answers `{}` itself, and the call never reaches Chrome. On the Mac it goes to
  Chrome. The table does not list it, because it is not in the model's set: on the root or a browser
  session it is refused, as every page call
  (`Not available in the agent browser: Emulation.setFocusEmulationEnabled.`). The reason is under
  "One window per page" (below).

**The scope, and one connection per tab.**

- A connection sees and attaches only the tabs of its scope. A tab joins a scope when a connection
  of that scope opens it (`Target.createTarget`: the relay names the scope in C10's `tabs.create`
  or `windows.create`), or when the receiver reports it (C10's `bridge.tabScope`: a popup takes its
  opener's scope, a replaced tab its old scope). The relay never puts a tab in a scope that the
  receiver did not report; its own `tabs.onReplaced` handling follows `bridge.tabScope` too. Every
  other tab is in no scope, and no connection sees it: the operator's tabs, the restore tab of an
  import, a tab that the receiver's map does not hold. In the per-scope build a tab of the map from
  before the relay's link up joins its scope at the link up, free (C10, the steps of the link up:
  `bridge.tabScopes`); for today's relay a tab from before it started is in no scope.
- A new tab that the relay did not create, and whose `bridge.tabScope` has not come: the relay keeps
  it in its model with no scope, attached and held as the receiver reported it, for up to
  `TAB_SCOPE_WAIT_MS = 500`. On `bridge.tabScope` it announces the tab to the scope, as a popup. At
  the end of the wait it releases and detaches the tab, as a tab of no scope; a later
  `bridge.tabScope` still puts the tab in its scope, as a free tab. At the tab's `tabs.onRemoved`
  the relay drops a `bridge.tabScope` that it kept for it.
- A tab belongs to one connection at a time, its owner. The owner is the connection that opened it,
  the owner of its opener (for a popup whose opener is in the same scope; the opener comes from
  Chrome's `openerId`, not from `chrome.tabs`' `openerTabId`, measured), or the first connection of
  the scope that attaches the free tab. The reason: all sessions of a tab share its one
  `chrome.debugger` attachment and its domain state.
- One connection can have several sessions on its tab (auto-attach, `Target.attachToTarget`,
  Playwright's `newCDPSession`).
- Another connection of the same scope sees the tab in `Target.getTargets` with `attached: true`.
  It cannot attach to it.
- When the owner leaves, the model detaches the tab. Its domain state goes, and the tab stays open,
  free for the scope's next connection.
- When the model detaches a tab itself (after a timeout, C10), the tab stays in its scope and its
  owner stays the same. When that connection has auto-attach on, the model attaches the tab again at
  once and announces it with a new `Target.attachedToTarget`. Playwright then gets a new page object
  for the same tab. Without auto-attach, the tab is free for the scope.
- For a tab that it creates (`Target.createTarget`), the relay asks for `about:blank`, with the
  connection's scope as the second arg: on Linux always C10's `windows.create` (a window of its
  own), on the Mac C10's `tabs.create` (`windows.create` only for `"newWindow":true`; one window per
  page, below). It holds the tab there (C10's hold), and navigates it to the client's `url` after
  the client's `Runtime.runIfWaitingForDebugger` has released the hold. C10 opens a new tab at
  `about:blank` only: a tab that opened the client's URL at once would load that URL before the
  hold, and before its scope rule is in force (C5).
- There is one browser context. Every target has `"browserContextId":"agentwatch-default"`, also in
  the answers and events from Chrome that the model passes on. `Target.getBrowserContexts` answers
  `{"browserContextIds":[]}`.
- The model turns the eager attach (C10) on while at least one connection is open.

**One window per page (board ab-v16.28).** On Linux the relay gives each page a window of its own,
as the anti-detect design says (agent-browser `docs/research/2026-11-05-anti-detect-drive.md`, "The
answer", steps 1, 2 and 5). A site can see a page in a background tab: the page is `hidden` and
draws nothing. With focus emulation, a page reports the focus while another page has it. On the Mac
the relay keeps its tabs until board task ab-v16.27 measures the Mac.

- `Target.createTarget`. On Linux the relay sends C10's `windows.create` with
  `[{"url":"about:blank","focused":false}, "<scope>"]` (the connection's scope), and never
  `tabs.create`, also when the client asks for a tab (no `newWindow`, or `"newWindow":false`) or a
  background tab (`"background":true`). The hold and the navigation after it stay the same (above).
  So a new page never takes the focus from another window, and Playwright's `newPage` and
  agent-browser's `open --tab` with `--cdp-url` each get a window. On the Mac the relay sends
  `tabs.create` with `[{"url":"about:blank","active":<boolean>}, "<scope>"]` (`active` is false for
  `"background":true`), and `windows.create` as on Linux only for `"newWindow":true`. A
  `Target.createTarget` with a `url` off the scope's list gets its refusal (below) before the relay
  opens a window or a tab.
- Focus emulation. On Linux the model answers `Emulation.setFocusEmulationEnabled` on a page session
  with `{}` (above), also for `"enabled":false`. A page in a window of its own draws without focus
  emulation, with the agent unit's Chrome flags (agentwatch's part). Playwright sends the call for
  each page unless it connects with `noDefaults: true`; the Playwright MCP connects with
  `noDefaults`. On the Mac the call goes to Chrome.
- The window comes forward for input, on Linux only. An input that starts an action is one of these
  calls on a page session:
  - `Input.dispatchMouseEvent` with `"type":"mousePressed"`;
  - `Input.dispatchKeyEvent` with `"type"` `keyDown`, `rawKeyDown` or `char`;
  - `Input.insertText`;
  - `Input.dispatchTouchEvent` with `"type":"touchStart"`;
  - `Runtime.callFunctionOn` with an argument whose `value` is a string that is all of Playwright's
    function `([injected, node, ...]) => injected.focusNode(...)`: the whole string matches
    `^\(\[injected\b[^\]]*\]\)\s*=>\s*injected\.focusNode\([^)]*\)\s*$` (the relay's
    `PLAYWRIGHT_FOCUS`; Playwright's focus call, below). A string that only contains `.focusNode(`,
    for example in a client's own function, does not count.

  Before such an input goes to Chrome, the model activates its page, as a person's press does:
  1. It reads the tab (`tabs.get`). When the tab is not active (a popup tab that the site opened in
     the window is in front), it selects the tab (`tabs.update` with `{"active":true}`).
  2. It reads the window (`windows.get`). When the window does not have the focus, it focuses the
     window (`windows.update` with `{"focused":true}`).
  3. It sends the input (`debugger.sendCommand`).
- The order and the limit. The tab's later calls for Chrome (`debugger.sendCommand`) wait behind
  that input, and reach Chrome in the client's order. The calls that the model answers go at once.
  The model runs one activation at a time, for all connections: an activation starts when the
  activation before it and its input went to the bridge. When an activation does not end in 2 s,
  the input goes on. After the limit, that activation sends no `tabs.update` and no
  `windows.update`; one already sent still runs. When an activation fails, the relay logs the error,
  and the input goes on. Every other input (a move, a wheel event, a release, a key-up) needs no
  activation. On the Mac every input goes to Chrome at once.
- The reason for the activation: on Linux Chrome raises a window for a press in it, but not for a
  key. A key into a window that does not have the focus gives its page the focus while another page
  keeps it.
- Playwright's focus call. `pressSequentially`, `press` and `type` on a locator first call
  Playwright's injected `focusNode` with a caret reset (Playwright 1.64.1). `focus` on a locator
  calls `focusNode` too, without the caret reset, and its window comes forward too. Playwright sends
  the text of its utility-script function as a string argument of `Runtime.callFunctionOn`. With the
  caret reset, `focusNode` moves the caret of an input to its start when `document.hasFocus()` is
  false. So without the activation, Playwright types at the start of a field whose window does not
  have the focus. The rule depends on Playwright's internal names `injected` and `focusNode`. If a
  later Playwright renames them, the caret moves to the start again, and nothing else changes.
- On Linux and on the Mac, `Target.activateTarget` only selects the tab in its window (`tabs.update`
  with `{"active":true}`). `Page.bringToFront` goes to Chrome, which selects the tab and focuses its
  window. On Linux the live test measured that `Page.bringToFront` focuses the page's window; it
  measured no tab switch.
- A popup stays where the site opened it: a tab in the opener's window (`target=_blank`, or
  `window.open` with no features), or a window of its own. The relay never moves a tab to another
  window.
- Measured (taylor, Chromium 156 in Xvfb, chrome-extension main 7e36332, three runs on 2026-11-05;
  the live group `windows` of agent-browser PR #44): with Playwright's defaults, with `noDefaults`
  and with the Playwright MCP, a page in its own window stayed `visible` while another window had
  the focus (with the live test's Chrome flags; the agent unit's Chrome flags are agentwatch's part),
  and it got the focus only with the input. Playwright typed where the caret was. No
  `Emulation.setFocusEmulationEnabled` reached Chrome. An activation took a median of 16 ms
  (`tabs.get` 3 ms, `windows.get` 13 ms), and `windows.update` 29 ms more when the window came
  forward.

**Permissions and content settings.**

- The model grants these permissions (the CDP name, then the content setting of C10's
  `contentSettings.set`): `geolocation` (`location`), `notifications` (`notifications`),
  `videoCapture` (`camera`), `audioCapture` (`microphone`), `clipboardReadWrite` and
  `clipboardSanitizedWrite` (`clipboard`). A grant with an origin needs a host that the
  connection's scope's list covers. A grant with no origin covers the scope's list. It refuses every
  other name.
- Content settings act on the whole profile and stay after a restart. So at its first `link` up the
  relay clears the six content-setting types (`contentSettings.clear`). Then no grant of an earlier
  run stays.
- At each `allowlist` line, the relay sets the content settings again: the grants of the open
  connections that their own scope's list still covers, and `automaticDownloads` to `allow` for each
  entry of every list (two-modes design, section 4.5; per-scope design, section 8.4).
- What one profile shares between scopes, stated plainly: a content setting is per origin pattern
  and acts on the whole profile, so a grant of one scope applies to another scope's tab on the same
  host; the sent sign-ins (cookies, storage, workers) are in the profile for every scope; only
  navigation is guarded per scope.

**Refusals.** The model answers each refused call itself, before any bridge request, with the CDP
error `{"code":-32000,"message":"<text>"}`. So the text is the same on every Chrome version, and the
call never reaches Chrome. In a text, `<method>` is the CDP method of the call, `<host>` a host,
`<name>` a permission name, and `<seconds>` the wait in seconds. `<scheme>` is a URL's scheme with
its colon (for example `chrome:`), or `relative` for a URL with no scheme. A rule applies on every
session (the root, a browser session, a page session) unless it names one.

A new context (board ab-jzg Q1: refuse). Programs use `browser.contexts()[0]`, as the Playwright MCP
does by default.

| What | The call | The text |
| --- | --- | --- |
| `browser.newContext()`, `browser.newPage()`, `recordVideo`, the MCP's `--isolated` | `Target.createBrowserContext` | `Not available in the agent browser: a new browser context (Target.createBrowserContext). Use the default context: browser.contexts()[0].` |
| A tab in another context | `Target.createTarget` with a `browserContextId` other than `agentwatch-default` | `No browser context with given id found` |

Chrome's approval path (board ab-jzg Q2: never). These features need Chrome's "Allow remote
debugging?" approval, and Chrome refuses them to an extension (two-modes design, section 5, rows 32
to 39). Agent mode never opens that path: no prompt and no debugging port.

| What | The call | The text |
| --- | --- | --- |
| JS coverage, CPU profiles | `Profiler.*` | `Not available in the agent browser: JS coverage and profiling (<method>). It needs Chrome's remote-debugging approval. Agent mode never asks for it.` |
| `page.requestGC()`, heap profiles | `HeapProfiler.*` | `Not available in the agent browser: heap profiling and page.requestGC() (<method>). It needs Chrome's remote-debugging approval. Agent mode never asks for it.` |
| `ignoreHTTPSErrors` | `Security.setIgnoreCertificateErrors` | `Not available in the agent browser: ignoreHTTPSErrors (Security.setIgnoreCertificateErrors). It needs Chrome's remote-debugging approval. Agent mode never asks for it.` |
| Service workers | `ServiceWorker.*` | `Not available in the agent browser: service workers (<method>). It needs Chrome's remote-debugging approval. Agent mode never asks for it.` |
| GPU and system data | `SystemInfo.*` | `Not available in the agent browser: system information (<method>). It needs Chrome's remote-debugging approval. Agent mode never asks for it.` |
| Tracing with no page (`browser.startTracing()`) | `Tracing.*` on the root or a browser session | `Not available in the agent browser: browser-wide tracing (<method>). Trace a page: browser.startTracing(page).` |
| Calls outside the model's set; extensions; the old interception | A call that the table above refuses; `Extensions.*`; `Target.exposeDevToolsProtocol`; `Network.setRequestInterception` | `Not available in the agent browser: <method>.` |
| `chrome://` pages, other extensions' pages, local files | `Page.navigate` with a `url` that is not `about:blank` and whose scheme is not `http:`, `https:` or `data:`, and is not `blob:` with an `http:` or `https:` inner origin; `Target.createTarget` with a `url` that is not empty, `about:blank`, `http:` or `https:` | `Not available in the agent browser: <scheme> URLs (<method>). Agent mode opens web pages only.` |

- `about:` URLs other than `about:blank` are refused, because Chrome opens some of them as
  `chrome://` pages. `file:` URLs are refused in the model; DNR blocks them in Chrome too (measured).
- An empty or missing `url` of `Target.createTarget` is `about:blank`. A new tab opens at
  `about:blank` (C10's `newTab` and `newWindow`), and the relay navigates it to an `http:` or
  `https:` `url` of the scope's list after the hold (the scope, and one connection per tab, above);
  a client navigates it to a `data:` or `blob:` URL after.
- A `blob:` URL passes only as `blob:http://<origin>/<id>` or `blob:https://<origin>/<id>`, the form
  that a page's `URL.createObjectURL` makes. `blob:chrome-extension://...`, `blob:null/...` and
  `blob:file://...` are refused: the first would open a page of an extension, and the others have no
  web origin. The refusal text names the scheme `blob:`.
- Service-worker targets: the model reports no target of type `service_worker`, `shared_worker` or
  `browser`. So `context.serviceWorkers()` is empty, and no `serviceworker` event comes. This is not
  an error: no CDP call asks for those targets alone.

Page marks (board ab-jzg Q3: refuse). These features put `__playwright__` names on the page's
`window`, which a site can see (two-modes design, section 5, rows 25 and 27). The rule refuses only
the page's main world (the world of the page's own scripts):

| What | The call | The text |
| --- | --- | --- |
| `addInitScript`, `exposeFunction`, `exposeBinding`, tracing snapshots, `page.clock` | `Page.addScriptToEvaluateOnNewDocument` with no `worldName`, or with `""` (the main world) | `Not available in the agent browser: init scripts in the page's main world (Page.addScriptToEvaluateOnNewDocument). addInitScript, exposeFunction, exposeBinding and tracing snapshots put names on the page that a site can see.` |
| `exposeFunction`, `exposeBinding` | `Runtime.addBinding` with no `executionContextName`, or with `""` (the main world) | `Not available in the agent browser: bindings in the page's main world (Runtime.addBinding). exposeFunction and exposeBinding put names on the page that a site can see.` |

- The same calls pass when they name an isolated world: `Page.addScriptToEvaluateOnNewDocument`
  with a `worldName` that is not empty, and `Runtime.addBinding` with an `executionContextName` that
  is not empty. A page's own scripts cannot read an isolated world. Playwright needs this: it sends
  `Page.addScriptToEvaluateOnNewDocument` with `"source":""` and its utility world's `worldName` for
  each page and each frame. If the model refused those, every Playwright connection would break.
- A `Runtime.addBinding` with an `executionContextId` and no `executionContextName` is refused. This
  is a policy, not a measure: the model cannot tell which world an id names.
- So these features put no `__playwright__` name on a page. The probe measured that plain use
  (navigate, click, type, read, screenshot, the MCP's default tools) adds no page global (two-modes
  design, section 7). A program that uses one of these features fails. Tracing with screenshots and
  no snapshots works.
- For stage 3: Playwright 1.64.1 keeps a refused `exposeFunction` or `exposeBinding` in its context.
  After one, it sends `Runtime.addBinding` again for each new page, so each later page of that
  connection fails too. Such a program must connect again without the feature. After a refused
  `addInitScript`, a later page works (measured). A
  program that calls `addInitScript` before it has a page gets no error at that call.
- A program's own `page.evaluate` can still write anything into the page. That is the program's
  choice, not a mark of Playwright.

Cookies (board ab-8mf: no cookies by default). The browser sends and stores its cookies as before,
so sites work. Programs cannot read, set or remove cookies through the endpoint.

| What | The call | The text |
| --- | --- | --- |
| `context.cookies()`, `addCookies()`, `clearCookies()`, `storageState()`, raw cookie calls | `Storage.getCookies`, `Storage.setCookies`, `Storage.clearCookies`, `Network.getCookies`, `Network.getAllCookies`, `Network.setCookie`, `Network.setCookies`, `Network.deleteCookies`, `Network.clearBrowserCookies` | `Not available in the agent browser: cookies (<method>). The browser sends its cookies to sites itself. Programs cannot read, set or remove them.` |
| Clearing a site's data with its cookies | `Storage.clearDataForOrigin`, `Storage.clearDataForStorageKey` when `storageTypes` names `cookies` or `all` | The same text |
| A cookie that a client sends or sets in a header | `Network.setExtraHTTPHeaders` or `Fetch.continueRequest` with a `Cookie` header; `Fetch.fulfillRequest` or `Fetch.continueResponse` with a `Set-Cookie` header in `responseHeaders` or `binaryResponseHeaders` | The same text |

- Header names match in any case.
- The cookie marker. In every `Network.*`, `Fetch.*` and `Audits.*` event and result that the model
  gives a client, the cookie values become the marker `(hidden)`, at any depth (for example in a
  `redirectResponse`, or in `Network.signedExchangeReceived`'s `outerResponse`). This covers
  `Network.requestWillBeSent`, `Network.requestWillBeSentExtraInfo`, `Network.responseReceived`,
  `Network.responseReceivedExtraInfo`, `Network.webSocketWillSendHandshakeRequest`,
  `Network.webSocketHandshakeResponseReceived`, `Network.signedExchangeReceived`,
  `Fetch.requestPaused` and `Audits.issueAdded`:
  - in header objects (`headers`, `requestHeaders`): the value of each `Cookie` and `Set-Cookie`
    header becomes `(hidden)`;
  - in header lists of `{name, value}` (`headers`, `responseHeaders`): the same;
  - in raw header texts (`headersText`, `requestHeadersText`): each such line becomes
    `<name>: (hidden)`;
  - `rawCookieLine` (in `Audits.issueAdded`'s cookie issues) becomes `(hidden)`. Not measured
    whether Chrome sends it to an extension;
  - the cookie lists `associatedCookies`, `blockedCookies` and `exemptedCookies` become `[]`.
- The limits of this rule, stated plainly:
  - Page storage stays readable. `DOMStorage.*`, `IndexedDB.*`, `CacheStorage.*` and page scripts
    through `Runtime` (for example `localStorage` in `page.evaluate`) read it. Many sites keep
    sign-in tokens there, and the import sends page storage too (C2).
  - A page script, also one that a program runs with `evaluate`, can still read and change the
    cookies that are not httpOnly (`document.cookie`), as any page script can.
  - These Playwright features fail, because they read or set the context's cookies (read in
    playwright-core 1.64.1, not run): `context.request`, `page.request` and `route.fetch()` (each
    request reads the cookies first), `routeFromHAR` with `Set-Cookie` entries (it fulfills with
    `Set-Cookie`), and `context.storageState()`.
- A later cookie grant, for a use that needs cookie access, can lift these refusals for the granted
  sites and add `cookies.*` ops to C10. The relay's code marks the place.

The allowlist, the scope and the size (two-modes design, sections 4.3, 4.4 and 8; per-scope design,
sections 6 and 8.4):

| What | The call | The text |
| --- | --- | --- |
| A permission for an origin off the scope's list | `Browser.grantPermissions` with such an `origin` | `Not allowed: <host> is not on the allowlist` |
| A navigation off the scope's list | `Page.navigate` of a tab's main frame with an `http:` or `https:` URL whose host the scope's list does not cover, or a `blob:` URL whose inner origin has such a host; `Target.createTarget` with such a `url` | `Not allowed: <host> is not on the allowlist` |
| A permission that `chrome.contentSettings` cannot grant | `Browser.grantPermissions` with another name | `Not available in the agent browser: the permission <name>` |
| A tab of the scope that another connection owns | `Target.attachToTarget` | `The tab is in use by another connection of this scope` |
| A tab of another scope, or no such tab | `Target.attachToTarget`, `Target.closeTarget`, `Target.activateTarget`, `Target.getTargetInfo`, `Browser.getWindowForTarget` | `No target with given id found` |
| A window with no tab of the scope | `Browser.getWindowBounds`, `Browser.setWindowBounds` | `Browser window not found` |
| A session that the connection does not have | Any call with that `sessionId` | `Session with given id not found.` |
| A result above `MAX_RESULT` | The receiver or the daemon answered `too large` | `The answer of <method> is larger than the agent browser's link allows (128 MiB).` |
| A command whose bridge request is above `MAX_REQUEST` | Any | `The command is too large for the agent browser: <method>.` |
| A deadline (C10) | The receiver or the daemon answered `timeout` | `The agent browser did not answer <method> in <seconds> s.` |

- A tab's main frame: a `Page.navigate` with no `frameId`, or with the `frameId` of the tab's own
  target (Playwright's `goto` sends the main frame's id). A frame's navigation is not refused (O11).
  So a client's `Page.navigate` or `Target.createTarget` never reaches a service worker of a site off
  its list (C5, the guard), and Chrome commits no error page for it. Other client actions still
  navigate as the page does (`Runtime.evaluate`, input on a link, `Page.reload`,
  `Page.navigateToHistoryEntry`); DNR and C5's guard cover them.
- After a `timeout`, the model acts as C10 says: no detach for a command that waits for a promise;
  for any other `debugger.sendCommand`, and for a `debugger.attach`, it detaches the tab, sends
  `Target.detachedFromTarget` to the tab's sessions, and announces the tab again (above).
- The text for another scope's tab is Chrome's own text for a target that does not exist. So a
  connection cannot tell another scope's tab from no tab.
- In the per-scope build, a `Target.createTarget` whose `tabs.create` or `windows.create` gets the
  receiver's `no list for this scope` (C10: the receiver applied a `set_scopes` without the scope's
  list before the relay got its `allowlist` line and closed the connection with 1008) gives the
  client `{"code":-32000,"message":"no list for this scope"}`, as for any other error of an op.

**The scope's list (board ab-v16.23).** The relay applies C4's `set_scopes` rules to the `allowlist`
line (C10), as the receiver applies them to `set_scopes` (the shared vector
`test/vectors/scopes.json` checks both). A scope's list: the list that its `scopes` entry names,
when it has an entry (no fall-back when that list is absent), else the `default` list. With keys
on, a scope that the line does not name has no list, whatever `default` says (it has no key). The
relay ignores the line's `operator` field. The readiness per scope and the order of the checks are
under "Before the upgrade", the 1008 closes under "When a connection ends", and the refusals off
the scope's list under "Refusals".

**The scope's key (the design's choice 1, aw-lead's "key").** Without keys the scope is advisory:
any process of the daemon's OS user can connect with any scope and get that scope's list. With the
design's choice 1 b (asked in ab-dm6) keys are on: the relay admits a connection only with its
scope's key. That changes two rules of "The socket and the URL" above: the URL with its key is a
secret, and a process of the daemon's OS user may connect only with the scope's key. With keys on,
`default` is `null`: a scope that `scopes` does not name has no key. The same OS user can read
`/proc/<pid>/environ`, so the key guards against mistakes and against an injected instruction that
only names another scope. It does not guard against a process of that user that reads another
process's environment, a token file, a transcript or a pane. The agent's own shell commands inherit
the key: an `env` writes it into the transcript.

- The token (the key): 64 lowercase hex digits (32 random bytes; `ws` cuts a `ws+unix:` URL at each
  `:`, and a `#` is an error, so hex is safe). Its hash: SHA-256 of those 64 ASCII characters, in
  lowercase hex.
- Where it lives: only in its token file and in the session's environment, where the launch line
  puts it at the session's launch, in one variable, `AGENTWATCH_BROWSER_CRED` (its name keeps `KEY`,
  `SECRET` and `TOKEN` out: Codex's default policy removes such names from the commands that the
  model runs). Never in an argv, never in the output of `agentwatch browser endpoint` or
  `agentwatch browser env`, never in a log, and never in a URL that a tool gets as an argument.
  agent-browser and a script read it from their environment and add it to the URL at the connect
  call only (agent-browser never puts it into its `Settings.cdpUrl`: `agent-browser status` prints
  that). The daemon keeps each session's key in a token file under `~/.config/agentwatch/tokens/`
  (0600 files in 0700 folders, the modes applied again at each write), never in the browser state
  folder.
- The session's environment is the agent's process environment. The launch line reads the key from
  the token file, and so does each line that starts the session's agent again (a restart, an
  account swap, a Codex resume). agentwatch never sets the key with `tmux -e` or `set-environment`:
  both put the value into tmux's argv.
- Only the daemon, and the launch lines that it writes, read the token files. No agentwatch command
  reads a key from them: the CLI cannot tell which session calls (agentwatch #563).
- The operator's answer age-4ks ("env: no", 2026-11-04) stands. Without a key, agentwatch puts no
  endpoint URL into a session's environment; only `agentwatch browser endpoint` and `agentwatch
  browser env` print it, on request. With a key, agentwatch puts only the key variable into the
  environment. `PLAYWRIGHT_MCP_CDP_ENDPOINT` with the key goes into it only after the operator
  answers that question again: it sends each session's Playwright MCP to the signed-in agent
  browser. (ab-dm6's options do not offer that variable, so a yes there does not answer age-4ks
  again.)
- With keys on, `agentwatch browser env` prints the keyless URL and one line that names the key
  variable, never the key. Both lines are comments, not assignments, so an `eval` of the output
  sets nothing (it can neither empty `AGENTWATCH_BROWSER_CRED` nor give an MCP the keyless URL,
  which gets the 403): `# PLAYWRIGHT_MCP_CDP_ENDPOINT without its key: ws+unix://<socket
  path>:/devtools/browser/<scope>` and `# The key is in AGENTWATCH_BROWSER_CRED. Set
  PLAYWRIGHT_MCP_CDP_ENDPOINT in the MCP server's environment (never on a command line) to this
  URL with ?key=, or use agentwatch browser <command>, which passes it for you.` In zsh without the
  `interactive_comments` option, an `eval` of the output prints an error for each line and still
  sets nothing (the Mac stage). `agentwatch browser <command>` passes the key to agent-browser only
  in that one variable, from its own environment, never in a URL or an argv.
- The URL form: the token goes in the query, `ws+unix://<socket
  path>:/devtools/browser/<scope>?key=<token>`, or in an upgrade header `X-Agentwatch-Key:
  <token>` for a client that can send one. Never in the path: playwright-core 1.61.1 and 1.63.0
  put the full path of a failed `connectOverCDP` into the error (six times for a 503), and the
  Playwright MCP gives that error to the agent, so it goes into a transcript; a `?key=` query, and
  the header, reached the relay, and no error held the key (measured by ab-lead's reviewers,
  review-42e and review-42f). A client that prints the URL itself removes the `key` query first:
  agent-browser's own errors and logs (its `cdpUrl` `UsageError` prints the full URL today), and
  agentwatch's logs. No side logs the URL's query or the `X-Agentwatch-Key` header: not the relay,
  not the daemon, not `agentwatch browser <command>`. A limit: with `DEBUG=pw:channel` (or
  `pw:*`), playwright-core 1.61.1 and 1.63.0 write the endpoint URL with its `?key=` and the
  header's value to standard error; clients do not run with that value.
- A valid key: 64 lowercase hex digits, once, in the `key` query or in the `X-Agentwatch-Key`
  header. An empty key, a key of another form, a `key` query or an `X-Agentwatch-Key` header that
  comes more than once, and a key in both the query and the header are no valid key: the key's 403
  at step 3 (before the upgrade, above). A relay without `--keys` ignores a key in the request.
- The hash check (step 6): the relay compares the SHA-256 of the request's key with the scope's
  `keys` entry in constant time (for example `crypto.timingSafeEqual` on the two 32-byte digests).
- Where the relay learns that keys are on: from its start, `agent-browser relay --socket <path>
  --keys`, not from an `allowlist` line (the relay drops the line at each link change). The daemon's
  `allowlist` line then carries `"keys":{"<scope>":"<hash>"}`. With keys on, for a named scope, a
  line with no `keys` field and a scope with no entry in `keys` both get the key's 403 (step 6). A
  `keys` that is not an object applies as an empty object, and an entry whose scope does not match
  the scope pattern, or whose value is not 64 lowercase hex digits, applies as absent. A relay
  started without `--keys` that gets a line with a `keys` field (any value) applies no list of that
  line, as if no line had come: it closes the open connections (1008, no list any more) and answers
  each upgrade with the 503 `the allowlist has keys, but the relay was started without --keys`,
  until a line without `keys` comes. So a daemon and a relay that disagree fail closed, with a
  clear text. The shared vector: `lines` in
  `test/vectors/scopes.json`.
- The key's life: the daemon makes a new key at each launch of a new session, before it adds the
  scope to its map, so the first `allowlist` line that names a scope carries its `keys` entry (else
  step 6 would give the new session the key's 403 in place of the no-list 503 of step 5). It keeps
  the key over a restart of the session's agent. At the session's end it removes the token file and
  drops the scope's entry from `keys`, in the line that drops the scope. A later session of the
  same name never gets an old key. Over a daemon restart the daemon keeps each live session's key in
  its token file (the session's environment still holds it) and sends the hashes again in its next
  `allowlist` line. Only a new session gets a key: a restart, an account swap or a Codex resume of
  the session's agent reads the existing token file, and with no token file the agent gets no key,
  so its session gets the 403 until the operator starts a new session. A lost token file refuses its
  session only at the next restart: of the session's agent (its launch line finds no key) or of the
  daemon (it sends no hash for the scope).
- A launch never waits for the agent browser. The daemon adds the scope to its map before the launch
  and sends `set_scopes` when the link is up. With `default` `null`, an earlier connection gets the
  no-list 503 (step 5), and the agent connects again.
