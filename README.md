# agentwatch Chrome extension

Send a sign-in from your own Chrome to your agent browser.

You sign in to a site in your own Chrome, with your password manager, 2FA or
passkey. Then you click the extension's button, pick an agentwatch box, and the
extension sends that site's cookies to the agent browser
([agent-browser](https://github.com/agentwatch-sh/agent-browser)) on that box.
The same step adds the site to that box's allowlist.

Status: not built yet. The design is in agentwatch's agent browser design
(section 5.14, "Send a sign-in from the operator's Chrome").

## What it does and does not do

- It reads only the cookies of the site you are on: its domain and its
  subdomains. It asks Chrome for access to that one site when you click, and
  keeps no standing access to other sites.
- It sends them only to your own agentwatch web viewer, with your web login and
  a password login. An agent can never start a send.
- It never stores or logs a cookie value.
- Device-bound sign-ins do not move, and a site that keeps its sign-in in page
  storage needs a sign-in in the agent browser's live view instead.

## Licence

MIT. See [LICENSE](LICENSE).
