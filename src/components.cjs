"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const REPOS = {
  xray: ["XTLS/Xray-core", /^Xray-windows-64\.zip$/],
  zapret: ["Flowseal/zapret-discord-youtube", /\.zip$/],
  ublock: ["gorhill/uBlock", /\.chromium\.zip$/],
};
const ALLOWED = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "dist.torproject.org",
]);
function trustedURL(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !ALLOWED.has(u.hostname) ||
    u.username ||
    u.password
  )
    throw Error("Недоверенный источник обновления");
  return u.href;
}
function hash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
function verify(data, digest) {
  if (
    !/^sha256:[a-f\d]{64}$/.test(digest || "") ||
    hash(data) !== digest.slice(7)
  )
    throw Error("SHA-256 пакета не совпал");
}
const psLiteral = (value) => "'" + value.replaceAll("'", "''") + "'";
async function powershell(command) {
  return run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 120000 },
  );
}
async function unpack(file, dest) {
  await fs.mkdir(dest, { recursive: true });
  {
    const { stdout } = await run("tar.exe", ["-tvf", file], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (
      stdout
        .split(/\r?\n/)
        .some(
          (line) =>
            /^[lh]/.test(line) || /(?:^|[\s/\\])\.\.(?:[/\\]|$)/.test(line),
        )
    )
      throw Error("Небезопасный архив");
    const listing = await run("tar.exe", ["-tf", file], { windowsHide: true });
    if (listing.stdout.split(/\r?\n/).some((name) => /^[/\\]|:/.test(name)))
      throw Error("Небезопасный путь архива");
    await run("tar.exe", ["-xf", file, "-C", dest], {
      windowsHide: true,
      timeout: 120000,
    });
  }
}
async function find(root, name) {
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) {
      const result = await find(p, name);
      if (result) return result;
    }
  }
  return null;
}
class Components {
  constructor(root, fetcher = fetch, notify = () => {}) {
    this.root = root;
    this.fetcher = fetcher;
    this.notify = notify;
    this.busy = false;
  }
  async get(url, binary = false) {
    let current = trustedURL(url);
    for (let i = 0; i < 8; i++) {
      const response = await this.fetcher(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(180000),
        headers: {
          "User-Agent": "QuietBrowser-ComponentUpdater/0.1",
          Accept: "application/vnd.github+json",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = trustedURL(
          new URL(response.headers.get("location"), current).href,
        );
        continue;
      }
      if (!response.ok)
        throw Error(`Сервер обновлений: HTTP ${response.status}`);
      if (!binary) return response.text();
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 300 * 1024 * 1024) throw Error("Пакет слишком большой");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    throw Error("Слишком много перенаправлений");
  }
  async manifest() {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.root, "manifest.json"), "utf8"),
      );
    } catch {
      return {};
    }
  }
  async locate(id, filename) {
    const m = await this.manifest();
    if (!m[id]) return null;
    return find(path.join(this.root, id, m[id].version), filename);
  }
  async update(ids = ["xray", "zapret", "ublock", "tor"]) {
    if (this.busy) throw Error("Обновление уже идёт");
    this.busy = true;
    const errors = [];
    try {
      await fs.mkdir(this.root, { recursive: true });
      const manifest = await this.manifest();
      for (const id of ids) {
        try {
          this.notify(`Проверка: ${id}`);
          let version, url, digest, filename;
          if (id === "tor") {
            const index = await this.get(
              "https://dist.torproject.org/torbrowser/",
            );
            const versions = [
              ...index.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\/"/g),
            ]
              .map((m) => m[1])
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            version = versions.at(-1);
            if (!version) throw Error("Не найден стабильный Tor");
            filename = `tor-expert-bundle-windows-x86_64-${version}.tar.gz`;
            const base = `https://dist.torproject.org/torbrowser/${version}/`;
            const sums = await this.get(base + "sha256sums-signed-build.txt");
            const line = sums
              .split("\n")
              .find((line) => line.trim().endsWith(filename));
            if (!line) throw Error("Нет контрольной суммы Tor");
            digest = "sha256:" + line.trim().split(/\s+/)[0];
            url = base + filename;
          } else {
            if (!REPOS[id]) throw Error("Неизвестный компонент");
            const [repo, match] = REPOS[id];
            const release = JSON.parse(
              await this.get(
                `https://api.github.com/repos/${repo}/releases/latest`,
              ),
            );
            const asset = release.assets.find((a) => match.test(a.name));
            if (!asset) throw Error("Нет Windows-пакета");
            version = release.tag_name;
            filename = asset.name;
            url = asset.browser_download_url;
            digest = asset.digest;
          }
          if (
            !/^[a-z\d._-]+$/i.test(version) ||
            !/^[a-z\d._-]+$/i.test(filename)
          )
            throw Error("Небезопасное имя пакета");
          if (
            manifest[id]?.version === version &&
            (await this.locate(
              id,
              id === "xray"
                ? "xray.exe"
                : id === "tor"
                  ? "tor.exe"
                  : id === "ublock"
                    ? "manifest.json"
                    : "winws.exe",
            ))
          )
            continue;
          this.notify(`Загрузка: ${id} ${version}`);
          const data = await this.get(url, true);
          verify(data, digest);
          const dest = path.join(this.root, id, version);
          await fs.mkdir(dest, { recursive: true });
          const file = path.join(dest, filename);
          await fs.writeFile(file, data);
          await unpack(file, path.join(dest, "unpacked"));
          manifest[id] = {
            version,
            filename,
            sha256: hash(data),
            source: url,
            downloaded: new Date().toISOString(),
          };
          const tmp = path.join(this.root, "manifest.next.json");
          await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
          await fs.rename(tmp, path.join(this.root, "manifest.json"));
          this.notify(`Готово: ${id} ${version}`);
        } catch (e) {
          errors.push(`${id}: ${e.message}`);
          this.notify(errors.at(-1));
        }
      }
    } finally {
      this.busy = false;
      await fs
        .writeFile(
          path.join(this.root, "update-state.json"),
          JSON.stringify({ checkedAt: Date.now() }),
        )
        .catch(() => {});
    }
    if (errors.length) throw Error(errors.join("\n"));
    return this.manifest();
  }
}
module.exports = {
  Components,
  trustedURL,
  verify,
  hash,
  unpack,
  find,
  powershell,
  psLiteral,
};
