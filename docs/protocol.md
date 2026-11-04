# Protocol and fixed values

Both repositories implement these contracts. Change them only in the agentwatch plan.

C4, C10 and C11 are the exceptions. Since the two-modes design (agent-browser
`docs/superpowers/specs/2026-11-03-two-modes-playwright-design.md`, sections 4, 8, 11 and 13), this
file is the master for them. The agentwatch plan's C4 text is older (`"v":1`, no channels). C10 and
C11 are only here. They bind three repositories: this one (the receiver), agent-browser (its relay)
and agentwatch (the daemon).

- Sender extension ID: `bpfkgknpndlpkcffmaaelkfcbpackiip`
- Receiver extension ID: `dofdpnfachcncepdoondkeodcbnhipdc`

### C1. Names and IDs

- Native messaging host name: `sh.agentwatch.browser`.
- Extension IDs: fixed by the manifest `key` of each extension. Task E1 generates two fresh RSA-2048
  keys (the private key goes through a pipe and is never written), puts the base64 DER public key into
  each manifest, computes each ID (SHA-256 of the DER, first 32 hex digits, `0-9a-f` -> `a-p`) and
  records both IDs in `docs/protocol.md`. Task A1 copies them into `tools/pins.py`.

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
  on the bridge channel, the events of C10: `{"t":"ev","ch":"bridge","ev":"<event>",...}`.
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
  res above the limit goes as `{"t":"res","id":"<id>","ok":false,"error":"too large"}` (with its `ch`
  on channel `bridge`). Any other message above the limit, and a res whose error is still above it,
  is not sent.

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
- C10 defines the bridge's ops, their data, its events, the waits and `MAX_IN_FLIGHT`, the daemon's
  limit of bridge requests in flight. The receiver sets no bound of its own: it starts each bridge
  request that it gets. A bridge request with an op that the receiver does not know gets
  `{"t":"res","ch":"bridge","id":"<id>","ok":false,"error":"unknown op"}`. The main ops are not
  bridge ops: `ping` on channel `bridge` is an unknown op too. A bridge request never stops or delays
  channel `main`. The receiver of today (before stage 2 of the two-modes design) knows no bridge op,
  so it answers each bridge request with `unknown op`. Stage 2 builds the C10 ops and waits.
- The shared vectors: `test/vectors/parts.json` (parts without `ch`) and
  `test/vectors/parts-bridge.json` (parts with `"ch":"bridge"`).

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
`chrome` events that the receiver forwards. The receiver holds no CDP logic, except the hold of a
new tab (below). This file is the master for C10. The vectors: `test/vectors/bridge.json`.

| Part | Side | Stage of the two-modes design |
| --- | --- | --- |
| The ops, the events, the receiver's waits, the hold, the stop rules | The receiver (this repo: `receiver/`, later `agent/`) | 2 (board ab-v16.5) |
| The requests, the waits that it picks, its standard input and output | agent-browser's relay (`agent-browser relay`) | 3 (board ab-v16.6) |
| The parts to the receiver, `MAX_IN_FLIGHT`, the daemon's waits and errors, the lines to the relay, the relay's start and stop | The agentwatch daemon | 4 (board ab-v16.7) |

**The path of a message.**

- The relay writes each request as one line of JSON on its standard output. The daemon reads the
  line and sends the request to the receiver in C4 parts on channel `bridge` (`"ch":"bridge"`,
  `PART_BYTES = 700000`).
- The receiver answers each request with one `res` on channel `bridge`. It sends events as `ev`
  messages on channel `bridge`. The daemon writes each of them as one line on the relay's standard
  input. It changes no field, and it writes them in the order in which it read them.
- So Chrome's order holds from the receiver to the relay. An event that Chrome fires before the
  answer to a command reaches the relay before that answer.

**Requests.** `{"t":"req","id":"<id>","op":"<op>","args":[...],"wait":<ms>}`.

- `id` is a string. It is unique on the bridge channel. The relay picks a random prefix of 8 hex
  digits at its start and counts after it (for example `5f3a9c01-17`). So a late answer to a request
  of an earlier relay never matches a new request.
- `op` is one of the ops below. `args` is the list of the op's arguments, in order. A request
  without `args` has `[]`.
- `wait` is optional (the deadline, below).
- The daemon drops a line from the relay that is not a JSON object with `"t":"req"`, a string `id`
  and a string `op`. It logs the line's length only.
- The receiver checks a request in this order: the op (else `unknown op`), the args (else
  `bad args`), the wait (else `bad wait`). The args check is the count, then the kind of each arg:
  `id` (an integer of 0 or more: a tab, window or download id), `object` (a JSON object), `string`
  (a string that is not empty), `boolean`, `target` (`{"tabId":<id>}` or
  `{"tabId":<id>,"sessionId":"<child session>"}`, with no other key) and `contentType` (one of
  `location`, `notifications`, `camera`, `microphone`, `clipboard`, `automaticDownloads`). A request
  that fails a check never reaches Chrome.

**Answers.** `{"t":"res","ch":"bridge","id":"<id>","ok":true,"data":<result>}` or
`{"t":"res","ch":"bridge","id":"<id>","ok":false,"error":"<text>"}`.

- `data` is the op's result: an object, a list or `null`. It is never left out.
- The receiver's error texts: `unknown op`, `bad args`, `bad wait`, `not attached`,
  `not an agent tab`, `timeout`, `too large` (C4), and the text of a `chrome.*` error as Chrome gives
  it (for example `No tab with id: 7.`).
- The relay gets exactly one res for each request: the receiver's, or one from the daemon. The
  daemon's error texts: `not connected` (no receiver with channel `bridge` is connected; the daemon
  answers at once), `disconnected` (the link dropped while the request waited or ran) and `timeout`
  (the deadline, below).

**The ops.** An arg name with `?` is optional.

| Op | Args | Result | What the receiver does |
| --- | --- | --- | --- |
| `debugger.attach` | `[tabId]` | `{"already": <bool>}` | `chrome.debugger.attach({tabId}, "1.3")`. `already` is true when the bridge holds the tab already, for example from the eager attach. The restore tab of an import (C6) gets `not an agent tab`. |
| `debugger.detach` | `[tabId]` | `null` | Releases a hold of the tab, then `chrome.debugger.detach({tabId})`. A tab that the bridge does not hold also answers `null`. |
| `debugger.sendCommand` | `[target, method, params?]` | the CDP result | `chrome.debugger.sendCommand(target, method, params)`; a missing `params` goes as `{}`. A tab that the bridge did not attach gets `not attached`, so a command never goes through the import's attachment. |
| `debugger.getTargets` | `[]` | `[TargetInfo]` | `chrome.debugger.getTargets()`. |
| `tabs.create` | `[createProperties]` | `Tab` | `chrome.tabs.create`. |
| `tabs.get` | `[tabId]` | `Tab` | `chrome.tabs.get`. |
| `tabs.query` | `[queryInfo]` | `[Tab]` | `chrome.tabs.query`. |
| `tabs.update` | `[tabId, updateProperties]` | `Tab` | `chrome.tabs.update`. |
| `tabs.remove` | `[tabId]` | `null` | `chrome.tabs.remove`. |
| `windows.get` | `[windowId, queryOptions?]` | `Window` | `chrome.windows.get`. |
| `windows.create` | `[createData]` | `Window` | `chrome.windows.create`. |
| `windows.update` | `[windowId, updateInfo]` | `Window` | `chrome.windows.update`. |
| `downloads.search` | `[query]` | `[DownloadItem]` | `chrome.downloads.search`. |
| `downloads.cancel` | `[downloadId]` | `null` | `chrome.downloads.cancel`. |
| `contentSettings.set` | `[type, details]` | `null` | `chrome.contentSettings[type].set(details)`. |
| `contentSettings.clear` | `[type]` | `null` | `chrome.contentSettings[type].clear({})`. |
| `bridge.info` | `[]` | an object (below) | The receiver's own op. |
| `bridge.attachNew` | `[on]` | `null` | Turns the eager attach on or off (the hold, below). |
| `bridge.release` | `[tabId]` | `null` | Ends the hold of the tab (below). A tab with no hold also answers `null`. |

- `bridge.info` answers `{"bridge":1,"version":"<manifest version>","id":"<extension id>","userAgent":"<navigator.userAgent>","fullVersion":"<version>"}`.
  `bridge` is the version of this contract, `BRIDGE_VERSION = 1`. `fullVersion` is the version of
  the brand "Google Chrome", else of "Chromium", in `navigator.userAgentData`'s `fullVersionList`;
  it is `""` when neither is there. The relay uses them for `Browser.getVersion`.
- No op changes the allowlist or the DNR rules, runs the import, or reads or writes page storage.
- No op reads, sets or removes cookies: agent mode gives programs no cookie access (board ab-8mf,
  C11). The import's cookie work stays on channel `main` (C4, C6). A later cookie grant, for a use
  that needs cookie access, can add `cookies.*` ops here.

**Events.** `{"t":"ev","ch":"bridge","ev":"<event>",...}` with the fields below.

| Event | Fields | When |
| --- | --- | --- |
| `debugger.onEvent` | `"source"` (`{"tabId":N}` or with `"sessionId"`), `"method"`, `"params"` | For a tab that the bridge holds. Never for the hold's own `Fetch` events, never for the import's restore tab. |
| `debugger.onDetach` | `"source"`, `"reason"` | For a tab that the bridge held. |
| `tabs.onCreated` | `"tab"`, `"attached"`, `"held"`, and `"error"` when the eager attach failed | For each new tab. |
| `tabs.onUpdated` | `"tabId"`, `"changeInfo"`, `"tab"` | When `changeInfo` has `url`, `title` or `status`. |
| `tabs.onRemoved` | `"tabId"`, `"removeInfo"` | For each tab. |
| `tabs.onReplaced` | `"addedTabId"`, `"removedTabId"` | For each tab. |
| `webNavigation.onCreatedNavigationTarget` | `"details"` | For each new navigation target. |
| `webNavigation.onErrorOccurred` | `"details"` (only `tabId`, `frameId`, `url`, `error`) | For the main frame only. |
| `downloads.onCreated` | `"item"` | For each download. |
| `downloads.onChanged` | `"delta"` | For each change. |
| `bridge.tooLarge` | `"of"` (the event), `"tabId"`, and `"method"` for `debugger.onEvent` | In place of an event above `MAX_TO_DAEMON`. |

- A bridge event never waits, like a res. The receiver sends it at once while the link is up, and
  drops it while the link is down. It never keeps or replays an event. A notice (`blocked`, C4) is
  different: it waits for the next link up. After a link change the relay builds its model again
  from the ops, so a lost event does no harm.
- The receiver sends no bridge event on a daemon connection before the first bridge request on that
  connection. So a daemon that does not use the bridge gets no bridge event.
- An event above `MAX_TO_DAEMON = 8388608` (C4) is not sent. The receiver sends `bridge.tooLarge` in
  its place. The relay logs the method and gives the client nothing.

**The order of requests.** The daemon sends the bridge requests in the order in which it read them.
The receiver starts them in the order in which their last parts arrive. It calls Chrome for a
request before it starts the next one: no `await` comes before the `chrome.*` call. So CDP commands
reach Chrome in the order in which the relay sent them. Playwright needs that, for example
`Runtime.enable` before `Runtime.evaluate`.

**The deadline.**

- Each request carries its wait in `wait`, in ms. Without `wait` it is `WAIT_DEFAULT_MS = 30000`.
  The largest is `WAIT_MAX_MS = 600000` (10 min). A `wait` that is not an integer from 1 to
  `WAIT_MAX_MS` gets `bad wait`.
- The relay picks the wait of each call. A CDP command that can wait on the page or the network gets
  `WAIT_MAX_MS`: for example `Runtime.evaluate`, `Runtime.callFunctionOn` and `Runtime.awaitPromise`
  (they can wait for a promise), `Page.navigate`, `Page.reload`, `Network.getResponseBody`,
  `Page.captureScreenshot`, `Page.printToPDF` and `IO.read`. Every other op gets the default. So a
  `page.evaluate` of a promise can run for 10 minutes. A longer one fails.
- The receiver answers `timeout` when an op runs `wait` ms.
- The daemon answers `timeout` itself when no res came `wait` + `WAIT_SLACK_MS = 2000` ms after it
  read the request. The time in its queue (`MAX_IN_FLIGHT`, below) counts. It then ignores the
  receiver's late res.
- The relay waits for the res: the daemon always sends one.
- The waits of channel `main` stay as in C4 (10 s and 120 s).

**What stops a handler.**

- After a timeout, the receiver drops the op's later result or error. It never sends a second res.
  It cannot stop a `chrome.*` call that started: Chrome runs it to its end. So, after a
  `debugger.sendCommand` that timed out, the relay detaches the tab (`debugger.detach`). That ends
  the command in Chrome: a command in flight at a detach fails (the probe's matrix saw "Detached
  while handling command."). The relay tells the tab's client sessions `Target.detachedFromTarget`,
  and the client can attach again (two-modes design, section 10).
- After a disconnect (the native port closes) or a new daemon connection (a `link` up), the
  receiver:
  1. drops the answers of the bridge requests that still run;
  2. turns the eager attach off and releases every hold;
  3. detaches every tab that the bridge holds. So no domain state (Fetch, emulation, interception)
     stays behind, and a long `Runtime.evaluate` ends. It never detaches the import's restore tab:
     that attachment belongs to channel `main`.
- The daemon, at a link drop, answers every bridge request that waits or runs with `disconnected`.
  Then it writes `{"t":"link","up":false}` to the relay, and the relay closes every client
  connection (C11).

**Parts and sizes.**

- A request goes to the receiver in C4 parts with `"ch":"bridge"`. The parts of one bridge request
  never interleave with those of another bridge request. The daemon mixes them with main parts (C4).
  So a large request, for example a file of 50 MB that Playwright sends by buffer, holds the next
  bridge requests back while its parts go.
- A request is at most `MAX_REQUEST = 134217728` bytes (128 MiB) of UTF-8 JSON. The relay writes no
  longer line (C11 gives the client an error), and the daemon reads the relay's lines up to that
  length.
- A res or an event is at most `MAX_TO_DAEMON` (C4). A res above it goes as `too large` (C4). So a
  result above about 8 MiB fails: for example a full-page screenshot of a very long page, or
  `response.body()` of a file above about 6 MiB (CDP sends a body in base64). The relay gives the
  client a clear error (C11). Results in parts from the receiver to the daemon are a later change,
  for when a program needs them.
- `MAX_IN_FLIGHT = 128`: the daemon sends at most 128 bridge requests to the receiver at a time.
  The next ones wait in the daemon, in order. The receiver sets no bound of its own (C4).

**The hold of a new tab.** Not measured: stage 2 measures it with the probe's popup cases. If Chrome
acts otherwise, stage 2 changes this text.

- `bridge.attachNew` with `[true]` turns the eager attach on; `[false]` turns it off. It starts off,
  and it goes off at each link change. The relay turns it on while at least one client connection is
  open (C11).
- While it is on, the receiver attaches each new tab in `tabs.onCreated` at once, and it holds the
  tab's first document request with `Fetch`. So the tab waits as with Chrome's
  `waitForDebuggerOnStart`. The event says `"attached":true,"held":true`. The receiver never
  attaches the restore tab of an import. Tabs that the operator opens in the live view have no mark
  today (agentwatch design §5.15 names an exemption for them, not built); when they get one, the
  receiver skips them too.
- The relay sends `bridge.release` after the client's `Runtime.runIfWaitingForDebugger` on that tab
  got its answer, or before it detaches a tab that no connection took. `debugger.detach` releases the
  hold too. The receiver releases a hold itself after `HOLD_MAX_MS = 5000`, so a tab never waits for
  a relay that does not answer.
- A release continues the held request and ends the receiver's `Fetch` on the tab. A client can turn
  `Fetch` on for that tab during the hold (a `debugger.sendCommand` of `Fetch.enable` without a
  `sessionId`). Then the receiver keeps `Fetch` on. It sends the held request's `Fetch.requestPaused`
  event to the relay instead, so the client's routes see the first request too. The hold's own
  `Fetch` events never reach the relay.

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
- No side logs the args, the results or the event params of the bridge: they can hold page content
  and sign-in values. A log line holds an op, a CDP method, a tab id, a size or a time.

### C11. The endpoint (agent-browser's relay)

The relay serves a CDP endpoint for Playwright, the Playwright MCP and agent-browser's own commands.
Behind it the browser model answers the browser-level calls with C10 ops. It sends each page-level
call to `debugger.sendCommand` (two-modes design, sections 4 and 8). This file is the master for
C11. The vectors: `test/vectors/endpoint.json`.

| Part | Side | Stage of the two-modes design |
| --- | --- | --- |
| The socket server, the scope, one connection per tab, the refusals, the cookie marker | agent-browser's relay | 3 (board ab-v16.6) |
| The socket path, `browser.control`, `agentwatch browser endpoint` and `env`, `end_scope` | The agentwatch daemon | 4 (board ab-v16.7) |

**The socket and the URL.**

- A Unix socket with mode 0600. The relay makes it at the path that the daemon gives it:
  `/run/user/<uid>/agentwatch/browser-cdp.sock` on Linux, `~/.cache/agentwatch/run/browser-cdp.sock`
  on the Mac. A path is at most 103 bytes. There is no TCP port.
- The URL is `ws+unix://<socket path>:/devtools/browser/<scope>`. Playwright's `connectOverCDP` and
  the Playwright MCP (`PLAYWRIGHT_MCP_CDP_ENDPOINT`) take it as it is (measured). The URL holds no
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

- `Browser.close` ends that connection only. The agent browser keeps running. Close code 1000, `Browser.close ends this connection; the agent browser keeps running`.
- `end_scope` (C10): the relay closes the scope's connections with 1000, `The agentwatch session ended`, and removes the scope's tabs.
- A link drop (C10 `link` down): every connection closes with 1011, `The agent browser's link went down`. The model starts again at the next `link` up.
- The relay stops: every connection closes with 1001, `The agent browser stopped`.

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
- One connection can hold several sessions on its tab (auto-attach, `Target.attachToTarget`,
  Playwright's `newCDPSession`).
- Another connection of the same scope sees the tab in `Target.getTargets` with `attached: true`.
  It cannot attach to it.
- When the owner leaves, the model detaches the tab. Its domain state goes, and the tab stays open,
  free for the scope's next connection.
- There is one browser context. Every target has `"browserContextId":"agentwatch-default"`, and
  `Target.getBrowserContexts` answers `{"browserContextIds":[]}`.
- The model turns the eager attach (C10) on while at least one connection is open.

**Refusals.** The model answers each refused call itself, before any bridge request, with the CDP
error `{"code":-32000,"message":"<text>"}`. So the text is the same on every Chrome version, and the
call never reaches Chrome. In a text, `<method>` is the CDP method of the call, `<host>` a host,
`<name>` a permission name, `<scheme>` a URL scheme with its colon, and `<seconds>` the wait in
seconds. A rule applies on every session (the root, a browser session, a page session) unless it
names one.

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
| Other browser-level calls; extensions; the old interception | A root or browser-session method outside the model's set; `Extensions.*`; `Target.exposeDevToolsProtocol`; `Network.setRequestInterception` | `Not available in the agent browser: <method>.` |
| `chrome://` pages, other extensions' pages | `Page.navigate` or `Target.createTarget` with a `url` that is not `about:blank` and whose scheme is not `http:`, `https:`, `data:`, `blob:` or `file:` | `Not available in the agent browser: <scheme> URLs (<method>). Agent mode opens web pages only.` |

- `about:` URLs other than `about:blank` are refused, because Chrome opens some of them as
  `chrome://` pages. A `file:` URL passes the model, and DNR blocks it in Chrome (measured).
- Service-worker targets: the model reports no target of type `service_worker`, `shared_worker` or
  `browser`. So `context.serviceWorkers()` is empty, and no `serviceworker` event comes. This is not
  an error: no CDP call asks for those targets alone.

Page marks (board ab-jzg Q3: refuse). These features put `__playwright__` names on the page's
`window`, which a site can see (two-modes design, section 5, rows 25 and 27). The rule refuses only
the page's main world (the world of the page's own scripts):

| What | The call | The text |
| --- | --- | --- |
| `addInitScript`, `exposeFunction`, `exposeBinding`, tracing snapshots, `page.clock` | `Page.addScriptToEvaluateOnNewDocument` with no `worldName`, or with `""` (the main world) | `Not available in the agent browser: init scripts in the page's main world (Page.addScriptToEvaluateOnNewDocument). addInitScript, exposeFunction, exposeBinding and tracing snapshots put names on the page that a site can see.` |
| `exposeFunction`, `exposeBinding` | `Runtime.addBinding` with no `executionContextName`, or with `""` (the main world; an `executionContextId` alone counts as the main world) | `Not available in the agent browser: bindings in the page's main world (Runtime.addBinding). exposeFunction and exposeBinding put names on the page that a site can see.` |

- The same calls pass when they name an isolated world: `Page.addScriptToEvaluateOnNewDocument`
  with a `worldName` that is not empty, and `Runtime.addBinding` with an `executionContextName` that
  is not empty. A page's own scripts cannot read an isolated world. Playwright needs this: it sends
  `Page.addScriptToEvaluateOnNewDocument` with `"source":""` and its utility world's `worldName` for
  each page and each frame. If the model refused those, every Playwright connection would break.
- So no `__playwright__` name reaches a page. A program that uses one of these features fails.
  Tracing with screenshots and no snapshots works.
- For stage 3: Playwright keeps a refused feature in its context. After a refused `exposeFunction`
  or `exposeBinding`, it sends `Runtime.addBinding` again for each new page, so each later page of
  that connection fails too. A program that calls `addInitScript` before it has a page gets no error
  at that call, and each later page fails. Such a program must connect again without the feature.
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
- The cookie marker. In every `Network.*` and `Fetch.*` event and result that the model gives a
  client, the value of each `Cookie` and `Set-Cookie` header becomes the marker `(hidden)`. This
  covers `Network.requestWillBeSent`, `Network.requestWillBeSentExtraInfo`,
  `Network.responseReceived`, `Network.responseReceivedExtraInfo`,
  `Network.webSocketWillSendHandshakeRequest`, `Network.webSocketHandshakeResponseReceived` and
  `Fetch.requestPaused`:
  - in header objects (`headers`, `requestHeaders`): the value becomes `(hidden)`;
  - in header lists of `{name, value}` (`headers`, `responseHeaders`): the value becomes `(hidden)`;
  - in raw header texts (`headersText`, `requestHeadersText`): each such line becomes
    `<name>: (hidden)`;
  - the cookie lists `associatedCookies`, `blockedCookies` and `exemptedCookies` become `[]`.
- A page script, also one that a program runs with `evaluate`, can still read and change the
  cookies that are not httpOnly (`document.cookie`), as any page script can.
- A later cookie grant, for a use that needs cookie access, can lift these refusals for the granted
  sites and add `cookies.*` ops to C10. The relay's code marks the place.

The allowlist, the scope and the size (two-modes design, sections 4.3, 4.4 and 8):

| What | The call | The text |
| --- | --- | --- |
| A permission for an origin off the allowlist | `Browser.grantPermissions` with such an `origin` | `Not allowed: <host> is not on the allowlist` |
| A permission that `chrome.contentSettings` cannot grant | `Browser.grantPermissions` with another name | `Not available in the agent browser: the permission <name>` |
| A tab of the scope that another connection holds | `Target.attachToTarget` | `The tab is in use by another connection of this scope` |
| A tab of another scope, or no such tab | `Target.attachToTarget`, `Target.closeTarget`, `Target.activateTarget`, `Target.getTargetInfo`, `Browser.getWindowForTarget` | `No target with given id found` |
| A window with no tab of the scope | `Browser.getWindowBounds`, `Browser.setWindowBounds` | `Browser window not found` |
| A session that the connection does not hold | Any call with that `sessionId` | `Session with given id not found.` |
| A result above `MAX_TO_DAEMON` | The receiver answered `too large` | `The answer of <method> is larger than the agent browser's link allows (8 MiB).` |
| A command whose bridge request is above `MAX_REQUEST` | Any | `The command is too large for the agent browser: <method>.` |
| A deadline (C10) | The receiver or the daemon answered `timeout` | `The agent browser did not answer <method> in <seconds> s.` |

- The model grants these permissions (the CDP name, then the content setting of C10's
  `contentSettings.set`): `geolocation` (`location`), `notifications` (`notifications`),
  `videoCapture` (`camera`), `audioCapture` (`microphone`), `clipboardReadWrite` and
  `clipboardSanitizedWrite` (`clipboard`). A grant with no origin covers the allowlisted domains. It
  refuses every other name. It sets `automaticDownloads` for the allowlisted domains itself
  (two-modes design, section 4.5).
- After a `timeout` of a `debugger.sendCommand`, the model also detaches the tab and sends
  `Target.detachedFromTarget` to the tab's sessions (C10).
- The text for another scope's tab is Chrome's own text for a target that does not exist. So a
  connection cannot tell another scope's tab from no tab.
