"use strict";
const {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  Menu,
  dialog,
  shell,
  safeStorage,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  AI,
  defaults,
  settings: validateSettings,
  navigate,
  webURL,
  proxyConfig,
} = require("./policy.cjs");
const { Components, find, powershell, psLiteral } = require("./components.cjs");
const { ProfileStore, xrayConfig } = require("./profiles.cjs");
const { prepareUBlock, attachFilter } = require("./ublock.cjs");
const smoke = process.argv.includes("--smoke-test");
if (smoke)
  app.setPath(
    "userData",
    path.join(require("node:os").tmpdir(), `quiet-smoke-${process.pid}`),
  );
app.enableSandbox();
if (smoke)
  app.on("web-contents-created", (_event, wc) => {
    wc.on("console-message", (event) => {
      if (wc.getType() === "backgroundPage")
        console.log(
          "EXTENSION:",
          event.message,
          event.sourceId,
          event.lineNumber,
        );
    });
  });
for (const name of [
  "disable-background-networking",
  "disable-component-update",
  "disable-domain-reliability",
  "disable-sync",
  "no-pings",
  "disable-quic",
])
  app.commandLine.appendSwitch(name);
app.commandLine.appendSwitch(
  "force-webrtc-ip-handling-policy",
  "disable_non_proxied_udp",
);
app.commandLine.appendSwitch(
  "disable-features",
  "MediaRouter,OptimizationHints,AutofillServerCommunication,InterestFeedContentSuggestions,PreconnectToSearch,Prerender2",
);
let win,
  config,
  components,
  updateSession,
  configFile,
  componentRoot,
  profiles,
  coreProcess = null;
let tabs = [],
  activeId,
  nextId = 0,
  aiKey = null,
  overlay = false,
  changing = false,
  quitting = false;
let blocked = 0,
  toolStatus = "Компоненты готовы",
  torProcess = null;
const aiViews = new Map(),
  sessionInit = new Map(),
  sessions = new Set(),
  extensionState = new Map();
const prefs = (ses, preload) => ({
  session: ses,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  ...(preload ? { preload } : {}),
});
function snapshot() {
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      loading: t.loading,
      error: t.error,
      back: t.view?.webContents.navigationHistory.canGoBack() || false,
      forward: t.view?.webContents.navigationHistory.canGoForward() || false,
    })),
    activeId,
    config,
    aiKey,
    overlay,
    blocked,
    toolStatus,
    changing,
    blockerStatus: [...extensionState.values()],
  };
}
function emit() {
  if (win && !win.isDestroyed())
    win.webContents.send("quiet:state", snapshot());
}
function status(text) {
  toolStatus = text;
  emit();
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const side = aiKey
    ? Math.min(440, Math.max(320, Math.floor(width * 0.35)))
    : 0;
  for (const tab of tabs)
    if (tab.view) {
      tab.view.setVisible(!overlay && tab.id === activeId && !tab.error);
      tab.view.setBounds({
        x: 0,
        y: 116,
        width: Math.max(0, width - 60 - side),
        height: Math.max(0, height - 146),
      });
    }
  for (const [key, view] of aiViews) {
    view.setVisible(!overlay && key === aiKey);
    view.setBounds({
      x: width - 60 - side,
      y: 160,
      width: side,
      height: Math.max(0, height - 190),
    });
  }
  emit();
}
async function browserSession(name) {
  const tor = config.network.mode === "tor";
  const ses = session.fromPartition(
    `persist:quiet-${tor ? "tor-" : ""}${name}`,
  );
  if (sessionInit.has(ses)) return sessionInit.get(ses);
  const pending = initializeSession(ses, tor);
  sessionInit.set(ses, pending);
  return pending;
}
async function initializeSession(ses, tor) {
  sessions.add(ses);
  if (tor) {
    await ses.clearStorageData();
    await ses.clearCache();
  }
  await ses.setProxy(proxyConfig(config.network));
  ses.setPermissionCheckHandler(
    (_wc, permission) =>
      config.media &&
      config.network.mode !== "tor" &&
      ["media", "audioCapture", "videoCapture"].includes(permission),
  );
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (
      !config.media ||
      config.network.mode === "tor" ||
      permission !== "media" ||
      !wc ||
      wc.isDestroyed()
    )
      return callback(false);
    const origin = new URL(wc.getURL()).origin;
    const result = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Запретить", "Разрешить сейчас"],
      defaultId: 0,
      cancelId: 0,
      message: `${origin} запрашивает камеру/микрофон`,
      detail: (details.mediaTypes || []).join(", "),
    });
    callback(
      result.response === 1 &&
        !wc.isDestroyed() &&
        new URL(wc.getURL()).origin === origin,
    );
  });
  ses.setDevicePermissionHandler(() => false);
  ses.removeAllListeners("will-download");
  ses.on("will-download", async (_event, item) => {
    if (config.network.mode === "tor") {
      item.cancel();
      status("Загрузки в Tor отключены. Открытый файл может раскрыть IP.");
      return;
    }
    item.pause();
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(
        app.getPath("downloads"),
        path.basename(item.getFilename()),
      ),
    });
    if (result.canceled || !result.filePath) item.cancel();
    else {
      item.setSavePath(result.filePath);
      item.resume();
    }
  });
  if (config.blocker) {
    try {
      const manifest = await components.locate("ublock", "manifest.json");
      if (!manifest) throw Error("пакет отсутствует");
      await prepareUBlock(path.dirname(manifest));
      const ext = await ses.extensions.loadExtension(path.dirname(manifest), {
        allowFileAccess: false,
      });
      await attachFilter(ses, ext.id, () => {
        blocked++;
        emit();
      });
      extensionState.set(ses, `uBlock Origin ${ext.version}`);
    } catch (e) {
      extensionState.set(ses, `uBlock не загружен: ${e.message}`);
    }
  } else extensionState.set(ses, "Блокировщик отключён");
  return ses;
}
function secureView(view) {
  const wc = view.webContents;
  wc.on(
    "did-frame-navigate",
    (
      _event,
      url,
      _httpResponseCode,
      _httpStatusText,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      const details = {
        tabId: wc.id,
        frameId: isMainFrame ? 0 : frameRoutingId,
        parentFrameId: isMainFrame ? -1 : 0,
        url,
        timeStamp: Date.now(),
        transitionType: "link",
      };
      const { webContents } = require("electron");
      for (const bg of webContents
        .getAllWebContents()
        .filter(
          (w) => w.getType() === "backgroundPage" && w.session === wc.session,
        ))
        bg.executeJavaScript(
          `globalThis.__quietNavigation?.('onCommitted',${JSON.stringify(details)})`,
        ).catch(() => {});
    },
  );
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  const guard = (event, url) => {
    try {
      webURL(url, config.network.mode === "tor");
    } catch {
      event.preventDefault();
    }
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.on("will-frame-navigate", (event, details) => {
    const url =
      typeof details === "string" ? details : details?.url || event.url;
    if (url) guard(event, url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    try {
      webURL(url, config.network.mode === "tor");
      void newTab(url).catch((e) => status(e.message));
    } catch {}
    return { action: "deny" };
  });
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if ((input.control || input.meta) && input.key.toLowerCase() === "l") {
      event.preventDefault();
      win.webContents.focus();
      win.webContents.send("quiet:focus-address");
    }
    if ((input.control || input.meta) && input.key.toLowerCase() === "t") {
      event.preventDefault();
      void newTab();
    }
    if ((input.control || input.meta) && input.key.toLowerCase() === "w") {
      event.preventDefault();
      void closeTab(activeId);
    }
    if (input.key === "F12" && config.developer) {
      event.preventDefault();
      wc.openDevTools({ mode: "detach" });
    }
  });
  wc.on("context-menu", (_e, p) => {
    const template = [
      { role: "copy", enabled: !!p.selectionText },
      { role: "paste", enabled: p.isEditable },
    ];
    if (p.linkURL)
      template.push({
        label: "Открыть ссылку в новой вкладке",
        click: () => void newTab(p.linkURL).catch((e) => status(e.message)),
      });
    if (config.developer)
      template.push({
        label: "Исследовать элемент",
        click: () => wc.inspectElement(p.x, p.y),
      });
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
async function newTab(input = "") {
  if (changing) throw Error("Дождись смены сети");
  if (tabs.length >= 40) throw Error("Лимит: 40 вкладок");
  const tab = {
    id: ++nextId,
    title: "Новая вкладка",
    url: "quiet:home",
    loading: false,
    error: "",
    view: null,
  };
  tabs.push(tab);
  activeId = tab.id;
  if (input) await loadTab(tab, input);
  layout();
  return tab;
}
async function loadTab(tab, input) {
  const search = config.engines.find((e) => e.id === config.search);
  const url = navigate(input, search, config.network.mode === "tor");
  tab.error = "";
  if (url === "quiet:home") {
    if (tab.view) {
      win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
      tab.view = null;
    }
    tab.url = url;
    tab.title = "Новая вкладка";
    tab.loading = false;
    layout();
    return;
  }
  if (!tab.view) {
    tab.view = new WebContentsView({
      webPreferences: prefs(await browserSession("web")),
    });
    secureView(tab.view);
    win.contentView.addChildView(tab.view);
    const wc = tab.view.webContents;
    wc.on("did-start-loading", () => {
      tab.loading = true;
      emit();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      emit();
    });
    wc.on("page-title-updated", (_e, title) => {
      tab.title = title.slice(0, 180);
      emit();
    });
    const nav = (_e, value) => {
      tab.url = value;
      tab.error = "";
      emit();
    };
    wc.on("did-navigate", nav);
    wc.on("did-navigate-in-page", nav);
    wc.on("did-fail-load", (_e, code, desc, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        tab.error = `${desc} (${code})`;
        tab.loading = false;
        layout();
      }
    });
    wc.on("render-process-gone", () => {
      tab.error = "Процесс страницы завершён. Перезагрузи вкладку.";
      layout();
    });
  }
  tab.url = url;
  tab.loading = true;
  tab.title = new URL(url).hostname;
  layout();
  tab.view.webContents.loadURL(url).catch((e) => {
    if (e.code !== "ERR_ABORTED") {
      tab.error = e.message;
      tab.loading = false;
      layout();
    }
  });
}
async function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = tabs.splice(i, 1);
  if (tab.view) {
    win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  }
  if (id === activeId) activeId = tabs[Math.min(i, tabs.length - 1)]?.id;
  if (!tabs.length && !changing && !quitting) await newTab();
  layout();
}
async function showAI(key) {
  if (!key || key === aiKey) {
    aiKey = null;
    layout();
    return;
  }
  if (!AI[key]) throw Error("Неизвестный AI");
  if (!aiViews.has(key)) {
    const view = new WebContentsView({
      webPreferences: prefs(await browserSession(`ai-${key}`)),
    });
    secureView(view);
    win.contentView.addChildView(view);
    aiViews.set(key, view);
    view.webContents.on("did-fail-load", (_e, code, desc, _url, main) => {
      if (main && code !== -3)
        status(
          `${AI[key][0]}: ${desc}. Можно открыть сайт отдельной вкладкой.`,
        );
    });
    view.webContents.loadURL(AI[key][1]).catch(() => {});
  }
  aiKey = key;
  layout();
}
async function closeViews() {
  for (const tab of [...tabs]) await closeTab(tab.id);
  for (const view of aiViews.values()) {
    win.contentView.removeChildView(view);
    view.webContents.close();
  }
  aiViews.clear();
  aiKey = null;
  for (const ses of sessions) {
    await ses.closeAllConnections();
    ses.webRequest.onBeforeRequest(null);
    for (const ext of ses.extensions.getAllExtensions())
      ses.extensions.removeExtension(ext.id);
  }
  sessions.clear();
  sessionInit.clear();
  extensionState.clear();
}
async function clearTor() {
  for (const name of ["web", ...Object.keys(AI).map((k) => `ai-${k}`)]) {
    const ses = session.fromPartition(`persist:quiet-tor-${name}`);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.closeAllConnections();
  }
}
async function saveConfig(value) {
  if (changing) throw Error("Настройки уже применяются");
  const next = validateSettings(value);
  if (next.network.mode === "profile") {
    const p = profiles.get(next.network.profileId);
    next.network.kind = p.kind;
  }
  changing = true;
  emit();
  try {
    await closeViews();
    await updateSession.closeAllConnections();
    if (config.network.mode === "tor") await clearTor();
    config = next;
    await updateSession.setProxy(proxyConfig(config.network));
    const tmp = configFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(config, null, 2));
    await fs.rename(tmp, configFile);
    if (config.network.mode === "tor") await startTor();
    else if (torProcess) {
      torProcess.kill();
      torProcess = null;
    }
    if (coreProcess) {
      const old = coreProcess;
      coreProcess = null;
      if (old.exitCode === null) {
        const exited = new Promise((resolve) => old.once("exit", resolve));
        old.kill();
        await exited;
      }
    }
    if (config.network.mode === "profile") await startCore();
    status("Настройки применены. Открыта чистая вкладка.");
  } finally {
    changing = false;
    await newTab();
    layout();
  }
}
async function startTor() {
  if (torProcess && torProcess.exitCode === null) return;
  const exe = await components.locate("tor", "tor.exe");
  if (!exe)
    throw Error("Tor не установлен. Обнови компоненты в обычном режиме.");
  const data = path.join(app.getPath("userData"), "tor-data");
  await fs.mkdir(data, { recursive: true });
  torProcess = spawn(
    exe,
    [
      "--SocksPort",
      "127.0.0.1:19050",
      "--DataDirectory",
      data,
      "--ClientOnly",
      "1",
      "--AvoidDiskWrites",
      "1",
      "--Log",
      "notice stdout",
    ],
    {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  torProcess.on("error", (e) => {
    status(`Tor: ${e.message}. Прямого подключения нет.`);
    torProcess = null;
  });
  torProcess.stdout.on("data", (data) => {
    const match = data.toString().match(/Bootstrapped \d+%[^\r\n]*/);
    if (match) status("Tor: " + match[0]);
  });
  torProcess.on("exit", () => {
    torProcess = null;
    status("Tor остановлен. Прямого подключения нет.");
  });
  status("Tor запускается. Дождись Bootstrapped 100%.");
}
async function startCore() {
  const profile = profiles.get(config.network.profileId);
  const exe =
    profile.kind === "awg"
      ? path.join(componentRoot, "awg", "quiet-awg.exe")
      : await components.locate("xray", "xray.exe");
  if (!exe) throw Error("Сетевое ядро отсутствует");
  await fs.access(exe);
  const child = spawn(
    exe,
    profile.kind === "awg" ? [] : ["run", "-config", "stdin:"],
    {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  coreProcess = child;
  child.stdin.on("error", () => {});
  child.on("error", () =>
    status("Сетевое ядро не запустилось. Прямого подключения нет."),
  );
  child.on("exit", () => {
    if (coreProcess === child) {
      coreProcess = null;
      status("VPN-ядро остановлено. Прямого подключения нет.");
    }
  });
  if (profile.kind === "awg")
    child.stdin.write(JSON.stringify({ config: profile.payload }) + "\n");
  else child.stdin.end(JSON.stringify(xrayConfig(profile.payload)));
  // Never relay core logs: providers can include credentials in diagnostic output.
  child.stdout.on("data", (data) => {
    if (profile.kind === "awg" && data.toString().includes("READY"))
      status(
        "AmneziaWG: локальный прокси готов. Подключение проверяется загрузкой страницы.",
      );
  });
  child.stderr.resume();
  status(
    `${profile.kind === "awg" ? "AmneziaWG" : "Xray"} запущен. Только браузер, без системного TUN. Доступность сервера ещё не проверена.`,
  );
}
async function zapretProfiles() {
  const exe = await components.locate("zapret", "winws.exe");
  if (!exe) return [];
  const dir = path.dirname(path.dirname(exe));
  return (await fs.readdir(dir)).filter((name) =>
    /^general[^/\\]*\.bat$/i.test(name),
  );
}
async function startZapret() {
  const exe = await components.locate("zapret", "winws.exe");
  if (!exe) throw Error("Пакет zapret отсутствует");
  const root = path.dirname(path.dirname(exe));
  const profiles = await zapretProfiles();
  if (!profiles.includes(config.zapretProfile))
    throw Error("Выбери существующую стратегию zapret");
  const file = path.join(root, config.zapretProfile);
  // Batch paths never enter cmd.exe string interpolation. Windows opens the selected official script.
  const result = await shell.openPath(file);
  if (result) throw Error(result);
  status(
    "Профиль zapret запущен. Статус обхода проверяется доступностью сайтов; возможен запрос UAC.",
  );
}
async function updateComponents() {
  if (config.network.mode === "tor")
    throw Error(
      "В Tor фоновые обновления отключены. Выбери обычный маршрут для обновления.",
    );
  await components.update();
  status(
    "Компоненты обновлены. Перезапусти браузер для применения. AmneziaWG обновляется вместе со сборкой браузера.",
  );
}
async function command(action, data) {
  if (changing) throw Error("Дождись смены сети");
  const tab = tabs.find((t) => t.id === activeId);
  switch (action) {
    case "state":
      return snapshot();
    case "new":
      await newTab(data || "");
      break;
    case "navigate":
      await loadTab(tab, data);
      break;
    case "activate":
      if (tabs.some((t) => t.id === data)) {
        activeId = data;
        layout();
      }
      break;
    case "close":
      await closeTab(data);
      break;
    case "back":
      if (tab?.view?.webContents.navigationHistory.canGoBack())
        tab.view.webContents.navigationHistory.goBack();
      break;
    case "forward":
      if (tab?.view?.webContents.navigationHistory.canGoForward())
        tab.view.webContents.navigationHistory.goForward();
      break;
    case "reload":
      if (tab) await loadTab(tab, tab.url);
      break;
    case "stop":
      tab?.view?.webContents.stop();
      break;
    case "home":
      await loadTab(tab, "quiet:home");
      break;
    case "ai":
      await showAI(data);
      break;
    case "ai-tab":
      if (aiKey) await newTab(AI[aiKey][1]);
      break;
    case "overlay":
      overlay = !!data;
      layout();
      break;
    case "save":
      await saveConfig(data);
      break;
    case "clear":
      changing = true;
      try {
        await closeViews();
        for (const ses of session.getAllSessions?.() || []) {
          await ses.clearStorageData();
          await ses.clearCache();
        }
        for (const name of ["web", ...Object.keys(AI).map((k) => `ai-${k}`)]) {
          const ses = session.fromPartition(`persist:quiet-${name}`);
          await ses.clearStorageData();
          await ses.clearCache();
        }
        await clearTor();
        status("Cookies и кэш удалены.");
      } finally {
        changing = false;
        await newTab();
      }
      break;
    case "devtools":
      if (!config.developer) throw Error("Включи режим разработки");
      tab?.view?.webContents.openDevTools({ mode: "detach" });
      break;
    case "update":
      await updateComponents();
      break;
    case "components":
      return {
        manifest: await components.manifest(),
        profiles: await zapretProfiles(),
      };
    case "profiles":
      return profiles.list();
    case "import-profile":
      return profiles.import(data?.name || "", data?.text);
    case "delete-profile":
      if (
        config.network.mode === "profile" &&
        config.network.profileId === data
      )
        throw Error("Сначала отключи этот профиль");
      return profiles.remove(data);
    case "connect-profile": {
      const p = profiles.get(data);
      await saveConfig({
        ...config,
        network: { mode: "profile", profileId: p.id, kind: p.kind },
      });
      break;
    }
    case "zapret":
      await startZapret();
      break;
    case "ublock": {
      const ses = await browserSession("web");
      const ext = ses.extensions
        .getAllExtensions()
        .find((e) => /uBlock Origin/i.test(e.name));
      if (!ext) throw Error("uBlock не загружен");
      const popup = new BrowserWindow({
        width: 750,
        height: 700,
        parent: win,
        webPreferences: prefs(ses),
      });
      await popup.loadURL(`chrome-extension://${ext.id}/dashboard.html`);
      break;
    }
    default:
      throw Error("Неизвестная команда");
  }
  return snapshot();
}
async function boot() {
  configFile = path.join(app.getPath("userData"), "settings.json");
  try {
    config = validateSettings(
      JSON.parse(await fs.readFile(configFile, "utf8")),
    );
  } catch {
    config = defaults();
  }
  profiles = new ProfileStore(
    path.join(app.getPath("userData"), "profiles.encrypted"),
    safeStorage,
  );
  await profiles.load();
  if (smoke) config.autoUpdate = false;
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "components")
    : path.join(__dirname, "../components");
  componentRoot = app.isPackaged
    ? path.join(app.getPath("userData"), "components")
    : bundled;
  if (app.isPackaged) {
    try {
      await fs.access(path.join(componentRoot, "manifest.json"));
    } catch {
      await fs.cp(bundled, componentRoot, { recursive: true });
    }
  }
  updateSession = session.fromPartition("quiet-updates");
  await updateSession.setProxy(proxyConfig(config.network));
  components = new Components(
    componentRoot,
    (url, options) => updateSession.fetch(url, options),
    status,
  );
  win = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: "#0e1016",
    title: "Quiet Browser",
    autoHideMenuBar: true,
    show: !smoke,
    webPreferences: prefs(
      session.fromPartition("quiet-ui"),
      path.join(__dirname, "preload.cjs"),
    ),
  });
  Menu.setApplicationMenu(null);
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) =>
    cb(false),
  );
  let ipcQueue = Promise.resolve();
  ipcMain.handle("quiet:command", async (event, action, data) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !==
        pathToFileURL(path.join(__dirname, "ui/index.html")).href
    )
      return { ok: false, error: "Forbidden" };
    const execute = async () => {
      try {
        return { ok: true, value: await command(action, data) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };
    if (
      ["state", "overlay", "components", "profiles", "update"].includes(action)
    )
      return execute();
    const pending = ipcQueue.then(execute);
    ipcQueue = pending.then(() => {});
    return pending;
  });
  win.on("resize", layout);
  await win.loadFile(path.join(__dirname, "ui/index.html"));
  await newTab();
  if (config.network.mode === "tor") {
    try {
      await startTor();
    } catch (e) {
      status(e.message);
    }
  }
  if (config.network.mode === "profile") {
    try {
      await startCore();
    } catch (e) {
      status(e.message);
    }
  }
  if (!smoke && config.autoZapret)
    startZapret().catch((e) => status(e.message));
  if (!smoke && config.autoUpdate && config.network.mode !== "tor") {
    const timer = setTimeout(async () => {
      try {
        let checkedAt = 0;
        try {
          checkedAt =
            JSON.parse(
              await fs.readFile(
                path.join(componentRoot, "update-state.json"),
                "utf8",
              ),
            ).checkedAt || 0;
        } catch {}
        if (Date.now() - checkedAt > 86400000) await updateComponents();
      } catch (e) {
        status(e.message);
      }
    }, 15000);
    timer.unref();
  }
  if (smoke)
    await require("../test/smoke.cjs")({
      app,
      win,
      command,
      browserSession,
      snapshot,
      components,
      getTab: () => tabs.find((t) => t.id === activeId),
      layout,
    });
}
app
  .whenReady()
  .then(boot)
  .catch((e) => {
    console.error(e);
    if (!smoke) dialog.showErrorBox("Quiet Browser", e.message);
    app.exit(1);
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  changing = true;
  Promise.resolve()
    .then(async () => {
      if (torProcess) torProcess.kill();
      if (coreProcess) coreProcess.kill();
      if (win && !win.isDestroyed()) await closeViews();
      await clearTor();
    })
    .catch(console.error)
    .finally(() => app.quit());
});
