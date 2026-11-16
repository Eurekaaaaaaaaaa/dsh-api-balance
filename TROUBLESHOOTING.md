# 出问题时怎么办

这页只写**动作**：先看哪里、改哪个文件、跑哪条命令。原理放在每节最后一行，方便判断「是不是同一类问题」。

版本：1.0.0 · 宿主半 `index.js` · 浏览器半 `client.js` · 数据在 `~/.dsh/api-balance/`

---

## 0. 先看三个地方（90% 的问题在这三处就有答案）

| 看什么 | 在哪 | 能看到什么 |
|---|---|---|
| 面板 | 点胶囊 → 每行右侧的错误原文 | `HTTP 401 {"code":"TOKEN_EXPIRED"…}` 这种**原始**报错，不要只看红点 |
| 状态快照 | `%USERPROFILE%\.dsh\api-balance\last-state.json` | 每次刷新写一份：每家 `status / balance / quota / today / renewable / keyExpiresAt`，**不含密钥** |
| 历史 | `%USERPROFILE%\.dsh\api-balance\history.json` | 每日基线（`days.<日期>.<来源>.base / .last`），「今日使用」就是 last 与 base 的差 |

命令行看快照（GBK 控制台里中文会乱码，用 Python 读）：

```bat
python -c "import json,io;s=json.load(io.open(r'%USERPROFILE%\.dsh\api-balance\last-state.json',encoding='utf-8'));[print(p['id'],p['status'],p.get('balance'),p.get('quota'),p.get('error','')) for p in s['providers']]"
```

> 原理：数据全部由宿主侧抓取，浏览器只负责显示。所以**面板红 ≠ 浏览器坏了**，几乎总是某一家的凭据或接口变了。

---

## 1. 胶囊不见了

1. 设置 → **API 余额** → 「显示位置」是不是选了「窗口标题栏」，而当前不是桌面窗口（浏览器形态）？那种情况下会退回会话标题栏，可能被别的东西挡住。
2. 悬浮模式下胶囊可能在屏幕外：双击（拖到别处后）没反应就**手动改回默认位置**——设置里切一次「窗口标题栏」再切回「悬浮气泡」，或直接在控制台执行 `localStorage.removeItem("dsh-api-balance:pos")` 后刷新页面。
3. 还是没有：设置 → 插件 → 把 `dsh-api-balance` 关掉再打开（不要只刷新页面，插件 fiber 要重建）。

> 原理：胶囊挂在 `shell.overlay` 的三个座位（70 悬浮 / 71 面板 / 72 标题栏）。座位没注册上 = 插件没加载；注册上了但看不见 = 位置/层级问题。

---

## 2. 胶囊点不动、拖不动

先确认是不是**落在窗口顶部 40px 的拖拽带**里：桌面壳为窗口拖动铺了一条 `[data-windows-titlebar] .mP3x-q_frame:before{height:40px; -webkit-app-region:drag}`，落在这里的按压会被 Windows 直接吃掉，网页收不到。

- 处理：把胶囊往下拖出 40px（悬浮模式自带的 clamp 已经会避开这一带；手动拖到顶部时可能贴进去）。
- 拖不动也点不动、且不在顶部：把胶囊拖到页面中间再试；仍不行就重载插件（关闭→开启）。

> 原理：胶囊只有 `onPointerDown` 记坐标、位移 >4px 才算拖拽并捕获指针；`pointerup` 位移 ≤6px 直接切换面板。捕获发生过早会把 `click` 重定向到外层，导致「只能拖不能点」——这条曾经踩过两次，改代码时不要退回「按下就 capture」。

---

## 3. 某一家数字变红 / 报 401

### 3.1 DeepSeek（`keySource: "account"`）

走 DSH 自己的账号登录，不存 Key。红了通常是 DSH 掉登录：重新登录 DSH，再点面板里的 ↻。
若你想改用 API Key：面板 → 该行 → 填 `apiKey`（`sk-…`），保存后 `keySource` 会变成 `config`。

### 3.2 FastAI（Bearer 令牌，会自动续期）

先看 `last-state.json` 里这一家的两个字段：

- `renewable: true` + `keyExpiresAt` 还没到 → **不用管**，下一次刷新（默认 300 秒）会自动换新。
- `keyExpiresAt` 已过 / 报 `TOKEN_EXPIRED` / `renewable: false` → 刷新令牌死了，必须**重新登录一次**（Cloudflare Turnstile 要求真人，没法脚本登录）：

```bat
:: 1) 开一个带调试端口的 Edge（配置复制到 %TEMP%\edge-cdp4，你自己的 Edge 不受影响）
"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9224 --user-data-dir="%TEMP%\edge-cdp4" https://www.fastaitoken.com/login
```

```bat
:: 2) 在弹出的窗口里登录（过掉人机校验），然后回到命令行：
cd /d <本插件目录>
node tools\harvest-fastai.mjs --port 9224 --wait 600
```

看到 `{"ok":true,"balance":…,"refreshed":true}` 就成了：脚本**先调 `/api/v1/auth/refresh` 验证，通了才写** `config.json`（旧文件备份为 `config.json.bak`），并自动填好 `refreshUrl`、`headers`、`extract`。之后插件按「access 剩余寿命不足 20%（上限 24h、下限 60s）就先换新」滚动维持，不用再登录。

只清死令牌、不写新值：

```bat
node tools\harvest-fastai.mjs --clear
```

> 原理：FastAI 是 sub2api 分支，`refresh_token` 是轮换式的——**用一次旧值就作废**。所以 `sk-` 开头的 API Key 查不了余额（`/api/v1/auth/me` 用它返回 401 `INVALID_TOKEN`），也没有长期 PAT；登录接口在凭据校验**之前**就要过 Turnstile。省事的唯一办法就是把 access+refresh 这一对存下来滚动续期。

### 3.3 百度千帆（配额，靠控制台 Cookie）

`quota.remain` 会掉或报 401，说明控制台会话过期：

1. 用你的 Edge 打开 <https://console.bce.baidu.com/qianfan/resource/token-plan> 并登录（如果已经登录，刷新一下页面即可）。
2. F12 → Network → 随便点一个 `console.bce.baidu.com` 的请求 → 复制整条 `cookie:` 请求头。
3. 设置 → API 余额 → 千帆那一行 → 「密钥/凭据」粘贴进去 → 保存。

> 原理：插件调 `GET https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource`，只带 `cookie: {{apiKey}}`；`remain = totalCredits − usedCredits`。Cookie 失效时 BCE 会返回登录页 HTML 或 401，两者都会在面板里显示原文。

### 3.4 自定义 HTTP 源

只在自己填过地址（或已启用）后才出现在面板里。失败时点开该行看 `url / headers / extract` 是否还对；`extract` 用点路径，支持 `a[0].b`。

---

## 4. 改了代码但不生效

```bat
cd /d <本插件目录>
node --check client.js && node --check index.js
```

- **改了 `client.js`**：插件宿主会重新供包，但页面里的模块是旧的 → 必须 **Ctrl+R 刷新页面**。刷新后还不对，再在 设置 → 插件 里关掉再打开 `dsh-api-balance`。
- **改了 `index.js`**：必须重载插件（关闭→开启）才会重建宿主 fiber。
- **改了 `package.json` 的 `version`**：重载一次即可，页面缓存按版本失效。

> 原理：`dsh.client` 的产物由宿主按版本供出，浏览器端拿的是启动时那一份；`fiberPhase: active` 只说明宿主半区起来了，不代表页面用的是新代码。

---

## 5. 「重启 DSH」「小鲸鱼」气泡也不见了

**先判断是不是本插件造成的**：设置 → 插件 → 关掉 `dsh-api-balance`，刷新页面。两个气泡回来了，才是本插件；没回来就是别的原因。

这两家的 UI 不走 React 槽位，而是往宿主**启动时**收集的 `webserver/index-inject` 表里塞一行脚本（桌面壳的 `index.html` 是静态直出，`tapIndex` 永远不生效）。这张表在宿主启动那一刻冻结，**没有任何刷新路径**：页面重载只是重放冻结的那一份，插件晚一步注册就永远进不去。

- 处理：**完整退出 DSH 应用**（不是刷新页面、不是重启会话），再启动一次。
- 别做的：反复 Ctrl+R、反复重载插件——都不会把那一行补进表。

---

## 6. 设置里找不到「API 余额」

设置分区 id 是 `api-balance`，order 55，宿在半区注册。找不到就是插件没加载：

1. 设置 → 插件 → `dsh-api-balance` 是否启用、`fiberPhase` 是否 `active`；
2. 关掉再打开；
3. 仍未出现 → 检查 `package.json` 是否被改坏（`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`）。

---

## 7. 数据错了 / 想从头来

| 想清掉什么 | 删什么 | 后果 |
|---|---|---|
| 今日使用与 30 天历史 | `%USERPROFILE%\.dsh\api-balance\history.json` | 下次 00:00 重建基线，今日从 0 开始 |
| 某一家配置 | 设置里该行改空并保存（`apiKey` 传空字符串会保留，传 `null` 才清空） | 该行显示未配置 |
| FastAI 刷新令牌 | `node tools\harvest-fastai.mjs --clear` | 只清 `refreshToken`，access 仍可用到过期 |
| 全部配置 | `config.json` 改名后重载插件 | 回到四条预设默认值 |

`config.json` 是唯一存密钥的地方（0600，只在属主可读）。改之前先复制一份：

```bat
copy "%USERPROFILE%\.dsh\api-balance\config.json" "%USERPROFILE%\.dsh\api-balance\config.json.bak"
```

面板编辑页保存时**不会**自动备份，只有 `harvest-fastai.mjs` 会。

---

## 8. 环境层面的坑

- **`ops_bash` 报 `EXECUTOR_UNAVAILABLE … link awk.exe`**：dsh-ops 0.5.2 执行树硬链接竞态，重试即可；连续失败时先确认没有长跑的后台 bash job（杀干净再试）。原生文件工具（读/写/删）不受影响。
- **控制台中文乱码**：本机代码页是 GBK。Python 打中文一律 `PYTHONIOENCODING=utf-8`；`.bat` 里不写中文（纯 ASCII）。
- **拿 CDP 抓数据**：`--remote-debugging-port` 必须配**非默认** `--user-data-dir`（Edge 157 起对默认配置目录禁用调试端口）。复制配置目录时 Cookies 是独占锁的，得先退干净 Edge 再 robocopy。
- **整站 401**：插件四条路由都过 `connection.requestRejection`，只认同源浏览器请求；`curl` 拿 401 是**设计**，不是故障。WorkBuddy 那条兄弟路由可用 `curl -H "Host: 127.0.0.1:<端口>"` 绕过。

---

## 9. 关键路径速查

```
<本插件目录>\        插件本体（index.js 宿主 / client.js 浏览器）
  tools\harvest-fastai.mjs           FastAI 重新登录后抓令牌（先验证再写）
  TROUBLESHOOTING.md                 本页
%USERPROFILE%\.dsh\api-balance\
  config.json                        配置 + 密钥（0600），面板可编辑
  last-state.json                    最近一次刷新的快照（无密钥）
  history.json                       每日基线与当天用量
```

界面座位（改代码时别弄丢）：

| 座位 | id | order |
|---|---|---|
| `shell.overlay` 悬浮胶囊 | `dsh-api-balance` | 70 |
| `shell.overlay` 面板 | `dsh-api-balance-panel` | 71 |
| `shell.overlay` 窗口标题栏 | `dsh-api-balance-titlebar` | 72 |
| `conversation.session.header.utilities`（浏览器形态） | `dsh-api-balance-header` | 28 |
| `conversation.session.header.actions`（⚙） | `dsh-api-balance-settings` | 5 |
| `settings.section` / `.icon` | `api-balance` | 55 |