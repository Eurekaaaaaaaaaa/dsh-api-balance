/**
 * dsh-api-balance · Host half.
 *
 * Owns three things and nothing else:
 *
 * 1. a provider list persisted in `~/.dsh/api-balance/config.json`, so API keys
 *    never enter `cordis.patch.yml` or the Web UI's own storage. A provider may
 *    instead name a DSH credential (`keyRef`, e.g. DEEPSEEK_API_KEY) and the key
 *    is read through `ctx.credentials.resolve()` at each poll, never cached —
 *    that is how the balance appears with no key typed into this plugin;
 * 2. a poller that asks every enabled provider for its balance / remaining
 *    quota, with the DeepSeek official endpoint built in and everything else
 *    driven by a declarative HTTP request;
 * 3. three loopback routes the browser half reads and writes:
 *      GET  /plugins/dsh-api-balance/state    current snapshot
 *      GET  /plugins/dsh-api-balance/config   sanitized config (no keys)
 *      POST /plugins/dsh-api-balance/config   save config (keys accepted)
 *      POST /plugins/dsh-api-balance/refresh  refresh now
 *
 * The routes follow the same trust fence as every other plugin route: the
 * connection service decides whether a request may be served at all, and the
 * state route is read-only.
 *
 * @module dsh-api-balance
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PLUGIN_NAME = "dsh-api-balance";
const STATE_ROUTE = "/plugins/dsh-api-balance/state";
const CONFIG_ROUTE = "/plugins/dsh-api-balance/config";
const REFRESH_ROUTE = "/plugins/dsh-api-balance/refresh";

const CONFIG_PATH = join(homedir(), ".dsh", "api-balance", "config.json");

/**
 * A diagnostics mirror of the last snapshot. The panel is the product surface,
 * but a file is the only way to see the same numbers from outside the browser
 * (no shell, no console): it records what each provider returned or why it did
 * not. It never contains a key — publicState() is already sanitized. Debug only,
 * never read back by the plugin.
 */
const STATE_MIRROR_PATH = join(homedir(), ".dsh", "api-balance", "last-state.json");
/** Daily snapshots: the first capture of a local day is the baseline for 今日使用. */
const HISTORY_PATH = join(homedir(), ".dsh", "api-balance", "history.json");
const HISTORY_DAYS = 30;
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Shown when a DeepSeek provider has no key from any source. */
const MISSING_DEEPSEEK_KEY = "DeepSeek 余额读取失败：登录 DSH 账号，或在面板里填 Key";

const MAX_PROVIDERS = 20;
const MAX_HEADERS = 20;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT = 4096;
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** The configuration a fresh install starts with. */
const DEFAULT_CONFIG = {
  version: 1,
  pollIntervalSec: 300,
  timeoutMs: 15000,
  providers: [
    {
      id: "deepseek",
      label: "DeepSeek 官方",
      type: "deepseek",
      enabled: true,
      apiKey: "",
      keyRef: "DEEPSEEK_API_KEY",
      url: DEEPSEEK_BALANCE_URL,
      method: "GET",
      headers: {},
      body: "",
      extract: {
        balance: "balance_infos[0].total_balance",
        currency: "balance_infos[0].currency",
        quotaRemain: "",
        quotaTotal: "",
        quotaUnit: "",
        planName: ""
      },
      note: "登录 DSH 账号即可读取余额；也可以在面板里填 API Key"
    },
    {
      id: "fastai",
      label: "FastAI Token",
      type: "http",
      enabled: false,
      apiKey: "",
      keyRef: "",
      url: "",
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer {{apiKey}}"
      },
      body: "",
      extract: {
        balance: "",
        currency: "",
        quotaRemain: "",
        quotaTotal: "",
        quotaUnit: "tokens",
        planName: ""
      },
      note: "面板接口未公开，按 FastAI 后台抓包结果填写"
    },
    {
      id: "qianfan",
      label: "百度千帆",
      type: "http",
      enabled: false,
      apiKey: "",
      keyRef: "",
      url: "",
      method: "GET",
      headers: {
        accept: "application/json",
        cookie: "{{apiKey}}"
      },
      body: "",
      extract: {
        balance: "",
        currency: "CNY",
        quotaRemain: "",
        quotaTotal: "",
        quotaUnit: "",
        planName: ""
      },
      note: "控制台未公开余额接口，F12 → Network 抓包后填写地址与取数路径"
    },
    {
      id: "custom",
      label: "自定义 API",
      type: "http",
      enabled: false,
      apiKey: "",
      keyRef: "",
      url: "",
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer {{apiKey}}"
      },
      body: "",
      extract: {
        balance: "",
        currency: "",
        quotaRemain: "",
        quotaTotal: "",
        quotaUnit: "tokens",
        planName: ""
      },
      note: "预留入口：新增一家就复制这一段并改 id / label / url"
    }
  ]
};

/* ------------------------------------------------------------------ helpers */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : fallback;
}

function clamp(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Read a dot/bracket path out of a parsed JSON document,
 * e.g. `balance_infos[0].total_balance`.
 * @param doc - the parsed document.
 * @param path - the path to walk.
 * @returns the value found, or undefined.
 */
function readPath(doc, path) {
  if (typeof path !== "string" || path.trim() === "") return undefined;
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current = doc;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/** A number from a JSON number or a string such as "¥12.30" / "1,024". */
function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[^0-9.+-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Replace `{{apiKey}}` and `{{env.NAME}}` templates in one string. */
function fill(textValue, provider) {
  return String(textValue)
    .replace(/\{\{\s*apiKey\s*\}\}/g, provider.apiKey)
    .replace(/\{\{\s*refreshToken\s*\}\}/g, provider.refreshToken || "")
    .replace(/\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g, (_match, name) => process.env[name] ?? "");
}

function normalizeHeaders(source) {
  const out = {};
  if (!isRecord(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(out).length >= MAX_HEADERS) break;
    if (typeof key !== "string" || key.length === 0 || key.length > 80) continue;
    if (value === null || value === undefined) continue;
    out[key] = String(value).slice(0, MAX_TEXT);
  }
  return out;
}

function normalizeExtract(source) {
  const record = isRecord(source) ? source : {};
  return {
    balance: text(record.balance),
    currency: text(record.currency),
    quotaRemain: text(record.quotaRemain),
    quotaUsed: text(record.quotaUsed),
    quotaTotal: text(record.quotaTotal),
    quotaUnit: text(record.quotaUnit),
    planName: text(record.planName)
  };
}

/**
 * One provider, normalized.
 * @param raw - an unknown provider entry.
 * @param previous - the entry this one replaces, if any.
 * @returns a complete provider.
 */
function normalizeProvider(raw, previous) {
  const record = isRecord(raw) ? raw : {};
  const base = isRecord(previous) ? previous : {};
  const id = PROVIDER_ID_RE.test(String(record.id ?? base.id ?? "")) ? String(record.id ?? base.id) : "custom";
  const type = record.type === "deepseek" || base.type === "deepseek" ? "deepseek" : "http";
  const extractSource = record.extract !== undefined ? record.extract : base.extract;
  const headersSource = record.headers !== undefined ? record.headers : base.headers;
  return {
    id,
    label: text(record.label, text(base.label, id)) || id,
    type,
    enabled: typeof record.enabled === "boolean" ? record.enabled : base.enabled === true,
    apiKey: text(record.apiKey, text(base.apiKey)),
    keyRef: text(record.keyRef, text(base.keyRef)),
    refreshUrl: text(record.refreshUrl, text(base.refreshUrl)),
    refreshToken: text(record.refreshToken, text(base.refreshToken)),
    url: text(record.url, text(base.url)),
    method: record.method === "POST" ? "POST" : base.method === "POST" ? "POST" : "GET",
    headers: normalizeHeaders(headersSource),
    body: text(record.body, text(base.body)),
    extract: normalizeExtract(extractSource),
    note: text(record.note, text(base.note))
  };
}

function normalizeConfig(source) {
  const record = isRecord(source) ? source : {};
  const providers = [];
  const seen = new Set();
  const list = Array.isArray(record.providers) ? record.providers : [];
  for (const raw of list.slice(0, MAX_PROVIDERS)) {
    const previous = presetFor(raw);
    const provider = normalizeProvider(raw, previous);
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    providers.push(provider);
  }
  if (providers.length === 0) {
    return {
      version: 1,
      pollIntervalSec: clamp(record.pollIntervalSec, DEFAULT_CONFIG.pollIntervalSec, 30, 86400),
      timeoutMs: clamp(record.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 60000),
      providers: DEFAULT_CONFIG.providers.map((provider) => normalizeProvider(provider, null))
    };
  }
  return {
    version: 1,
    pollIntervalSec: clamp(record.pollIntervalSec, DEFAULT_CONFIG.pollIntervalSec, 30, 86400),
    timeoutMs: clamp(record.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 60000),
    providers
  };
}

/** The shipped preset for one raw entry, used to fill the fields it omits. */
function presetFor(raw) {
  const id = isRecord(raw) ? raw.id : undefined;
  return DEFAULT_CONFIG.providers.find((provider) => provider.id === id) ?? null;
}

/* ------------------------------------------------------------------ storage */

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      return normalizeConfig(parsed);
    }
  } catch {
    /* a corrupt file degrades to defaults rather than stopping the plugin */
  }
  const fresh = normalizeConfig(DEFAULT_CONFIG);
  saveConfig(fresh);
  return fresh;
}

function saveConfig(config) {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- history */

function readHistory() {
  try {
    if (existsSync(HISTORY_PATH)) {
      const parsed = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      if (isRecord(parsed) && isRecord(parsed.days)) return parsed;
    }
  } catch {
    /* a corrupt history starts over rather than blocking the panel */
  }
  return { days: {} };
}

function writeHistory(history) {
  try {
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
    writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* history is a convenience, never a reason to fail a refresh */
  }
}

/** The local calendar day, so "today" follows the user's midnight, not UTC's. */
function dayKey(date) {
  const now = date ?? new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function sampleOf(row) {
  return {
    balance: typeof row.balance === "number" ? row.balance : null,
    currency: text(row.currency, ""),
    quotaRemain: row.quota ? row.quota.remain : null,
    quotaTotal: row.quota ? row.quota.total : null,
    unit: row.quota ? text(row.quota.unit, "") : "",
    at: Date.now()
  };
}

/**
 * How much this provider has spent today: the day's first capture minus the
 * current reading, in quota units when the provider has a quota and in money
 * otherwise. Null when nothing was spent or no baseline exists yet.
 */
function usageOn(history, row) {
  const entry = (history.days[dayKey()] || {})[row.id];
  if (!entry || !entry.base) return null;
  const base = entry.base;
  if (row.quota && typeof base.quotaRemain === "number" && typeof base.quotaTotal === "number") {
    const used = base.quotaRemain - row.quota.remain;
    if (used > 0.0005) {
      return { kind: "quota", amount: Math.round(used * 100) / 100, unit: text(row.quota.unit, "") };
    }
  }
  if (typeof row.balance === "number" && typeof base.balance === "number" && base.currency === row.currency) {
    const used = base.balance - row.balance;
    if (used > 0.000001) {
      return { kind: "money", amount: Math.round(used * 10000) / 10000, currency: row.currency };
    }
  }
  return null;
}

/** Spend recorded for each of the last `limit` days, provider by provider. */
function dailyUsage(history, limit = 7) {
  const days = history.days || {};
  return Object.keys(days).sort().slice(-limit).map((day) => {
    const items = [];
    for (const [id, entry] of Object.entries(days[day] || {})) {
      if (!entry || !entry.base || !entry.last) continue;
      const base = entry.base;
      const last = entry.last;
      if (typeof base.quotaRemain === "number" && typeof last.quotaRemain === "number") {
        const used = base.quotaRemain - last.quotaRemain;
        if (used > 0.0005) {
          items.push({ id, kind: "quota", amount: Math.round(used * 100) / 100, unit: text(last.unit, "") });
        }
        continue;
      }
      if (typeof base.balance === "number" && typeof last.balance === "number" && base.currency === last.currency) {
        const used = base.balance - last.balance;
        if (used > 0.000001) {
          items.push({ id, kind: "money", amount: Math.round(used * 10000) / 10000, currency: last.currency });
        }
      }
    }
    return { day, items };
  });
}

/** Keep the day's first sample as the baseline and refresh the last one. */
function recordHistory(history, snapshot) {
  const day = dayKey();
  const bucket = (history.days[day] = history.days[day] || {});
  for (const row of snapshot.providers) {
    if (!row.ok) continue;
    const sample = sampleOf(row);
    const entry = bucket[row.id];
    bucket[row.id] = entry ? { base: entry.base, last: sample } : { base: sample, last: sample };
  }
  const keys = Object.keys(history.days).sort();
  while (keys.length > HISTORY_DAYS) delete history.days[keys.shift()];
  writeHistory(history);
}

/* ----------------------------------------------------------------- providers */

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${body.slice(0, 160)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`返回不是 JSON：${body.slice(0, 160)}`);
  }
}

/**
 * DeepSeek's documented balance endpoint.
 * @param provider - the configured provider.
 * @param timeoutMs - request deadline.
 * @returns balance / currency / granted / topped-up split.
 */
async function queryDeepSeek(provider, timeoutMs) {
  if (provider.apiKey.trim() === "") throw new Error("未填写 API Key");
  const document = await fetchJson(provider.url || DEEPSEEK_BALANCE_URL, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${provider.apiKey.trim()}`
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const infos = Array.isArray(document?.balance_infos) ? document.balance_infos : [];
  const primary = isRecord(infos[0]) ? infos[0] : {};
  const balance = toNumber(primary.total_balance);
  return {
    balance,
    currency: text(primary.currency, ""),
    quota: null,
    extra: {
      available: document?.is_available !== false,
      granted: toNumber(primary.granted_balance),
      topped: toNumber(primary.topped_up_balance)
    }
  };
}

/**
 * The signed-in balance route, the way dsh-whale-widget does it: DSH's own
 * `deepseekAccount` service already holds the account session, so a user who
 * signed into the client gets a balance with no API key at all.
 *
 * Read it as an OPTIONAL service through ctx.get and never put it in `inject`:
 * a host without the service would otherwise wait for it forever and never
 * apply the plugin.
 * @param ctx - the plugin context.
 * @returns balance summed over the recharge and bonus wallets.
 */
async function queryDeepSeekAccount(ctx) {
  const account = typeof ctx.get === "function" ? ctx.get("deepseekAccount") : null;
  if (!account || typeof account.getBalance !== "function") {
    throw new Error("当前 DSH 没有账号服务");
  }
  const result = await account.getBalance({
    version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || "") || "unknown",
    locale: String(process.env.DSH_LOCALE || "") || "zh_CN",
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
  });
  if (!result) throw new Error("未登录 DeepSeek 账号（没有账号凭据）");
  if (result.status !== "ready") throw new Error(`账号余额接口未就绪（${String(result.status || "unknown")}）`);
  const usable = (list) => (Array.isArray(list) ? list : [])
    .filter((wallet) => wallet && Number.isFinite(Number(wallet.balance)));
  const rechargeWallets = usable(result.value);
  const bonusWallets = usable(result.bonusWallets);
  const all = rechargeWallets.concat(bonusWallets);
  if (all.length === 0) throw new Error("账号没有余额钱包");
  const currencyOf = (wallet) => String(wallet.currency || "CNY").toUpperCase();
  const preferred = all.find((wallet) => Number(wallet.balance) > 0 && currencyOf(wallet) === "CNY")
    ?? all.find((wallet) => Number(wallet.balance) > 0)
    ?? all.find((wallet) => currencyOf(wallet) === "CNY")
    ?? all[0];
  const currency = currencyOf(preferred);
  const sumOf = (list) => list
    .filter((wallet) => currencyOf(wallet) === currency)
    .reduce((sum, wallet) => sum + Number(wallet.balance), 0);
  const recharge = sumOf(rechargeWallets);
  const bonus = sumOf(bonusWallets);
  return {
    balance: Number((recharge + bonus).toFixed(6)),
    currency,
    quota: null,
    extra: { route: "account", recharge, bonus }
  };
}

/**
 * Any other endpoint, driven entirely by configuration.
 * @param provider - the configured provider.
 * @param timeoutMs - request deadline.
 * @returns what the extraction paths delivered.
 */
async function queryHttp(provider, timeoutMs) {
  if (provider.url.trim() === "") throw new Error("未填写接口地址");
  const headers = {};
  for (const [key, value] of Object.entries(provider.headers)) {
    headers[key] = fill(value, provider);
  }
  const init = {
    method: provider.method,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (provider.method === "POST" && provider.body !== "") {
    init.body = fill(provider.body, provider);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
  }
  const document = await fetchJson(fill(provider.url, provider), init);
  const extract = provider.extract;
  const balance = toNumber(readPath(document, extract.balance));
  const quotaRemain = toNumber(readPath(document, extract.quotaRemain));
  const quotaUsed = toNumber(readPath(document, extract.quotaUsed));
  const quotaTotal = toNumber(readPath(document, extract.quotaTotal));
  const remain = quotaRemain !== undefined
    ? quotaRemain
    : quotaTotal !== undefined && quotaUsed !== undefined
      ? Math.max(0, quotaTotal - quotaUsed)
      : undefined;
  const unit = text(readPath(document, extract.quotaUnit) ?? extract.quotaUnit, "");
  const plan = text(readPath(document, extract.planName), "");
  return {
    balance,
    currency: text(readPath(document, extract.currency) ?? extract.currency, ""),
    quota: quotaTotal !== undefined || remain !== undefined ? {
      remain: remain ?? 0,
      total: quotaTotal ?? 0,
      unit,
      plan
    } : null,
    extra: quotaUsed !== undefined ? { used: quotaUsed } : null
  };
}

function hasRenewal(provider) {
  return provider.refreshUrl.trim() !== "" && provider.refreshToken.trim() !== "";
}

/**
 * When a bearer token is a JWT, its own `exp` claim is the cheapest reliable
 * expiry signal — no extra request, and it works for every provider that hands
 * out a JWT. Returns milliseconds since the epoch, or 0 for an opaque token
 * (a `sk-…` key, a cookie header) whose lifetime we cannot read.
 * @param token - the raw credential string.
 * @returns {number} expiry in ms, or 0.
 */
function jwtExpiry(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = Number(payload && payload.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Should this provider be renewed before its next request rather than after a
 * 401? Renewing a little early keeps the panel green across the boundary: a
 * token that dies between two polls shows one red row for a whole interval.
 * The threshold is 20% of the token's own lifetime, capped at a day, so a
 * two-hour token renews in its last 24 minutes and a 30-day one its last day.
 * @param provider - the configured provider.
 * @param now - current time in ms.
 * @returns {boolean} true when a renewal should run first.
 */
function needsRenewal(provider, now) {
  if (!hasRenewal(provider)) return false;
  const expiresAt = jwtExpiry(provider.apiKey);
  if (expiresAt === 0) return false;
  const issuedAt = jwtIssuedAt(provider) || now;
  const lifetime = Math.max(60000, expiresAt - issuedAt);
  const threshold = Math.min(86400000, Math.max(60000, lifetime / 5));
  return expiresAt - now <= threshold;
}

/** Best-effort `iat` for a JWT, used only to size the renewal threshold. */
function jwtIssuedAt(provider) {
  const parts = String(provider.apiKey || "").split(".");
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const iat = Number(payload && payload.iat);
    return Number.isFinite(iat) && iat > 0 ? iat * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Trade a refresh token for a new access token, so a short-lived bearer keeps
 * working without the user re-capturing it from a browser.
 * @param provider - the configured provider holding refreshUrl/refreshToken.
 * @param timeoutMs - request deadline.
 * @returns { access, refresh } with the rotated refresh token when the
 *          endpoint returns a new one.
 */
async function renewProvider(provider, timeoutMs) {
  const headers = {};
  for (const [key, value] of Object.entries(provider.headers)) {
    const name = key.toLowerCase();
    if (name === "authorization" || name === "cookie") continue;
    headers[key] = fill(value, provider);
  }
  headers["content-type"] = "application/json";
  const response = await fetch(provider.refreshUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ refresh_token: provider.refreshToken }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`刷新令牌失败：HTTP ${response.status} ${body.slice(0, 160)}`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`刷新令牌返回不是 JSON：${body.slice(0, 160)}`);
  }
  const data = isRecord(parsed.data) ? parsed.data : parsed;
  const access = text(data.access_token ?? data.accessToken ?? parsed.access_token, "");
  const refresh = text(data.refresh_token ?? data.refreshToken ?? parsed.refresh_token, "");
  if (access === "") throw new Error("刷新令牌返回里没有 access_token");
  return { access, refresh: refresh === "" ? provider.refreshToken : refresh };
}

function isConfigured(provider) {
  if (provider.type === "deepseek") {
    return provider.apiKey.trim().length > 0 || provider.keyRef.trim().length > 0;
  }
  return provider.url.trim().length > 0;
}

/**
 * The key a provider should use, and where it came from.
 *
 * Order: the key typed into the panel, then the DSH credential named by
 * `keyRef` (resolved on every call — the store may change while we run), then
 * an environment variable of the same name. `keyRef` is not cached on purpose:
 * a key added in DSH settings must show up at the next poll, without a restart.
 *
 * @param ctx - the plugin context, used only to reach the optional service.
 * @param provider - the configured provider.
 * @returns { value, source } with source one of config|credential|env|none.
 */
async function resolveKey(ctx, provider) {
  if (provider.apiKey.trim() !== "") {
    return { value: provider.apiKey.trim(), source: "config", reason: "" };
  }
  const ref = provider.keyRef.trim();
  if (ref === "") return { value: "", source: "none", reason: "没有配置 keyRef" };
  let reason = "";
  const credentials = ctx.credentials ?? ctx.get?.("credentials");
  if (!credentials || typeof credentials.resolve !== "function") {
    reason = "credentials 服务不可用";
  } else {
    try {
      const resolved = await credentials.resolve(ref);
      if (resolved && typeof resolved.value === "string" && resolved.value.trim() !== "") {
        return { value: resolved.value.trim(), source: "credential", reason: "" };
      }
      reason = resolved ? `凭据 ${ref} 的值为空` : `DSH 凭据里没有 ${ref}`;
    } catch (error) {
      reason = `读取凭据 ${ref} 失败：${String(error?.message ?? error)}`;
    }
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    const fromEnv = process.env[ref];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
      return { value: fromEnv.trim(), source: "env", reason: "" };
    }
  }
  return { value: "", source: "none", reason };
}

/* ------------------------------------------------------------------- plugin */

/** The entry id this bundle patch inserts; the settings namespace follows it. */
const name = PLUGIN_NAME;

/** Route table, trust fence: the services this plugin needs. */
const inject = ["webServer", "connection", "credentials"];

function apply(ctx, rawConfig) {
  let config = loadConfig();
  if (isRecord(rawConfig) && rawConfig.pollIntervalSec !== undefined) {
    config = { ...config, pollIntervalSec: clamp(rawConfig.pollIntervalSec, config.pollIntervalSec, 30, 86400) };
  }

  const results = new Map();
  const history = readHistory();
  let snapshotAt = 0;
  let inflight = null;
  let timer = null;
  let midnightTimer = null;
  let stopped = false;

  function publicState() {
    const rows = config.providers.map((provider) => {
      const result = results.get(provider.id) || {};
      const enabled = provider.enabled;
      const status = !enabled ? "disabled" : (result.status ?? "pending");
      const row = {
        id: provider.id,
        label: provider.label,
        type: provider.type,
        enabled,
        configured: Boolean(result.keySource && result.keySource !== "none") || isConfigured(provider),
        status,
        ok: Boolean(result.ok),
        keySource: text(result.keySource, ""),
        hint: text(result.hint, ""),
        error: result.status === "error" ? text(result.error, "请求失败") : "",
        balance: typeof result.balance === "number" ? result.balance : null,
        currency: text(result.currency, ""),
        quota: result.quota && result.quota.total > 0 ? result.quota : null,
        extra: result.extra ?? null,
        latencyMs: typeof result.latencyMs === "number" ? result.latencyMs : null,
        updatedAt: typeof result.updatedAt === "number" ? result.updatedAt : null,
        /* Lets the panel warn before a bearer dies, and say whether it can heal
           itself: a provider with a refresh endpoint never needs the warning. */
        keyExpiresAt: jwtExpiry(provider.apiKey) || null,
        renewable: hasRenewal(provider),
        note: provider.note
      };
      row.today = usageOn(history, row);
      return row;
    });
    const totals = {};
    for (const row of rows) {
      if (!row.enabled || !row.ok || typeof row.balance !== "number" || row.currency === "") continue;
      totals[row.currency] = Math.round(((totals[row.currency] ?? 0) + row.balance) * 100) / 100;
    }
    return {
      at: snapshotAt,
      pollIntervalSec: config.pollIntervalSec,
      providers: rows,
      totals,
      history: dailyUsage(history, 7),
      configPath: CONFIG_PATH
    };
  }

  function publicConfig() {
    return {
      pollIntervalSec: config.pollIntervalSec,
      timeoutMs: config.timeoutMs,
      configPath: CONFIG_PATH,
      providers: config.providers.map((provider) => ({
        ...provider,
        apiKey: "",
        apiKeySet: provider.apiKey.trim().length > 0,
        refreshToken: "",
        refreshTokenSet: provider.refreshToken.trim().length > 0
      }))
    };
  }

  function refresh() {
    if (inflight !== null) return inflight;
    const timeoutMs = config.timeoutMs;
    const jobs = config.providers.map(async (provider) => {
      if (!provider.enabled) return { id: provider.id, status: "disabled", ok: false };
      const key = await resolveKey(ctx, provider);
      const startedAt = Date.now();
      if (provider.type === "deepseek") {
        let keyFailure = key.value === "" ? (key.reason || MISSING_DEEPSEEK_KEY) : "";
        if (key.value !== "") {
          try {
            const answer = await queryDeepSeek({ ...provider, apiKey: key.value }, timeoutMs);
            return {
              id: provider.id,
              status: "ok",
              ok: true,
              keySource: key.source,
              ...answer,
              latencyMs: Date.now() - startedAt,
              updatedAt: Date.now()
            };
          } catch (error) {
            keyFailure = String(error?.message ?? error);
          }
        }
        try {
          const answer = await queryDeepSeekAccount(ctx);
          return {
            id: provider.id,
            status: "ok",
            ok: true,
            keySource: "account",
            ...answer,
            latencyMs: Date.now() - startedAt,
            updatedAt: Date.now()
          };
        } catch (accountError) {
          return {
            id: provider.id,
            status: "unconfigured",
            ok: false,
            keySource: key.source,
            hint: `${MISSING_DEEPSEEK_KEY}（API Key 路：${keyFailure === "" ? "不可用" : keyFailure}；账号登录路：${String(accountError?.message ?? accountError)}）`,
            latencyMs: Date.now() - startedAt,
            updatedAt: Date.now()
          };
        }
      }
      if (provider.url.trim() === "") {
        return {
          id: provider.id,
          status: "unconfigured",
          ok: false,
          keySource: key.source,
          hint: key.reason,
          updatedAt: Date.now()
        };
      }
      const effective = { ...provider, apiKey: key.value };
      try {
        let answer;
        let renewed = null;
        try {
          if (needsRenewal(provider, Date.now())) {
            renewed = await renewProvider(provider, timeoutMs);
            provider.apiKey = renewed.access;
            provider.refreshToken = renewed.refresh;
            saveConfig(config);
          }
          answer = await queryHttp(renewed ? { ...provider } : effective, timeoutMs);
        } catch (error) {
          const message = String(error?.message ?? error);
          if (!/HTTP 401/.test(message) || !hasRenewal(provider)) throw error;
          renewed = await renewProvider(provider, timeoutMs);
          provider.apiKey = renewed.access;
          provider.refreshToken = renewed.refresh;
          saveConfig(config);
          answer = await queryHttp({ ...provider }, timeoutMs);
        }
        return {
          id: provider.id,
          status: "ok",
          ok: true,
          keySource: key.source,
          ...answer,
          latencyMs: Date.now() - startedAt,
          updatedAt: Date.now()
        };
      } catch (error) {
        const message = String(error?.message ?? error);
        return {
          id: provider.id,
          status: "error",
          ok: false,
          keySource: key.source,
          error: message === "The operation was aborted due to timeout" ? "请求超时" : message,
          latencyMs: Date.now() - startedAt,
          updatedAt: Date.now()
        };
      }
    });
    inflight = Promise.all(jobs)
      .then((list) => {
        for (const row of list) results.set(row.id, row);
        snapshotAt = Date.now();
        const snapshot = publicState();
        recordHistory(history, snapshot);
        try {
          mkdirSync(dirname(STATE_MIRROR_PATH), { recursive: true });
          writeFileSync(STATE_MIRROR_PATH, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
        } catch {
          /* the mirror is a diagnostic, never a reason to fail a refresh */
        }
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await refresh();
      } catch {
        /* refresh never rejects; this is belt and braces */
      }
      if (!stopped) schedule();
    }, config.pollIntervalSec * 1000);
    timer.unref?.();
  }

  /** One capture just after local midnight, so 今日使用 starts from a real baseline. */
  function scheduleMidnight() {
    if (midnightTimer !== null) clearTimeout(midnightTimer);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
    midnightTimer = setTimeout(async () => {
      if (stopped) return;
      try {
        await refresh();
      } catch {
        /* a failed capture just means no new baseline for today */
      }
      if (!stopped) scheduleMidnight();
    }, Math.max(60000, next.getTime() - now.getTime()));
    midnightTimer.unref?.();
  }

  function guard(req, res) {
    const rejection = ctx.connection?.requestRejection?.(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return false;
    }
    return true;
  }

  function sendJson(res, status, value) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(value));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("请求体过大"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const stateHandler = (req, res) => {
    if (!guard(req, res)) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD");
      res.end();
      return;
    }
    sendJson(res, 200, publicState());
  };

  const configHandler = async (req, res) => {
    if (!guard(req, res)) return;
    if (req.method === "GET" || req.method === "HEAD") {
      sendJson(res, 200, publicConfig());
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD, POST");
      res.end();
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      return;
    }
    if (!isRecord(body)) {
      sendJson(res, 400, { ok: false, error: "请求体必须是对象" });
      return;
    }
    const next = { ...config };
    if (body.pollIntervalSec !== undefined) {
      next.pollIntervalSec = clamp(body.pollIntervalSec, config.pollIntervalSec, 30, 86400);
    }
    if (body.timeoutMs !== undefined) {
      next.timeoutMs = clamp(body.timeoutMs, config.timeoutMs, 1000, 60000);
    }
    if (Array.isArray(body.providers)) {
      const merged = [];
      const seen = new Set();
      for (const raw of body.providers.slice(0, MAX_PROVIDERS)) {
        if (!isRecord(raw) || !PROVIDER_ID_RE.test(String(raw.id ?? ""))) continue;
        const previous = config.providers.find((provider) => provider.id === raw.id) ?? null;
        const provider = normalizeProvider(raw, previous);
        if (raw.apiKey === null) provider.apiKey = "";
        else if (typeof raw.apiKey === "string" && raw.apiKey.trim() !== "") provider.apiKey = raw.apiKey.trim();
        else if (previous) provider.apiKey = previous.apiKey;
        if (raw.refreshToken === null) provider.refreshToken = "";
        else if (typeof raw.refreshToken === "string" && raw.refreshToken.trim() !== "") provider.refreshToken = raw.refreshToken.trim();
        else if (previous) provider.refreshToken = previous.refreshToken;
        if (seen.has(provider.id)) continue;
        seen.add(provider.id);
        merged.push(provider);
      }
      if (merged.length > 0) next.providers = merged;
    }
    const saved = saveConfig(next);
    config = next;
    results.clear();
    snapshotAt = 0;
    schedule();
    refresh().catch(() => {});
    sendJson(res, 200, { ok: saved, config: publicConfig(), state: publicState() });
  };

  const refreshHandler = async (req, res) => {
    if (!guard(req, res)) return;
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST");
      res.end();
      return;
    }
    try {
      sendJson(res, 200, await refresh());
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: "exact", path: STATE_ROUTE, handler: stateHandler }),
      ctx.webServer.register({ kind: "exact", path: CONFIG_ROUTE, handler: configHandler }),
      ctx.webServer.register({ kind: "exact", path: REFRESH_ROUTE, handler: refreshHandler })
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* a route already gone is not a failure */
        }
      }
    };
  }, `${PLUGIN_NAME}: local routes`);

  ctx.effect(() => {
    stopped = false;
    refresh().catch(() => {});
    schedule();
    scheduleMidnight();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (midnightTimer !== null) clearTimeout(midnightTimer);
      midnightTimer = null;
    };
  }, `${PLUGIN_NAME}: poll loop`);
}

export { apply, inject, name, DEFAULT_CONFIG, CONFIG_PATH, STATE_ROUTE, CONFIG_ROUTE, REFRESH_ROUTE };