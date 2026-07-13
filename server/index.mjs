import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

function loadDotEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    const value = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
}

loadDotEnv();

function readIntEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  return fallback;
}

function normalizeBaseUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

const port = readIntEnv("PORT", 8787, { min: 1, max: 65535 });
const qbitUrls = [...new Set([
  normalizeBaseUrl(process.env.QBIT_URL || "http://192.168.1.27:8085"),
  normalizeBaseUrl(process.env.QBIT_URL_EXT)
].filter(Boolean))];
const qbitUsername = process.env.QBIT_USERNAME || "admin";
const qbitPassword = process.env.QBIT_PASSWORD || "admin";
const qbitTimeoutMs = readIntEnv("QBIT_TIMEOUT_MS", 8000, { min: 1000, max: 120000 });
const appInfoTtlMs = readIntEnv("APP_INFO_TTL_MS", 60 * 60 * 1000, { min: 60_000, max: 24 * 60 * 60 * 1000 });

app.use(express.json({ limit: "2mb" }));

class QbitError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class QbitClient {
  constructor(urls, username, password) {
    this.urls = urls;
    this.baseUrl = urls[0];
    this.username = username;
    this.password = password;
    this.sid = "";
    this.lastLoginAt = 0;
    this.loginPromise = null;
    /** @type {Map<string, number>} url -> fail-until timestamp (ms) */
    this.failedUntil = new Map();
  }

  async login() {
    const body = new URLSearchParams({
      username: this.username,
      password: this.password
    });
    const response = await this.rawFetch("/api/v2/auth/login", {
      method: "POST",
      headers: (baseUrl) => ({
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${baseUrl}/`
      }),
      body
    });
    const text = await response.text();
    if (!response.ok || !text.includes("Ok.")) {
      throw new QbitError("qBittorrent 登录失败，请检查地址、账号或密码", response.status || 502, text);
    }
    const cookie = response.headers.get("set-cookie") || "";
    const sid = cookie.match(/SID=([^;]+)/)?.[1];
    if (!sid) {
      throw new QbitError("qBittorrent 登录成功但没有返回 SID Cookie", 502);
    }
    this.sid = sid;
    this.lastLoginAt = Date.now();
  }

  async rawFetch(apiPath, options = {}) {
    const now = Date.now();
    const ordered = [this.baseUrl, ...this.urls.filter((url) => url !== this.baseUrl)];
    // Prefer healthy URLs; cooled-down failures last.
    const candidates = [
      ...ordered.filter((url) => (this.failedUntil.get(url) || 0) <= now),
      ...ordered.filter((url) => (this.failedUntil.get(url) || 0) > now)
    ];
    let lastError;
    const { headers: optionHeaders, ...fetchOptions } = options;
    for (let i = 0; i < candidates.length; i += 1) {
      const baseUrl = candidates[i];
      // Secondary / cooled-down URLs get a shorter probe timeout.
      const isPrimary = baseUrl === this.baseUrl && (this.failedUntil.get(baseUrl) || 0) <= now;
      const timeoutMs = isPrimary ? qbitTimeoutMs : Math.min(qbitTimeoutMs, 3500);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = typeof optionHeaders === "function" ? optionHeaders(baseUrl) : optionHeaders;
        const response = await fetch(`${baseUrl}${apiPath}`, {
          ...fetchOptions,
          headers,
          signal: controller.signal
        });
        if (response.ok || (response.status >= 400 && response.status < 500)) {
          this.failedUntil.delete(baseUrl);
          if (baseUrl !== this.baseUrl) {
            this.baseUrl = baseUrl;
            this.sid = "";
            console.log(`[qbit] switched to ${baseUrl}`);
          }
          return response;
        }
        this.failedUntil.set(baseUrl, now + 30_000);
        lastError = new QbitError(`qBittorrent responded ${response.status}`, response.status);
      } catch (error) {
        this.failedUntil.set(baseUrl, now + 30_000);
        lastError = error?.name === "AbortError"
          ? new QbitError(`连接超时：${baseUrl}`, 504)
          : new QbitError(`无法连接：${error?.message || String(error)}`, 502);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new QbitError("所有 qBittorrent 地址均不可达", 502);
  }



  async ensureLogin() {
    if (this.sid && Date.now() - this.lastLoginAt <= 20 * 60 * 1000) return;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  async request(apiPath, options = {}, retry = true) {
    await this.ensureLogin();
    const headers = (baseUrl) => ({
      Referer: `${baseUrl}/`,
      Cookie: `SID=${this.sid}`,
      ...(options.headers || {})
    });
    const response = await this.rawFetch(apiPath, {
      ...options,
      headers
    });
    if ((response.status === 401 || response.status === 403) && retry) {
      this.sid = "";
      await this.ensureLogin();
      return this.request(apiPath, options, false);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new QbitError(`qBittorrent API 请求失败：${apiPath}`, response.status, text);
    }
    return response;
  }

  async json(apiPath) {
    const response = await this.request(apiPath);
    return response.json();
  }

  async text(apiPath, options = {}) {
    const response = await this.request(apiPath, options);
    return response.text();
  }

  async postForm(apiPath, fields = {}) {
    const body = new URLSearchParams();
    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        body.set(key, String(value));
      }
    });
    return this.text(apiPath, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
  }

  async postMultipart(apiPath, fields = {}) {
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        body.append(key, String(value));
      }
    });
    return this.text(apiPath, {
      method: "POST",
      body
    });
  }
}

const qbit = new QbitClient(qbitUrls, qbitUsername, qbitPassword);
const trafficBaselinePath = path.resolve(__dirname, "../data/traffic-baseline.json");
const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.TZ || "Asia/Shanghai" });
let appInfoCache = null;
let dashboardServerState = {};
let dashboardInitialized = false;
/** @type {Map<number, Promise<any>>} concurrent dashboard requests by rid */
const dashboardInflight = new Map();

function todayKey() {
  return dayFormatter.format(new Date());
}

function readTrafficBaseline() {
  try {
    if (!fs.existsSync(trafficBaselinePath)) return null;
    return JSON.parse(fs.readFileSync(trafficBaselinePath, "utf8"));
  } catch {
    return null;
  }
}

function writeTrafficBaseline(baseline) {
  fs.mkdirSync(path.dirname(trafficBaselinePath), { recursive: true });
  fs.writeFileSync(trafficBaselinePath, JSON.stringify(baseline, null, 2));
}

let trafficBaseline = readTrafficBaseline();

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function getDailyStats(transfer, serverState = {}) {
  const key = todayKey();
  const alltimeDl = numberOrZero(serverState.alltime_dl ?? transfer.alltime_dl);
  const alltimeUl = numberOrZero(serverState.alltime_ul ?? transfer.alltime_ul);
  const sessionDl = numberOrZero(transfer.dl_info_data);
  const sessionUl = numberOrZero(transfer.up_info_data);
  if (!trafficBaseline || trafficBaseline.date !== key || trafficBaseline.dl > alltimeDl || trafficBaseline.ul > alltimeUl) {
    trafficBaseline = {
      date: key,
      dl: Math.max(0, alltimeDl - sessionDl),
      ul: Math.max(0, alltimeUl - sessionUl)
    };
    writeTrafficBaseline(trafficBaseline);
  }

  return {
    date: key,
    downloaded: Math.max(0, alltimeDl - numberOrZero(trafficBaseline.dl)),
    uploaded: Math.max(0, alltimeUl - numberOrZero(trafficBaseline.ul))
  };
}

function buildQuery(query) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "" && value !== "all") {
      params.set(key, String(value));
    }
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function hashField(hashes) {
  if (hashes === "all") return "all";
  const values = (Array.isArray(hashes) ? hashes : [hashes])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!values.length) throw new QbitError("请至少选择一个种子", 400);
  if (values.length > 2000) throw new QbitError("单次最多操作 2000 个种子", 400);
  if (values.some((value) => !/^[0-9a-f]{40,64}$/.test(value))) {
    throw new QbitError("种子 Hash 格式无效", 400);
  }
  return values.join("|");
}

function textField(value, label, { max = 500, trim = true } = {}) {
  if (value === undefined || value === null) return "";
  const text = trim ? String(value).trim() : String(value);
  if (text.length > max) {
    throw new QbitError(`${label} 不能超过 ${max} 个字符`, 400);
  }
  return text;
}

function limitField(value, label) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 0) {
    throw new QbitError(`${label} 必须是非负数字`, 400);
  }
  return Math.floor(limit);
}

function torrentUrlsField(value) {
  const text = textField(value, "种子链接", { max: 100_000 });
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    throw new QbitError("请填写磁力链接、种子 URL 或本地可访问 URL", 400);
  }
  if (lines.length > 200) {
    throw new QbitError("单次最多添加 200 条种子链接", 400);
  }
  return lines.join("\n");
}

async function getAppInfo() {
  if (appInfoCache && appInfoCache.baseUrl === qbit.baseUrl && Date.now() - appInfoCache.cachedAt < appInfoTtlMs) {
    return appInfoCache;
  }
  const [version, apiVersion] = await Promise.all([
    qbit.text("/api/v2/app/version"),
    qbit.text("/api/v2/app/webapiVersion")
  ]);
  appInfoCache = { version, apiVersion, baseUrl: qbit.baseUrl, cachedAt: Date.now() };
  return appInfoCache;
}

function requestedRid(value) {
  const rid = Number(value);
  return Number.isSafeInteger(rid) && rid >= 0 ? rid : 0;
}

async function withActionFallback(primary, fallback) {
  try {
    return await primary();
  } catch (error) {
    if (fallback && [404, 405].includes(error.status)) {
      return fallback();
    }
    throw error;
  }
}

app.get("/api/config", (_request, response) => {
  response.json({
    qbitUrl: qbit.baseUrl,
    user: qbitUsername
  });
});

app.get("/api/health", async (_request, response, next) => {
  try {
    // Avoid full maindata?rid=0 (heavy with 1000+ torrents). Use transfer/info + cached server state.
    const [appInfo, transfer] = await Promise.all([
      getAppInfo(),
      qbit.json("/api/v2/transfer/info")
    ]);
    const serverState = {
      ...dashboardServerState,
      dl_info_speed: transfer.dl_info_speed,
      up_info_speed: transfer.up_info_speed,
      dl_info_data: transfer.dl_info_data,
      up_info_data: transfer.up_info_data,
      alltime_dl: transfer.alltime_dl ?? dashboardServerState.alltime_dl,
      alltime_ul: transfer.alltime_ul ?? dashboardServerState.alltime_ul,
      global_ratio: transfer.global_ratio ?? dashboardServerState.global_ratio,
      free_space_on_disk: transfer.free_space_on_disk ?? dashboardServerState.free_space_on_disk
    };
    response.json({
      ok: true,
      qbitUrl: qbit.baseUrl,
      version: appInfo.version,
      apiVersion: appInfo.apiVersion,
      transfer,
      serverState,
      daily: getDailyStats(transfer, serverState)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard", async (request, response, next) => {
  try {
    const clientRid = requestedRid(request.query.rid);
    const rid = dashboardInitialized ? clientRid : 0;

    let inflight = dashboardInflight.get(rid);
    if (!inflight) {
      inflight = (async () => {
        const [appInfo, syncData] = await Promise.all([
          getAppInfo(),
          qbit.json(`/api/v2/sync/maindata?rid=${rid}`)
        ]);
        if (syncData.full_update) dashboardServerState = {};
        Object.assign(dashboardServerState, syncData.server_state || {});
        dashboardInitialized = true;
        return {
          ok: true,
          qbitUrl: qbit.baseUrl,
          version: appInfo.version,
          apiVersion: appInfo.apiVersion,
          rid: requestedRid(syncData.rid),
          fullUpdate: Boolean(syncData.full_update),
          torrents: syncData.torrents || {},
          torrentsRemoved: syncData.torrents_removed || [],
          categories: syncData.categories || {},
          categoriesRemoved: syncData.categories_removed || [],
          tags: syncData.tags || [],
          tagsRemoved: syncData.tags_removed || [],
          serverState: dashboardServerState,
          daily: getDailyStats(dashboardServerState, dashboardServerState)
        };
      })().finally(() => {
        if (dashboardInflight.get(rid) === inflight) dashboardInflight.delete(rid);
      });
      dashboardInflight.set(rid, inflight);
    }

    response.json(await inflight);
  } catch (error) {
    // Force full resync next time after hard failure (session drop, rid mismatch, etc.)
    dashboardInitialized = false;
    next(error);
  }
});

app.get("/api/torrents", async (request, response, next) => {
  try {
    const allowed = ["filter", "category", "tag", "sort", "reverse", "limit", "offset", "hashes"];
    const query = Object.fromEntries(allowed.map((key) => [key, request.query[key]]));
    response.json(await qbit.json(`/api/v2/torrents/info${buildQuery(query)}`));
  } catch (error) {
    next(error);
  }
});

app.get("/api/transfer", async (_request, response, next) => {
  try {
    response.json(await qbit.json("/api/v2/transfer/info"));
  } catch (error) {
    next(error);
  }
});

app.get("/api/categories", async (_request, response, next) => {
  try {
    response.json(await qbit.json("/api/v2/torrents/categories"));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tags", async (_request, response, next) => {
  try {
    response.json(await qbit.json("/api/v2/torrents/tags"));
  } catch (error) {
    next(error);
  }
});

app.post("/api/torrents/add", async (request, response, next) => {
  try {
    const { urls, category, tags, savepath, paused, skipChecking, sequentialDownload, firstLastPiecePrio } = request.body || {};
    await qbit.postMultipart("/api/v2/torrents/add", {
      urls: torrentUrlsField(urls),
      category: textField(category, "分类", { max: 200 }),
      tags: textField(tags, "标签", { max: 500 }),
      savepath: textField(savepath, "保存路径", { max: 1000 }),
      paused: paused ? "true" : "false",
      skip_checking: skipChecking ? "true" : "false",
      sequentialDownload: sequentialDownload ? "true" : "false",
      firstLastPiecePrio: firstLastPiecePrio ? "true" : "false"
    });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/torrents/action", async (request, response, next) => {
  try {
    const { action, hashes, deleteFiles, category, tags, dlLimit, upLimit } = request.body || {};
    const selected = hashField(hashes);
    if (!action) throw new QbitError("缺少操作类型", 400);

    if (action === "pause") {
      await withActionFallback(
        () => qbit.postForm("/api/v2/torrents/pause", { hashes: selected }),
        () => qbit.postForm("/api/v2/torrents/stop", { hashes: selected })
      );
    } else if (action === "resume") {
      await withActionFallback(
        () => qbit.postForm("/api/v2/torrents/resume", { hashes: selected }),
        () => qbit.postForm("/api/v2/torrents/start", { hashes: selected })
      );
    } else if (action === "delete") {
      await qbit.postForm("/api/v2/torrents/delete", { hashes: selected, deleteFiles: deleteFiles ? "true" : "false" });
    } else if (action === "recheck") {
      await qbit.postForm("/api/v2/torrents/recheck", { hashes: selected });
    } else if (action === "reannounce") {
      await qbit.postForm("/api/v2/torrents/reannounce", { hashes: selected });
    } else if (action === "setCategory") {
      await qbit.postForm("/api/v2/torrents/setCategory", { hashes: selected, category: textField(category, "分类", { max: 200 }) });
    } else if (action === "addTags") {
      await qbit.postForm("/api/v2/torrents/addTags", { hashes: selected, tags: textField(tags, "标签", { max: 500 }) });
    } else if (action === "setDlLimit") {
      await qbit.postForm("/api/v2/torrents/setDownloadLimit", { hashes: selected, limit: limitField(dlLimit ?? 0, "下载限速") });
    } else if (action === "setUpLimit") {
      await qbit.postForm("/api/v2/torrents/setUploadLimit", { hashes: selected, limit: limitField(upLimit ?? 0, "上传限速") });
    } else {
      throw new QbitError(`不支持的操作：${action}`, 400);
    }
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/transfer/limits", async (request, response, next) => {
  try {
    const { dlLimit, upLimit } = request.body || {};
    if (dlLimit !== undefined) {
      await qbit.postForm("/api/v2/transfer/setDownloadLimit", { limit: limitField(dlLimit, "下载限速") });
    }
    if (upLimit !== undefined) {
      await qbit.postForm("/api/v2/transfer/setUploadLimit", { limit: limitField(upLimit, "上传限速") });
    }
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

if (process.env.SERVE_STATIC === "true" || process.argv.includes("--static")) {
  const distPath = path.resolve(__dirname, "../dist");
  const indexPath = path.join(distPath, "index.html");
  if (!fs.existsSync(indexPath)) {
    console.error("[static] dist/index.html 不存在，请先运行: npm run build");
    process.exit(1);
  }
  app.use(express.static(distPath, { index: "index.html", dotfiles: "deny", fallthrough: true }));
  app.get(/^\/(?!api).*/, (_request, response, next) => {
    if (!fs.existsSync(indexPath)) return next(new QbitError("前端尚未构建，请先运行 npm run build", 503));
    response.sendFile(indexPath);
  });
}

app.use((error, _request, response, _next) => {
  const rawStatus = Number(error.status || 500);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const body = {
    ok: false,
    message: error.message || "服务器错误"
  };
  if (status < 500 && error.details !== undefined) {
    body.details = error.details;
  }
  response.status(status).json(body);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`PT qB proxy listening on http://127.0.0.1:${port}`);
  console.log(`qBittorrent targets: ${qbitUrls.join(" -> ")}`);
});
