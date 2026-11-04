# Protocol and fixed values

Both repositories implement these contracts. Change them only in the agentwatch plan.

C4 is the exception. Since the two-modes design (agent-browser
`docs/superpowers/specs/2026-11-03-two-modes-playwright-design.md`, section 13), this file is the
master for C4. The agentwatch plan's C4 text is older (`"v":1`, no channels).

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
  (a res on the bridge channel also has `"ch":"bridge"`);
  `{"t":"blocked","tab":<tab id>,"host":"<host>"}`.
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
- C10 defines the bridge's ops, their data and the daemon's waits. Until C10 sets them, the daemon
  waits 10 s for a bridge request. The daemon keeps at most N bridge requests in flight; C10 sets N.
  The receiver sets no bound of its own: it starts each bridge request that it gets. A bridge request
  with an op that the receiver does not know gets `{"t":"res","ch":"bridge","id":"<id>","ok":false,"error":"unknown op"}`.
  The main ops are not bridge ops: `ping` on channel `bridge` is an unknown op too. A bridge request
  never stops or delays channel `main`. Until C10 sets the waits, the receiver answers a bridge
  request that runs 9 s with `"ok":false,"error":"timeout"`, before the daemon's 10 s.
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
