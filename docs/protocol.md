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
  `{"t":"hello","v":2,"version":"<manifest version>","channels":["main","bridge"]}`;
  `{"t":"res","id":"<id>","ok":true,"data":{...}}` or `{"t":"res","id":"<id>","ok":false,"error":"<text>"}`
  (a res on the bridge channel also has `"ch":"bridge"`, and its `data` can also be a list or `null`:
  C10);
  `{"t":"blocked","tab":<tab id>,"host":"<host>"}`;
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
  `{"t":"req","id":"<id>","op":"set_allowlist","domains":["a.example"]}` ->
  `{"rules":<1 if the valid list is not empty, else 0>,"closed":<tabs closed>,"refused":<entries refused>}`;
  `{"t":"req","id":"<id>","op":"import","state":<C2 payload>}` ->
  `{"cookies_removed":0,"cookies_set":0,"tabs_closed":0,"local":0,"session":0,"idb_databases":0,"idb_records":0,"cache_entries":0,"errors":["<store or cookie name>: <reason>"]}`.
- Ids are strings. The daemon waits 10 s for `ping` and `set_allowlist`, 120 s for `import`.
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

**Target (board ab-v16.23): `set_scopes` in place of `set_allowlist`.** C4, C5, C6, C10 and C11 hold
blocks marked "Target (board ab-v16.23)". Each block is the contract of the build that gives each
scope its own allowlist (the design: agent-browser
`docs/superpowers/specs/2026-11-04-per-scope-allowlist-design.md`). The text around a block holds
until that build merges; the build then replaces it with the block, and changes the vectors with it.
There is no backward compatibility: agentwatch pins both repositories and moves them at once.

- The rollout. The receiver's hello names the new form:
  `{"t":"hello","v":2,"version":"<manifest version>","channels":["main","bridge"],"features":["scopes"]}`.
  Each side meets the other's old form fails closed, by name:
  - A new daemon and an old receiver (its latest hello has no `"scopes"` in `features`): the daemon
    sends `set_allowlist` with `"domains":[]` (the old receiver then blocks every site and closes its
    `http:`/`https:` tabs), writes no `allowlist` line to the relay (so the relay admits no
    connection), and shows on the Browser page: "The agent browser's extension is too old for the
    per-repo allowlists. Update it."
  - A new receiver and an old daemon: the receiver answers `set_allowlist` with
    `{"t":"res","id":"<id>","ok":false,"error":"set_allowlist is gone: send set_scopes"}` and applies
    nothing, so no scope rule exists and every tab is blocked (it removed the old dynamic rules 2
    and 4 at its start). An old relay's `tabs.create` without the scope arg gets `bad args`.
- `set_allowlist` goes. In its place, on channel `main`:
  `{"t":"req","id":"<id>","op":"set_scopes","lists":{"<list>":["a.example"]},"scopes":{"<scope>":"<list>"},"default":"<list>"}` ->
  `{"rules":<scope rules in force>,"closed":<tabs closed>,"refused":<entries, list names and scopes refused>}`.
  - `lists` maps a list name to its entries. A list name matches the scope pattern of C11
    (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`); a list with another name applies as absent, and its entries
    count in `refused`. Each entry follows C5; an entry that is not normalized is refused and
    counted, and the other entries of its list apply.
  - A list whose value is not an array applies as absent and counts 1 in `refused`.
  - `scopes` maps a scope to a list name or `null`. A scope with `null`, or whose list is not in
    `lists`, has no list; it does not fall back to `default`. A scope that does not match the scope
    pattern, or whose value is neither a string nor `null`, applies as absent and counts in
    `refused`.
  - `default` is a list name or `null`: the list of a scope that `scopes` does not name. With `null`,
    or a name that is not in `lists`, such a scope has no list. A `default` that is neither a string
    nor `null` counts in `refused` and applies as `null`.
  - A `lists` or `scopes` that is not an object applies as an empty object and counts 1 in
    `refused`.
  - The new object replaces the last one in full. The daemon sends it after each `link` up, at each
    change of a list, and when a session (a scope) starts or ends. It waits 10 s for the answer.
  - The daemon names a session's scope in `scopes` before it gives the session its endpoint (C11),
    also through `agentwatch browser env` and an endpoint URL in the session's environment at its
    launch: else the session could connect in the moment before and get the `default` list, which
    can be another repo's list. The URL is easy to guess, so with a `default` list any scope that
    `scopes` does not name gets it.
  - At a session's end the daemon writes `end_scope` to the relay (C10) and drops the scope from
    `scopes` in its next `set_scopes` (agentwatch stage 4, B5). So `scopes` holds only the live
    sessions, and the receiver's map cannot grow without bound. With `default` `null` (the design's
    choice 5 a) a dropped scope has no list, so its tabs fail closed. Only with a `default` list does
    the daemon first send the ended scope as `null`, and drop it when `end_scope` has removed the
    scope's tabs: so the ended scope never falls back to the `default` list.
  - With choice 3 of the design (the operator's own tabs), `set_scopes` has one more field,
    `"operator"`: `"*"` (the marked tabs may open any site), a list name (they have that list), or
    `null` (no site; also when the field is absent). C10's target gives the mark. For "every repo's
    sites" agentwatch adds a list of the union to `lists` and names it. Any other value (not `"*"`,
    not `null`, not a string that matches the scope pattern) counts 1 in `refused` and applies as
    `null`; a valid name that is not in `lists` applies as `null` with no count. `rules` counts the
    marked-tab rule (C5's target) too. The daemon's `allowlist` line carries the field; the relay
    ignores it (no connection sees a marked tab). The shared vector `test/vectors/scopes.json` holds
    these cases.
  - The answer comes after the scope rules are in force, the workers are removed (when C5 needs it)
    and the tabs are closed (C5's target). `rules` counts the scope rules of C5's target.
- `blocked` names the tab's scope: `{"t":"blocked","tab":<tab id>,"host":"<host>","scope":"<scope>"}`,
  with `"scope":null` for a tab of no scope.

### C5. The allowlist and the block

- File `CONFIG_DIR/browser/allowlist.json` = `{"allow": ["example.com", ...]}` (agent-browser's
  format; the daemon writes it with `statefiles.write_json`).
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
- DNR: the receiver's static ruleset `block_main_frame` (`rules/block-main-frame.json`, enabled in the
  manifest): rule id 1, priority 1, `{"type":"block"}`, `resourceTypes: ["main_frame"]`. One dynamic
  rule id 2, priority 2, `{"type":"allow"}`, `requestDomains` = the list, `resourceTypes:
  ["main_frame"]`; no rule 2 when the list is empty. So the block holds from Chromium's first moment,
  before the service worker runs.
- Three more rules come from the two-modes design (sections 7 and 8). Each `set_allowlist` writes the
  dynamic rules 2, 4 and 5 in one `updateDynamicRules` call, so the daemon's `allowlist` line to the
  relay (C10) always comes after them. The answer's `rules` still counts rule 2 only.
  - The frame rules, as rules 1 and 2 for pages. The static ruleset `block_frames`
    (`rules/block-frames.json`, enabled in the manifest): rule id 3, priority 1, `{"type":"block"}`,
    `resourceTypes: ["sub_frame", "object"]` (an `<object>` or `<embed>` document is type `object`).
    The dynamic rule id 4, priority 2, `{"type":"allow"}`, `topDomains` = the list, the same
    `resourceTypes`; no rule 4 when the list is empty. A CDP client can make a top-level document
    with no request (`about:blank`, `setContent`) and put any host in a frame, an `<object>` or an
    `<embed>` there; these rules load such a document only in a tab whose top-level domain is on the
    list. A page of an allowlisted site still loads them from any host (O11). Measured on Chromium
    156: no frame, `<object>` or `<embed>` document loads under an `about:blank` tab, also from an
    allowlisted host; under an allowlisted page all three load, also from an off-list host; an
    `about:blank` popup of an allowlisted page loads them too. `topDomains` needs Chrome 141; the receiver's `minimum_chrome_version` is 145,
    a safe minimum.
  - The navigation-header rule: dynamic rule id 5, priority 3, `{"type":"modifyHeaders",
    "requestHeaders":[{"header":"sec-fetch-site","operation":"set","value":"none"}]}`,
    `resourceTypes: ["main_frame"]`, `initiatorDomains` = the receiver's own ID (`chrome.runtime.id`),
    `regexFilter` = `^(https://|http://(localhost|[^/:]+\.localhost|127\.[0-9]+\.[0-9]+\.[0-9]+|\[::1\])(:[0-9]+)?/)`.
    Chrome names the extension as the initiator of a top-level request that it starts (a bridge
    `Page.navigate`, `tabs.create`), so without the rule a `Page.navigate` sends `Sec-Fetch-Site:
    cross-site`. Chrome sends `Sec-Fetch-*` headers only to a potentially trustworthy URL (`https:`,
    and `http:` to `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`), so the `regexFilter` keeps
    the rule to those: a `Sec-Fetch-Site` on another `http:` URL would mark the agent browser.
    Measured on Chromium 156: a `Page.navigate` sends `none` and `Sec-Fetch-User: ?1`, as a typed
    URL; a page script's navigation keeps `same-origin`; a `Page.navigate` to an off-list host is
    still blocked; a `Page.navigate` and a page script's navigation to a plain-`http:` host that is
    not localhost send no `Sec-Fetch-*` header. Chrome applies a `modifyHeaders` rule only above the
    priority of every `allow` rule that matches, so its priority is above rule 2's.
- `set_allowlist` replaces the list. An entry that is not a normalized entry (C5 rules, equal to its
  normalized form) is refused and counted in `refused`; the valid entries apply, so an invalid entry
  never keeps an older, wider rule. A `domains` that is not a list applies as an empty list.
- A site's service worker answers a navigation to its host before DNR sees it (measured on Chromium
  156: a link to a host that had left the list loaded the worker's page). So whenever the new list
  lacks an entry of the last applied one (and on the first `set_allowlist` after the receiver's
  worker starts), the receiver calls `browsingData.remove({}, {serviceWorkers: true})` (permission
  `browsingData`) after the rule update and before the tabs close. A failed removal fails the call
  (`ok: false`) after the tabs closed; the next call removes again.
- On each `set_allowlist` the receiver closes every tab whose `http:`/`https:` host the new list does
  not cover; if that would close the last tab of a window, it first opens `about:blank` there.
- A main-frame `webNavigation.onErrorOccurred` with `net::ERR_BLOCKED_BY_CLIENT` sends `blocked` with
  the host only.
- Stage-2 limit (not handled now): a tab whose back/forward cache holds a page of a removed host may go
  Back to it with no request, so DNR does not block it.

**Target (board ab-v16.23): a list per scope.** Measured in the design's probe (Chromium 156,
2026-11-04). It replaces the DNR bullets, `set_allowlist`, the worker removal and the closing rule
above. The entry rules (normalization, refusal) stay.

- Each tab has at most one scope (C10's target gives the map), and each scope at most one list
  (`set_scopes`, C4's target: its `scopes` entry when it has one, else `default`). A **tab's list** is its scope's list. A tab of
  no scope, and a tab whose scope has no list, has no list.
- The rules:
  - Static rules 1 (`block_main_frame`) and 3 (`block_frames`) stay as above.
  - Dynamic rule 5 (the navigation-header rule) stays as above. The receiver writes it at each
    `set_scopes`, in one `updateDynamicRules` call that also removes the dynamic ids 2 and 4.
  - Dynamic rules 2 and 4 go. The receiver removes ids 2 and 4, and every session rule, as the first
    thing that its worker does at its start, and removes ids 2 and 4 again at each `set_scopes`: a
    package before this build leaves them in the profile, and dynamic rules stay after a browser
    restart (measured). Between an update of the package and that start, the old rules 2 and 4 still
    allow the old one list in every tab (the upgrade window).
  - The **scope rules** are session rules (`updateSessionRules`). For each list L that has at least
    one entry and is the list of at least one open tab: one rule with priority 2,
    `{"type":"allow"}`, `requestDomains` = L, `resourceTypes: ["main_frame"]`, `tabIds` = the tabs
    whose list is L; and one rule with priority 2, `{"type":"allow"}`, `topDomains` = L,
    `resourceTypes: ["sub_frame", "object"]`, the same `tabIds`. Their ids are 100 and up, two per
    list; the receiver picks them. A list with no open tab or no entry has no rule.
  - The import's rules (C6's target): session rule id 6, priority 2, `{"type":"allow"}`,
    `requestDomains` = [the import's `domain`], `resourceTypes: ["main_frame"]`, `tabIds` = [the
    restore tab]; and session rule id 7, priority 2, `{"type":"allow"}`, `topDomains` = [the same
    `domain`], `resourceTypes: ["sub_frame", "object"]`, the same `tabIds`. They hold from C6 step 2
    until the restore tab's last navigation (C6's target).
  - The marked-tab rule (with choice 3 of the design; C10's target gives the operator mark): with
    `"operator":"*"`, session rule id 8, priority 2, `{"type":"allow"}`, `resourceTypes:
    ["main_frame", "sub_frame", "object"]`, `tabIds` = the marked tabs, no host condition. No rule 8
    while no tab is marked (DNR refuses an empty `tabIds`). With `"operator":"<list>"`, the marked
    tabs join the `tabIds` of that list's two scope rules. With `null`, they have no rule.
  - Each change is one `updateSessionRules` call, and the changes run one after the other, each from
    the map when it runs. A `set_scopes` replaces every scope rule. A tab that gets or loses a scope
    replaces only the two rules of its list (of both lists when it changes lists).
  - A failed `updateSessionRules` (the rule limit, a Chrome error) fails closed: the receiver removes
    every scope rule with a remove-only call and keeps the map, so the tabs of every scope are
    blocked until the next update that succeeds; that next update is a full replace from the map. A
    failed `set_scopes` answers `ok: false` after the tabs close (the closing rule runs with the new
    lists). If the remove-only call fails too, old rules can stay in force: the guard below still
    judges each navigation by the new lists of the map, the closing rule still runs, and every later
    change is a full replace until one succeeds.
- So a tab of no list matches no allow rule and fails closed. Session rules go at a browser restart
  and at an extension reload or update (measured: none left after a restart). Until the first
  `set_scopes`, every main frame and every frame is blocked, except the restore tab of an import
  (rules 6 and 7).
- DNR decides when a request starts, before the hold's `Fetch` pause (measured: a request of a tab
  with no rule was blocked at once, 10 of 10, and never paused). So a tab's rule must be in force
  before its first request; C10's target says how.
- The limits (measured): at most 5000 session rules (`MAX_NUMBER_OF_SESSION_RULES`; the 5001st is
  refused with "Session rule count exceeded."). A rule took 100,000 entries and 10,000 tab ids. At two
  rules per list, about 2,490 lists can be in use at once.
- The worker removal: the receiver calls `browsingData.remove({}, {serviceWorkers: true})` after the
  rule update and before the tabs close, at the first `set_scopes` after its worker starts, and in
  one case only after that: a scope has a list in the last and in the new `set_scopes` (its `scopes`
  entry, else the `default` list), and the new list lacks an entry of the old one. A new scope, a
  scope that leaves the map, and a scope whose new list is none (an ended session's `null`, a list
  that is gone) do not remove the workers: their tabs are blocked and close, so no tab of them can
  reach a worker. The entries count, not the list names; "the last" is the last `set_scopes` that
  applied in full. A failed removal fails the call (`ok: false`) after
  the tabs closed; the next call removes again.
- The closing rule: on each `set_scopes` the receiver closes every tab whose `http:`/`https:` host its
  list does not cover; for a marked tab, its `operator` value counts (with `"*"` it never closes;
  with a list name, that list); for a tab of no scope, the union of the lists counts (so an
  unmarked operator's tab and the page of a finished import stay while a list covers them). It never closes the restore tab of a
  running import. A window closes with its last tab, except the browser's last window: there the
  receiver first opens `about:blank`, so that Chrome does not end. (With one window per page,
  agent-browser PR #43, the old rule would leave an `about:blank` window for each closed page.)
- The guard (the operator's choice 2 of the design can replace it with a block of service workers): a
  site's service worker answers a navigation before DNR sees it, also in a tab of a scope whose list
  lacks the site. Measured: a scope-B tab loaded a scope-A site's worker page, 20 of 20; a worker that
  passes the navigation on (`fetch(event.request)`) loaded the page from the network in a scope-B tab,
  5 of 5, with no DNR match (in its own scope it loaded too, so no site breaks); navigation preload
  is a `main_frame` request of the tab and was blocked in the scope-B tab, 5 of 5, for a worker that
  does not fall back to `fetch()` (one that falls back loads the page as above). So at each
  main-frame `webNavigation.onBeforeNavigate` and `webNavigation.onCommitted` of an `http:`/`https:`
  URL, or a `blob:` URL with such an inner origin, whose host the tab's list does not cover (for a
  tab of no scope: the union of the lists; for the restore tab: its `domain`; for a marked tab:
  nothing with `"*"`, else the named list), the receiver sends the tab to `about:blank` (`tabs.update`) and sends `blocked`. `onCommitted` also catches a redirect from
  a host of the list to a worker's host (a redirect fires no new `onBeforeNavigate`). A page's own
  navigation was stopped before its commit 10 of 10; a page that commits runs its scripts until the
  receiver acts (measured: `tabs.update` answered 50 to 75 ms after the navigation started). The
  relay refuses a client's `Page.navigate` and `Target.createTarget` off the list itself (C11's
  target). The guard stops the page, not the request of a worker that passes the navigation on: with
  both receiver layers on, no page of such a worker committed in a scope-B tab (0 of 10), but its
  request reached the site in 10 of 10, with the site's cookies, and the site's answer came back to
  the worker (ab-lead's reviewer).
- `blocked` (C4's target) names the tab's scope. One navigation sends at most one `blocked` (the
  guard and `onErrorOccurred` can both see it). C10's retry decides the notice of a popup's first
  request; a retried request that is blocked again sends `blocked` (there is no second retry).
- The back/forward-cache limit above stays. The guard's `onCommitted` check also covers a page that
  Chrome restores from the cache and reports there (not measured).

### C6. The restore page (the receiver's import)

1. Close every tab whose origin equals `origin` (they hold the state being replaced, and a page of
   the origin could write a cookie during the swap; the about:blank guard of C5 applies). Then
   (measured: a partitioned cookie of an http secure-context test site, `*.localhost`, does not move
   with this URL rule; https sites are not affected) remove every cookie of `domain` and its
   subdomains (`getAll({domain})` and `getAll({domain, partitionKey: {}})`), then `cookies.set` each
   sent cookie (C2 -> set details: `url` = `https://` if secure else `http://`, the domain without a
   leading dot, the path; `domain` only when not `hostOnly`; `expirationDate` only when not
   `session`; `sameSite` and `partitionKey` as sent).
2. `tabs.create({url: "about:blank", active: true})`, `debugger.attach({tabId}, "1.3")`,
   `Network.enable`, `Network.setBypassServiceWorker({bypass: true})` (measured: the bypass needs the
   Network domain on), `Fetch.enable({patterns: [{urlPattern: R, requestStage: "Request"}]})` with
   `R = origin + "/__agentwatch_restore_" + <16 hex chars> + "__"`, `tabs.update(tabId, {url: R})`;
   on `Fetch.requestPaused` for `R`: `Fetch.fulfillRequest` 200, headers `Content-Type: text/html;
   charset=utf-8` and `Cache-Control: no-store`, body
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

**Target (board ab-v16.23).** In step 2, after `tabs.create` and before `tabs.update(tabId, {url: R})`,
the receiver adds the import's rules (C5's target, session rules 6 and 7: `domain` for the restore
tab only, main frames and frames). They allow `domain` whatever the lists hold, so the restore page
and step 4's `location.replace` load. Step 4 starts that navigation in a timer after its script
returns, so the rules cannot go at the end of the step: the receiver removes them at the restore
tab's first main-frame `webNavigation.onCommitted` or `onErrorOccurred` after step 4 (not matched to
`state.url`: a redirect commits another URL), at most 4 s after step 4, and in every failure cleanup
(step 5). The import ends (its answer, and the next import of the queue) only after the rules are
gone, so two imports never share rules 6 and 7; the 4 s fit in the budget (100 s + 4 s + two
cleanups of 4 s = 112 s, below 115 s). Until the rules go, C5's guard judges the tab by `domain`. The restore tab is in no scope; after the import its page stays
while a list covers it (C5's closing rule), and it cannot navigate further or load new frames.

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
`chrome` events that the receiver forwards. The receiver has no CDP logic, except the hold of a
new tab (below). This file is the master for C10. The vectors: `test/vectors/bridge.json`.

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
  before the answer to a command reaches the relay before that answer.

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
  4. The tab: `not an agent tab` or `not attached` (below).
- The kinds of args:
  - `id`: an integer of 0 or more (a tab, window or download id).
  - `object`: a JSON object. `string`: a string that is not empty. `boolean`: true or false.
  - `target`: `{"tabId":<id>}` or `{"tabId":<id>,"sessionId":"<child session>"}`, with no other key.
  - `contentType`: one of `location`, `notifications`, `camera`, `microphone`, `clipboard`,
    `automaticDownloads`.
  - `newTab` (`tabs.create`): an object with `url`, and at most `active` (a boolean), `windowId` and
    `index` (ids). `url` is a web URL.
  - `tabUpdate` (`tabs.update`): exactly `{"active":<boolean>}`. A navigation is `Page.navigate`.
  - `newWindow` (`windows.create`): an object with `url` (a web URL, one string), and at most
    `focused` (a boolean), `left`, `top`, `width`, `height` (integers) and `state`.
  - `windowUpdate` (`windows.update`): an object with at least one of `left`, `top`, `width`,
    `height`, `state` and `focused`, and no other key.
  - `contentDetails` (`contentSettings.set`): exactly `primaryPattern` and `setting`. `setting` is
    `allow` or `block`. `primaryPattern` is `<scheme>://<host>/*` or `<scheme>://<host>:<port>/*`.
    `<scheme>` is `http`, `https` or `*`. `<host>` is a host that the receiver's applied allowlist
    covers (C5: the list of its last `set_allowlist`), with or without `*.` before it.
  - A web URL is `about:blank`, or an absolute `http:` or `https:` URL. So a bridge op never opens a
    `chrome:`, `file:` or `javascript:` URL, or Chrome's New Tab page.
- The tab checks:
  - `not an agent tab`: `debugger.attach`, `debugger.detach`, `tabs.update` and `tabs.remove` of the
    restore tab of a running import (C6); and `debugger.attach` of a tab whose `url` or `pendingUrl`
    is in the receiver's own origin (`chrome-extension://<receiver id>/`).
  - `not attached`: `debugger.sendCommand` for a tab that is not a bridge tab. So a command never
    goes through the import's attachment.

**Answers.** `{"t":"res","ch":"bridge","id":"<id>","ok":true,"data":<result>}` or
`{"t":"res","ch":"bridge","id":"<id>","ok":false,"error":"<text>"}`.

- `data` is the op's result: an object, a list or `null`. It is never left out.
- The receiver's error texts: `unknown op`, `bad args`, `bad wait`, `not an agent tab`,
  `not attached`, `timeout`, `too large` (a res above `MAX_RESULT`), and the text of a `chrome.*`
  error as Chrome gives it (for example `No tab with id: 7.`).
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
| `debugger.sendCommand` | `[target, method, params?]` | the CDP result | `WAIT_MAX_MS` | `chrome.debugger.sendCommand(target, method, params)`; a missing `params` goes as `{}`. |
| `debugger.getTargets` | `[]` | `[TargetInfo]` | `WAIT_DEFAULT_MS` | `chrome.debugger.getTargets()`. |
| `tabs.create` | `[createProperties]` | `Tab` | `WAIT_DEFAULT_MS` | `chrome.tabs.create`. |
| `tabs.get` | `[tabId]` | `Tab` | `WAIT_DEFAULT_MS` | `chrome.tabs.get`. |
| `tabs.query` | `[queryInfo]` | `[Tab]` | `WAIT_DEFAULT_MS` | `chrome.tabs.query`. |
| `tabs.update` | `[tabId, updateProperties]` | `Tab` | `WAIT_DEFAULT_MS` | `chrome.tabs.update`. |
| `tabs.remove` | `[tabId]` | `null` | `WAIT_DEFAULT_MS` | `chrome.tabs.remove`. |
| `windows.get` | `[windowId, queryOptions?]` | `Window` | `WAIT_DEFAULT_MS` | `chrome.windows.get`. |
| `windows.create` | `[createData]` | `Window` | `WAIT_DEFAULT_MS` | `chrome.windows.create`. |
| `windows.update` | `[windowId, updateInfo]` | `Window` | `WAIT_DEFAULT_MS` | `chrome.windows.update`. |
| `downloads.search` | `[query]` | `[DownloadItem]` | `WAIT_DEFAULT_MS` | `chrome.downloads.search`. |
| `downloads.cancel` | `[downloadId]` | `null` | `WAIT_DEFAULT_MS` | `chrome.downloads.cancel`. |
| `contentSettings.set` | `[type, details]` | `null` | `WAIT_DEFAULT_MS` | `chrome.contentSettings[type].set(details)`. |
| `contentSettings.clear` | `[type]` | `null` | `WAIT_DEFAULT_MS` | `chrome.contentSettings[type].clear({})`. |
| `bridge.info` | `[]` | an object (below) | `WAIT_DEFAULT_MS` | The receiver's own op. |
| `bridge.attachNew` | `[on]` | `null` | `WAIT_DEFAULT_MS` | Turns the eager attach on or off (the hold, below). |
| `bridge.release` | `[tabId]` | `null` | `WAIT_DEFAULT_MS` | Ends the hold of the tab (below). A tab with no hold also answers `null`. |

- `bridge.info` answers `{"bridge":1,"version":"<manifest version>","id":"<extension id>","userAgent":"<navigator.userAgent>","fullVersion":"<version>"}`.
  `bridge` is the version of this contract, `BRIDGE_VERSION = 1`. `fullVersion` is the version of
  the brand "Google Chrome", else of "Chromium", in `navigator.userAgentData`'s `fullVersionList`;
  it is `""` when neither is there. The relay uses them for `Browser.getVersion`.
- No op changes the allowlist or the DNR rules, runs the import, or reads or writes page storage.
- No op reads, sets or removes cookies: agent mode gives programs no cookie access (board ab-8mf,
  C11). The import's cookie work stays on channel `main` (C4, C6). A later cookie grant, for a use
  that needs cookie access, can add `cookies.*` ops here.

**Events.** `{"t":"ev","ch":"bridge","ev":"<event>",...}` with the fields below, and no other field.

| Event | Fields | When |
| --- | --- | --- |
| `debugger.onEvent` | `"source"` (`{"tabId":N}` or with `"sessionId"`), `"method"`, `"params"` | For a bridge tab. Never for the hold's own `Fetch` events, never for the import's restore tab. |
| `debugger.onDetach` | `"source"`, `"reason"` | For a bridge tab. |
| `tabs.onCreated` | `"tab"`, `"attached"`, `"held"`, and `"error"` when the eager attach failed | For each new tab. |
| `tabs.onUpdated` | `"tabId"`, `"changeInfo"`, `"tab"` | When `changeInfo` has `url`, `title` or `status`. |
| `tabs.onRemoved` | `"tabId"`, `"removeInfo"` | For each tab. |
| `tabs.onReplaced` | `"addedTabId"`, `"removedTabId"` | For each tab. |
| `webNavigation.onCreatedNavigationTarget` | `"details"` | For each new navigation target. |
| `webNavigation.onErrorOccurred` | `"details"` (only `tabId`, `frameId`, `url`, `error`) | For the main frame only. |
| `downloads.onCreated` | `"item"` | For each download. |
| `downloads.onChanged` | `"delta"` | For each change. |
| `bridge.tooLarge` | `"of"` (the event), `"tabId"`, and for `debugger.onEvent` `"method"`, `"sessionId"` (of a child session) and `"requestId"` (of a `Fetch` event) | In place of an event above `MAX_TO_DAEMON`. |

- A bridge event never waits, like a res. The receiver sends it at once while the link is up, and
  drops it while the link is down. It never keeps or replays an event. A notice (`blocked`, C4) is
  different: it waits for the next link up. After a link change the relay builds its model again
  from the ops, so a lost event does no harm.
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
`Runtime.enable` before `Runtime.evaluate`.

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
  1. drops the answers of the bridge requests that still run;
  2. turns the eager attach off and releases every hold;
  3. detaches every bridge tab, and every tab that `chrome.debugger.getTargets()` reports as
     attached (a worker that started again knows no bridge tabs). It ignores the error of a detach.
     It never detaches the restore tab of a running import: that attachment belongs to channel
     `main`.
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
  can come before the tab's `tabs.onCreated`. While the eager attach is off, `tabs.onCreated` comes
  at once.
- The receiver never attaches the restore tab of an import. The import sets a flag before it calls
  `tabs.create` for its restore tab, and it clears the flag when it knows that tab's id. A
  `tabs.onCreated` that comes while the flag is set waits until the import knows the id. Then the
  receiver skips the restore tab (`"attached":false`) and attaches the others.
- The receiver also skips a tab of its own origin. Tabs that the operator opens in the live view
  have no mark today (agentwatch design §5.15 names an exemption for them, not built). When they get
  one, the receiver skips them too.
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
  path). The relay reads the daemon's lines on its standard input. It writes its requests on its
  standard output, and its log on its standard error. When its standard input ends, the relay closes
  every connection, removes its socket and exits. The daemon stops the relay that way when the unit
  stops.
- The daemon's lines to the relay, in addition to the receiver's `res` and `ev`:
  - `{"t":"link","up":true,"version":"<manifest version>"}`: a receiver is connected, and its hello
    lists `bridge`.
  - `{"t":"link","up":false}`: the link dropped. The `disconnected` answers come first.
  - `{"t":"allowlist","domains":["a.example"]}`: the receiver confirmed this list (an `ok` answer to
    `set_allowlist` on the current connection). It comes after each such answer.
  - `{"t":"end_scope","scope":"<scope>"}`: the agentwatch session of that name ended. The relay
    closes the scope's connections and removes its tabs (C11).
- No side logs the args, the results or the event params of the bridge: they can contain page
  content and sign-in values. A log line contains an op, a CDP method, a tab id, a size or a time.

**Target (board ab-v16.23): each tab's scope.** It changes the ops, an event, the hold and the
daemon's `allowlist` line above. The rest of C10 stays.

- The receiver keeps a map from tab to scope. It sets a tab's scope in these cases only:
  - `tabs.create` with `[createProperties, scope]` and `windows.create` with `[createData, scope]`:
    the second arg is required, of the new kind `scope` (a string that matches C11's scope pattern).
    The `url` of `newTab` and `newWindow` is `about:blank` only (it makes no request). If the build
    of one window per page (agent-browser PR #43) moves a popup into a window of its own
    (`windows.create` with a `tabId`), that move takes no `url`, its scope arg must be the moved
    tab's own scope (else `bad args`), and the tab keeps its scope and rules. The receiver
    creates the tab, sets its scope, and answers when the tab's scope rule (C5's target) is in force.
    When the rule update fails, the receiver closes the new tab and the op answers with the error
    (C5's target: a failed update fails closed).
    Measured: the probe's whole assignment (its rule update and the wait for it, small lists, its tabs
    open) took 11 to 15 ms, and the next `Page.navigate` loaded 20 of 20. Chrome's index cost alone
    grows with the entries of all lists in use (about 46 ms to replace one list's rules with 20 lists
    of 1,000 in use).
  - A popup: in `webNavigation.onCreatedNavigationTarget`, the new tab (`tabId`) takes the scope of
    `sourceTabId`, when that tab has one. The receiver sets it in the map in the handler, then
    updates the rules. Measured: `sourceTabId` named the right opener in every popup of every kind,
    also behind a tab of another scope; `chrome.tabs`' `openerTabId` named the active tab instead.
    The receiver never uses `openerTabId`.
  - `tabs.onReplaced`: the added tab takes the removed tab's scope.
  - Every other tab has no scope: the restore tab, the tab that C5's closing rule opens, a tab from
    before the link, and the operator's own tabs. The operator's tabs depend on choice 3 of the
    design: with it, a tab that starts at `chrome://newtab/` and that no page opened gets the
    **operator mark** (no agent tab starts there: the relay opens `about:blank` only and refuses
    `chrome:` URLs; that a page cannot open a `chrome://` page is Chrome's rule, not measured), and
    a popup of a marked tab is marked too. A marked tab has no scope; C4's `operator` field gives
    what it may open (C5's target: rule 8 with `"*"`, and C5's guard and closing rule skip the tab;
    a list name: that list). For the retry, a marked tab's list is its `operator` value (with `"*"`
    every host is covered). The mark stays at a link change (it is not a connection's) and at
    `tabs.onReplaced`; it goes at the worker's start (those tabs then fail closed). Without that
    build, the operator's tabs fail closed.
  - A tab leaves the map when it closes. At its worker's start and at each disconnect and each new
    daemon connection (the cleanup of "What stops a handler"), the receiver empties the map and
    removes every scope rule.
  - No stale entry: the receiver writes a scope only for a tab that exists, and drops a write of an
    op or an event that started before the last reset (the epoch check of `attach.js`).
- The new event `bridge.tabScope`, fields `"tabId"`, `"scope"`: sent when the receiver sets a scope
  itself (a popup, a replaced tab), as soon as it is in the map. Not for a tab of `tabs.create` or
  `windows.create`: the relay named that scope. For a popup it comes before the popup's
  `tabs.onCreated`: `webNavigation.onCreatedNavigationTarget` comes 0 to 1 ms after Chrome creates
  the tab, before the eager attach ends; while the eager attach is off, the receiver sends a new
  tab's `tabs.onCreated` after that event, or after 50 ms when none comes (a tab that no page
  opened). The row for C10's event table, with the build:

  | Event | Fields | When (target) |
  | --- | --- | --- |
  | `bridge.tabScope` | `"tabId"`, `"scope"` | When the receiver gives a tab a scope itself: a popup (its opener's), a replaced tab (its old one). Before the popup's `tabs.onCreated`. |

- The retry. A popup's first request often starts before its rule is in force (measured: a `noopener`
  popup, a `target=_blank` link and a form with a target in every trial; a popup with an opener in a
  few). DNR blocks it (C5's target). The trigger: the tab's first main-frame
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
  another error (which one a POST gets is not measured).
- How often a popup with an opener needs the retry (it depends on load): in the probe 1 of 60 with
  no hold and 2 of 60 with the hold; in ab-lead's reviewer's runs 3 to 4 of 20 with the hold, 2 of
  10 for the sign-in pattern, and 8 of 10 with one window per page (agent-browser PR #43) behind
  another window. The time of one assignment grows with the tabs open under the rules (the
  reviewer: median 9 ms with none, 13 ms with 50, 25 ms with 100).
- The hold stays. The retry's request is a document request of the tab, so the hold keeps it until
  the release, while the hold is still on (`HOLD_MAX_MS`; the retry comes about 70 ms after the
  block). While the eager attach is on, the receiver also holds the `tabs.onCreated` event of a
  popup whose hold is on (`"held":true`; a popup with `"held":false` gets its event when the eager
  attach ends, as above). That hold ends at the first of: the popup's first document request is
  allowed (the hold pauses it); the retry's request is in the hold; the decision to send `blocked`
  (a host off the list, a popup of no scope, a retry that is blocked again, a retry that starts no
  request); a main-frame commit with no network request (a `blob:` URL, a worker's page; not an
  `about:blank` that the opener writes into, which makes no new commit and looks like the first
  step of the sign-in pattern); no main-frame navigation within 50 ms from the moment the popup's
  rule is in force (a later navigation is allowed by the rule and needs no retry; this ends the
  hold of a popup that stays at `about:blank`); `HOLD_MAX_MS` after `tabs.onCreated`. Other events
  of the popup that come before its `tabs.onCreated` go to the relay as they come; the relay keeps
  `bridge.tabScope` and drops the other events of a tab that it does not know yet. So a client attaches to a popup
  whose real document is still to come, and does not see Chrome's error page as the popup's page
  through CDP (the error page still shows in the window for 60 to 100 ms).
- `contentDetails`: `<host>` must be covered by a list of the last applied `set_scopes` (any list).
- No op changes a list or a rule's entries. `tabs.create` and `windows.create` put the new tab under
  its scope's rules.
- The daemon's line `{"t":"allowlist","domains":[...]}` becomes
  `{"t":"allowlist","lists":{"<list>":["a.example"]},"scopes":{"<scope>":"<list>"},"default":"<list>"}`
  (with `"default":null` when there is none): the object of the `set_scopes` that the receiver
  confirmed on the current connection. It comes after each such answer.

### C11. The endpoint (agent-browser's relay)

The relay serves a CDP endpoint for Playwright, the Playwright MCP and agent-browser's own commands.
Behind it the browser model answers the browser-level calls with C10 ops. It sends each page-level
call to `debugger.sendCommand` (two-modes design, sections 4 and 8). This file is the master for
C11. The vectors: `test/vectors/endpoint.json`.

| Part | Side | Stage of the two-modes design |
| --- | --- | --- |
| The socket server, where each call goes, the scope, one connection per tab, the refusals, the cookie marker, the content settings | agent-browser's relay | 3 (board ab-v16.6) |
| The socket path, `browser.control`, `agentwatch browser endpoint` and `env`, `end_scope` | The agentwatch daemon | 4 (board ab-v16.7) |

**The socket and the URL.**

- A Unix socket with mode 0600. The relay makes it at the path that the daemon gives it:
  `/run/user/<uid>/agentwatch/browser-cdp.sock` on Linux, `~/.cache/agentwatch/run/browser-cdp.sock`
  on the Mac. A path is at most 103 bytes. There is no TCP port.
- The URL is `ws+unix://<socket path>:/devtools/browser/<scope>`. Playwright's `connectOverCDP` and
  the Playwright MCP (`PLAYWRIGHT_MCP_CDP_ENDPOINT`) take it as it is (measured). The URL contains no
  secret.
- `agentwatch browser endpoint` prints the URL, with the calling session's name as the scope.
  `agentwatch browser env` prints `PLAYWRIGHT_MCP_CDP_ENDPOINT=<url>`. With `browser.control: false`
  there is no relay and no socket.
- A scope matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Every agentwatch session name matches it.
- Every process of the daemon's OS user that can open the socket may connect, as with
  `agentwatch browser` today. The scope is advisory (agent-browser #14).

**Before the upgrade.** The relay serves only the WebSocket upgrade of
`GET /devtools/browser/<scope>`. Its other answers have a `text/plain` body:

- Another path, or a scope that does not match: 404 `Not found. Connect a CDP client to /devtools/browser/<scope>.`
- A request with an `Origin` header: 403 `A web page cannot connect to the agent browser.`
- The relay is not ready: 503 with one of these bodies.
  - 503 `The agent browser is not ready: its extension is not connected.`
  - 503 `The agent browser is not ready: its extension has not confirmed the allowlist.`
  - 503 `The agent browser is not ready: its extension is too old for agent mode.`
- The relay is ready while the link is up (C10 `link`), an `allowlist` line came after that, and
  `bridge.info` answered with `bridge` 1 or more. A receiver before stage 2 answers `unknown op` to
  `bridge.info`: it is too old. So the endpoint fails closed: no connection before the extension
  confirmed the operator's list (two-modes design, section 10).
- A client message is at most `MAX_REQUEST` bytes (C10). A longer one closes the connection (code
  1009). A command whose bridge request would be longer gets an error (the refusals, below).

**When a connection ends.**

- `Browser.close` ends that connection only. The agent browser keeps running. Close code
  1000, `Browser.close ends this connection; the agent browser keeps running`.
- `end_scope` (C10): the relay closes the scope's connections with
  1000, `The agentwatch session ended`, and removes the scope's tabs.
- A link drop (C10 `link` down): every connection closes with
  1011, `The agent browser's link went down`. The model starts again at the next `link` up.
- The relay stops: every connection closes with 1001, `The agent browser stopped`.

**Where each call goes.** The model answers the calls of its set (two-modes design, section 4.3) on
the root session and on a browser session (`Target.attachToBrowserTarget`). Every other call there
is refused (`Not available in the agent browser: <method>.`, below). On a page session, the model
answers its calls as in this table, and every other call goes to Chrome
(`debugger.sendCommand`), after the refusals below.

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

**The scope, and one connection per tab.**

- A connection sees and attaches only the tabs of its scope. A tab joins a scope when a connection
  of that scope opens it (`Target.createTarget`), or as a popup of a tab of that scope. The opener of
  a popup comes from Chrome's `openerId`, not from `chrome.tabs`' `openerTabId` (measured). Every
  other tab is in no scope, and no connection sees it: the operator's tabs, the restore tab of an
  import, a tab from before the relay started.
- A tab belongs to one connection at a time, its owner. The owner is the connection that opened it,
  the owner of its opener (for a popup), or the first connection of the scope that attaches the free
  tab. The reason: all sessions of a tab share its one `chrome.debugger` attachment and its domain
  state.
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
- For a tab that it creates (`Target.createTarget`), the relay asks C10's `newTab` for `about:blank`,
  holds the tab there (C10's hold), and navigates it to the client's `url` after the client's
  `Runtime.runIfWaitingForDebugger` has released the hold. A tab that the relay creates with the
  client's URL at once would load that URL before the hold.
- There is one browser context. Every target has `"browserContextId":"agentwatch-default"`, also in
  the answers and events from Chrome that the model passes on. `Target.getBrowserContexts` answers
  `{"browserContextIds":[]}`.
- The model turns the eager attach (C10) on while at least one connection is open.

**Permissions and content settings.**

- The model grants these permissions (the CDP name, then the content setting of C10's
  `contentSettings.set`): `geolocation` (`location`), `notifications` (`notifications`),
  `videoCapture` (`camera`), `audioCapture` (`microphone`), `clipboardReadWrite` and
  `clipboardSanitizedWrite` (`clipboard`). A grant with no origin covers the allowlisted domains. It
  refuses every other name.
- Content settings act on the whole profile and stay after a restart. So at its first `link` up the
  relay clears the six content-setting types (`contentSettings.clear`). Then no grant of an earlier
  run stays.
- At each `allowlist` line, the relay sets the content settings again: the grants of the open
  connections that the new list still covers, and `automaticDownloads` to `allow` for each
  allowlisted domain (two-modes design, section 4.5).

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
- An empty or missing `url` of `Target.createTarget` is `about:blank`. A new tab opens only
  `about:blank` or an `http:` or `https:` URL, as C10's `newTab` allows; a client navigates it to a
  `data:` or `blob:` URL after.
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

The allowlist, the scope and the size (two-modes design, sections 4.3, 4.4 and 8):

| What | The call | The text |
| --- | --- | --- |
| A permission for an origin off the allowlist | `Browser.grantPermissions` with such an `origin` | `Not allowed: <host> is not on the allowlist` |
| A permission that `chrome.contentSettings` cannot grant | `Browser.grantPermissions` with another name | `Not available in the agent browser: the permission <name>` |
| A tab of the scope that another connection owns | `Target.attachToTarget` | `The tab is in use by another connection of this scope` |
| A tab of another scope, or no such tab | `Target.attachToTarget`, `Target.closeTarget`, `Target.activateTarget`, `Target.getTargetInfo`, `Browser.getWindowForTarget` | `No target with given id found` |
| A window with no tab of the scope | `Browser.getWindowBounds`, `Browser.setWindowBounds` | `Browser window not found` |
| A session that the connection does not have | Any call with that `sessionId` | `Session with given id not found.` |
| A result above `MAX_RESULT` | The receiver or the daemon answered `too large` | `The answer of <method> is larger than the agent browser's link allows (128 MiB).` |
| A command whose bridge request is above `MAX_REQUEST` | Any | `The command is too large for the agent browser: <method>.` |
| A deadline (C10) | The receiver or the daemon answered `timeout` | `The agent browser did not answer <method> in <seconds> s.` |

- After a `timeout`, the model acts as C10 says: no detach for a command that waits for a promise;
  for any other `debugger.sendCommand`, and for a `debugger.attach`, it detaches the tab, sends
  `Target.detachedFromTarget` to the tab's sessions, and announces the tab again (above).
- The text for another scope's tab is Chrome's own text for a target that does not exist. So a
  connection cannot tell another scope's tab from no tab.

**Target (board ab-v16.23): the scope's list.** It changes the readiness, the scope, the content
settings and the allowlist refusals above. The rest of C11 stays.

- The relay applies C4's `set_scopes` rules to the `allowlist` line, as the receiver does (a shared
  vector checks both). A scope's list: the list that its `scopes` entry names, when it has an entry
  (no fall-back when that list is absent), else the `default` list.
- Readiness per scope: the relay admits a connection of a scope while the link is up, `bridge.info`
  answered with `bridge` 1 or more, and the last `allowlist` line gives the scope a list. Else 503
  with the text above, or, when only the list is missing:
  503 `The agent browser is not ready: the allowlist has no list for this scope.` A scope whose
  list is empty is admitted; it can open `about:blank` only.
- At each `allowlist` line, the relay closes every connection of a scope that has no list any more,
  with 1008, `The allowlist has no list for this scope any more`.
- The scope of a tab: a tab joins a scope when a connection of that scope opens it (the relay names
  the scope in C10's `tabs.create` or `windows.create`), or when the receiver reports it
  (`bridge.tabScope`: a popup takes its opener's scope, a replaced tab its old scope). The relay
  never puts a tab in a scope that the receiver did not report; its own `tabs.onReplaced` handling
  follows `bridge.tabScope` too. Chrome's `openerId` still names a popup's owner, when the opener is
  in the same scope.
- A new tab that the relay did not create, and whose `bridge.tabScope` has not come: the relay keeps
  it in its model with no scope, attached and held as the receiver reported it, for up to
  `TAB_SCOPE_WAIT_MS = 500`. On `bridge.tabScope` it announces the tab to the scope, as a popup. At
  the end of the wait it releases and detaches the tab, as a tab of no scope; a later
  `bridge.tabScope` still puts the tab in its scope, as a free tab.
- New refusals, before any bridge request: `Page.navigate` of a tab's main frame (no `frameId`, or
  the `frameId` of the tab's own target; Playwright's `goto` sends the main frame's id) with an
  `http:` or `https:` URL whose host the scope's list does not cover, or a `blob:` URL whose inner
  origin has such a host; `Target.createTarget` with such a `url`: `Not allowed: <host> is not on the
  allowlist`. A frame's navigation is not refused (O11). So a client's `Page.navigate` or
  `Target.createTarget` never reaches a service worker of a site off its list (C5's target, the
  guard), and Chrome commits no error page for it. Other client actions still navigate as the page
  does (`Runtime.evaluate`, input on a link, `Page.reload`, `Page.navigateToHistoryEntry`); DNR and
  C5's guard cover them.
- Permissions and content settings per scope: `Browser.grantPermissions` with an origin needs a host
  that the connection's scope's list covers, else `Not allowed: <host> is not on the allowlist`; a
  grant with no origin covers the scope's list. At each `allowlist` line the relay sets again the
  grants of the open connections that their own scope's list still covers, and `automaticDownloads`
  to `allow` for each entry of every list.
- What one profile shares between scopes, stated plainly: a content setting is per origin pattern
  and acts on the whole profile, so a grant of one scope applies to another scope's tab on the same
  host; the sent sign-ins (cookies, storage, workers) are in the profile for every scope; only
  navigation is guarded per scope.
- The scope stays advisory unless the operator chooses a scope token (the design's choice 1, aw-lead's
  "key"): any process of the daemon's OS user can connect with any scope and get that scope's list.
  With a token, `default` is `null`: a scope that `scopes` does not name has no token. The token
  lives only in the session's environment: never in an argv, never in the output of `agentwatch
  browser endpoint` or `env`, never in a log, and never in a URL that a tool gets as an argument
  (the client reads it from its environment and adds it to the URL itself). The same OS user can
  read `/proc/<pid>/environ`, so the token guards against mistakes and against another session's
  prompt injection, not against a hostile process of that user. A connection of a scope with no
  valid token gets 403 `The agent browser needs this session's key. A session that started before
  the key existed gets one when it starts again.` A session that is live before the deploy has no
  token until its restart, so it gets that refusal (fail closed).
