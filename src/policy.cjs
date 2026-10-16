"use strict";
const net = require("node:net");
const ENGINES = [
  { id: "duck", name: "DuckDuckGo", url: "https://duckduckgo.com/?q={query}" },
  {
    id: "brave",
    name: "Brave Search",
    url: "https://search.brave.com/search?q={query}",
  },
  {
    id: "google",
    name: "Google",
    url: "https://www.google.com/search?q={query}",
  },
  {
    id: "yandex",
    name: "Яндекс",
    url: "https://yandex.ru/search/?text={query}",
  },
];
const AI = {
  perplexity: ["Perplexity", "https://www.perplexity.ai/"],
  gpt: ["ChatGPT", "https://chatgpt.com/"],
  deepseek: ["DeepSeek", "https://chat.deepseek.com/"],
  qwen: ["Qwen", "https://chat.qwen.ai/"],
};
function webURL(value, tor = false) {
  if (typeof value !== "string" || value.length > 12000)
    throw Error("Некорректный адрес");
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("Разрешены только HTTP/HTTPS без пароля в адресе");
  if (u.hostname.endsWith(".onion") && !tor)
    throw Error(".onion доступен только в режиме Tor");
  return u.href;
}
function engine(value) {
  if (
    !value ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 60 ||
    typeof value.url !== "string" ||
    !value.url.includes("{query}")
  )
    throw Error("Нужны название и URL с {query}");
  const url = webURL(value.url.replaceAll("{query}", "test"), true);
  const u = new URL(value.url.replaceAll("{query}", "test"));
  if (
    u.hostname.includes("test") &&
    new URL(url).hostname !==
      new URL(value.url.replaceAll("{query}", "other")).hostname
  )
    throw Error("{query} не должен изменять домен");
  return {
    id: String(value.id || "custom").slice(0, 80),
    name: value.name.trim(),
    url: value.url,
  };
}
function navigate(input, search, tor = false) {
  const text = String(input).trim();
  if (!text || text === "quiet:home") return "quiet:home";
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[\w.-]+:\d+(?:\/|$)/.test(text))
    return webURL(text, tor);
  if (
    !/\s/.test(text) &&
    /^(localhost|\[[\da-f:]+\]|[\w-]+(?:\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(
      text,
    )
  ) {
    return webURL(
      (/^(localhost|127\.)/.test(text) ? "http://" : "https://") + text,
      tor,
    );
  }
  return webURL(
    engine(search).url.replaceAll("{query}", encodeURIComponent(text)),
    tor,
  );
}
function proxyConfig(value) {
  const mode = value?.mode;
  if (mode === "direct" || mode === "system") return { mode };
  if (!["http", "socks5", "tor", "profile"].includes(mode))
    throw Error("Неизвестный режим сети");
  const host = ["tor", "profile"].includes(mode) ? "127.0.0.1" : value.host;
  const port = Number(
    mode === "tor"
      ? 19050
      : mode === "profile"
        ? value.kind === "awg"
          ? 19081
          : 19080
        : value.port,
  );
  if (
    typeof host !== "string" ||
    (!net.isIP(host) &&
      !/^(?=.{1,253}$)[a-z\d]+(?:[.-][a-z\d]+)*$/i.test(host)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error("Проверь адрес и порт прокси");
  const formatted = net.isIP(host) === 6 ? `[${host}]` : host;
  return {
    mode: "fixed_servers",
    proxyRules: `${mode === "http" ? "http" : "socks5"}://${formatted}:${port}`,
    proxyBypassRules: "<-loopback>",
  };
}
function settings(value) {
  if (
    !value ||
    !Array.isArray(value.engines) ||
    !value.engines.length ||
    value.engines.length > 40
  )
    throw Error("Нужна хотя бы одна поисковая система");
  const engines = value.engines.map(engine);
  if (new Set(engines.map((e) => e.id)).size !== engines.length)
    throw Error("ID поисковиков должны быть уникальны");
  if (!engines.some((e) => e.id === value.search))
    throw Error("Выбери поисковик");
  proxyConfig(value.network);
  return {
    engines,
    search: value.search,
    network: {
      mode: value.network.mode,
      host: String(value.network.host || "127.0.0.1"),
      port: Number(value.network.port) || 10808,
      profileId: String(value.network.profileId || "").slice(0, 80),
      kind: value.network.kind === "awg" ? "awg" : "xray",
    },
    developer: !!value.developer,
    media: !!value.media,
    blocker: value.blocker !== false,
    autoUpdate: value.autoUpdate !== false,
    autoZapret: !!value.autoZapret,
    zapretProfile:
      typeof value.zapretProfile === "string"
        ? value.zapretProfile.slice(0, 160)
        : "general.bat",
  };
}
const defaults = () =>
  settings({
    engines: ENGINES,
    search: "duck",
    network: { mode: "direct" },
    blocker: true,
    autoUpdate: true,
  });
module.exports = {
  AI,
  ENGINES,
  webURL,
  engine,
  navigate,
  proxyConfig,
  settings,
  defaults,
};
