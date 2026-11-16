/**
 * FastAI 令牌抓取器（免依赖，只用 Node 22 自带的 fetch / WebSocket）。
 *
 * 用途：FastAI（sub2api 分支）的余额必须用登录态的 Bearer 查，而它的
 *       refresh_token 是轮换式的、登录又必须先过 Cloudflare Turnstile，
 *       所以纯 HTTP 自动登录做不到。这里走"一次登录、长期自动续期"路线：
 *
 *   1) 用带调试端口的 Edge 打开 fastaitoken.com 并登录一次；
 *   2) 跑本脚本，它从页面 localStorage 读出 auth_token + refresh_token；
 *   3) 先用 /api/v1/auth/refresh 验证这对令牌是不是活的（死令牌绝不写入，
 *      否则会把配置里的可用 access 覆盖掉）；
 *   4) 验证通过才写进 config.json（并备份 .bak），之后插件自己滚动续期。
 *
 * 用法：
 *   node tools/harvest-fastai.mjs                 # 默认端口 9224，抓一次就退出
 *   node tools/harvest-fastai.mjs --port 9223     # 换端口
 *   node tools/harvest-fastai.mjs --wait 600      # 等用户登录，最多 10 分钟
 *   node tools/harvest-fastai.mjs --clear          # 只清掉配置里失效的 refresh_token
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CONFIG_PATH = join(homedir(), ".dsh", "api-balance", "config.json");
const REFRESH_URL = "https://www.fastaitoken.com/api/v1/auth/refresh";
const ME_URL = "https://www.fastaitoken.com/api/v1/auth/me?timezone=Asia%2FShanghai";

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return true;
  return value;
}

const PORT = Number(arg("port", 9224));
const WAIT_SEC = Number(arg("wait", 0));
const CLEAR_ONLY = arg("clear", false) === true;
const CDP = `http://127.0.0.1:${PORT}`;

function readConfig() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`找不到配置：${CONFIG_PATH}`);
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function writeFastai(access, refresh, expiresAt) {
  const config = readConfig();
  const row = (config.providers || []).find((item) => item.id === "fastai");
  if (!row) throw new Error("配置里没有 fastai 这一项");
  copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak");
  row.apiKey = access;
  row.refreshToken = refresh;
  row.refreshUrl = REFRESH_URL;
  row.url = ME_URL;
  row.type = "http";
  row.enabled = true;
  row.method = "GET";
  row.headers = { accept: "application/json", authorization: "Bearer {{apiKey}}" };
  row.extract = { balance: "data.balance", currency: "USD" };
  row.note = expiresAt
    ? `已配置刷新接口，access 于 ${new Date(expiresAt).toLocaleString("zh-CN")} 到期前自动续期（refresh_token 每次轮换并写回）`
    : "已配置刷新接口，access 过期前自动续期（refresh_token 每次轮换并写回）";
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

async function listPages() {
  const answer = await fetch(`${CDP}/json/list`);
  if (!answer.ok) throw new Error(`CDP ${CDP} 返回 HTTP ${answer.status}`);
  return answer.json();
}

/** 在匹配的页面里执行一段表达式，返回它的值。 */
async function evaluate(wsUrl, expression) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP evaluate 超时")), 8000);
      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || "CDP error"));
        else resolve(message.result && message.result.result ? message.result.result.value : undefined);
      });
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: false }
      }));
    });
    return result;
  } finally {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

async function readTokens() {
  const pages = await listPages();
  const page = pages.find((item) => item.type === "page" && /fastaitoken\.com/.test(item.url || ""));
  if (!page) return null;
  const raw = await evaluate(page.webSocketDebuggerUrl,
    "JSON.stringify({a:localStorage.getItem('auth_token')||'',r:localStorage.getItem('refresh_token')||'',e:localStorage.getItem('token_expires_at')||''})");
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed.a || !parsed.r) return null;
  return { access: parsed.a, refresh: parsed.r, expires: Number(parsed.e) || 0, url: page.url };
}

/** 只有 refresh 真能用，这一对令牌才算"活的"。 */
async function verify(refresh) {
  const answer = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refresh_token: refresh })
  });
  const body = await answer.text();
  if (!answer.ok) return { ok: false, status: answer.status, body: body.slice(0, 200) };
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, status: answer.status, body: body.slice(0, 200) };
  }
  const payload = (data && data.data) || {};
  const access = payload.access_token || payload.accessToken || payload.token;
  const rotated = payload.refresh_token || payload.refreshToken || "";
  if (!access) return { ok: false, status: answer.status, body: body.slice(0, 200) };
  return { ok: true, access, refresh: rotated || refresh };
}

async function balanceOf(access) {
  const answer = await fetch(ME_URL, { headers: { authorization: `Bearer ${access}`, accept: "application/json" } });
  if (!answer.ok) return null;
  const data = await answer.json();
  return data && data.data ? data.data.balance : null;
}

async function main() {
  if (CLEAR_ONLY) {
    const config = readConfig();
    const row = (config.providers || []).find((item) => item.id === "fastai");
    if (!row) throw new Error("配置里没有 fastai");
    copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak");
    row.refreshToken = "";
    row.note = "未持有可用刷新令牌（旧的已被轮换作废）。重新登录一次并运行 tools/harvest-fastai.mjs 写入新的 access+refresh。";
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    console.log("已清空 fastai.refreshToken（access 保留，仍可查余额）");
    return;
  }

  const deadline = Date.now() + WAIT_SEC * 1000;
  let seen = "";
  for (;;) {
    let tokens = null;
    try {
      tokens = await readTokens();
    } catch (error) {
      console.log(`读不到令牌：${error.message}`);
    }
    if (tokens) {
      if (tokens.refresh !== seen) {
        seen = tokens.refresh;
        const result = await verify(tokens.refresh);
        if (result.ok) {
          const balance = await balanceOf(result.access);
          writeFastai(result.access, result.refresh, tokens.expires);
          console.log(JSON.stringify({
            ok: true,
            balance,
            accessLen: result.access.length,
            refreshLen: result.refresh.length,
            refreshed: result.refresh !== tokens.refresh,
            page: tokens.url
          }, null, 2));
          console.log("已写入 config.json（旧文件备份为 config.json.bak）。刷新插件面板即可看到，无需重启。");
          return;
        }
        console.log(`令牌 ${tokens.refresh.slice(0, 12)}… 验证失败：HTTP ${result.status} ${result.body}`);
      }
    }
    if (Date.now() >= deadline) {
      console.log("超时：没有拿到可用的新令牌。请在带调试端口的 Edge 窗口里重新登录 FastAI 后再运行本脚本。");
      process.exitCode = 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

mkdirSync(dirname(CONFIG_PATH), { recursive: true });
main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
