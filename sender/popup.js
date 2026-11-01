// The popup. The logic is exported so a Node test can run it; the page wiring
// runs only where there is a document.
import { chooseDomain, domainChoices, fetchTargets, readableSites } from "./send.js";

// The Send click. permissions.request is the first statement, before any
// await, so Chrome counts it as the user's gesture. The worker then does the
// read and the POST, so a closing popup does not stop the send.
export async function onSendClick(chrome, ctx) {
  const asked = chrome.permissions.request({ origins: ["*://*." + ctx.domain + "/*"] });
  const granted = await asked;
  if (!granted) {
    await chrome.storage.session.set({
      lastSend: { state: "error", text: `Chrome did not give access to ${ctx.domain}.` },
    });
    return;
  }
  await chrome.runtime.sendMessage({
    op: "send", tabId: ctx.tabId, url: ctx.url, domain: ctx.domain, box: ctx.box, user: ctx.user,
  });
}

function show(el, text, link) {
  el.replaceChildren(document.createTextNode(text));
  if (link) {
    const a = document.createElement("a");
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = " Open the login page.";
    el.append(a);
  }
}

async function start() {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const sendBtn = $("send");
  const domainSel = $("domain");
  const boxSel = $("box");
  const userSel = $("user");
  const userNote = $("user-note");
  let tab = null;

  const refreshSend = () => {
    sendBtn.disabled = !(tab && domainSel.value && boxSel.value && userSel.value);
  };
  const fill = (sel, values) => {
    sel.replaceChildren(...values.map((v) => Object.assign(document.createElement("option"), { value: v, textContent: v })));
  };

  const showLast = (last) => {
    if (last) show(status, last.text, last.link);
  };
  const { lastSend } = await chrome.storage.session.get("lastSend");
  showLast(lastSend);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.lastSend) showLast(changes.lastSend.newValue);
  });

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    const u = new URL(active?.url ?? "");
    if (u.protocol === "https:" || u.protocol === "http:") host = u.hostname;
  } catch {
    host = "";
  }
  const choices = host ? domainChoices(host) : [];
  if (choices.length === 0) {
    $("site-note").textContent = "Open the site you want to send in this tab first.";
  } else {
    tab = { tabId: active.id, url: active.url };
    fill(domainSel, choices);
    domainSel.value = await chooseDomain(chrome, active.id, host);
  }

  const { boxes = [] } = await chrome.storage.local.get("boxes");
  fill(boxSel, boxes);
  $("no-box").hidden = boxes.length > 0;
  $("add-box").addEventListener("click", () => chrome.runtime.openOptionsPage());

  async function loadUsers() {
    userNote.textContent = "";
    fill(userSel, []);
    refreshSend();
    if (!boxSel.value) return;
    const box = boxSel.value;
    const r = await fetchTargets(fetch, box);
    if (box !== boxSel.value) return;
    if (r.kind !== "ok") {
      show(userNote, r.text, r.link);
      return;
    }
    const withLogin = r.users.filter((u) => u.password_login);
    fill(userSel, withLogin.map((u) => u.name));
    if (withLogin.length < r.users.length) {
      show(userNote, `Log in to ${new URL(box).host} with your password first.`, box + "/login?next=/browser");
    }
    refreshSend();
  }
  boxSel.addEventListener("change", loadUsers);
  domainSel.addEventListener("change", refreshSend);
  userSel.addEventListener("change", refreshSend);
  await loadUsers();

  sendBtn.addEventListener("click", () => {
    sendBtn.disabled = true;
    onSendClick(chrome, {
      ...tab, domain: domainSel.value, box: boxSel.value, user: userSel.value,
    }).finally(refreshSend);
  });

  async function renderSites() {
    const list = $("sites");
    const granted = await chrome.permissions.getAll();
    const sites = readableSites(granted.origins ?? [], boxes);
    list.replaceChildren();
    $("no-sites").hidden = sites.length > 0;
    for (const origin of sites) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = origin;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Remove";
      btn.addEventListener("click", async () => {
        await chrome.permissions.remove({ origins: [origin] });
        await renderSites();
      });
      li.append(span, btn);
      list.append(li);
    }
  }
  await renderSites();
  refreshSend();
}

if (typeof document !== "undefined" && typeof chrome !== "undefined" && document.getElementById("send")) {
  start();
}
