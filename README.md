# agentwatch Chrome extensions

Send a sign-in from your own Chrome to the agent browser on an agentwatch box.

You sign in to a site in your own Chrome, with your password manager, 2FA or a
passkey. You click the **sender** extension's button, pick a box, and the
sender sends that site's cookies and page storage to the box's agentwatch web
viewer. On the box, agentwatch hands them to the **receiver** extension in the
agent's Chrome, which replaces the site's state there. The same step adds the
site to the box's allowlist. The receiver also blocks every top-level
navigation to a site that is not on the allowlist.

This repository holds both extensions. agentwatch pins a tag of it. The design
is in agentwatch's agent browser design (sections 5.14 to 5.16); the messages
and fixed values are in [docs/protocol.md](docs/protocol.md).

| Folder | Runs in | Does |
| --- | --- | --- |
| [`sender/`](sender/) | your own Chrome | reads one site's state on your click and sends it to your box |
| [`receiver/`](receiver/) | the agent's Chrome on the box | writes a sent state; blocks sites that are not on the allowlist |
| `shared/` | both (copied into `sender/lib/` and `receiver/lib/` by `npm run sync`) | the value codec, the cookie conversions, the allowlist rules |

Both are Manifest V3 extensions in plain JavaScript, with no build step and no
dependencies.

## The sender

### What it reads

When you click **Send** in its popup, and only then, the sender reads from the
current tab:

- every cookie of the site's domain and its subdomains, with all attributes
  (httpOnly, Secure, SameSite, expiry, host-only or domain, path, partition
  key);
- the page storage of the tab's **origin** only: localStorage, the tab's
  sessionStorage, every IndexedDB database (version, stores, key paths,
  indexes and records with typed values) and Cache Storage.

It reads nothing else: no history, no other tab, no other origin's page
storage. It never stores a cookie value or a storage value, and no status text
or error holds one.

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

1. Get this repository (or the sender folder that your box's web viewer offers
   for download).
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked** and pick the `sender/` folder. The extension's ID is fixed
   by the `key` in its manifest: `bpfkgknpndlpkcffmaaelkfcbpackiip`.
3. Open the extension's options (**Details**, then **Extension options**), type
   the address of your box's web viewer (for example `box.example.com`) and
   click **Add**. Chrome asks to allow the extension to talk to that address.
   Click **Allow**.
4. Log in to the web viewer in the same Chrome, with your password.

### Send a site

1. Sign in to the site in a tab of your Chrome.
2. Click the extension's button. The popup shows the site's domain, your boxes
   and the box's users that have a password login.
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
Chrome, and the message names the largest database.

## The receiver

The receiver runs only in the agent's Chrome on the box. agentwatch starts that
Chrome with `--load-extension=<receiver folder>` on each launch; you do not
install it yourself. Its ID is `dofdpnfachcncepdoondkeodcbnhipdc`.

Chromium writes its indexed ruleset into `_metadata/` in the receiver folder
when it loads the receiver. So the folder must be writable by the OS user that
runs the agent's Chrome: from a read-only folder, Chromium 156 does not load
the receiver at all (measured), and then nothing blocks.

### What it does

- It connects to the agentwatch daemon of the box's user through native
  messaging (host `sh.agentwatch.browser`). Nothing else can talk to it: it
  has no content scripts, no web-accessible files and no
  `externally_connectable`, so a page cannot see it.
- **A send** replaces the site's state in the agent's Chrome: it removes every
  cookie of the domain and its subdomains, writes the sent ones, closes the
  agent's tabs of the origin, writes the page storage on a restore page that
  the site never receives, and then opens the site. The site's first script
  sees the sent state. The answer holds counts and names only.
- **The allowlist block:** a static rule blocks every top-level navigation,
  and one dynamic rule allows the allowlist's domains and their subdomains. So
  the block holds from Chrome's first moment. Frames and subresources from any
  host still load. When the list changes, the receiver closes the tabs whose
  site left it, and it reports each blocked navigation (the host only) to the
  daemon.

### Its permissions, and why

| Permission | Why |
| --- | --- |
| `cookies` | to remove the site's old cookies and write the sent ones |
| `scripting` | to write the page storage on the restore page and then open the site |
| `tabs` | to open the restore tab and to close the tabs that a send or a list change makes stale |
| `webNavigation` | to know when the restore page has loaded, and to report a blocked navigation |
| `declarativeNetRequest` | the allowlist block |
| `nativeMessaging` | the link to the agentwatch daemon |
| `debugger` | to serve the restore page from the extension (the site never sees that request) and to bypass the site's service worker during the import |
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

## Development

```sh
npm test        # the unit tests (node --test, no dependencies)
npm run sync    # copy shared/ into sender/lib/ and receiver/lib/
```

`test/live/` holds a live test of both extensions in real Chromium on a Linux
box with Xvfb. See [test/live/README.md](test/live/README.md).

## Licence

MIT. See [LICENSE](LICENSE).
