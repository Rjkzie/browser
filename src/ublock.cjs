const fs = require("node:fs/promises");
const path = require("node:path");
async function prepareUBlock(root) {
  const background = path.join(root, "background.html");
  let html = await fs.readFile(background, "utf8");
  await fs.copyFile(
    path.join(__dirname, "ublock-compat.js"),
    path.join(root, "quiet-compat.js"),
  );
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
async function attachFilter(session, extensionId, onBlocked = () => {}) {
  const { webContents } = require("electron");
  let background;
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
    if (
      background &&
      (await background
        .executeJavaScript("globalThis.µBlock?.readyToFilter===true")
        .catch(() => false))
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (
    !background ||
    !(await background
      .executeJavaScript("globalThis.µBlock?.readyToFilter===true")
      .catch(() => false))
  )
    throw Error("Фильтры uBlock не готовы");
  const types = {
    mainFrame: "main_frame",
    subFrame: "sub_frame",
    xhr: "xmlhttprequest",
    cspReport: "csp_report",
    webSocket: "websocket",
  };
  session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    async (details, callback) => {
      const wc = webContents.fromId(details.webContentsId);
      if (!wc || wc.getType() === "backgroundPage") return callback({});
      const request = {
        requestId: String(details.id),
        url: details.url,
        method: details.method,
        type: types[details.resourceType] || details.resourceType,
        tabId: details.webContentsId,
        frameId:
          details.resourceType === "mainFrame"
            ? 0
            : details.frame?.routingId || 0,
        parentFrameId: details.resourceType === "mainFrame" ? -1 : 0,
        documentUrl: wc.getURL(),
        initiator: details.initiator,
        timeStamp: details.timestamp,
      };
      try {
        const result = await Promise.race([
          background.executeJavaScript(
            `(()=>{const d=${JSON.stringify(request)};vAPI.net.normalizeDetails(d);return vAPI.net.onBeforeSuspendableRequest(d)||{}})()`,
          ),
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(Error("filter timeout")),
              3000,
            );
            timer.unref();
          }),
        ]);
        if (result.cancel || result.redirectUrl) onBlocked();
        callback({
          cancel: !!result.cancel,
          ...(result.redirectUrl ? { redirectURL: result.redirectUrl } : {}),
        });
      } catch {
        callback({ cancel: true });
      }
    },
  );
  return background;
}
module.exports = { prepareUBlock, attachFilter };
