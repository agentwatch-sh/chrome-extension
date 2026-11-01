// The sender's service worker. The popup asks for a send and may close at
// once; this worker does the read, the size check and the POST.
import { runSend } from "./send.js";

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.op !== "send") return false;
  runSend(chrome, fetch, msg);
  return false;
});
