/**
 * dsh-api-balance · Client half.
 *
 * One widget that can live in two seats, chosen in its own settings:
 *
 *   float   — a draggable pill in `shell.overlay` (the default)
 *   header  — in the window title bar on the desktop shell, otherwise inline in
 *             `conversation.session.header.utilities`, left of the hot-restart
 *             control
 *
 * The panel and the DSH Settings page are separate seats: the panel is portalled
 * to `document.body` so no transformed/clipped slot ancestor can move it, and
 * `settings.section` puts the same placement + interval controls into the app's
 * own Settings window.
 *
 * Everything is plain ESM + React.createElement: no build step, no JSX. Data
 * comes from this package's own loopback routes, served by index.js.
 */

window.__ModuleLoader__.load({
  id: "dsh-api-balance",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    /* The window-titlebar pill has to sit outside every app layer: the
       overlay seat lives inside the frame, so a `position:fixed` child there
       is clipped by the frame that contains it. react-dom is in the shell's
       shared module table (dsh-better-sidebar and dsh-config-manager both
       require it), and the shell pairs it with the same React instance, so
       portalling to <body> is available in practice. If any host does not
       ship it, `createPortal` stays null and the seat falls back to rendering
       in place — narrower on screen, never broken. */
    let createPortal = null;
    try {
      const ReactDOM = require("react-dom");
      if (ReactDOM && typeof ReactDOM.createPortal === "function") createPortal = ReactDOM.createPortal;
    } catch {
      createPortal = null;
    }

    /* Isolation boundary. Every seat this plugin occupies is a shared React
       tree owned by the shell: a throw inside one entry unmounts the whole
       list, which is how this plugin could take unrelated bubbles (the
       hot-restart button, the whale) down with it. A boundary confines a
       failure to this plugin's own slot entry. */
    const ReactComponent = React.Component;
    const Guard = typeof ReactComponent === "function"
      ? class Guard extends ReactComponent {
          constructor(props) {
            super(props);
            this.state = { failed: false };
          }
          static getDerivedStateFromError() {
            return { failed: true };
          }
          componentDidCatch(error) {
            console.warn("[dsh-api-balance] render failed, entry hidden:", error);
          }
          render() {
            return this.state.failed ? null : this.props.children;
          }
        }
      : function Passthrough(props) {
          return props.children;
        };

    const NS = "dsh-api-balance";
    const STATE_ROUTE = "/plugins/dsh-api-balance/state";
    const CONFIG_ROUTE = "/plugins/dsh-api-balance/config";
    const REFRESH_ROUTE = "/plugins/dsh-api-balance/refresh";
    const WB_ROUTE = "/plugins/dsh-connect-workbuddy/account-credits";
    const POLL_MS = 5000;
    const WB_POLL_MS = 60000;
    const WB_REGION_KEY = "dsh-api-balance:wb-region";
    const PLACE_KEY = "dsh-api-balance:placement";
    const POS_KEY = "dsh-api-balance:pos";
    const CUSTOM_RE = /^(custom|source-)/;

    /* Logos are inline SVG data URIs rather than remote favicons: the GUI page's
       CSP (and an offline machine) refuse an <img src="https://…">, so every row
       silently fell back to a grey letter. A data URI always paints. */
    const brandIcon = (from, to, glyph) =>
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        + '<stop offset="0" stop-color="' + from + '"/><stop offset="1" stop-color="' + to + '"/>'
        + "</linearGradient></defs>"
        + '<rect width="32" height="32" rx="9" fill="url(#g)"/>'
        + '<text x="16" y="22.5" text-anchor="middle"'
        + ' font-family="Segoe UI,Microsoft YaHei,Arial,sans-serif"'
        + ' font-size="17" font-weight="700" fill="#fff">' + glyph + "</text></svg>");

    const ICONS = {
      deepseek: brandIcon("#4D6BFE", "#2F4BE0", "D"),
      qianfan: brandIcon("#3B82F6", "#2932E1", "千"),
      fastai: brandIcon("#8B5CF6", "#6D28D9", "F"),
      workbuddy: brandIcon("#34D399", "#059669", "W"),
      custom: brandIcon("#71717A", "#3F3F46", "+")
    };

    /* ------------------------------------------------------------ dictionary */

    const DICT = {
      zh: {
        "overlay.label": "API 余额",
        "pill.loading": "余额读取中…",
        "pill.none": "未配置余额来源",
        "pill.error": "{n} 个来源异常",
        "pill.hint": "点击查看详情 · 拖动可换位置 · 双击复位",
        "pill.dotOk": "正常：所有已启用来源都取到了数据",
        "pill.dotError": "异常：{who} 没取到数据（点开看原因）",
        "pill.dotPending": "正在读取…",
        "pill.dotIdle": "空闲：没有已启用的来源",
        "dot.separator": "、",
        "panel.title": "API 余额",
        "panel.refresh": "刷新",
        "panel.close": "收起",
        "panel.settings": "设置",
        "panel.history": "历史记录",
        "panel.save": "保存",
        "panel.saving": "保存中…",
        "panel.saved": "已保存",
        "panel.total": "合计",
        "panel.configPath": "配置文件",
        "panel.never": "尚未更新",
        "panel.unconfigured": "尚未配置，点行内「配置」填写接口",
        "panel.addCustom": "新增自定义 API",
        "panel.configure": "配置",
        "panel.url": "接口地址",
        "panel.credential": "凭证 / Cookie（留空表示不修改已保存的值）",
        "panel.credentialRef": "凭据名（DSH 凭据或环境变量，例如 DEEPSEEK_API_KEY）",
        "panel.headers": "请求头 JSON，可用 {{apiKey}} 与 {{env.名称}}",
        "panel.extract": "取数路径 JSON（balance / currency / quotaUsed / quotaRemain / quotaTotal / quotaUnit / planName）",
        "panel.refreshUrl": "令牌刷新接口（可选，401 时自动调用）",
        "panel.refreshToken": "刷新令牌（可选）",
        "panel.enabled": "启用",
        "panel.keySaved": "已保存",
        "panel.keyMissing": "未设置",
        "panel.today": "今日使用",
        "panel.expiresIn": "令牌约 {h} 小时后过期，且未配置刷新接口；到期后需重新抓取凭证",
        "panel.expired": "令牌已过期，需重新抓取凭证",
        "panel.keySource.config": "面板密钥",
        "panel.keySource.credential": "DSH 凭据",
        "panel.keySource.env": "环境变量",
        "panel.keySource.account": "DSH 账号登录",
        "panel.saveFailed": "保存失败",
        "settings.sectionLabel": "API 余额",
        "settings.sectionHint": "控制悬浮胶囊的位置与自动刷新间隔；余额数据来自本机插件目录下的配置文件。",
        "settings.liveTitle": "数据状态",
        "settings.pillTitle": "胶囊显示内容",
        "settings.pillHint": "不勾选的那家不出现在胶囊上。空间不够时按下面这条轮播：先看前两家，4 秒后换后两家。",
        "settings.pillCycle": "空间不足时轮播（前两个 ↔ 后两个）",
        "pill.name.deepseek": "DeepSeek",
        "pill.name.qianfan": "千帆",
        "pill.name.fastai": "FastAI",
        "pill.name.workbuddy": "WorkBuddy",
        "settings.openPanel": "打开面板",
        "settings.title": "设置",
        "settings.interval": "自动刷新间隔（秒，30–86400）",
        "settings.placement": "显示位置",
        "settings.float": "悬浮胶囊（可拖动，双击复位）",
        "settings.header": "窗口标题栏（缩小/关闭那一层 · 重启 DSH 左侧）",
        "settings.hint": "位置保存在本机浏览器，换设备各记各的。非桌面窗口时「标题栏」会退回会话标题栏；想临时挪动就用悬浮胶囊，按住拖动即可。",
        "history.title": "历史记录",
        "history.hint": "每天 00:00 抓一次基线，之后每次刷新累加当天用量；保留最近 30 天。",
        "history.empty": "还没有历史数据，今天先刷新一次。",
        "wb.label": "WorkBuddy",
        "wb.signedIn": "已登录",
        "wb.signedOut": "未登录",
        "wb.expiring": "即将过期",
        "wb.hint": "未检测到 WorkBuddy 插件或未登录",
        "wb.regionCn": "CN",
        "wb.regionGlobal": "全球",
        "panel.pointsUnit": "积分",
        "status.ok": "正常",
        "status.error": "异常",
        "status.unconfigured": "待配置",
        "status.disabled": "已停用",
        "status.pending": "读取中"
      },
      en: {
        "overlay.label": "API balance",
        "pill.loading": "Reading balances…",
        "pill.none": "No balance source configured",
        "pill.error": "{n} provider(s) failing",
        "pill.hint": "Click for details · drag to move · double-click to reset",
        "pill.dotOk": "Healthy: every enabled source reported",
        "pill.dotError": "Failing: {who} returned no data (open for the reason)",
        "pill.dotPending": "Reading…",
        "pill.dotIdle": "Idle: no source enabled",
        "dot.separator": ", ",
        "panel.title": "API balance",
        "panel.refresh": "Refresh",
        "panel.close": "Close",
        "panel.settings": "Settings",
        "panel.history": "History",
        "panel.save": "Save",
        "panel.saving": "Saving…",
        "panel.saved": "Saved",
        "panel.total": "Total",
        "panel.configPath": "Config file",
        "panel.never": "Not updated yet",
        "panel.unconfigured": "Not configured yet — open Configure in the row",
        "panel.addCustom": "Add custom API",
        "panel.configure": "Configure",
        "panel.url": "Endpoint URL",
        "panel.credential": "Credential / cookie (leave empty to keep the saved value)",
        "panel.credentialRef": "Credential name (DSH credential or env var, e.g. DEEPSEEK_API_KEY)",
        "panel.headers": "Headers JSON; {{apiKey}} and {{env.NAME}} are substituted",
        "panel.extract": "Extract paths JSON (balance / currency / quotaUsed / quotaRemain / quotaTotal / quotaUnit / planName)",
        "panel.refreshUrl": "Token refresh endpoint (optional, called on 401)",
        "panel.refreshToken": "Refresh token (optional)",
        "panel.enabled": "Enabled",
        "panel.keySaved": "saved",
        "panel.keyMissing": "unset",
        "panel.today": "used today",
        "panel.expiresIn": "Token expires in ~{h}h and no refresh endpoint is set; re-capture the credential when it does",
        "panel.expired": "Token expired — re-capture the credential",
        "panel.keySource.config": "panel key",
        "panel.keySource.credential": "DSH credential",
        "panel.keySource.env": "env var",
        "panel.keySource.account": "DSH account",
        "panel.saveFailed": "Save failed",
        "settings.sectionLabel": "API balance",
        "settings.sectionHint": "Controls the floating pill's placement and the auto-refresh interval; balance data comes from the config file in this plugin's data folder.",
        "settings.liveTitle": "Data status",
        "settings.pillTitle": "Pill contents",
        "settings.pillHint": "An unchecked wallet stays off the pill. When the strip is too narrow the pill cycles instead of squeezing: first two wallets, then the last two, every 4 seconds.",
        "settings.pillCycle": "Cycle when the strip is too narrow (first two ↔ last two)",
        "pill.name.deepseek": "DeepSeek",
        "pill.name.qianfan": "Qianfan",
        "pill.name.fastai": "FastAI",
        "pill.name.workbuddy": "WorkBuddy",
        "settings.openPanel": "Open panel",
        "settings.title": "Settings",
        "settings.interval": "Auto-refresh interval (seconds, 30–86400)",
        "settings.placement": "Placement",
        "settings.float": "Floating pill (draggable, double-click to reset)",
        "settings.header": "Window title bar (minimize/close row · left of restart DSH)",
        "settings.hint": "The placement is stored in this browser only. Outside the desktop window the title bar placement falls back to the session header; use the floating pill when you want to move it around.",
        "history.title": "History",
        "history.hint": "A baseline is taken at 00:00 and each refresh adds to the day; 30 days are kept.",
        "history.empty": "No history yet — refresh once today.",
        "wb.label": "WorkBuddy",
        "wb.signedIn": "signed in",
        "wb.signedOut": "signed out",
        "wb.expiring": "expiring",
        "wb.hint": "WorkBuddy plugin not found or signed out",
        "wb.regionCn": "CN",
        "wb.regionGlobal": "Global",
        "panel.pointsUnit": "pts",
        "status.ok": "ok",
        "status.error": "error",
        "status.unconfigured": "to configure",
        "status.disabled": "disabled",
        "status.pending": "reading"
      }
    };

    function createTranslator(ctx) {
      let bound = null;
      try {
        if (ctx && ctx.locale && typeof ctx.locale.bind === "function" && typeof ctx.effect === "function") {
          ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), "dsh-api-balance: dictionaries");
          bound = ctx.locale.bind(NS);
        }
      } catch {
        bound = null;
      }
      return (key) => {
        if (bound) {
          try {
            const value = bound(key);
            if (typeof value === "string" && value !== "" && value !== key) return value;
          } catch {
            /* fall through to the bundled dictionary */
          }
        }
        return DICT.zh[key] ?? key;
      };
    }

    /* ---------------------------------------------------------------- storage */

    function readStored(key, fallback) {
      try {
        const value = window.localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch {
        return fallback;
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* a browser with storage disabled keeps the in-memory value only */
      }
    }

    function removeStored(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }

    function readPlacement() {
      const value = readStored(PLACE_KEY, "float");
      return value === "header" ? value : "float";
    }

    /* The Windows caption strip is a `-webkit-app-region: drag` band painted over
       the frame's top edge (`.mP3x-q_frame:before`, height
       `--dsh-windows-titlebar-height`). Anything parked inside it stops
       receiving pointer events altogether — that is why a pill dragged near the
       top looked alive but answered neither clicks nor drags. Keep the floating
       pill out of that band. */
    function captionBand() {
      const root = document.documentElement;
      if (!root || !root.hasAttribute("data-windows-titlebar")) return 0;
      const raw = window.getComputedStyle(root).getPropertyValue("--dsh-windows-titlebar-height");
      const parsed = parseFloat(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 32;
    }

    function clampPosition(right, bottom, height) {
      const width = Math.max(96, window.innerWidth - 8);
      const box = Math.max(24, height || 32);
      const floor = window.innerHeight - captionBand() - 4 - box - 8;
      return {
        right: Math.round(Math.min(Math.max(8, right), width - 8)),
        bottom: Math.round(Math.min(Math.max(8, bottom), Math.max(8, floor))),
        height: Math.max(24, Math.round(height || 32))
      };
    }

    function readPosition() {
      try {
        const parsed = JSON.parse(readStored(POS_KEY, "null"));
        if (parsed && typeof parsed.right === "number" && typeof parsed.bottom === "number") {
          return clampPosition(parsed.right, parsed.bottom, parsed.height);
        }
      } catch {
        /* a corrupt position falls back to the default corner */
      }
      return null;
    }

    /* ------------------------------------------------------- workbuddy usage */

    const WB_USAGE_KEY = "dsh-api-balance:wb-usage";

    function todayKey() {
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      return `${now.getFullYear()}-${month}-${day}`;
    }

    function readWbUsage() {
      try {
        const parsed = JSON.parse(readStored(WB_USAGE_KEY, "null"));
        if (parsed && parsed.date === todayKey() && parsed.accounts && typeof parsed.accounts === "object") {
          return parsed;
        }
      } catch {
        /* a corrupt record only costs today's counter, not the readings */
      }
      return { date: todayKey(), accounts: {} };
    }

    /* WorkBuddy does not expose a "used today" figure, so the pill keeps one:
       the drop between two consecutive readings of the same account is what
       that account spent in between. A rise is a top-up (or the midnight
       allowance landing), never usage, so it only moves the baseline. */
    function trackWorkbuddy(accounts) {
      const usage = readWbUsage();
      const list = accounts.map((account) => {
        const id = String(account.id);
        const cell = usage.accounts[id] || { seen: null, used: 0 };
        const credits = typeof account.credits === "number" ? account.credits : null;
        if (credits !== null) {
          if (typeof cell.seen === "number" && credits < cell.seen) cell.used += cell.seen - credits;
          cell.seen = credits;
        }
        usage.accounts[id] = cell;
        return { ...account, today: cell.used || 0 };
      });
      writeStored(WB_USAGE_KEY, JSON.stringify(usage));
      return list;
    }

    /* ------------------------------------------------------- pill contents */

    const PILL_MASK_KEY = "dsh-api-balance:pill-mask";
    const PILL_CYCLE_KEY = "dsh-api-balance:pill-cycle";

    function readPillMask() {
      try {
        const parsed = JSON.parse(readStored(PILL_MASK_KEY, "null"));
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        /* a corrupt mask only costs the selection, not the readings */
      }
      return {};
    }

    function setPillMask(id, visible) {
      if (!data) return;
      const next = { ...data.pillMask, [id]: Boolean(visible) };
      writeStored(PILL_MASK_KEY, JSON.stringify(next));
      patchStore({ pillMask: next });
    }

    function togglePillCycle() {
      if (!data) return;
      const next = !data.pillCycle;
      writeStored(PILL_CYCLE_KEY, next ? "1" : "0");
      patchStore({ pillCycle: next });
    }

    /* ------------------------------------------------------------------ store */

    const listeners = new Set();
    const data = {
      state: null,
      link: null,
      config: null,
      draft: null,
      busy: false,
      message: "",
      failed: false,
      open: false,
      view: "main",
      placement: readPlacement(),
      workbuddy: null,
      wbRegion: readStored(WB_REGION_KEY, "cn") === "global" ? "global" : "cn",
      pillMask: readPillMask(),
      pillCycle: readStored(PILL_CYCLE_KEY, "1") !== "0"
    };

    function emit() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          /* one broken component must not stop the others */
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useStore() {
      const [, force] = React.useState(0);
      React.useEffect(() => subscribe(() => force((value) => value + 1)), []);
      return data;
    }

    function patchStore(patch) {
      Object.assign(data, patch);
      emit();
    }

    /* ------------------------------------------------------------------- http */

    async function readJson(url, init) {
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { accept: "application/json" },
          ...init
        });
        const status = response.status;
        if (!response.ok) return { ok: false, status, data: null };
        return { ok: true, status, data: await response.json() };
      } catch (error) {
        return { ok: false, status: 0, data: null, error: String(error) };
      }
    }

    function postJson(url, payload) {
      return readJson(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload ?? {})
      });
    }

    let pollTimer = null;
    let wbTimer = null;
    let wbInFlight = false;
    /* `polling` is the off switch both loops consult *after* their await: a
       poll already in flight when the plugin unloads would otherwise schedule
       the next tick and keep the timer chain alive with no owner. */
    let polling = false;

    async function pollState() {
      pollTimer = null;
      const answer = await readJson(STATE_ROUTE);
      if (answer.ok && answer.data) patchStore({ state: answer.data, link: { status: 200, error: "" } });
      else patchStore({ link: { status: answer.status, error: answer.error || "" } });
      if (!polling) return;
      pollTimer = window.setTimeout(pollState, POLL_MS);
    }

    async function pollWorkbuddy() {
      wbTimer = null;
      /* A manual refresh can land while a poll is in flight. Skipping the
         request is right, dropping the timer is not: that used to end the
         whole WorkBuddy chain until the next reload. */
      if (wbInFlight) {
        if (polling) wbTimer = window.setTimeout(pollWorkbuddy, 5000);
        return;
      }
      wbInFlight = true;
      try {
        const answer = await readJson(`${WB_ROUTE}?region=${encodeURIComponent(data.wbRegion)}`);
        const accounts = answer.ok && answer.data && Array.isArray(answer.data.accounts) ? answer.data.accounts : null;
        patchStore({
          workbuddy: accounts
            ? { available: true, accounts: trackWorkbuddy(accounts) }
            : { available: false, accounts: [] }
        });
      } finally {
        wbInFlight = false;
      }
      if (!polling) return;
      wbTimer = window.setTimeout(pollWorkbuddy, WB_POLL_MS);
    }

    /* A tab left open overnight wakes up with hour-old numbers; refresh the
       WorkBuddy block as soon as the tab is shown again. */
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      pollWorkbuddyOnce();
    }

    function pollWorkbuddyOnce() {
      if (wbTimer !== null) window.clearTimeout(wbTimer);
      wbTimer = null;
      if (wbInFlight) return;
      pollWorkbuddy();
    }

    function openPanel(view) {
      patchStore({ open: true, view: view || "main" });
      if (!data.config) loadConfig();
    }

    async function loadConfig() {
      const answer = await readJson(CONFIG_ROUTE);
      if (!answer.ok || !answer.data) return null;
      patchStore({ config: answer.data, draft: toDraft(answer.data) });
      return answer.data;
    }

    async function saveConfig(payload) {
      const answer = await postJson(CONFIG_ROUTE, payload);
      if (!answer.ok || !answer.data || answer.data.ok !== true) {
        patchStore({ failed: true, message: String((answer.data && answer.data.error) || "保存失败") });
        return false;
      }
      if (answer.data.config) patchStore({ config: answer.data.config, draft: toDraft(answer.data.config) });
      if (answer.data.state) patchStore({ state: answer.data.state });
      patchStore({ failed: false, message: "" });
      return true;
    }

    async function refreshNow() {
      patchStore({ busy: true });
      const answer = await postJson(REFRESH_ROUTE, {});
      if (answer.ok && answer.data) patchStore({ state: answer.data });
      patchStore({ busy: false });
    }

    function setPlacement(placement) {
      writeStored(PLACE_KEY, placement);
      patchStore({ placement });
    }

    function startPolling() {
      ensureStyles();
      if (polling) return;
      polling = true;
      pollState();
      pollWorkbuddy();
      try {
        document.addEventListener("visibilitychange", onVisible);
      } catch {
        /* no document: a headless harness */
      }
    }

    function stopPolling() {
      polling = false;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      if (wbTimer !== null) window.clearTimeout(wbTimer);
      pollTimer = null;
      wbTimer = null;
      try {
        document.removeEventListener("visibilitychange", onVisible);
      } catch {
        /* ignore */
      }
    }

    /* --------------------------------------------------------------- format */

    const SYMBOLS = { CNY: "¥", USD: "$", EUR: "€", JPY: "¥", GBP: "£" };

    function trimNumber(value) {
      if (!Number.isFinite(value)) return "—";
      return String(Math.round(value * 100) / 100);
    }

    function money(value, currency) {
      if (typeof value !== "number") return "";
      const symbol = SYMBOLS[currency] ?? (currency ? `${currency} ` : "");
      return symbol + trimNumber(value);
    }

    function formatCredits(value) {
      if (typeof value !== "number") return "—";
      return new Intl.NumberFormat().format(Math.round(value));
    }

    function quotaPercent(quota) {
      if (!quota || !(quota.total > 0)) return 0;
      return Math.max(0, Math.min(100, Math.round((quota.remain / quota.total) * 100)));
    }

    function relativeTime(at, t) {
      if (typeof at !== "number" || at <= 0) return t("panel.never");
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      return `${Math.round(minutes / 60)}h`;
    }

    function toneOf(status) {
      if (status === "ok") return "ok";
      if (status === "error") return "error";
      if (status === "disabled") return "disabled";
      if (status === "pending") return "pending";
      return "idle";
    }

    function usageText(usage) {
      if (!usage || typeof usage.amount !== "number") return "";
      if (usage.kind === "money") return money(usage.amount, usage.currency);
      return `${trimNumber(usage.amount)} ${usage.unit || ""}`.trim();
    }

    function iconFor(id) {
      if (ICONS[id]) return ICONS[id];
      return CUSTOM_RE.test(id) ? ICONS.custom : "";
    }

    /**
     * A bearer that dies in under a day is worth saying out loud — but only
     * when nothing can renew it. A provider with a refresh endpoint heals
     * itself, so staying quiet is correct there.
     * @param row - one provider row from the state route.
     * @param t - the translator.
     * @returns {string} a hint, or "" for a healthy or self-renewing source.
     */
    function renewHint(row, t) {
      if (!row || row.renewable) return "";
      const expiresAt = row.keyExpiresAt;
      if (typeof expiresAt !== "number" || expiresAt <= 0) return "";
      const left = expiresAt - Date.now();
      if (left <= 0) return t("panel.expired");
      if (left > 86400000) return "";
      const hours = Math.max(1, Math.round(left / 3600000));
      return t("panel.expiresIn").replace("{h}", String(hours));
    }

    /* ---------------------------------------------------------------- styles */

    const STYLE_TEXT = `
.dshb-root{position:fixed;right:16px;bottom:16px;z-index:80;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-size:12px;line-height:1.45;}
.dshb-pill{line-height:1;position:relative;pointer-events:auto;-webkit-app-region:no-drag;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:6px 11px;border-radius:999px;cursor:pointer;max-width:100%;min-width:0;
  border:1px solid var(--dsw-alias-border-l1,#2a2d35);background:var(--dsw-alias-bg-overlay,#14161c);
  color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:0 2px 10px rgba(0,0,0,.28);font:inherit;font-size:12px;
  cursor:pointer;touch-action:none;user-select:none;}
.dshb-pill:hover{border-color:var(--dsw-alias-border-l2,#3a3f4b);}
body.dshb-dragging .dshb-pill{cursor:grabbing !important;}
.dshb-root .dshb-pill{max-width:calc(100vw - 40px);}
.dshb-pill.inline{cursor:pointer;-webkit-app-region:no-drag;box-shadow:none;padding:2px 8px;background:transparent;border-color:transparent;font-size:12px;}
.dshb-pill.inline:hover{border-color:var(--dsw-alias-border-l2,#3a3f4b);background:var(--dsw-alias-bg-layer-2,#16181d);}
/* Status colours are hard-coded: the theme tokens resolve to near-invisible
   tints on the light window chrome, which made the dot disappear entirely. */
.dshb-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#9ca3af;}
.dshb-dot-ok{background:#22c55e;}
.dshb-dot-error{background:#ef4444;}
.dshb-dot-pending{background:#f59e0b;}
.dshb-pill-text{overflow:visible;white-space:nowrap;}
/* One segment per wallet: its own mark sits immediately before its own number,
   so a reader never has to guess which icon belongs to which amount. */
.dshb-pill-text{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-width:0;}
.dshb-measure{position:absolute;left:0;top:0;display:inline-flex;align-items:center;gap:10px;
  visibility:hidden;pointer-events:none;white-space:nowrap;width:max-content;max-width:none;}
.dshb-seg{display:inline-flex;align-items:center;gap:5px;flex:none;}
.dshb-seg-icon{width:13px;height:13px;border-radius:4px;display:block;flex:none;}
.dshb-seg-text{font-variant-numeric:tabular-nums;}
/* Desktop shell: the window buttons are drawn by Electron's titleBarOverlay at
   a fixed 3 x 46px, so the strip left of "minimize" is at right:146px. This
   layer spans the strip but is click-through and claims no app-region: only
   the capsule itself is no-drag, so the rest of the caption still drags the
   window. */
.dshb-titlebar{position:fixed;left:8px;top:6px;height:28px;z-index:2147482000;display:flex;align-items:center;
  justify-content:flex-end;pointer-events:none;}
/* The title-bar seat must read as a real capsule: an inline pill drops its
   surface so it can sit in a text row, which on the window chrome just looks
   like loose words. Restore surface, border and shadow here, and never cap the
   text (the title bar has room to the left of the window buttons). */
.dshb-titlebar .dshb-seg{transform:translateY(.5em);}
.dshb-titlebar .dshb-seg-icon{width:15px;height:15px;transform:translateY(.08em);}
.dshb-titlebar .dshb-pill{height:26px;padding:0 10px;gap:8px;min-width:0;max-width:100%;
  background:var(--dsw-alias-bg-layer-1,#10131a);
  border:1px solid var(--dsw-alias-border-l1,#2a2d35);
  box-shadow:0 1px 6px rgba(0,0,0,.18);}
.dshb-titlebar .dshb-pill{pointer-events:auto;-webkit-app-region:no-drag;}
.dshb-panel{pointer-events:auto;position:fixed;left:50%;bottom:96px;transform:translateX(-50%);width:390px;max-height:72vh;overflow:auto;box-sizing:border-box;
  padding:12px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#2a2d35);
  background:var(--dsw-alias-bg-layer-1,#10131a);color:var(--dsw-alias-label-primary,#e6e6e6);
  box-shadow:0 12px 32px rgba(0,0,0,.4);z-index:90;}
.dshb-panel *{box-sizing:border-box;}
.dshb-head{display:flex;align-items:center;gap:6px;margin-bottom:10px;}
.dshb-title{font-weight:600;font-size:13px;flex:1;min-width:0;}
.dshb-head-actions{display:inline-flex;align-items:center;gap:2px;flex:none;}
.dshb-btn{font:inherit;font-size:12px;line-height:1;padding:4px 7px;border-radius:6px;cursor:pointer;
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);}
.dshb-btn:hover{border-color:var(--dsw-alias-border-l1,#2a2d35);color:var(--dsw-alias-label-primary,#e6e6e6);}
.dshb-btn:disabled{opacity:.5;cursor:default;}
.dshb-total{display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:6px 0 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1,#2a2d35);margin-bottom:8px;}
.dshb-total b{font-size:14px;}
.dshb-row{padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,#2a2d35);}
.dshb-row:last-child{border-bottom:0;}
.dshb-row-head{display:flex;align-items:center;gap:8px;}
.dshb-icon{position:relative;width:18px;height:18px;flex:none;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;
  font-size:10px;font-weight:700;color:var(--dsw-alias-label-secondary,#a1a1aa);background:var(--dsw-alias-bg-layer-2,#16181d);}
.dshb-icon img{position:absolute;inset:0;width:18px;height:18px;border-radius:5px;object-fit:contain;background:transparent;}
.dshb-label{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshb-status{flex:none;font-size:10px;padding:1px 6px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,#2a2d35);color:var(--dsw-alias-label-secondary,#a1a1aa);}
.dshb-status-ok{color:var(--dsw-alias-state-success-primary,#22c55e);}
.dshb-status-error{color:var(--dsw-alias-state-error-primary,#ef4444);}
.dshb-value{font-size:15px;font-weight:600;margin-top:3px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.dshb-today{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary,#a1a1aa);}
.dshb-today b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600;}
.dshb-quota{margin-top:5px;display:flex;align-items:center;gap:8px;}
.dshb-bar{flex:1;height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,#16181d);overflow:hidden;}
.dshb-bar > i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-success-primary,#22c55e);}
.dshb-bar.warn > i{background:var(--dsw-alias-state-warn-primary,#f59e0b);}
.dshb-bar.bad > i{background:var(--dsw-alias-state-error-primary,#ef4444);}
.dshb-quota-text{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);}
.dshb-error{margin-top:5px;font-size:11px;color:var(--dsw-alias-state-error-primary,#ef4444);word-break:break-all;}
.dshb-hint{margin-top:5px;font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);}
.dshb-meta{margin-top:4px;font-size:10px;color:var(--dsw-alias-label-secondary,#8b8b95);}
.dshb-details{margin-top:6px;}
.dshb-details > summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);user-select:none;}
.dshb-field{margin-top:7px;}
.dshb-field > span{display:block;font-size:10px;color:var(--dsw-alias-label-secondary,#a1a1aa);margin-bottom:3px;}
.dshb-field input[type="text"],.dshb-field input[type="password"],.dshb-field input[type="number"],.dshb-field textarea{
  width:100%;font:inherit;font-size:11px;padding:4px 7px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1,#2a2d35);background:var(--dsw-alias-bg-layer-2,#16181d);
  color:var(--dsw-alias-label-primary,#e6e6e6);}
.dshb-field textarea{min-height:56px;resize:vertical;font-family:ui-monospace,Consolas,Menlo,monospace;}
.dshb-field input:focus,.dshb-field textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f8cff);}
.dshb-toggle{display:flex;align-items:center;gap:6px;margin-top:7px;font-size:11px;}
.dshb-save-row{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;}
.dshb-msg{font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);word-break:break-all;}
.dshb-msg.error{color:var(--dsw-alias-state-error-primary,#ef4444);}
.dshb-foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#2a2d35);
  font-size:10px;color:var(--dsw-alias-label-secondary,#8b8b95);word-break:break-all;}
.dshb-pill-picks{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;}
.dshb-pill-picks label{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-primary,#e6e6e6);}
.dshb-pill-picks img{width:13px;height:13px;border-radius:4px;display:block;flex:none;}
.dshb-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;margin-top:8px;
  color:var(--dsw-alias-label-primary,#e6e6e6);}
.dshb-place{display:flex;flex-direction:column;gap:6px;margin-top:6px;}
.dshb-place label{display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;}
.dshb-hist{display:flex;flex-direction:column;gap:8px;margin-top:8px;}
.dshb-hist-day{font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);}
.dshb-hist-item{display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0;}
.dshb-hist-item b{margin-left:auto;font-weight:600;}
.dshb-side{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;cursor:pointer;
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:14px;}
.dshb-side:hover{border-color:var(--dsw-alias-border-l1,#2a2d35);color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#16181d);}
.dshb-section-title{font-weight:600;font-size:14px;margin-bottom:4px;}
.dshb-section-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);margin-bottom:12px;line-height:1.5;}
.dshb-block{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#2a2d35);}
.dshb-kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;}
.dshb-kv span:last-child{color:var(--dsw-alias-label-secondary,#a1a1aa);font-variant-numeric:tabular-nums;}
`;

    /* The stylesheet used to be rendered inside the panel, so the pill was
       unstyled (and therefore flowed to the overlay's origin, top-left) until
       the panel had been opened once. Installed into <head> instead, before
       anything can render. */
    let stylesInstalled = false;

    function ensureStyles() {
      if (stylesInstalled) return;
      try {
        const existing = document.getElementById("dsh-api-balance-styles");
        const element = existing || document.createElement("style");
        element.id = "dsh-api-balance-styles";
        element.textContent = STYLE_TEXT;
        if (!existing) document.head.appendChild(element);
        stylesInstalled = true;
      } catch {
        /* a headless test harness has no document.head; nothing to install */
      }
    }

    /* ------------------------------------------------------------ components */

    function ProviderIcon(props) {
      return h("span", { className: "dshb-icon", title: props.label },
        (props.label || "?").slice(0, 1).toUpperCase(),
        props.src
          ? h("img", {
              src: props.src,
              alt: "",
              onError: (event) => {
                event.currentTarget.style.display = "none";
              }
            })
          : null);
    }

    function Field(props) {
      return h("label", { className: "dshb-field" },
        h("span", null, props.label),
        props.children);
    }

    function quotaBarClass(percent) {
      if (percent <= 10) return "dshb-bar bad";
      if (percent <= 30) return "dshb-bar warn";
      return "dshb-bar";
    }

    function ProviderEditor(props) {
      const { t, provider, onChange } = props;
      const credentialPlaceholder = provider.apiKeySet ? t("panel.keySaved") : t("panel.keyMissing");
      return h("details", { className: "dshb-details" },
        h("summary", null, t("panel.configure")),
        h(Field, { label: t("panel.url") },
          h("input", {
            type: "text",
            value: provider.url ?? "",
            placeholder: "https://example.com/api/balance",
            onChange: (event) => onChange({ url: event.target.value })
          })),
        h(Field, { label: `${t("panel.credential")}（${credentialPlaceholder}）` },
          h("input", {
            type: "password",
            value: provider.apiKey ?? "",
            placeholder: credentialPlaceholder,
            autoComplete: "off",
            onChange: (event) => onChange({ apiKey: event.target.value })
          })),
        h(Field, { label: t("panel.credentialRef") },
          h("input", {
            type: "text",
            value: provider.keyRef ?? "",
            placeholder: "DEEPSEEK_API_KEY",
            onChange: (event) => onChange({ keyRef: event.target.value })
          })),
        h(Field, { label: t("panel.headers") },
          h("textarea", {
            value: provider.headersText ?? "{}",
            spellCheck: false,
            onChange: (event) => onChange({ headersText: event.target.value })
          })),
        h(Field, { label: t("panel.extract") },
          h("textarea", {
            value: provider.extractText ?? "{}",
            spellCheck: false,
            onChange: (event) => onChange({ extractText: event.target.value })
          })),
        h(Field, { label: t("panel.refreshUrl") },
          h("input", {
            type: "text",
            value: provider.refreshUrl ?? "",
            placeholder: "https://example.com/api/v1/auth/refresh",
            onChange: (event) => onChange({ refreshUrl: event.target.value })
          })),
        h(Field, { label: `${t("panel.refreshToken")}（${provider.refreshTokenSet ? t("panel.keySaved") : t("panel.keyMissing")}）` },
          h("input", {
            type: "password",
            value: provider.refreshToken ?? "",
            placeholder: provider.refreshTokenSet ? t("panel.keySaved") : t("panel.keyMissing"),
            autoComplete: "off",
            onChange: (event) => onChange({ refreshToken: event.target.value })
          })),
        h("label", { className: "dshb-toggle" },
          h("input", {
            type: "checkbox",
            checked: provider.enabled === true,
            onChange: (event) => onChange({ enabled: event.target.checked })
          }),
          t("panel.enabled")));
    }

    function ProviderRow(props) {
      const { t, row, provider, onChange } = props;
      const percent = quotaPercent(row.quota);
      /* Every working row states today's usage, a zero included: the unit comes
         from the row's own shape (money → its currency, quota → its unit) so a
         source that has not moved yet still fills the slot instead of leaving a
         blank where the number belongs. */
      const today = usageText(row.today) || (row.enabled && row.ok
        ? typeof row.balance === "number"
          ? money(0, row.currency)
          : row.quota
            ? `0 ${(row.quota.unit || "").trim()}`.trim()
            : ""
        : "");
      return h("div", { className: "dshb-row" },
        h("div", { className: "dshb-row-head" },
          h(ProviderIcon, { id: row.id, label: row.label, src: iconFor(row.id) }),
          h("span", { className: "dshb-label" }, row.label),
          h("span", { className: "dshb-status dshb-status-" + toneOf(row.status) }, t("status." + row.status))),
        h("div", { className: "dshb-value" },
          h("span", null,
            row.ok && typeof row.balance === "number"
              ? money(row.balance, row.currency)
              : row.ok && row.quota
                ? `${quotaPercent(row.quota)}%`
                : "—"),
          today
            ? h("span", { className: "dshb-today" }, `${t("panel.today")} `, h("b", null, today))
            : null),
        row.ok && row.quota
          ? h("div", { className: "dshb-quota" },
              h("div", { className: quotaBarClass(percent) }, h("i", { style: { width: percent + "%" } })),
              h("span", { className: "dshb-quota-text" },
                `${percent}% · ${trimNumber(row.quota.remain)} / ${trimNumber(row.quota.total)} ${row.quota.unit || ""}`.trim()))
          : null,
        row.status === "error" ? h("div", { className: "dshb-error" }, row.error) : null,
        row.status === "unconfigured"
          ? h("div", { className: "dshb-hint" }, row.hint || row.note || t("panel.unconfigured"))
          : null,
        renewHint(row, t)
          ? h("div", { className: "dshb-hint" }, renewHint(row, t))
          : null,
        h("div", { className: "dshb-meta" },
          relativeTime(row.updatedAt, t)
            + (row.keySource ? ` · ${t("panel.keySource." + row.keySource)}` : "")
            + (typeof row.latencyMs === "number" ? ` · ${row.latencyMs} ms` : "")),
        h(ProviderEditor, { t, provider, onChange }));
    }

    function SettingsView(props) {
      const { t, store, embedded } = props;
      const [interval, setIntervalValue] = React.useState(
        store.state ? String(store.state.pollIntervalSec) : "300");
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState("");
      React.useEffect(() => {
        if (store.state && store.state.pollIntervalSec) setIntervalValue(String(store.state.pollIntervalSec));
      }, [store.state && store.state.pollIntervalSec]);
      const choose = (placement) => setPlacement(placement);
      const save = async () => {
        setBusy(true);
        setMessage("");
        const value = Number(interval);
        const ok = await saveConfig({ pollIntervalSec: Number.isFinite(value) ? value : 300 });
        setBusy(false);
        setMessage(ok ? t("panel.saved") : t("panel.saveFailed"));
      };
      return h("div", { className: embedded ? "dshb-embedded" : null },
        embedded ? h("div", { className: "dshb-section-title" }, t("settings.sectionLabel")) : null,
        embedded ? h("div", { className: "dshb-section-hint" }, t("settings.sectionHint")) : null,
        h(Field, { label: t("settings.interval") },
          h("input", {
            type: "number",
            min: 30,
            max: 86400,
            value: interval,
            onChange: (event) => setIntervalValue(event.target.value)
          })),
        h("div", { className: "dshb-field" },
          h("span", null, t("settings.placement")),
          h("div", { className: "dshb-place" },
            ["float", "header"].map((placement) =>
              h("label", { key: placement },
                h("input", {
                  type: "radio",
                  name: embedded ? "dshb-placement-embedded" : "dshb-placement",
                  checked: store.placement === placement,
                  onChange: () => choose(placement)
                }),
                t("settings." + placement))))),
        h("div", { className: "dshb-field" },
          h("span", null, t("settings.pillTitle")),
          h("div", { className: "dshb-pill-picks" },
            ["deepseek", "qianfan", "fastai", "workbuddy"].map((id) =>
              h("label", { key: id },
                h("input", {
                  type: "checkbox",
                  checked: (store.pillMask || {})[id] !== false,
                  onChange: (event) => setPillMask(id, event.target.checked)
                }),
                h(ProviderIcon, { id, label: t("pill.name." + id), src: iconFor(id) }),
                h("span", null, t("pill.name." + id))))),
          h("label", { className: "dshb-check" },
            h("input", {
              type: "checkbox",
              checked: store.pillCycle !== false,
              onChange: () => togglePillCycle()
            }),
            h("span", null, t("settings.pillCycle"))),
          h("div", { className: "dshb-hint" }, t("settings.pillHint"))),
        h("div", { className: "dshb-hint" }, t("settings.hint")),
        h("div", { className: "dshb-save-row" },
          h("button", { className: "dshb-btn", disabled: busy, onClick: save }, busy ? t("panel.saving") : t("panel.save")),
          h("span", { className: "dshb-msg" }, message)),
        embedded
          ? h("div", { className: "dshb-block" },
              h("div", { className: "dshb-kv" },
                h("span", null, t("settings.liveTitle")),
                h("span", null, store.state ? t("status.ok") : t("status.pending"))),
              store.state && store.state.configPath
                ? h("div", { className: "dshb-kv" },
                    h("span", null, t("panel.configPath")),
                    h("span", null, store.state.configPath))
                : null,
              h("div", { className: "dshb-save-row" },
                h("button", { className: "dshb-btn", onClick: () => openPanel("main") }, t("settings.openPanel")),
                h("button", { className: "dshb-btn", disabled: store.busy, onClick: () => refreshNow() },
                  store.busy ? t("panel.saving") : t("panel.refresh"))))
          : null);
    }

    function HistoryView(props) {
      const { t, store } = props;
      const days = (store.state && store.state.history) || [];
      const labels = {};
      for (const row of (store.state && store.state.providers) || []) labels[row.id] = row.label;
      if (days.length === 0) return h("div", { className: "dshb-hint" }, t("history.empty"));
      return h("div", { className: "dshb-hist" },
        h("div", { className: "dshb-hint" }, t("history.hint")),
        days.slice().reverse().map((day) =>
          h("div", { key: day.day },
            h("div", { className: "dshb-hist-day" }, day.day),
            day.items.length === 0
              ? h("div", { className: "dshb-hist-item" }, h("span", null, "—"))
              : day.items.map((item) =>
                  h("div", { className: "dshb-hist-item", key: item.id },
                    h(ProviderIcon, { id: item.id, label: labels[item.id] || item.id, src: iconFor(item.id) }),
                    h("span", null, labels[item.id] || item.id),
                    h("b", null, usageText(item)))))));
    }

    function WorkbuddyBlock(props) {
      const { t, store } = props;
      const bundle = store.workbuddy;
      if (!bundle || bundle.available !== true || bundle.accounts.length === 0) {
        return h("div", { className: "dshb-row" },
          h("div", { className: "dshb-row-head" },
            h(ProviderIcon, { id: "workbuddy", label: t("wb.label"), src: ICONS.workbuddy }),
            h("span", { className: "dshb-label" }, t("wb.label")),
            h("span", { className: "dshb-status" }, t("wb.signedOut"))),
          h("div", { className: "dshb-hint" }, t("wb.hint")));
      }
      return h("div", null,
        h("div", { className: "dshb-row-head", style: { marginTop: 6 } },
          h(ProviderIcon, { id: "workbuddy", label: t("wb.label"), src: ICONS.workbuddy }),
          h("span", { className: "dshb-label" }, t("wb.label")),
          h("button", {
            className: "dshb-btn",
            onClick: () => {
              const next = store.wbRegion === "cn" ? "global" : "cn";
              writeStored(WB_REGION_KEY, next);
              patchStore({ wbRegion: next });
              pollWorkbuddy();
            }
          }, store.wbRegion === "cn" ? t("wb.regionCn") : t("wb.regionGlobal"))),
        bundle.accounts.map((account) =>
          h("div", { className: "dshb-row", key: "wb-" + account.id },
            h("div", { className: "dshb-row-head" },
              h("span", { className: "dshb-label" }, account.accountName || account.name || account.id),
              h("span", { className: "dshb-status dshb-status-ok" },
                typeof account.credits === "number" ? t("wb.signedIn") : t("wb.signedOut"))),
            h("div", { className: "dshb-value" },
              `${formatCredits(account.credits)} ${t("panel.pointsUnit")}`),
            h("div", { className: "dshb-today" },
              `${t("panel.today")} `,
              h("b", null, `${formatCredits(typeof account.today === "number" ? account.today : 0)} ${t("panel.pointsUnit")}`)),
            typeof account.expiringSoon === "number" && account.expiringSoon > 0
              ? h("div", { className: "dshb-hint" },
                  `${t("wb.expiring")} ${formatCredits(account.expiringSoon)} ${t("panel.pointsUnit")}`)
              : null)));
    }

    function Panel(props) {
      const { t, store } = props;
      const panelRef = React.useRef(null);
      const rows = (store.state && store.state.providers) || [];
      const totals = (store.state && store.state.totals) || {};
      const totalText = Object.keys(totals).length
        ? Object.entries(totals).map(([currency, value]) => money(value, currency)).join(" + ")
        : "—";
      /* A custom API that was never filled in has nothing to report: it stays
         out of the detail list (the ＋ button is the way back in) instead of
         rendering an empty row of dashes under a heading it does not deserve. */
      const customRows = rows.filter((row) => (CUSTOM_RE.test(row.id) || row.id === "custom")
        && (row.configured || row.enabled));
      const visibleRows = rows.filter((row) => !CUSTOM_RE.test(row.id) && row.id !== "custom");
      React.useEffect(() => {
        const close = (event) => {
          if (!panelRef.current || panelRef.current.contains(event.target)) return;
          if (event.target.closest && event.target.closest(".dshb-pill")) return;
          if (event.target.closest && event.target.closest(".dshb-side")) return;
          patchStore({ open: false });
        };
        const escape = (event) => {
          if (event.key === "Escape") patchStore({ open: false });
        };
        document.addEventListener("pointerdown", close, true);
        document.addEventListener("keydown", escape);
        return () => {
          document.removeEventListener("pointerdown", close, true);
          document.removeEventListener("keydown", escape);
        };
      }, []);
      const title = store.view === "settings"
        ? t("settings.title")
        : store.view === "history"
          ? t("history.title")
          : t("panel.title");
      const body = h("div", { className: "dshb-panel", ref: panelRef },
        h("div", { className: "dshb-head" },
          h("button", {
            className: "dshb-btn",
            title: t("panel.history"),
            onClick: () => patchStore({ view: store.view === "history" ? "main" : "history" })
          }, "⟲"),
          h("button", {
            className: "dshb-btn",
            title: t("panel.settings"),
            onClick: () => patchStore({ view: store.view === "settings" ? "main" : "settings" })
          }, "⚙"),
          h("span", { className: "dshb-title" }, title),
          h("div", { className: "dshb-head-actions" },
            h("button", {
              className: "dshb-btn",
              title: t("panel.refresh"),
              disabled: store.busy,
              onClick: () => refreshNow()
            }, store.busy ? "…" : "↻"),
            h("button", {
              className: "dshb-btn",
              title: t("panel.addCustom"),
              onClick: () => startAdd()
            }, "＋"),
            h("button", { className: "dshb-btn", title: t("panel.close"), onClick: () => patchStore({ open: false }) }, "×"))),
        store.view === "settings"
          ? h(SettingsView, { t, store })
          : store.view === "history"
            ? h(HistoryView, { t, store })
            : h("div", null,
                h("div", { className: "dshb-total" },
                  h("span", null, t("panel.total")),
                  h("b", null, totalText)),
                visibleRows.length === 0
                  ? h("div", { className: "dshb-hint" }, t("panel.unconfigured"))
                  : visibleRows.map((row) => h(ProviderRow, {
                      key: row.id,
                      t,
                      row,
                      provider: providerDraft(row),
                      onChange: (patch) => updateProvider(row.id, patch)
                    })),
                customRows.map((row) => h(ProviderRow, {
                  key: row.id,
                  t,
                  row,
                  provider: providerDraft(row),
                  onChange: (patch) => updateProvider(row.id, patch)
                })),
                h(WorkbuddyBlock, { t, store }),
                h("div", { className: "dshb-save-row" },
                  h("button", { className: "dshb-btn", disabled: store.busy, onClick: () => saveDraft() },
                    store.busy ? t("panel.saving") : t("panel.save")),
                  h("span", { className: "dshb-msg" + (store.failed ? " error" : "") }, store.message)),
                h("div", { className: "dshb-foot" },
                  store.state && store.state.configPath
                    ? `${t("panel.configPath")}: ${store.state.configPath}`
                    : "")));
      /* No createPortal: the panel already has its own `shell.overlay` seat,
         which the shell documents as a frame-wide floating layer outside every
         column's scroll/transform container, so fixed positioning is already
         viewport-correct. Portalling through a second React copy is not worth
         the risk — a mismatched ReactDOM can throw inside the shared overlay
         root and take every other plugin's bubble down with it. */
      return body;
    }

    function providerDraft(row) {
      const draft = data.draft;
      if (draft) {
        const found = draft.providers.find((item) => item.id === row.id);
        if (found) return found;
      }
      return {
        url: row.url || "",
        apiKey: "",
        apiKeySet: false,
        keyRef: row.keyRef || "",
        headersText: "{}",
        extractText: "{}",
        refreshUrl: row.refreshUrl || "",
        refreshToken: "",
        refreshTokenSet: false,
        enabled: row.enabled
      };
    }

    function updateProvider(id, patch) {
      const draft = data.draft;
      if (!draft) return;
      patchStore({
        draft: {
          ...draft,
          providers: draft.providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider))
        }
      });
    }

    async function startAdd() {
      if (!data.draft) {
        const loaded = await loadConfig();
        if (!loaded) return;
      }
      const current = data.draft;
      const draft = current || toDraft(data.config || { providers: [] });
      patchStore({
        draft: { ...draft, providers: draft.providers.concat([newProvider("source-" + Date.now().toString(36))]) }
      });
    }

    function saveDraft() {
      let payload;
      try {
        payload = buildPayload(data.draft);
      } catch (error) {
        patchStore({ failed: true, message: String(error && error.message ? error.message : error) });
        return;
      }
      patchStore({ busy: true });
      saveConfig(payload).then((ok) => patchStore({ busy: false, failed: !ok }));
    }

    /* The coloured dot was unexplained: it is the aggregate health of every
       enabled source, so name the failing ones in its tooltip instead of
       leaving the user to guess what red means. */
    function dotTip(t, rows, tone) {
      if (tone === "pending") return t("pill.dotPending");
      if (tone === "idle") return t("pill.dotIdle");
      if (tone === "ok") return t("pill.dotOk");
      const who = rows
        .filter((row) => row.enabled && row.status === "error")
        .map((row) => row.label || row.id)
        .join(t("dot.separator"));
      return t("pill.dotError").replace("{who}", who);
    }

    function segmentNode(segment) {
      const src = iconFor(segment.id);
      return h("span", { className: "dshb-seg", key: segment.key },
        src
          ? h("img", {
              className: "dshb-seg-icon",
              src,
              alt: "",
              onError: (event) => {
                event.currentTarget.style.display = "none";
              }
            })
          : null,
        h("span", { className: "dshb-seg-text" }, segment.text));
    }

    function Pill(props) {
      const { t, store, inline } = props;
      /* A swallowed `click` (pointer capture, a drag band, an overlay above)
         used to leave the pill looking dead. The press itself is the reliable
         signal: a pointer that went down and up in place toggles the panel,
         and the click that may follow it is then spent, not re-run. */
      const pressRef = React.useRef(null);
      const spentRef = React.useRef(false);
      const toggle = () => {
        if (store.open) patchStore({ open: false, view: "main" });
        else openPanel("main");
      };
      const rows = (store.state && store.state.providers) || [];
      const tone = !store.state
        ? "pending"
        : rows.some((row) => row.enabled && row.status === "error")
          ? "error"
          : rows.some((row) => row.enabled && row.status === "ok")
            ? "ok"
            : "idle";
      /* Every reading carries the wallet it came from, and that wallet's mark
         sits immediately before its own number (`D ¥12.34  F $45.67  千 85%`).
         The old line collected all the marks up front and joined the amounts
         with " + ", which read as if the currencies had been added together. */
      const segments = [];
      let text = t("pill.loading");
      if (store.link && store.link.status === 0) text = t("pill.loading");
      else if (store.state) {
        for (const row of rows) {
          if (!row.enabled || !row.ok) continue;
          if (typeof row.balance === "number") {
            segments.push({ key: row.id, id: row.id, text: money(row.balance, row.currency) });
          } else if (row.quota) {
            segments.push({ key: row.id, id: row.id, text: quotaPercent(row.quota) + "%" });
          }
        }
        const wb = (store.workbuddy && store.workbuddy.accounts) || [];
        if (wb.length) {
          const sum = wb.reduce((total, account) => total + (typeof account.credits === "number" ? account.credits : 0), 0);
          segments.push({ key: "workbuddy", id: "workbuddy", text: formatCredits(sum) });
        }
        if (segments.length === 0) {
          const failing = rows.filter((row) => row.enabled && row.status === "error").length;
          text = failing > 0 ? t("pill.error").replace("{n}", String(failing)) : t("pill.none");
        }
      }
      /* The strip the pill lives in is often narrower than the pill (the
         title bar has to stop left of the window buttons, the composer stats
         line is already full). So each wallet can be switched off in settings,
         and when the reading still does not fit the pill cycles between the
         first two and the last two segments instead of shoving text under its
         neighbours. `scrollWidth > clientWidth` is the browser's own answer to
         "does it fit", not an estimate. */
      const mask = store.pillMask || {};
      const visibleSegments = segments.filter((segment) => mask[segment.id] !== false);
      const textRef = React.useRef(null);
      /* Measuring the visible text while cycling flickers: showing two looks
         like it fits, so all four come back, which overflows again. The hidden
         measurer always renders every segment at its natural width, so the
         answer stays put while the visible list flips. */
      const measureRef = React.useRef(null);
      const [tight, setTight] = React.useState(false);
      const [phase, setPhase] = React.useState(0);
      const [perPage, setPerPage] = React.useState(2);
      React.useEffect(() => {
        const node = textRef.current;
        const probe = measureRef.current;
        if (!node || !probe) return undefined;
        /* The strip's width is stable; the pill's is not, because it shrinks to
           whatever page it is showing. Reading capacity off the pill would
           ratchet it down to one segment. */
        const stripSpace = () => {
          const pill = node.closest(".dshb-pill");
          const bar = node.closest(".dshb-titlebar");
          if (bar) return bar.getBoundingClientRect().width;
          return Math.max(120, window.innerWidth - 40 - (pill ? 12 : 0));
        };
        const check = () => {
          const widths = Array.from(probe.children).map((child) => Math.round(child.getBoundingClientRect().width));
          if (widths.length === 0) {
            setTight(false);
            setPerPage(1);
            return;
          }
          const pill = node.closest(".dshb-pill");
          const chrome = pill
            ? Math.max(24, Math.round(pill.getBoundingClientRect().width - node.getBoundingClientRect().width))
            : 30;
          const capacity = Math.max(40, stripSpace() - chrome);
          const total = widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * 10;
          setTight(total > capacity + 1);
          let count = 0;
          let used = 0;
          for (const width of widths) {
            const next = used + (count > 0 ? 10 : 0) + width;
            if (next > capacity + 1 && count > 0) break;
            used = next;
            count += 1;
          }
          setPerPage(Math.max(1, Math.min(count || 1, widths.length)));
        };
        check();
        const timer = window.setInterval(check, 1200);
        window.addEventListener("resize", check);
        return () => {
          window.clearInterval(timer);
          window.removeEventListener("resize", check);
        };
      }, [visibleSegments.length, store.state, store.workbuddy, inline]);
      /* Pages are as big as the strip really holds: four wallets on a wide
         bar cycle as 2 + 2, a cramped composer row cycles one at a time. */
      const perPageSafe = Math.max(1, Math.min(perPage, visibleSegments.length || 1));
      const pages = Math.max(1, Math.ceil(visibleSegments.length / perPageSafe));
      React.useEffect(() => {
        if (!tight || !store.pillCycle || pages < 2) {
          setPhase((value) => (value === 0 ? value : 0));
          return undefined;
        }
        const timer = window.setInterval(() => setPhase((value) => (value + 1) % pages), 4000);
        return () => window.clearInterval(timer);
      }, [tight, store.pillCycle, pages]);
      const start = (phase % pages) * perPageSafe;
      const shown = tight && store.pillCycle && pages > 1
        ? visibleSegments.slice(start, start + perPageSafe)
        : visibleSegments;
      return h("div", {
        className: "dshb-pill" + (inline ? " inline" : ""),
        role: "button",
        title: t("pill.hint"),
        onClick: () => {
          /* Clicking the pill again closes the panel: with the panel in its own
             overlay seat, a second click is the obvious "put it away" gesture
             and previously did nothing (the panel just stayed). Any open view
             closes; the next click reopens on the main view. */
          if (spentRef.current) {
            spentRef.current = false;
            return;
          }
          toggle();
        },
        onPointerDown: (event) => {
          if (typeof event.button === "number" && event.button !== 0) return;
          pressRef.current = { x: event.clientX, y: event.clientY };
          spentRef.current = false;
        },
        onPointerUp: (event) => {
          const press = pressRef.current;
          pressRef.current = null;
          if (!press) return;
          if (Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) > 6) return;
          spentRef.current = true;
          toggle();
        }
      },
        h("span", { className: "dshb-dot dshb-dot-" + tone, title: dotTip(t, rows, tone) }),
        h("span", { className: "dshb-pill-text", ref: textRef },
          shown.length === 0
            ? (segments.length === 0 ? text : null)
            : shown.map(segmentNode)),
        h("span", { className: "dshb-measure", ref: measureRef }, segments.length ? visibleSegments.map((segment) => segmentNode(segment)) : null));
    }

    function FloatWidget(props) {
      const { t, store } = props;
      const [pos, setPos] = React.useState(readPosition);
      const dragRef = React.useRef(null);
      const posRef = React.useRef(pos);
      const skipClickRef = React.useRef(false);
      React.useEffect(() => {
        posRef.current = pos;
      }, [pos]);
      const onPointerDown = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          right: window.innerWidth - rect.right,
          bottom: window.innerHeight - rect.bottom,
          height: rect.height,
          moved: false,
          target: event.currentTarget,
          pointerId: event.pointerId
        };
        skipClickRef.current = false;
      };
      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved) {
          if (Math.abs(dx) + Math.abs(dy) < 4) return;
          drag.moved = true;
          /* Capture only once the gesture is definitely a drag. Capturing on
             pointerdown re-targets the following click to this wrapper, so the
             pill's own onClick never fired — that is why "click for details"
             looked dead and the cursor seemed to offer dragging only. */
          drag.target.setPointerCapture?.(drag.pointerId);
          document.body.classList.add("dshb-dragging");
        }
        setPos(clampPosition(drag.right - dx, drag.bottom - dy, drag.height));
      };
      const onPointerUp = () => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        document.body.classList.remove("dshb-dragging");
        if (drag.moved) {
          skipClickRef.current = true;
          if (posRef.current) writeStored(POS_KEY, JSON.stringify(posRef.current));
        }
      };
      const onDoubleClick = () => {
        setPos(null);
        posRef.current = null;
        removeStored(POS_KEY);
      };
      const style = pos
        ? {
            right: pos.right,
            left: "auto",
            ...(window.innerHeight - pos.bottom - pos.height < 140
              ? { top: window.innerHeight - pos.bottom - pos.height, bottom: "auto" }
              : { bottom: pos.bottom, top: "auto" })
          }
        : undefined;
      return h("div", { className: "dshb-root", style },
        h("div", {
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onClick: (event) => {
            if (skipClickRef.current) {
              skipClickRef.current = false;
              event.stopPropagation();
            }
          },
          onDoubleClick
        }, h(Pill, { t, store })));
    }

    /* ---------------------------------------------------------------- prompts */

    function toDraft(config) {
      return {
        pollIntervalSec: config.pollIntervalSec,
        timeoutMs: config.timeoutMs,
        providers: (config.providers || []).map((provider) => ({
          ...provider,
          apiKey: "",
          refreshToken: "",
          headersText: JSON.stringify(provider.headers || {}, null, 0),
          extractText: JSON.stringify(provider.extract || {}, null, 0)
        }))
      };
    }

    function buildPayload(draft) {
      if (!draft) throw new Error("no config loaded");
      return {
        pollIntervalSec: draft.pollIntervalSec,
        timeoutMs: draft.timeoutMs,
        providers: draft.providers.map((provider) => {
          const next = { ...provider };
          delete next.headersText;
          delete next.extractText;
          next.headers = JSON.parse(provider.headersText || "{}");
          next.extract = JSON.parse(provider.extractText || "{}");
          return next;
        })
      };
    }

    function newProvider(id) {
      const headers = { accept: "application/json", authorization: "Bearer {{apiKey}}" };
      const extract = {
        balance: "",
        currency: "",
        quotaUsed: "",
        quotaRemain: "",
        quotaTotal: "",
        quotaUnit: "",
        planName: ""
      };
      return {
        id,
        label: "自定义来源",
        type: "http",
        enabled: false,
        apiKey: "",
        apiKeySet: false,
        keyRef: "",
        url: "",
        method: "GET",
        body: "",
        headers,
        extract,
        refreshUrl: "",
        refreshToken: "",
        refreshTokenSet: false,
        headersText: JSON.stringify(headers),
        extractText: JSON.stringify(extract),
        note: ""
      };
    }

    /* ------------------------------------------------------------------ init */

    const inject = ["slots"];

    function Widget(props) {
      const { t, placement, inline } = props;
      const store = useStore();
      if (store.placement !== placement) return null;
      return inline ? h(Pill, { t, store, inline: true }) : h(FloatWidget, { t, store });
    }

    /* The panel is its own seat: one instance in `shell.overlay` that is shown
       whenever `store.open` is true, independent of which placement the
       launcher sits in. */
    function PanelSeat(props) {
      const { t } = props;
      const store = useStore();
      return store.open ? h(Panel, { t, store }) : null;
    }

    /* ------------------------------------------------------------- seats */

    /* The desktop window paints its own minimize/maximize/close through
       Electron's titleBarOverlay, but that strip is still inside the app
       layer. dsh-hot-restart already parks its button at right:146px (three
       46px buttons plus an 8px gap); the pill takes the same slot and steps
       to that button's left when it is on screen. */
    function isDesktopTitlebar() {
      const root = document.documentElement;
      if (!root || root.hasAttribute("data-fullscreen")) return false;
      if (root.hasAttribute("data-windows-titlebar")) return true;
      return /DSHDesktop\//i.test(navigator.userAgent || "");
    }

    function TitlebarSeat(props) {
      const { t } = props;
      const store = useStore();
      const [right, setRight] = React.useState(146);
      const desktop = isDesktopTitlebar();
      React.useEffect(() => {
        if (!desktop) return undefined;
        const measure = () => {
          let value = 146;
          const restart = document.getElementById("dsh-hr-btn");
          if (restart) {
            const rect = restart.getBoundingClientRect();
            if (rect && rect.width > 0) value = Math.round(window.innerWidth - rect.left) + 8;
          }
          setRight((current) => (current === value ? current : value));
        };
        measure();
        window.addEventListener("resize", measure);
        const timer = window.setInterval(measure, 2000);
        return () => {
          window.removeEventListener("resize", measure);
          window.clearInterval(timer);
        };
      }, [desktop]);
      if (!desktop || store.placement !== "header") return null;
      const node = h("div", { className: "dshb-titlebar", style: { right: right + "px" } },
        h(Pill, { t, store, inline: true }));
      if (createPortal && typeof document !== "undefined" && document.body) {
        return createPortal(node, document.body);
      }
      return node;
    }

    /* Browser windows have no titlebar strip, so the header placement keeps
       using the session utilities seat there. Exactly one of the two seats
       renders, never both. */
    function HeaderInlineSeat(props) {
      const { t } = props;
      const store = useStore();
      if (store.placement !== "header" || isDesktopTitlebar()) return null;
      return h(Pill, { t, store, inline: true });
    }

    function SettingsSection(props) {
      const { t } = props;
      const store = useStore();
      React.useEffect(() => {
        ensureStyles();
      }, []);
      return h(SettingsView, { t, store, embedded: true });
    }

    /* The settings nav draws one icon per section id; without this the new page
       is the only entry in that list with no mark beside its name. */
    function SectionIcon(props) {
      const size = props && typeof props.size === "number" ? props.size : 14;
      return h("svg", { viewBox: "0 0 16 16", width: String(size), height: String(size), "aria-hidden": "true", focusable: "false", fill: "currentColor" },
        h("rect", { x: "1.6", y: "9", width: "2.6", height: "5", rx: "0.9" }),
        h("rect", { x: "6.7", y: "5.4", width: "2.6", height: "8.6", rx: "0.9" }),
        h("rect", { x: "11.8", y: "2", width: "2.6", height: "12", rx: "0.9" }));
    }

    function SideButton(props) {
      const { t } = props;
      const store = useStore();
      return h("button", {
        className: "dshb-side",
        title: t("panel.settings"),
        onClick: () => openPanel(store.view === "settings" && store.open ? "main" : "settings")
      }, "⚙");
    }

    function apply(ctx) {
      const t = createTranslator(ctx);
      ensureStyles();
      startPolling();
      ctx.effect(() => {
        const dispose = ctx.slots.inject("shell.overlay", () => ctx.slots.register({
          name: "shell.overlay",
          id: "dsh-api-balance",
          order: 70,
          label: () => t("overlay.label")
        }, () => h(Guard, null, h(Widget, { t, placement: "float", inline: false }))));
        return () => {
          dispose();
          stopPolling();
        };
      }, "dsh-api-balance: floating pill");
      ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-api-balance-panel",
        order: 71,
        label: () => t("panel.title")
      }, () => h(Guard, null, h(PanelSeat, { t })))), "dsh-api-balance: panel layer");
      ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-api-balance-titlebar",
        order: 72,
        label: () => t("overlay.label")
      }, () => h(Guard, null, h(TitlebarSeat, { t })))), "dsh-api-balance: window title bar");
      ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "dsh-api-balance-header",
        order: 28,
        label: () => t("overlay.label")
      }, () => h(Guard, null, h(HeaderInlineSeat, { t })))), "dsh-api-balance: session header");
      ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "dsh-api-balance-settings",
        order: 5,
        label: () => t("panel.settings")
      }, () => h(Guard, null, h(SideButton, { t })))), "dsh-api-balance: header settings");
      ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "api-balance",
        order: 55,
        label: () => t("settings.sectionLabel")
      }, () => h(SettingsSection, { t }))), "dsh-api-balance: settings section");
      ctx.effect(() => ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
        name: "settings.section.icon",
        id: "api-balance",
        order: 55,
        label: () => t("settings.sectionLabel")
      }, () => h(Guard, null, h(SectionIcon, null)))), "dsh-api-balance: settings icon");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});