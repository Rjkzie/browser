const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error("Performance fixture timeout");
}
async function chromeBenchmark(base, userData) {
  const candidates = [
    process.env.QUIET_CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  let exe;
  for (const p of candidates) {
    try {
      await fs.access(p);
      exe = p;
      break;
    } catch {}
  }
  if (!exe) return { available: false };
  const dir = path.join(userData, "chrome-comparison");
  await fs.mkdir(dir, { recursive: true });
  const child = spawn(
    exe,
    [
      "--headless=new",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${dir}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  let socket;
  try {
    let info;
    await until(async () => {
      try {
        info = (await fs.readFile(path.join(dir, "DevToolsActivePort"), "utf8"))
          .trim()
          .split("\n");
        return info.length === 2;
      } catch {
        return false;
      }
    });
    socket = new WebSocket(`ws://127.0.0.1:${info[0]}${info[1]}`);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let seq = 0;
    const pending = new Map(),
      listeners = new Set();
    socket.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = pending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(m.id);
          m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
        }
      } else for (const f of listeners) f(m);
    };
    const call = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Chrome CDP timeout: " + method));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      });
    const { targetId } = await call("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await call("Page.enable", {}, sessionId);
    const navigate = async (url) => {
      const t = performance.now();
      const loaded = new Promise((resolve) => {
        const on = (m) => {
          if (m.method === "Page.loadEventFired" && m.sessionId === sessionId) {
            listeners.delete(on);
            resolve();
          }
        };
        listeners.add(on);
      });
      await call("Page.navigate", { url }, sessionId);
      await loaded;
      return performance.now() - t;
    };
    const samples = [];
    await navigate(base + "/heavy");
    for (let i = 0; i < 5; i++)
      samples.push(await navigate(base + "/heavy?sample=" + i));
    const version = await call("Browser.getVersion");
    await call("Browser.close");
    return {
      available: true,
      version: version.product,
      heavySamplesMs: samples,
      heavyMedianMs: median(samples),
    };
  } finally {
    socket?.close();
    child.kill();
  }
}
module.exports = async ({ app, win, command, snapshot, getTab, startupMs }) => {
  let resourceHits = 0;
  const count = 160;
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "public,max-age=3600");
    if (req.url.startsWith("/assets/") || req.url.startsWith("/ads/")) {
      resourceHits++;
      res.setHeader("Content-Type", "application/javascript");
      res.end("window.fixtureCount=(window.fixtureCount||0)+1;");
      return;
    }
    const blocked = req.url.startsWith("/blocked");
    const heavy = blocked || req.url.startsWith("/heavy");
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><title>Performance fixture</title><h1>Local benchmark</h1>" +
        (heavy
          ? Array.from(
              { length: count },
              (_, i) =>
                `<script async src="/${blocked ? "ads" : "assets"}/${blocked ? "advertisement" : "resource"}-${i}.js"></script>`,
            ).join("")
          : "") +
        "<script>window.fixtureReady=true</script>",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let code = 0;
  try {
    await win.webContents.executeJavaScript(
      'window.tabMutations=0;new MutationObserver(m=>window.tabMutations+=m.length).observe(document.getElementById("tabs"),{childList:true,subtree:true});',
    );
    const navigate = async (url) => {
      const t = performance.now();
      await command("navigate", url);
      const wc = getTab().view.webContents;
      await until(() => !wc.isLoading() && !getTab().loading);
      assert.equal(getTab().error, "");
      return performance.now() - t;
    };
    const firstNavigationMs = await navigate(base + "/light");
    const { webContents } = require("electron");
    let background = webContents
      .getAllWebContents()
      .find(
        (w) =>
          w.getType() === "backgroundPage" &&
          w.session === getTab().view.webContents.session,
      );
    assert.ok(background, "uBlock background missing");
    console.log(
      "PERF EXTENSION STARTUP",
      await background.executeJavaScript("JSON.stringify(µBlock.supportStats)"),
    );
    await background.executeJavaScript(
      `µBlock.appendUserFilters(${JSON.stringify(`||127.0.0.1:${server.address().port}/ads/$script`)})`,
    );
    let hostFilterEvaluations = 0;
    const originalEvaluate = background.executeJavaScript.bind(background);
    background.executeJavaScript = (...args) => {
      hostFilterEvaluations++;
      return originalEvaluate(...args);
    };
    const beforeMutations = await win.webContents.executeJavaScript(
      "window.tabMutations",
    );
    const heavySamplesMs = [];
    for (let i = 0; i < 5; i++) {
      heavySamplesMs.push(await navigate(base + "/heavy?sample=" + i));
      assert.equal(
        await getTab().view.webContents.executeJavaScript(
          "window.fixtureCount",
        ),
        count,
      );
    }
    const blockStart = snapshot().blocked;
    const blockedNavigationMs = await navigate(base + "/blocked");
    await delay(250);
    const blockedRequests = snapshot().blocked - blockStart;
    console.log(
      "PERF FILTER COUNTERS",
      JSON.stringify({
        blockedRequests,
        resourceHits,
        extensionBlocked: await background.executeJavaScript(
          "globalThis.__quietBlockedCount?.()",
        ),
      }),
    );
    assert.equal(
      blockedRequests,
      count,
      "Benchmark must exercise the actual ad-blocking hot path",
    );
    const tabMutations =
      (await win.webContents.executeJavaScript("window.tabMutations")) -
      beforeMutations;
    const resourcePathEvaluations = hostFilterEvaluations;
    const chrome = await chromeBenchmark(base, app.getPath("userData"));
    const result = {
      date: new Date().toISOString(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      startupMainToHomeMs: startupMs,
      firstNavigationMs,
      heavySamplesMs,
      heavyMedianMs: median(heavySamplesMs),
      resourceCount: count,
      blockedNavigationMs,
      blockedRequests,
      tabMutations,
      resourcePathEvaluations,
      resourceHits,
      chrome,
    };
    if (process.env.QUIET_PERF_OUTPUT)
      await fs.writeFile(
        process.env.QUIET_PERF_OUTPUT,
        JSON.stringify(result, null, 2),
      );
    console.log("PERF RESULT " + JSON.stringify(result));
    if (process.env.QUIET_PERF_ASSERT === "1") {
      assert.ok(
        tabMutations < 50,
        "Request filtering still repeatedly rebuilds tab UI",
      );
      assert.ok(
        resourcePathEvaluations < 100,
        "Per-request host filtering round-trips returned",
      );
      assert.ok(
        median(heavySamplesMs) < 200,
        "Warm resource loading regressed",
      );
    }
  } catch (e) {
    console.error("PERF FAIL", e.message);
    code = 1;
  } finally {
    server.closeAllConnections();
    server.close();
    app.exit(code);
  }
};
