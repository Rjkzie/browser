"use strict";
const $ = (id) => document.getElementById(id);
let state,
  draft,
  toastTimer,
  profiles = [],
  editing = false;
const names = {
  perplexity: "Perplexity",
  gpt: "ChatGPT",
  deepseek: "DeepSeek",
  qwen: "Qwen",
};
const routes = {
  direct: "Прямое",
  system: "Системный прокси",
  socks5: "SOCKS5",
  http: "HTTP-прокси",
  tor: "Tor",
  profile: "VPN · только браузер",
};
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 9000);
}
async function cmd(action, data) {
  const result = await window.quiet.command(action, data);
  if (!result.ok) {
    toast(result.error);
    return null;
  }
  return result.value;
}
function button(text, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.onclick = action;
  return b;
}
function render(value) {
  state = value;
  const tab = state.tabs.find((t) => t.id === state.activeId);
  $("tabs").replaceChildren();
  for (const t of state.tabs) {
    const node = document.createElement("div");
    node.className = "tab" + (t.id === state.activeId ? " active" : "");
    node.setAttribute("role", "tab");
    node.setAttribute("aria-selected", String(t.id === state.activeId));
    node.tabIndex = t.id === state.activeId ? 0 : -1;
    node.onclick = () => cmd("activate", t.id);
    node.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") cmd("activate", t.id);
    };
    const icon = document.createElement("span");
    icon.className = "tab-icon";
    icon.textContent = t.loading ? "◌" : "◈";
    const label = document.createElement("span");
    label.className = "tab-title";
    label.textContent = t.title;
    label.title = t.title;
    const close = button("×", (e) => {});
    close.className = "tab-close";
    close.setAttribute("aria-label", "Закрыть " + t.title);
    close.onclick = (e) => {
      e.stopPropagation();
      cmd("close", t.id);
    };
    node.append(icon, label, close);
    $("tabs").append(node);
  }
  if (document.activeElement !== $("address"))
    $("address").value = tab?.url === "quiet:home" ? "" : tab?.url || "";
  $("home").hidden = tab?.url !== "quiet:home" || !!tab?.error;
  $("page-error").hidden = !tab?.error;
  $("page-error-text").textContent = tab?.error || "";
  $("back").disabled = !tab?.back;
  $("forward").disabled = !tab?.forward;
  $("reload").textContent = tab?.loading ? "×" : "↻";
  $("route").textContent = routes[state.config.network.mode] || "Маршрут";
  $("engine-name").textContent =
    state.config.engines.find((e) => e.id === state.config.search)?.name || "";
  $("status").textContent = state.toolStatus;
  $("tool-output").textContent = state.toolStatus;
  $("privacy-status").textContent = state.blockerStatus.length
    ? [...new Set(state.blockerStatus)].join(" · ")
    : "uBlock Origin · проверка при открытии сайта";
  document.body.classList.toggle("ai-open", !!state.aiKey);
  $("ai-panel").hidden = !state.aiKey;
  const side = state.aiKey
    ? Math.min(440, Math.max(320, Math.floor(innerWidth * 0.35)))
    : 0;
  $("ai-panel").style.width = side + "px";
  $("home").style.width = `calc(100% - ${side}px)`;
  $("ai-title").textContent = names[state.aiKey] || "AI";
  document
    .querySelectorAll("[data-ai]")
    .forEach((b) => b.classList.toggle("active", b.dataset.ai === state.aiKey));
  $("save-settings").disabled = state.changing;
}
function renderEngines() {
  const select = $("default-engine");
  select.replaceChildren();
  $("engine-list").replaceChildren();
  for (const e of draft.engines) {
    const option = document.createElement("option");
    option.value = e.id;
    option.textContent = e.name;
    select.append(option);
    const row = document.createElement("div");
    row.className = "engine-row";
    const info = document.createElement("div");
    info.textContent = e.name;
    const url = document.createElement("small");
    url.textContent = e.url;
    info.append(url);
    const remove = button("Удалить", () => {
      if (draft.engines.length === 1)
        return toast("Нужен хотя бы один поисковик");
      draft.engines = draft.engines.filter((x) => x.id !== e.id);
      if (draft.search === e.id) draft.search = draft.engines[0].id;
      renderEngines();
    });
    row.append(info, remove);
    $("engine-list").append(row);
  }
  select.value = draft.search;
}
function section(name) {
  document
    .querySelectorAll("[data-page]")
    .forEach((e) => (e.hidden = e.dataset.page !== name));
  document
    .querySelectorAll("[data-section]")
    .forEach((e) => e.classList.toggle("selected", e.dataset.section === name));
}
async function refreshComponents() {
  const data = await cmd("components");
  if (!data) return;
  $("component-list").replaceChildren();
  for (const id of ["xray", "awg", "tor", "zapret", "ublock"]) {
    const row = document.createElement("div");
    row.className = "component-row";
    const label = document.createElement("span");
    label.textContent = {
      xray: "Xray · профили Happ",
      awg: "AmneziaWG · userspace",
      tor: "Tor",
      zapret: "zapret",
      ublock: "uBlock Origin",
    }[id];
    const version = document.createElement("strong");
    version.textContent = data.manifest[id]?.version || "Не установлен";
    row.append(label, version);
    $("component-list").append(row);
  }
  $("zapret-profile").replaceChildren();
  for (const p of data.profiles) {
    const option = document.createElement("option");
    option.textContent = p;
    option.value = p;
    $("zapret-profile").append(option);
  }
  $("zapret-profile").value = draft?.zapretProfile || "general.bat";
}
async function refreshProfiles() {
  const data = await cmd("profiles");
  if (!data) return;
  profiles = data;
  $("profile-list").replaceChildren();
  for (const p of profiles) {
    const row = document.createElement("div");
    row.className = "profile-row";
    const info = document.createElement("div");
    info.textContent = p.name;
    const type = document.createElement("small");
    type.textContent = p.kind === "awg" ? "AmneziaWG / WireGuard" : "Xray";
    info.append(type);
    row.append(
      info,
      button("Подключить", async () => {
        const result = await cmd("connect-profile", p.id);
        if (result) {
          draft = structuredClone(state.config);
          $("network-mode").value = "profile";
          toast("Профиль выбран. Состояние соединения — внизу окна.");
        }
      }),
      button("Удалить", async () => {
        await cmd("delete-profile", p.id);
        await refreshProfiles();
      }),
    );
    $("profile-list").append(row);
  }
}
async function openSettings(page = "search") {
  draft = structuredClone(state.config);
  editing = true;
  await cmd("overlay", true);
  $("settings-dialog").showModal();
  section(page);
  renderEngines();
  $("network-mode").value = draft.network.mode;
  $("proxy-host").value = draft.network.host;
  $("proxy-port").value = draft.network.port;
  $("blocker-enabled").checked = draft.blocker;
  $("media-enabled").checked = draft.media;
  $("developer-enabled").checked = draft.developer;
  $("auto-update").checked = draft.autoUpdate;
  $("auto-zapret").checked = draft.autoZapret;
  proxyFields();
  await refreshComponents();
  await refreshProfiles();
}
function closeSettings() {
  $("settings-dialog").close();
  editing = false;
  $("profile-input").value = "";
  cmd("overlay", false);
}
function proxyFields() {
  $("proxy-fields").hidden = !["socks5", "http"].includes(
    $("network-mode").value,
  );
}
async function submit(input) {
  if (await cmd("navigate", input)) {
    document.activeElement?.blur();
  }
}
window.quiet.onState(render);
window.quiet.onFocusAddress(() => {
  $("address").focus();
  $("address").select();
});
cmd("state").then((s) => s && render(s));
$("address-form").onsubmit = (e) => {
  e.preventDefault();
  submit($("address").value);
};
$("home-search").onsubmit = (e) => {
  e.preventDefault();
  submit($("search-input").value);
};
$("new-tab").onclick = () => cmd("new");
$("back").onclick = () => cmd("back");
$("forward").onclick = () => cmd("forward");
$("reload").onclick = () =>
  cmd(
    state.tabs.find((t) => t.id === state.activeId)?.loading
      ? "stop"
      : "reload",
  );
$("retry").onclick = () => cmd("reload");
document
  .querySelectorAll("[data-url]")
  .forEach((b) => (b.onclick = () => submit(b.dataset.url)));
document
  .querySelectorAll("[data-ai]")
  .forEach((b) => (b.onclick = () => cmd("ai", b.dataset.ai)));
$("ai-close").onclick = () => cmd("ai", null);
$("ai-tab").onclick = () => cmd("ai-tab");
$("settings").onclick = () => openSettings();
$("route").onclick = () => openSettings("network");
$("network").onclick = () => openSettings("network");
$("choose-search").onclick = () => openSettings();
$("developer").onclick = () => cmd("devtools");
$("blocker").onclick = () => cmd("ublock");
$("close-settings").onclick = closeSettings;
$("settings-dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeSettings();
});
document
  .querySelectorAll("[data-section]")
  .forEach((b) => (b.onclick = () => section(b.dataset.section)));
$("network-mode").onchange = proxyFields;
$("default-engine").onchange = () => (draft.search = $("default-engine").value);
$("add-engine").onclick = () => {
  const name = $("engine-label").value.trim(),
    url = $("engine-template").value.trim();
  if (!name || !url.includes("{query}"))
    return toast("Нужны название и URL с {query}");
  try {
    const u = new URL(url.replaceAll("{query}", "test"));
    if (!["https:", "http:"].includes(u.protocol)) throw Error();
  } catch {
    return toast("Некорректный URL");
  }
  draft.engines.push({ id: crypto.randomUUID(), name, url });
  $("engine-label").value = "";
  $("engine-template").value = "";
  renderEngines();
};
$("save-settings").onclick = async () => {
  draft.search = $("default-engine").value;
  draft.network = {
    ...draft.network,
    mode: $("network-mode").value,
    host: $("proxy-host").value,
    port: Number($("proxy-port").value),
  };
  draft.blocker = $("blocker-enabled").checked;
  draft.media = $("media-enabled").checked;
  draft.developer = $("developer-enabled").checked;
  draft.autoUpdate = $("auto-update").checked;
  draft.autoZapret = $("auto-zapret").checked;
  draft.zapretProfile = $("zapret-profile").value || "general.bat";
  if (await cmd("save", draft)) closeSettings();
};
$("clear-data").onclick = async () => {
  if (confirm("Закрыть вкладки и удалить cookies и кэш?")) await cmd("clear");
};
$("update-components").onclick = async () => {
  const b = $("update-components");
  b.disabled = true;
  try {
    await cmd("update");
    await refreshComponents();
  } finally {
    b.disabled = false;
  }
};
$("launch-zapret").onclick = async () => {
  if (draft.zapretProfile !== $("zapret-profile").value) {
    draft.zapretProfile = $("zapret-profile").value;
    if (!(await cmd("save", draft))) return;
  }
  await cmd("zapret");
};
$("import-profile").onclick = async () => {
  const result = await cmd("import-profile", {
    name: $("profile-name").value,
    text: $("profile-input").value,
  });
  if (result) {
    $("profile-input").value = "";
    $("profile-name").value = "";
    await refreshProfiles();
    toast("Профиль сохранён с шифрованием Windows");
  }
};
window.addEventListener("resize", () => state && render(state));
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
    e.preventDefault();
    $("address").focus();
    $("address").select();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t" && !editing) {
    e.preventDefault();
    cmd("new");
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && !editing) {
    e.preventDefault();
    cmd("close", state.activeId);
  }
});
