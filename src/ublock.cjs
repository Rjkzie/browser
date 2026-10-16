const fs = require("node:fs/promises");
const path = require("node:path");
const activeFilters = new WeakMap();
async function prepareUBlock(root) {
  const background = path.join(root, "background.html");
  let html = await fs.readFile(background, "utf8");
  const source = await fs.readFile(path.join(__dirname, "ublock-compat.js"));
  const destination = path.join(root, "quiet-compat.js");
  const existing = await fs.readFile(destination).catch(() => null);
  if (!existing?.equals(source)) await fs.writeFile(destination, source);
  if (!html.includes("quiet-compat.js")) {
    if (!html.includes("<script src="))
      throw Error("Изменился формат uBlock. Нужна проверка совместимости.");
    html = html.replace(
      "<script src=",
      '<script src="quiet-compat.js"></script>\n<script src=',
    );
    await fs.writeFile(background, html);
  }
}
async function evaluate(wc, code, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([
      wc.executeJavaScript(code),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("uBlock timeout")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function attachFilter(
  session,
  extensionId,
  onBlocked = () => {},
  onFailure = () => {},
) {
  const { webContents } = require("electron");
  let background,
    ready = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    background = webContents
      .getAllWebContents()
      .find(
        (w) =>
          w.getType() === "backgroundPage" &&
          w.session === session &&
          w.getURL().startsWith(`chrome-extension://${extensionId}/`),
      );
    if (background) {
      ready = await evaluate(
        background,
        "globalThis.µBlock?.readyToFilter===true",
        500,
      ).catch(() => false);
      if (ready) break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) throw Error("Фильтры uBlock не готовы");
  let last = 0,
    pending = false,
    stopped = false;
  const fail = () => {
    if (stopped) return;
    cleanup();
    session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_details, callback) => callback({ cancel: true }),
    );
    onFailure();
  };
  const timer = setInterval(async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      const total = await evaluate(
        background,
        "globalThis.__quietBlockedCount()",
      );
      if (!stopped && Number.isSafeInteger(total) && total >= last) {
        if (total > last) onBlocked(total - last);
        last = total;
      }
    } catch {
      fail();
    } finally {
      pending = false;
    }
  }, 250);
  timer.unref();
  function cleanup() {
    stopped = true;
    clearInterval(timer);
    background.removeListener("render-process-gone", fail);
    background.removeListener("destroyed", fail);
  }
  background.once("render-process-gone", fail);
  background.once("destroyed", fail);
  activeFilters.set(session, cleanup);
  return background;
}
function detachFilter(session) {
  activeFilters.get(session)?.();
  activeFilters.delete(session);
  session.webRequest.onBeforeRequest(null);
}
module.exports = { prepareUBlock, attachFilter, detachFilter };
