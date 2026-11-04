// The agent package's service worker. Every chrome event listener is
// registered synchronously while this file is evaluated (the Manifest V3 rule).
import { ReceiverLink, watchBlocked } from "./link.js";
import { applyAllowlist } from "./dnr.js";
import { importState } from "./importer.js";
import { Bridge } from "./bridge.js";

const link = new ReceiverLink(chrome, {
  main: {
    ping: async () => ({}),
    set_allowlist: (req) => applyAllowlist(chrome, req.domains),
    import: (req) => importState(chrome, req.state),
  },
  bridge: (req) => bridge.handle(req),
}, {
  // C10: the cleanup at each disconnect and each new daemon connection.
  onLinkChange: () => bridge.reset(),
});
const bridge = new Bridge(chrome, link);

watchBlocked(chrome, (msg) => link.send(msg));
// C10: the cleanup at the worker's start (a worker that started again knows no bridge tabs).
void bridge.reset();
link.start();
