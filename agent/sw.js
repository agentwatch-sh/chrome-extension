// The agent package's service worker. Every chrome event listener is
// registered synchronously while this file is evaluated (the Manifest V3 rule),
// before the first await.
import { ReceiverLink } from "./link.js";
import { mainOps } from "./allowlist.js";
import { Bridge } from "./bridge.js";
import { receiver } from "./receiver.js";

const link = new ReceiverLink(chrome, {
  main: mainOps(chrome),
  bridge: (req) => bridge.handle(req),
}, {
  // C10: the cleanup at each disconnect and each new daemon connection.
  onLinkChange: () => bridge.reset(),
});
const bridge = new Bridge(chrome, link);

// The blocked notices (C4): the guard, DNR's blocks, and a popup's retry,
// which decides the notice of its first request (guard.js, popups.js).
receiver(chrome).notify = (msg) => link.send(msg);
// C10: the cleanup at the worker's start (a worker that started again knows no bridge tabs).
void bridge.reset();
// C5 and C10 at the worker's start: every session rule goes and the map comes
// back from its copy; only then does the native port connect (its hello).
void receiver(chrome).startup().finally(() => link.start());
