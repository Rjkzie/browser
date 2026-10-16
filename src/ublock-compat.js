/* Quiet Browser compatibility glue. MIT. Runs only in the bundled uBO background page.
 * uBlock Origin itself remains GPL-3.0-or-later, unmodified JavaScript sources.
 * Navigation events are delivered by the host. Host owns privacy policy.
 */
(() => {
  if (globalThis.browser instanceof Object)
    globalThis.chrome = globalThis.browser;
  else globalThis.browser = globalThis.chrome;
  const event = () => {
    const listeners = new Set();
    return {
      addListener: (f) => listeners.add(f),
      removeListener: (f) => listeners.delete(f),
      hasListener: (f) => listeners.has(f),
      emit: (...args) => {
        for (const f of listeners)
          try {
            f(...args);
          } catch (e) {
            console.error(e);
          }
      },
    };
  };
  const events = {};
  chrome.webNavigation ||= {};
  for (const name of [
    "onCreatedNavigationTarget",
    "onCommitted",
    "onDOMContentLoaded",
    "onCompleted",
    "onHistoryStateUpdated",
    "onReferenceFragmentUpdated",
  ]) {
    chrome.webNavigation[name] ||= event();
    events[name] = chrome.webNavigation[name];
  }
  const frames = new Map();
  globalThis.__quietNavigation = (name, details) => {
    if (name === "onCommitted")
      frames.set(details.tabId, [{ ...details, parentFrameId: -1 }]);
    events[name]?.emit(details);
  };
  chrome.webNavigation.getAllFrames ||= (details, cb) =>
    cb?.(frames.get(details.tabId) || []);
  chrome.webNavigation.getFrame ||= (details, cb) =>
    cb?.(
      (frames.get(details.tabId) || []).find(
        (f) => f.frameId === details.frameId,
      ) || null,
    );
  chrome.contextMenus ||= {
    onClicked: event(),
    create: (_p, cb) => {
      cb?.();
      return "quiet-menu";
    },
    remove: (_id, cb) => cb?.(),
    removeAll: (cb) => cb?.(),
  };
  chrome.browserAction ||= {
    onClicked: event(),
    setBadgeBackgroundColor: (_v, cb) => cb?.(),
    setBadgeText: (_v, cb) => cb?.(),
    setIcon: (_v, cb) => cb?.(),
    setTitle: (_v, cb) => cb?.(),
  };
  chrome.privacy ||= { network: {}, services: {}, websites: {} };
  for (const [category, name, value] of [
    ["network", "networkPredictionEnabled", false],
    ["network", "webRTCIPHandlingPolicy", "disable_non_proxied_udp"],
    ["websites", "hyperlinkAuditingEnabled", false],
  ]) {
    chrome.privacy[category] ||= {};
    chrome.privacy[category][name] ||= {
      get: (_details, cb) =>
        cb?.({ value, levelOfControl: "not_controllable" }),
      set: (_details, cb) => cb?.(),
      clear: (_details, cb) => cb?.(),
    };
  }
  chrome.windows ||= {
    WINDOW_ID_NONE: -1,
    onFocusChanged: event(),
    get: (id, _details, cb) => {
      if (typeof _details === "function") cb = _details;
      cb?.({ id, focused: true });
    },
    create: (details, cb) => {
      window.open(details.url);
      cb?.();
    },
    update: (id, _details, cb) => cb?.({ id }),
  };
  if (!chrome.alarms) {
    const alarms = new Map();
    chrome.alarms = {
      onAlarm: event(),
      create(name, details, cb) {
        const delay = Math.max(
          1000,
          details.when
            ? details.when - Date.now()
            : (details.delayInMinutes || 1) * 60000,
        );
        const timer = setTimeout(() => {
          alarms.delete(name);
          chrome.alarms.onAlarm.emit({ name, scheduledTime: Date.now() });
        }, delay);
        alarms.set(name, { timer, name, scheduledTime: Date.now() + delay });
        cb?.();
      },
      clear(name, cb) {
        clearTimeout(alarms.get(name)?.timer);
        cb?.(alarms.delete(name));
      },
      clearAll(cb) {
        for (const a of alarms.values()) clearTimeout(a.timer);
        alarms.clear();
        cb?.(true);
      },
      get(name, cb) {
        cb?.(alarms.get(name));
      },
      getAll(cb) {
        cb?.(
          [...alarms.values()].map(({ name, scheduledTime }) => ({
            name,
            scheduledTime,
          })),
        );
      },
    };
  }
  chrome.tabs.get ||= (id, cb) =>
    chrome.tabs.query({}, (tabs) => cb(tabs.find((t) => t.id === id)));
  chrome.tabs.getCurrent ||= (cb) =>
    chrome.tabs.query({ active: true }, (tabs) => cb(tabs[0]));
  chrome.tabs.create ||= (details, cb) => {
    window.open(details.url);
    cb?.();
  };
  chrome.tabs.remove ||= (_id, cb) => cb?.();
  chrome.tabs.insertCSS ||= (_id, _details, cb) => cb?.();
  chrome.tabs.onCreated ||= event();
})();
