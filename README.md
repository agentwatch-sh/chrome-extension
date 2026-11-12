# agentwatch Chrome extension

Send a sign-in from your own Chrome to the agent browser on an agentwatch box,
and let agents drive that agent browser.

You sign in to a site in your own Chrome, with your password manager, 2FA or a
passkey. You click the **operator mode** extension's button (the sender), pick
a box, and it sends that site's cookies and page storage to the box's
agentwatch web viewer. On the box, agentwatch hands them to the **agent mode**
extension (the receiver) in the agent's Chrome, which replaces the site's state
there. The same step adds the site to the box's allowlist. Agent mode also
blocks every top-level navigation to a site that is not on the allowlist, and
it carries the bridge that lets agent-browser's relay drive the agent's Chrome
(contract C10).

This repository holds one source tree and builds two packages from it, one for
each mode (agent-browser's two-modes design, section 3.1). agentwatch pins a
commit of it by its 40-hex ID. The design is in agentwatch's agent browser
design (sections 5.14 to 5.16) and the two-modes design; the messages and fixed
values are in [docs/protocol.md](docs/protocol.md).

| Folder | Runs in | Does |
| --- | --- | --- |
| [`operator/`](operator/) | your own Chrome | operator mode: reads one site's state on your click and sends it to your box |
| [`agent/`](agent/) | the agent's Chrome on the box | agent mode: writes a sent state; blocks sites that are not on the allowlist; the bridge |
| `shared/` | both (copied into `operator/lib/` and `agent/lib/` by `npm run sync`) | the value codec, the cookie conversions, the allowlist rules |

Both are Manifest V3 extensions in plain JavaScript, with no build step and no
dependencies; each folder loads as it is (the agent package also comes as a
packed CRX, below). The operator package holds no `debugger`, `nativeMessaging` or
`declarativeNetRequest` permission, so it can never control your Chrome; a
test fails the build if it gains one.

## Operator mode (the sender)

### What it reads

When you click **Send** in its popup, and only then, the sender reads from the
current tab:

- every cookie of the site's domain and its subdomains, with all attributes
  (httpOnly, Secure, SameSite, expiry, host-only or domain, path, partition
  key);
- the page storage of the tab's **origin** only: localStorage, the tab's
  sessionStorage, every IndexedDB database (version, stores, key paths,
  indexes and records with typed values) and Cache Storage (except opaque
  entries: the page itself cannot read their bytes; the result counts them).

It reads nothing else: no history, no other tab, no other origin's page
storage. It never stores a cookie value or a storage value, and no status text
or error holds one.

It never sends a box's own sign-in. A send from a box's web viewer tab, or of a
domain that covers the host of a box you added, stops with "This is an
agentwatch box. Its sign-in is never sent." before it reads anything, and no
send holds a cookie that a box's host would receive.

### Its permissions, and why

| Permission | Why |
| --- | --- |
| `cookies` | to read the site's cookies, also httpOnly ones; a page cannot read those |
| `activeTab` | to read the page storage of the tab you clicked on |
| `scripting` | to run the reader in that tab (in the extension's isolated world) |
| `storage` | to keep your list of boxes and the status of the last send |
| optional host permission `*://*.<site>/*` | Chrome opens `chrome.cookies` for a site only with a host permission. The popup asks for the site at your first send: Chrome shows "Read and change your data on all <site> sites" with Deny focused. The grant stays, so the next send of that site is one click. The popup lists the sites it can read, and **Remove** takes a grant back. |
| optional host permission for each box | the options page asks for it when you add a box, so the sender can call the box's web viewer with your login cookie |

The sender sends only to a box that you added, with your web login cookie, and
the box accepts it only from this extension's ID and only after a password
login. An agent cannot start a send.

### Load it (unpacked) and add a box

1. Get this repository (or the `operator/` folder that your box's web viewer offers
   for download). The sender needs Chrome 132 or later.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked** and pick the `operator/` folder. The extension's ID is fixed
   by the `key` in its manifest: `bpfkgknpndlpkcffmaaelkfcbpackiip`.
3. Open the extension's options (**Details**, then **Extension options**), type
   the address of your box's web viewer (for example `box.example.com`) and
   click **Add**. Chrome asks to allow the extension to talk to that address.
   Click **Allow**.
4. Log in to the web viewer in the same Chrome, with your password.

### Send a site

1. Sign in to the site in a tab of your Chrome.
2. Click the extension's button. The popup shows the site's domain, your boxes
   and the box's users that have a password login. The domain list starts at
   the tab's host and stops at the site's registrable domain (Chrome's public
   suffix list), so it never offers a domain such as `co.uk`.
3. Click **Send**. At the first send of a site, Chrome asks for access to it
   and closes the popup. Click **Allow**; the send goes on without the popup.
4. Open the popup again to see the result: the domain and the counts
   (cookies, storage keys, databases, records, cache entries), or the reason
   for a refusal.

A send that waits for Chrome's access gives up after 2 minutes. If you click
**Deny** (Chrome has closed the popup by then), the popup shows "Waiting for
Chrome's access to <site>..." until those 2 minutes end, and then "Chrome did
not give access to <site>." Click **Send** again to ask once more. If the tab
shows another site when the access comes, the send stops with "The tab moved
to another page. Send again." and reads nothing.

A send is at most 32 MiB. A larger state is refused before it leaves your
Chrome, and the message names the largest database (or cache). The reader
reads in batches and stops as soon as the state passes 32 MiB, so a very large
site does not fill the memory of your tab.

## Agent mode (the receiver)

The receiver runs only in the agent's Chrome on the box. agentwatch starts that
Chrome with `--load-extension=<agent folder>` on each launch; you do not
install it yourself. Google Chrome ignores that option, so for a Google Chrome
the receiver comes as a packed CRX through Chrome's external extensions file
(see [The packed CRX](#the-packed-crx)); agentwatch's stage 4 (board ab-v16.7)
builds that install. Its ID is `ifhfjdmdbgbnmllffiadajepajbcdnai`, from the
`key` in its manifest, unpacked and packed. Its frame rule (below) needs Chrome
141; the package asks for Chrome 145 as a safe minimum.

The native host `sh.agentwatch.browser` is agentwatch's, not this
repository's. Its check that its parent Chrome runs on the agent profile
(two-modes design, section 3.2) is built in agentwatch, with stage 4 (board
ab-v16.7). `test/live/host.py` here is a host for the live test only, and it
does not check its parent.

Chromium writes its indexed ruleset into `_metadata/` in the agent folder
when it loads the receiver. So the folder must be writable by the OS user that
runs the agent's Chrome: from a read-only folder, Chromium 156 does not load
the receiver at all (measured), and then nothing blocks. A CRX does not have
this limit: Chrome unpacks it into the profile (`Extensions/<ID>/<version>_0/`)
and writes `_metadata/` there (measured).

### The packed CRX

Chrome's external extensions file takes a packed extension (a CRX) that a
private key signs, and that key fixes the extension's ID. Build the CRX on
taylor, where the key lives:

```sh
npm run pack:agent                  # writes dist/agent.crx (git-ignored); prints the ID and the version
npm run pack:agent -- --key PATH    # another key file (or AGENT_KEY_PATH=PATH)
npm run pack:agent -- --out release # writes release/agent.crx, the committed copy (below)
```

- **The committed copy:** `release/agent.crx` is in the repository (board
  task ab-v16.22). agentwatch pins two values: a commit of this repository,
  by its 40-hex ID, and the SHA-256 of that commit's `release/agent.crx`.
  It installs that CRX; it never runs the script and never opens the key.
  So a change of `agent/` reaches the boxes only after agentwatch moves both
  pins. The CRX holds no secret: only the archive, the public key and the
  signature.
- **What goes in:** the script packs only the files that git tracks in
  `agent/` (`git ls-files`). An ignored or untracked file there, for example
  `agent/notes.zip` or `agent/attach.js~`, stays out.
- **The checks** (`test/pack-agent.test.mjs`, board task ab-v16.24). The same
  files and the same key give the same bytes only with the same Node and zlib
  build: another zlib build can deflate the same files to other bytes. So the
  tests compare content, not bytes, and they need no key:
  - The committed CRX has the agent ID, a valid signature and exactly the
    tracked files of `agent/`.
  - `release/versions.json` holds each released version and the content
    SHA-256 of that version (below). The entry of the manifest version
    matches `agent/` and the CRX, and that version is the highest in the
    table, in Chrome's order.
  - The table keeps each entry of its base. On a push run in CI, the base is
    the main before the push (`github.event.before`): the workflow fetches
    that commit and passes it to the test as `VERSIONS_BASE`. On a
    pull_request run, the base is `HEAD^1`, the main tip of the merge commit
    (the checkout has `fetch-depth: 2`). Elsewhere, the base is
    `origin/main`. An entry that the base holds never changes or leaves the
    table. A branch may correct its own new entry. A base from before the
    table passes. A base commit that is not in the clone, or an all-zero
    `github.event.before` (a new branch), fails the test.
- **The content SHA-256:** take the files of the package (not its folders)
  and sort them by the UTF-8 bytes of their paths. For each file, write its
  path, a NUL byte, its size in decimal ASCII digits, a NUL byte and its
  bytes. The SHA-256 of all of it, in lowercase hex, is the content SHA-256.
  Each path is printable ASCII (the script refuses other paths), so each ZIP
  reader (for example Python's `zipfile`) reads the same names.
- **A change of `agent/`** fails `npm test` until the key holder repacks on
  taylor: raise `version` in `agent/manifest.json` (Chrome installs an
  external CRX again only when its version is higher), run `npm run
  pack:agent -- --out release`, add the entry of the new version to
  `release/versions.json` (`npm test` prints it), and commit the three
  changes together.

- **The key:** its working copy lives only on taylor, in
  `~/.config/agentwatch/browser/agent-extension.pem` (mode 0600, in a 0700
  folder). It was generated once there (board task ab-v16.18). It never goes
  into this repository, a commit, a log, an argv or a mail. The script reads
  the key from that path (or from the path that you give it) and refuses a
  key file that is not yours, that group or others can open, or that is not
  a regular file. It never prints, logs or copies the key, and it refuses to
  pack a file of the package that is named as a key or a CRX (`.pem`,
  `.key`, `.der`, `.crx`) or that is the key file itself.
- **The backup** of the key is the operator's: the operator keeps a copy in
  their password manager. Agents never copy or send the key.
- **The ID.** The manifest's `key` is the public key of that file, so the
  unpacked folder and the CRX get the same ID. The script refuses to pack
  when the two differ.
- **A lost key means a new ID.** Then generate a new key, put its public key
  into `agent/manifest.json` (the base64 of `openssl pkey -in <key> -pubout
  -outform DER`), write the new ID into docs/protocol.md, and change every
  pin of the ID in agentwatch again (contract C1 lists them).

Chrome reads `<the folder of the Chrome binary>/extensions/<ID>.json` at its
start, with `{"external_crx": "<path of agent.crx>", "external_version":
"<manifest version>"}`; the script prints that line. Measured on taylor on
2026-11-04 (Chromium 156.0.8078.79, a private copy of `/usr/lib/chromium`, a
private Xvfb display, a new profile): Chromium installed the CRX with the ID
`ifhfjdmdbgbnmllffiadajepajbcdnai`, location 2 (external file), enabled with
no disable reason; its worker started, both static rulesets were indexed,
and no prompt showed.

### What it does

- It connects to the agentwatch daemon of the box's user through native
  messaging (host `sh.agentwatch.browser`). Nothing else can talk to it: it
  has no content scripts, no web-accessible files and no
  `externally_connectable`, so a page cannot see it.
- **A send** replaces the site's state in the agent's Chrome: it closes the
  agent's tabs of the origin, removes every cookie of the domain and its
  subdomains, writes the sent ones, writes the page storage on a restore page
  that the site never receives, and then opens the site. The site's first script
  sees the sent state. The answer holds counts and names only.
- **The allowlist block, one list per scope (contract C4 `set_scopes`, C5):**
  a static rule blocks every top-level navigation, so the block holds from
  Chrome's first moment. Each agentwatch session is a scope, and each scope
  has at most one list. The receiver keeps the scope of each tab (a map, with
  a copy in `chrome.storage.session` that a restarted service worker reads
  back), and for each list in use two session rules allow its domains and
  their subdomains in the tabs of that list only. In the same way, a second
  static rule blocks every frame, `<object>` and `<embed>` document, and the
  list's frame rule allows them in its tabs whose top-level page is on the
  list. So a page of a listed site still loads frames and subresources from
  any host, and a tab whose top-level page is not on its list (for example
  `about:blank` with content that a CDP client wrote) loads none. A tab of no
  scope, and a tab whose scope has no list, matches no rule. Your own tabs in
  the live view are the exception: a tab that you open at Chrome's New Tab
  page (Ctrl+T, a new window), and each popup of it, gets a mark, and the
  daemon's setting says what a marked tab may open (any site, one list, or
  none). No agent connection sees a marked tab. When the lists
  change, the receiver closes each tab whose site left its list, and every tab
  of a scope that has no list any more (a session that ended), in one removal
  queue that never closes the browser's last window; it reports each blocked
  navigation (the host only) to the daemon. An entry that is not a valid host
  is refused and counted in the answer; the valid entries of the same list
  still apply. A site's service worker answers a navigation before the block
  sees it (measured), so when a scope's list loses a site, the receiver
  removes every service worker of the profile before it closes the tabs; the
  sites that stay register theirs again on their next visit. A send's restore
  tab gets two rules of its own for the sent domain, so a send works also for
  a site that is on no list.
- **The bridge (agent mode, contract C10):** on a second channel of the same
  native link, agent-browser's relay calls a fixed list of 20 operations
  (attach, CDP commands, tabs, windows, downloads, content settings, the
  tab-to-scope map) and gets a fixed list of Chrome events. The bridge checks
  each request before it reaches Chrome: a new tab or window opens only
  `about:blank` and names its scope (never a site, a `chrome:`, `file:` or
  `javascript:` URL); it never touches the restore tab of a running send, a
  tab of an ended session or one of your marked tabs, sets content settings only for hosts that a list
  covers, and has no cookie operation. A close of a tab is the receiver's
  own (`Target.closeTarget`, no "Leave site?" dialog), except a client's
  `Page.close`. A navigation is a CDP command (`Page.navigate`), which the
  bridge passes on: the relay refuses a navigation to such a URL before it
  reaches the bridge (contract C11). A top-level navigation that the agent
  package starts sends `Sec-Fetch-Site: none`, as a typed URL does (a third
  dynamic rule); Chrome would send `cross-site`. The rule acts only where
  Chrome sends `Sec-Fetch-*` headers: `https:` and local `http:`. While the
  relay asks for it,
  the bridge attaches each new tab at once and holds its first document
  request until the relay's client is ready, as Chrome's own
  `waitForDebuggerOnStart` does. Chrome starts the first request of some new
  tabs before the hold is on (measured; see contract C10). At each link
  change the bridge detaches every tab that it attached.

- **The act of the stored sign-ins (contracts C4, C5 and C10; board
  ab-v16.97.3):** agent-browser's service signs in to a site with a
  credential that the operator stored, in an act window of its own: an
  incognito window that the receiver opens (`windows.create` with the mark
  `act`), so the act shares no cookie, storage or worker with the agent's
  tabs. The act tab has its caller's scope for the list rules, but no
  connection sees it. On the service's request (`act_rules`) the receiver
  holds the act's rules A to E, which block the act's requests to a host
  outside the origins that may receive the password, and confirms them
  before the first key; it reads the act window's cookies for the move
  (`act_cookies`), and it closes the act window and then removes the rules
  (`act_end`). A link change ends the act too. Every other incognito tab is
  no agent tab, and the import never touches the act's context. The
  manifest keeps `"incognito": "spanning"` (Chrome's default, written out);
  the service writes the receiver's incognito allow into the profile before
  each Chrome start.

### Its permissions, and why

No permission is new for the act of the stored sign-ins: it uses `cookies`,
`declarativeNetRequest` and `tabs` as below.

| Permission | Why |
| --- | --- |
| `cookies` | to remove the site's old cookies and write the sent ones; to read the act window's cookies of a site for the move of a stored sign-in (`act_cookies`) |
| `scripting` | to write the page storage on the restore page and then open the site |
| `tabs` | to open the restore tab and to close the tabs that a send or a list change makes stale |
| `storage` | to keep the copy of the tab-to-scope map in `chrome.storage.session` (only for this browser run), so a restarted service worker knows each tab's scope |
| `webNavigation` | to know when the restore page has loaded, and to report a blocked navigation |
| `webRequest` | to read the method of a popup's blocked first request: the retry reloads a GET only, so a form that posts into a new tab fails closed with no "Confirm Form Resubmission" dialog (read only; Chrome shows no install warning for it) |
| `declarativeNetRequest` | the allowlist block, the frame rule, the navigation header and the act's rules A to E |
| `nativeMessaging` | the link to the agentwatch daemon |
| `debugger` | to serve the restore page from the extension (the site never sees that request) and to bypass the site's service worker during the import; the bridge's CDP commands |
| `browsingData` | to remove the service workers when a site leaves the allowlist: a worker would otherwise answer a navigation to its host past the block |
| `downloads` | the bridge: the relay follows and cancels downloads |
| `contentSettings` | the bridge: the relay grants permissions (location, camera and others) for allowlisted hosts only |
| host permission `<all_urls>` | the allowlist changes at run time, and an optional permission would need a click in a Chrome that nobody watches |

## What is not moved

- Service workers: the site registers them again when it loads.
- Third-party (partitioned) storage of embedded frames.
- Device-bound sign-ins (for example device-bound session credentials).
- Page storage of other origins and other subdomains of the site (see below).
- Values that the codec cannot carry, for example a `CryptoKey` in IndexedDB.
  Such a record is left out, and the result names its store.

## Limits

- **One sign-in from two places.** The site sees the same sign-in from your
  Chrome and from the box (another IP address). It may ask you to sign in again
  or send you a security email.
- **Session cookies end when the agent Chrome restarts.** Persistent cookies
  stay.
- **Page storage of the current tab's origin only.** A site that keeps its
  sign-in in the page storage of another subdomain needs a send from a tab of
  that subdomain too.
- **Back after a removal (stage 2).** A tab whose back/forward cache still
  holds a page of a site that left the allowlist may go Back to that page with
  no request, so no block. The receiver closes the tabs of a removed site, but
  another tab's history can still hold such a page.

## Development

```sh
npm test             # the unit tests (node --test, no dependencies)
npm run sync         # copy shared/ into operator/lib/ and agent/lib/
npm run pack:agent   # the packed CRX of agent/ (see The packed CRX)
```

CI (`.github/workflows/test.yml`) runs `npm test` on each PR and each push to main.

`test/live/` holds a live test of both packages in real Chromium on a Linux
box with Xvfb. See [test/live/README.md](test/live/README.md).

## Licence

MIT. See [LICENSE](LICENSE).
