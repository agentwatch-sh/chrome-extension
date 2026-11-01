// The receiver service worker. Every chrome event listener is registered
// synchronously while this file is evaluated (the Manifest V3 rule).
import { ReceiverLink, watchBlocked } from "./link.js";
import { applyAllowlist } from "./dnr.js";
import { importState } from "./importer.js";

const link = new ReceiverLink(chrome, {
  ping: async () => ({}),
  set_allowlist: (req) => applyAllowlist(chrome, req.domains),
  import: (req) => importState(chrome, req.state),
});

watchBlocked(chrome, (msg) => link.send(msg));
link.start();
