"use strict";
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const fs = require("node:fs/promises");
const ALLOWED = new Set([
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "socks",
  "http",
]);
function sanitizeOutbound(value) {
  if (!value || !ALLOWED.has(value.protocol) || !value.settings)
    throw Error("Нужен поддерживаемый сетевой outbound Xray");
  const result = {
    protocol: value.protocol,
    settings: value.settings,
    tag: "vpn",
  };
  if (value.streamSettings) {
    result.streamSettings = structuredClone(value.streamSettings);
    delete result.streamSettings.sockopt;
    if (result.streamSettings.tlsSettings) {
      result.streamSettings.tlsSettings.allowInsecure = false;
      delete result.streamSettings.tlsSettings.certificates;
    }
  }
  return result;
}
function uriProfile(text) {
  if (text.startsWith("vmess://")) {
    let p;
    try {
      p = JSON.parse(Buffer.from(text.slice(8), "base64").toString("utf8"));
    } catch {
      throw Error("Некорректный VMess");
    }
    const streamSettings = {
      network: p.net || "tcp",
      security: p.tls === "tls" ? "tls" : "none",
    };
    if (p.host || p.path)
      streamSettings.wsSettings = {
        path: p.path || "/",
        headers: p.host ? { Host: p.host } : {},
      };
    if (p.tls === "tls")
      streamSettings.tlsSettings = {
        serverName: p.sni || p.host || p.add,
        allowInsecure: false,
      };
    return sanitizeOutbound({
      protocol: "vmess",
      settings: {
        vnext: [
          {
            address: p.add,
            port: Number(p.port),
            users: [
              {
                id: p.id,
                alterId: Number(p.aid) || 0,
                security: p.scy || "auto",
              },
            ],
          },
        ],
      },
      streamSettings,
    });
  }
  let u;
  try {
    u = new URL(text);
  } catch {
    throw Error("Некорректная ссылка подключения");
  }
  const protocol = u.protocol.slice(0, -1),
    q = u.searchParams;
  if (!["vless", "trojan", "ss"].includes(protocol))
    throw Error(
      "Поддерживаются VLESS, VMess, Trojan, Shadowsocks, Xray JSON и AmneziaWG",
    );
  const port = Number(u.port) || 443;
  if (!u.hostname || port < 1 || port > 65535)
    throw Error("Проверь сервер и порт");
  if (protocol === "ss") {
    let auth =
      decodeURIComponent(u.username) +
      (u.password ? ":" + decodeURIComponent(u.password) : "");
    if (!auth.includes(":"))
      auth = Buffer.from(auth, "base64").toString("utf8");
    const split = auth.indexOf(":");
    if (split < 1 || q.has("plugin"))
      throw Error("Нужна SS-ссылка без SIP003-плагина");
    return sanitizeOutbound({
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address: u.hostname,
            port,
            method: auth.slice(0, split),
            password: auth.slice(split + 1),
          },
        ],
      },
    });
  }
  const security =
    q.get("security") || (protocol === "trojan" ? "tls" : "none");
  if (!["none", "tls", "reality"].includes(security))
    throw Error("Неподдерживаемый транспорт безопасности");
  const streamSettings = { network: q.get("type") || "tcp", security };
  if (
    !["tcp", "raw", "ws", "grpc", "httpupgrade", "xhttp"].includes(
      streamSettings.network,
    )
  )
    throw Error("Неподдерживаемый транспорт");
  if (security === "tls")
    streamSettings.tlsSettings = {
      serverName: q.get("sni") || u.hostname,
      fingerprint: q.get("fp") || "chrome",
      allowInsecure: false,
      ...(q.get("alpn") ? { alpn: q.get("alpn").split(",") } : {}),
    };
  if (security === "reality")
    streamSettings.realitySettings = {
      serverName: q.get("sni") || "",
      fingerprint: q.get("fp") || "chrome",
      publicKey: q.get("pbk") || "",
      shortId: q.get("sid") || "",
      spiderX: q.get("spx") || "/",
    };
  if (streamSettings.network === "ws")
    streamSettings.wsSettings = {
      path: q.get("path") || "/",
      headers: q.get("host") ? { Host: q.get("host") } : {},
    };
  if (streamSettings.network === "grpc")
    streamSettings.grpcSettings = {
      serviceName: q.get("serviceName") || "",
      multiMode: q.get("mode") === "multi",
    };
  if (streamSettings.network === "httpupgrade")
    streamSettings.httpupgradeSettings = {
      path: q.get("path") || "/",
      host: q.get("host") || "",
    };
  if (streamSettings.network === "xhttp")
    streamSettings.xhttpSettings = {
      path: q.get("path") || "/",
      host: q.get("host") || "",
      mode: q.get("mode") || "auto",
    };
  const settings =
    protocol === "vless"
      ? {
          vnext: [
            {
              address: u.hostname,
              port,
              users: [
                {
                  id: decodeURIComponent(u.username),
                  encryption: "none",
                  flow: q.get("flow") || "",
                },
              ],
            },
          ],
        }
      : {
          servers: [
            {
              address: u.hostname,
              port,
              password: decodeURIComponent(u.username),
            },
          ],
        };
  return sanitizeOutbound({ protocol, settings, streamSettings });
}
function parseProfile(text) {
  if (typeof text !== "string" || text.length > 1024 * 1024)
    throw Error("Профиль слишком большой");
  text = text.trim();
  if (text.startsWith("vpn://")) {
    try {
      const packed = Buffer.from(text.slice(6), "base64url");
      text = zlib
        .inflateSync(packed.subarray(4), { maxOutputLength: 2 * 1024 * 1024 })
        .toString("utf8");
    } catch {
      throw Error("Не удалось распаковать ключ Amnezia vpn://");
    }
  }
  if (/^\[Interface\]/im.test(text) && /^\[Peer\]/im.test(text))
    return { kind: "awg", payload: text };
  if (/^(vless|vmess|trojan|ss):\/\//.test(text))
    return { kind: "xray", payload: uriProfile(text) };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Error(
      "Неизвестный формат. Вставь ссылку подключения, .conf или JSON, без подписки HTTP.",
    );
  }
  const find = (node, depth = 0) => {
    if (depth > 12 || node === null) return null;
    if (typeof node === "string") {
      if (/^\[Interface\]/im.test(node) && /^\[Peer\]/im.test(node))
        return { kind: "awg", payload: node };
      try {
        return find(JSON.parse(node), depth + 1);
      } catch {
        return null;
      }
    }
    if (typeof node !== "object") return null;
    if (Array.isArray(node.outbounds)) {
      const outbound = node.outbounds.find((o) => ALLOWED.has(o.protocol));
      if (outbound)
        return { kind: "xray", payload: sanitizeOutbound(outbound) };
    }
    if (ALLOWED.has(node.protocol) && node.settings)
      return { kind: "xray", payload: sanitizeOutbound(node) };
    for (const value of Object.values(node)) {
      const result = find(value, depth + 1);
      if (result) return result;
    }
    return null;
  };
  const result = find(data);
  if (!result)
    throw Error(
      "В ключе нет поддерживаемого Xray или WireGuard/AmneziaWG .conf. OpenVPN, IKEv2 и Amnezia Premium API пока не поддерживаются.",
    );
  return result;
}
function xrayConfig(outbound) {
  return {
    log: { loglevel: "none" },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: 19080,
        protocol: "socks",
        settings: { auth: "noauth", udp: false },
      },
    ],
    outbounds: [sanitizeOutbound(outbound)],
  };
}
class ProfileStore {
  constructor(file, storage) {
    this.file = file;
    this.storage = storage;
    this.items = [];
  }
  async load() {
    try {
      const encrypted = await fs.readFile(this.file);
      if (!this.storage.isEncryptionAvailable()) throw Error();
      this.items = JSON.parse(this.storage.decryptString(encrypted));
    } catch (e) {
      if (e.code !== "ENOENT")
        throw Error("Хранилище VPN недоступно или повреждено");
    }
    return this.list();
  }
  list() {
    return this.items.map(({ id, name, kind }) => ({ id, name, kind }));
  }
  async save() {
    if (!this.storage.isEncryptionAvailable())
      throw Error("Шифрование Windows недоступно. Профиль не сохранён.");
    const temp = this.file + ".tmp";
    await fs.writeFile(
      temp,
      this.storage.encryptString(JSON.stringify(this.items)),
    );
    await fs.rename(temp, this.file);
  }
  async import(name, text) {
    if (typeof name !== "string" || name.length > 60)
      throw Error("Название: до 60 символов");
    if (this.items.length >= 30) throw Error("Лимит: 30 профилей");
    const parsed = parseProfile(text);
    const item = {
      id: crypto.randomUUID(),
      name: name.trim() || "VPN профиль",
      ...parsed,
    };
    this.items.push(item);
    try {
      await this.save();
    } catch (e) {
      this.items.pop();
      throw e;
    }
    return this.list();
  }
  get(id) {
    const item = this.items.find((p) => p.id === id);
    if (!item) throw Error("VPN-профиль не найден");
    return item;
  }
  async remove(id) {
    const previous = this.items;
    this.items = this.items.filter((p) => p.id !== id);
    try {
      await this.save();
    } catch (e) {
      this.items = previous;
      throw e;
    }
    return this.list();
  }
}
module.exports = { parseProfile, uriProfile, xrayConfig, ProfileStore };
