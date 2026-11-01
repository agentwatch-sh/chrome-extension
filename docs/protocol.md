# Protocol and fixed values

Both repositories implement these contracts. Change them only in the agentwatch plan.

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

- receiver -> daemon: `{"t":"hello","v":1,"version":"<manifest version>"}`;
  `{"t":"res","id":"<id>","ok":true,"data":{...}}` or `{"t":"res","id":"<id>","ok":false,"error":"<text>"}`;
  `{"t":"blocked","tab":<tab id>,"host":"<host>"}`.
- native host -> receiver: `{"t":"link","up":true}` after each connect to the daemon socket (the
  receiver answers with `hello`).
- daemon -> receiver: only parts, `{"t":"part","id":"<id>","seq":<i>,"n":<count>,"b64":"<base64>"}`.
  The daemon serializes the request as compact UTF-8 JSON, cuts the bytes into slices of
  `PART_BYTES = 700000` (the last slice may be shorter; an empty request is never sent), and sends
  slice `i` base64-encoded with `seq = i`, `n` = the slice count. The receiver joins the decoded slices
  of one `id` in `seq` order once all `n` arrived, decodes UTF-8 and parses the request. Parts of
  different ids may not interleave (the daemon sends one request at a time); a part with a new `id`
  drops an unfinished one.
- Requests: `{"t":"req","id":"<id>","op":"ping"}` -> `{}`;
  `{"t":"req","id":"<id>","op":"set_allowlist","domains":["a.example"]}` ->
  `{"rules":<1 if the list is not empty, else 0>,"closed":<tabs closed>}`;
  `{"t":"req","id":"<id>","op":"import","state":<C2 payload>}` ->
  `{"cookies_removed":0,"cookies_set":0,"local":0,"session":0,"idb_databases":0,"idb_records":0,"cache_entries":0,"errors":["<store or cookie name>: <reason>"]}`.
- Ids are strings. The daemon waits 10 s for `ping` and `set_allowlist`, 120 s for `import`.

### C5. The allowlist and the block

- File `CONFIG_DIR/browser/allowlist.json` = `{"allow": ["example.com", ...]}` (agent-browser's
  format; the daemon writes it with `statefiles.write_json`).
- An entry is a hostname: trimmed, lowercased, a trailing dot removed, Unicode labels to punycode
  (IDNA), at least two labels, each label 1-63 of `[a-z0-9-]` not starting or ending with `-`, total at
  most 253; no scheme, port, path, `*` or IP address. A pasted URL is refused with the hint "paste the
  host only" (the web viewer strips a URL to its host before it sends). An entry covers itself and
  every subdomain (O10).
- DNR: the receiver's static ruleset `block_main_frame` (`rules/block-main-frame.json`, enabled in the
  manifest): rule id 1, priority 1, `{"type":"block"}`, `resourceTypes: ["main_frame"]`. One dynamic
  rule id 2, priority 2, `{"type":"allow"}`, `requestDomains` = the list, `resourceTypes:
  ["main_frame"]`; no rule 2 when the list is empty. So the block holds from Chromium's first moment,
  before the service worker runs.
- On each `set_allowlist` the receiver closes every tab whose `http:`/`https:` host the new list does
  not cover; if that would close the last tab of a window, it first opens `about:blank` there.
- A main-frame `webNavigation.onErrorOccurred` with `net::ERR_BLOCKED_BY_CLIENT` sends `blocked` with
  the host only.

### C6. The restore page (the receiver's import)

1. Remove every cookie of `domain` and its subdomains (`getAll({domain})` and
   `getAll({domain, partitionKey: {}})`), then `cookies.set` each sent cookie (C2 -> set details:
   `url` = `https://` if secure else `http://`, the domain without a leading dot, the path; `domain`
   only when not `hostOnly`; `expirationDate` only when not `session`; `sameSite` and `partitionKey` as
   sent).
2. `tabs.create({url: "about:blank", active: true})`, `debugger.attach({tabId}, "1.3")`,
   `Fetch.enable({patterns: [{urlPattern: R, requestStage: "Request"}]})` with
   `R = origin + "/__agentwatch_restore_" + <16 hex chars> + "__"`, `tabs.update(tabId, {url: R})`;
   on `Fetch.requestPaused` for `R`: `Fetch.fulfillRequest` 200, headers `Content-Type: text/html;
   charset=utf-8` and `Cache-Control: no-store`, body
   `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>agentwatch</title>`.
3. After `webNavigation.onCompleted` for `R` in that tab: `executeScript({files: ["lib/codec.js"]})`,
   then `executeScript({func: replacePageState, args: [JSON.stringify(state.storage)]})`
   (one JSON string: `executeScript` drops null-valued properties). `replacePageState` clears
   localStorage, sessionStorage, every IndexedDB database of the origin and every cache, then writes
   the sent ones, and returns counts and errors.
4. `Fetch.disable`, `debugger.detach`, then `executeScript({func: (u) => location.replace(u), args:
   [state.url]})`.
5. Any step that fails: detach, close the restore tab, answer `ok: false` with the step's name. Each
   step has a 20 s deadline. One import at a time; a second waits.

