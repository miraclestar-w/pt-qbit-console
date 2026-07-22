/**
 * Daily stats collector for qBittorrent.
 * Samples torrents periodically and aggregates per-day / per-tracker traffic,
 * status duration, and speed min/max/avg.
 */
import fs from "node:fs";
import path from "node:path";

/** Status buckets used for duration accounting. */
export const STATUS_KEYS = [
  "downloading",
  "seeding",
  "stalled_up",
  "stalled_dl",
  "paused",
  "error",
  "checking",
  "other"
];

/** Map legacy "stalled" bucket into stalled_up for old day files. */
const LEGACY_STATUS_MAP = {
  stalled: "stalled_up"
};

function numberOrAny(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Shift a YYYY-MM-DD calendar key by delta days (pure date arithmetic). */
function shiftDayKey(dateStr, deltaDays) {
  const parts = String(dateStr || "").split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return "";
  const [y, m, d] = parts;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(deltaDays || 0));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Parse lastSnapshot.at as epoch ms (number or ISO string). */

function parseSnapshotAt(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== "") {
    // numeric string epoch
    if (/^\d+(\.\d+)?$/.test(String(value).trim())) return n;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function emptySpeedStats() {
  return { min: null, max: null, sum: 0, n: 0, activeMin: null, activeSum: 0, activeN: 0 };
}

function emptyStatusMap() {
  return Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
}

function emptyCountsMap() {
  return Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
}

function emptyTrackerBucket() {
  return {
    downloaded: 0,
    uploaded: 0,
    sampleCount: 0,
    torrentCountMax: 0,
    torrentCountSum: 0,
    dlSpeed: emptySpeedStats(),
    upSpeed: emptySpeedStats(),
    statusSeconds: emptyStatusMap(),
    statusWallSeconds: emptyStatusMap(),
    statusCountSum: emptyCountsMap()
  };
}

function emptyDay(date) {
  return {
    date,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sampleCount: 0,
    trafficSource: "torrent_delta",
    global: {
      downloaded: 0,
      uploaded: 0,
      alltimeDlStart: null,
      alltimeUlStart: null,
      alltimeDlEnd: null,
      alltimeUlEnd: null,
      alltimeDownloaded: 0,
      alltimeUploaded: 0,
      freeSpaceMin: null,
      freeSpaceMax: null,
      torrentCountMax: 0,
      torrentCountSum: 0,
      dlSpeed: emptySpeedStats(),
      upSpeed: emptySpeedStats(),
      statusSeconds: emptyStatusMap(),
      statusWallSeconds: emptyStatusMap(),
      statusCountSum: emptyCountsMap()
    },
    trackers: {},
    lastSnapshot: null
  };
}

function ensureSpeed(stats) {
  if (!stats || typeof stats !== "object") return emptySpeedStats();
  return {
    min: stats.min ?? null,
    max: stats.max ?? null,
    sum: numberOrAny(stats.sum),
    n: numberOrAny(stats.n),
    activeMin: stats.activeMin ?? null,
    activeSum: numberOrAny(stats.activeSum),
    activeN: numberOrAny(stats.activeN)
  };
}

function ensureStatus(map) {
  const out = emptyStatusMap();
  if (!map || typeof map !== "object") return out;
  for (const [rawKey, value] of Object.entries(map)) {
    const key = LEGACY_STATUS_MAP[rawKey] || rawKey;
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] += numberOrAny(value);
    }
  }
  return out;
}

function ensureCounts(map) {
  return ensureStatus(map);
}

function ensureTracker(raw) {
  const base = emptyTrackerBucket();
  if (!raw || typeof raw !== "object") return base;
  return {
    downloaded: numberOrAny(raw.downloaded),
    uploaded: numberOrAny(raw.uploaded),
    sampleCount: numberOrAny(raw.sampleCount),
    torrentCountMax: numberOrAny(raw.torrentCountMax),
    torrentCountSum: numberOrAny(raw.torrentCountSum),
    dlSpeed: ensureSpeed(raw.dlSpeed),
    upSpeed: ensureSpeed(raw.upSpeed),
    statusSeconds: ensureStatus(raw.statusSeconds),
    statusWallSeconds: ensureStatus(raw.statusWallSeconds),
    statusCountSum: ensureCounts(raw.statusCountSum)
  };
}

function slimSnapshotTorrents(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = Object.create(null);
  for (const [hash, row] of Object.entries(raw)) {
    if (!hash || !row || typeof row !== "object") continue;
    const uploaded = numberOrAny(row.u ?? row.uploaded);
    const downloaded = numberOrAny(row.d ?? row.downloaded);
    const tracker = String((row.t ?? row.tracker) || "\u672a\u6c47\u62a5");
    out[hash] = { u: uploaded, d: downloaded, t: tracker };
  }
  return out;
}

function normalizeDay(raw, date) {
  const day = emptyDay(date);
  if (!raw || typeof raw !== "object") return day;
  day.createdAt = raw.createdAt || day.createdAt;
  day.updatedAt = raw.updatedAt || day.updatedAt;
  day.sampleCount = numberOrAny(raw.sampleCount);
  day.trafficSource = "torrent_delta";
  if (raw.lastSnapshot && typeof raw.lastSnapshot === "object") {
    day.lastSnapshot = {
      at: parseSnapshotAt(raw.lastSnapshot.at),
      transfer: raw.lastSnapshot.transfer || null,
      torrents: slimSnapshotTorrents(raw.lastSnapshot.torrents)
    };
  }
  if (raw.global && typeof raw.global === "object") {
    day.global.downloaded = numberOrAny(raw.global.downloaded);
    day.global.uploaded = numberOrAny(raw.global.uploaded);
    day.global.alltimeDlStart = raw.global.alltimeDlStart ?? null;
    day.global.alltimeUlStart = raw.global.alltimeUlStart ?? null;
    day.global.alltimeDlEnd = raw.global.alltimeDlEnd ?? null;
    day.global.alltimeUlEnd = raw.global.alltimeUlEnd ?? null;
    day.global.alltimeDownloaded = numberOrAny(raw.global.alltimeDownloaded);
    day.global.alltimeUploaded = numberOrAny(raw.global.alltimeUploaded);
    if (!day.global.alltimeDownloaded && day.global.alltimeDlStart != null && day.global.alltimeDlEnd != null) {
      day.global.alltimeDownloaded = Math.max(0, numberOrAny(day.global.alltimeDlEnd) - numberOrAny(day.global.alltimeDlStart));
    }
    if (!day.global.alltimeUploaded && day.global.alltimeUlStart != null && day.global.alltimeUlEnd != null) {
      day.global.alltimeUploaded = Math.max(0, numberOrAny(day.global.alltimeUlEnd) - numberOrAny(day.global.alltimeUlStart));
    }
    day.global.freeSpaceMin = raw.global.freeSpaceMin ?? null;
    day.global.freeSpaceMax = raw.global.freeSpaceMax ?? null;
    day.global.torrentCountMax = numberOrAny(raw.global.torrentCountMax);
    day.global.torrentCountSum = numberOrAny(raw.global.torrentCountSum);
    day.global.dlSpeed = ensureSpeed(raw.global.dlSpeed);
    day.global.upSpeed = ensureSpeed(raw.global.upSpeed);
    day.global.statusSeconds = ensureStatus(raw.global.statusSeconds);
    day.global.statusWallSeconds = ensureStatus(raw.global.statusWallSeconds);
    day.global.statusCountSum = ensureCounts(raw.global.statusCountSum);
  }
  day.trackers = {};
  if (raw.trackers && typeof raw.trackers === "object") {
    for (const [host, bucket] of Object.entries(raw.trackers)) {
      day.trackers[host] = ensureTracker(bucket);
    }
  }
  return day;
}

function pushSpeed(stats, value) {
  const v = Math.max(0, numberOrAny(value));
  if (stats.min === null || v < stats.min) stats.min = v;
  if (stats.max === null || v > stats.max) stats.max = v;
  stats.sum += v;
  stats.n += 1;
  if (v > 0) {
    if (stats.activeMin === null || v < stats.activeMin) stats.activeMin = v;
    stats.activeSum += v;
    stats.activeN += 1;
  }
}

function finalizeSpeed(stats) {
  const n = stats.n || 0;
  const activeN = stats.activeN || 0;
  return {
    min: stats.min === null ? 0 : stats.min,
    max: stats.max === null ? 0 : stats.max,
    avg: n ? stats.sum / n : 0,
    activeMin: stats.activeMin === null ? 0 : stats.activeMin,
    activeAvg: activeN ? stats.activeSum / activeN : 0,
    samples: n,
    activeSamples: activeN
  };
}

/** Safe JSON ratio: number, 0, or null (null means Infinity / pure upload). */
export function safeRatio(uploaded, downloaded) {
  const ul = numberOrAny(uploaded);
  const dl = numberOrAny(downloaded);
  if (dl > 0) return Math.round((ul / dl) * 10000) / 10000;
  if (ul > 0) return null;
  return 0;
}

function statusKind(state, progress = 0) {
  const s = String(state || "unknown");
  if (["error", "missingFiles"].includes(s)) return "error";
  if (s.includes("checking")) return "checking";
  if (s.includes("paused") || s.includes("stopped")) return "paused";
  if (s === "stalledUP" || s.includes("stalledUP")) return "stalled_up";
  if (s === "stalledDL" || s.includes("stalledDL")) return "stalled_dl";
  if (s.includes("stalled")) {
    return numberOrAny(progress) >= 1 ? "stalled_up" : "stalled_dl";
  }
  if (s.includes("uploading") || s.includes("forcedUP") || s.includes("queuedUP")) return "seeding";
  if (s.includes("downloading") || s.includes("forcedDL") || s.includes("metaDL") || s.includes("queuedDL")) {
    return "downloading";
  }
  return "other";
}

function trackerHost(tracker) {
  if (!tracker) return "\u672a\u6c47\u62a5";
  const text = String(tracker);
  try {
    return new URL(text).hostname.replace(/^www\./, "") || "\u672a\u6c47\u62a5";
  } catch {
    return text.replace(/^https?:\/\//, "").split("/")[0] || text || "\u672a\u6c47\u62a5";
  }
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  fs.writeFileSync(tmpPath, payload);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    fs.renameSync(tmpPath, filePath);
  }
}

function finalizeDayView(day) {
  const trackers = Object.entries(day.trackers || {})
    .map(([host, raw]) => {
      const t = ensureTracker(raw);
      const samples = Math.max(1, t.sampleCount || day.sampleCount || 1);
      const statusAvg = {};
      for (const k of STATUS_KEYS) statusAvg[k] = (t.statusCountSum[k] || 0) / samples;
      return {
        host,
        downloaded: t.downloaded,
        uploaded: t.uploaded,
        ratio: safeRatio(t.uploaded, t.downloaded),
        torrentCountAvg: t.sampleCount ? t.torrentCountSum / t.sampleCount : 0,
        torrentCountMax: t.torrentCountMax,
        sampleCount: t.sampleCount,
        dlSpeed: finalizeSpeed(t.dlSpeed),
        upSpeed: finalizeSpeed(t.upSpeed),
        statusSeconds: t.statusSeconds,
        statusWallSeconds: t.statusWallSeconds || emptyStatusMap(),
        statusAvg
      };
    })
    .sort((a, b) => (b.uploaded + b.downloaded) - (a.uploaded + a.downloaded));

  const g = day.global;
  const gSamples = Math.max(1, day.sampleCount || 1);
  const statusAvg = {};
  for (const k of STATUS_KEYS) statusAvg[k] = (g.statusCountSum[k] || 0) / gSamples;
  const seedingRelatedSeconds =
    numberOrAny(g.statusSeconds.seeding) + numberOrAny(g.statusSeconds.stalled_up);

  return {
    date: day.date,
    createdAt: day.createdAt,
    updatedAt: day.updatedAt,
    sampleCount: day.sampleCount,
    trafficSource: day.trafficSource || "torrent_delta",
    global: {
      downloaded: g.downloaded,
      uploaded: g.uploaded,
      ratio: safeRatio(g.uploaded, g.downloaded),
      alltimeDlStart: g.alltimeDlStart,
      alltimeUlStart: g.alltimeUlStart,
      alltimeDlEnd: g.alltimeDlEnd,
      alltimeUlEnd: g.alltimeUlEnd,
      alltimeDownloaded: g.alltimeDownloaded || 0,
      alltimeUploaded: g.alltimeUploaded || 0,
      freeSpaceMin: g.freeSpaceMin,
      freeSpaceMax: g.freeSpaceMax,
      torrentCountAvg: day.sampleCount ? g.torrentCountSum / day.sampleCount : 0,
      torrentCountMax: g.torrentCountMax,
      dlSpeed: finalizeSpeed(g.dlSpeed),
      upSpeed: finalizeSpeed(g.upSpeed),
      statusSeconds: g.statusSeconds,
      statusWallSeconds: g.statusWallSeconds || emptyStatusMap(),
      statusAvg,
      seedingRelatedSeconds,
      seedingRelatedWallSeconds:
        numberOrAny(g.statusWallSeconds?.seeding) + numberOrAny(g.statusWallSeconds?.stalled_up)
    },
    trackers
  };
}

export class DailyStatsCollector {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.dayKey = options.dayKey;
    this.fetchTorrents = options.fetchTorrents;
    this.fetchTransfer = options.fetchTransfer || (async () => ({}));
    this.sampleMs = options.sampleMs ?? 60_000;
    this.maxGapMs = options.maxGapMs ?? 15 * 60_000;
    this.retentionDays = options.retentionDays ?? 90;
    this.forceMinIntervalMs = options.forceMinIntervalMs ?? 10_000;
    this.logger = options.logger || (() => {});
    this.timer = null;
    this.intervalTimer = null;
    this.inflight = null;
    this.lastForceAt = 0;
    this.cache = new Map();
    this.viewCache = new Map();
    this.dirty = new Set();
    this.saveTimer = null;
    this.stopped = false;
    // Live cache from dashboard maindata (avoids extra torrents/info when fresh)
    this.liveTorrents = null;
    this.liveTransfer = null;
    this.lastIngestAt = 0;
    this.trackerByHash = new Map();
    this.lastSampleAt = 0;
    this.lastSampleDurationMs = 0;
    this.lastSampleSource = "none";
    this.successCount = 0;
    this.failCount = 0;
    this.failStreak = 0;
    this.lastError = null;
    this.currentIntervalMs = this.sampleMs;
  }

  /** Merge maindata / transfer into live cache for zero-extra-API sampling. */
  ingestLive({ torrents, transfer, serverState } = {}) {
    if (this.stopped) return;
    let list = null;
    if (Array.isArray(torrents)) {
      list = torrents;
    } else if (torrents && typeof torrents === "object") {
      list = Object.entries(torrents).map(([hash, row]) => ({
        ...(row || {}),
        hash: (row && row.hash) || hash
      }));
    }
    if (list) {
      this.liveTorrents = list;
      for (const t of list) {
        const hash = String(t.hash || "").toLowerCase();
        const tr = String(t.tracker || "").trim();
        if (hash && tr) this.trackerByHash.set(hash, tr);
      }
    }
    const ss = serverState || {};
    const tr = transfer || {};
    this.liveTransfer = {
      alltime_dl: numberOrAny(ss.alltime_dl ?? tr.alltime_dl ?? tr.alltimeDl),
      alltime_ul: numberOrAny(ss.alltime_ul ?? tr.alltime_ul ?? tr.alltimeUl),
      dl_info_speed: Math.max(0, numberOrAny(ss.dl_info_speed ?? tr.dl_info_speed)),
      up_info_speed: Math.max(0, numberOrAny(ss.up_info_speed ?? tr.up_info_speed)),
      free_space_on_disk:
        ss.free_space_on_disk != null
          ? numberOrAny(ss.free_space_on_disk)
          : tr.free_space_on_disk != null
            ? numberOrAny(tr.free_space_on_disk)
            : null
    };
    this.lastIngestAt = Date.now();
    // Opportunistic sample when interval elapsed and idle
    if (
      !this.inflight &&
      this.lastSampleAt > 0 &&
      Date.now() - this.lastSampleAt >= this.currentIntervalMs
    ) {
      void this.sampleSafe();
    }
  }

  getHealth() {
    return {
      running: Boolean(this.timer) && !this.stopped,
      sampleMs: this.sampleMs,
      currentIntervalMs: this.currentIntervalMs,
      maxGapMs: this.maxGapMs,
      forceMinIntervalMs: this.forceMinIntervalMs,
      lastSampleAt: this.lastSampleAt || null,
      lastSampleDurationMs: this.lastSampleDurationMs,
      lastSampleSource: this.lastSampleSource,
      lastIngestAt: this.lastIngestAt || null,
      liveTorrentCount: Array.isArray(this.liveTorrents) ? this.liveTorrents.length : 0,
      trackerCacheSize: this.trackerByHash.size,
      successCount: this.successCount,
      failCount: this.failCount,
      failStreak: this.failStreak,
      lastError: this.lastError,
      inflight: Boolean(this.inflight),
      dirtyDays: this.dirty.size
    };
  }

  start() {
    if (this.timer || this.stopped) return;
    this.logger(`[stats] collector started, interval ${this.sampleMs}ms`);
    this.currentIntervalMs = this.sampleMs;
    const tick = () => {
      void this.sampleSafe().finally(() => this._scheduleNext());
    };
    this.timer = setTimeout(tick, 3_000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  _scheduleNext() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    // Backoff on failures: sampleMs * 2^streak capped at 10min
    const factor = Math.min(8, Math.max(0, this.failStreak));
    this.currentIntervalMs = Math.min(10 * 60_000, this.sampleMs * (2 ** factor));
    this.timer = setTimeout(() => {
      void this.sampleSafe().finally(() => this._scheduleNext());
    }, this.currentIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.flushSync();
  }

  dayPath(date) {
    return path.join(this.dataDir, `${date}.json`);
  }

  loadDay(date, { keepSnapshot = true } = {}) {
    if (this.cache.has(date)) return this.cache.get(date);
    let day;
    try {
      const file = this.dayPath(date);
      if (fs.existsSync(file)) {
        day = normalizeDay(JSON.parse(fs.readFileSync(file, "utf8")), date);
      } else {
        day = emptyDay(date);
      }
    } catch (error) {
      this.logger(`[stats] load ${date} failed: ${error.message}`);
      day = emptyDay(date);
    }
    if (!keepSnapshot) day.lastSnapshot = null;
    const today = this.dayKey();
    if (date === today || keepSnapshot) this.cache.set(date, day);
    return day;
  }

  markDirty(date) {
    this.dirty.add(date);
    this.viewCache.delete(date);
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSync();
    }, 2_000);
    if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
  }

  flushSync() {
    if (!this.dirty.size) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const date of [...this.dirty]) {
      const day = this.cache.get(date);
      if (!day) {
        this.dirty.delete(date);
        continue;
      }
      try {
        const payload = {
          date: day.date,
          createdAt: day.createdAt,
          updatedAt: day.updatedAt,
          sampleCount: day.sampleCount,
          trafficSource: "torrent_delta",
          global: day.global,
          trackers: day.trackers,
          lastSnapshot: day.lastSnapshot
            ? {
                at: day.lastSnapshot.at,
                transfer: day.lastSnapshot.transfer,
                torrents: slimSnapshotTorrents(day.lastSnapshot.torrents)
              }
            : null
        };
        atomicWriteJson(this.dayPath(date), payload);
        this.dirty.delete(date);
      } catch (error) {
        this.logger(`[stats] save ${date} failed: ${error.message}`);
        // keep in dirty; schedule one retry
        if (!this.saveTimer) {
          this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flushSync();
          }, 5_000);
          if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
        }
      }
    }
    this.pruneOldFiles();
  }

  pruneOldFiles() {
    try {
      if (!fs.existsSync(this.dataDir)) return;
      const files = fs.readdirSync(this.dataDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
      if (files.length <= this.retentionDays) return;
      files.sort();
      const remove = files.slice(0, Math.max(0, files.length - this.retentionDays));
      for (const f of remove) {
        try {
          fs.unlinkSync(path.join(this.dataDir, f));
          const date = f.replace(/\.json$/, "");
          this.cache.delete(date);
          this.viewCache.delete(date);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  listDays() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const fromDisk = fs.readdirSync(this.dataDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, ""));
    const today = this.dayKey();
    if (!fromDisk.includes(today) && this.cache.has(today)) fromDisk.push(today);
    return [...new Set(fromDisk)].sort().reverse();
  }

  getDayView(date) {
    if (this.viewCache.has(date) && !this.dirty.has(date)) {
      return this.viewCache.get(date);
    }
    const today = this.dayKey();
    const day = this.loadDay(date, { keepSnapshot: date === today });
    if (date !== today && this.cache.has(date)) {
      const cached = this.cache.get(date);
      if (cached) cached.lastSnapshot = null;
    }
    const view = finalizeDayView(day);
    this.viewCache.set(date, view);
    if (this.viewCache.size > this.retentionDays + 5) {
      const keys = [...this.viewCache.keys()].sort();
      while (this.viewCache.size > this.retentionDays && keys.length) {
        const k = keys.shift();
        if (k !== today) this.viewCache.delete(k);
        else break;
      }
    }
    return view;
  }

  getSummary({ from, to, limit = 30 } = {}) {
    let days = this.listDays();
    if (from) days = days.filter((d) => d >= from);
    if (to) days = days.filter((d) => d <= to);
    days = days.slice(0, Math.max(1, Math.min(365, limit)));
    return days.map((d) => {
      const view = this.getDayView(d);
      return {
        date: view.date,
        sampleCount: view.sampleCount,
        downloaded: view.global.downloaded,
        uploaded: view.global.uploaded,
        ratio: view.global.ratio,
        dlSpeed: view.global.dlSpeed,
        upSpeed: view.global.upSpeed,
        torrentCountAvg: view.global.torrentCountAvg,
        torrentCountMax: view.global.torrentCountMax,
        statusSeconds: view.global.statusSeconds,
        statusWallSeconds: view.global.statusWallSeconds,
        seedingRelatedWallSeconds: view.global.seedingRelatedWallSeconds,
        trackerCount: view.trackers.length,
        updatedAt: view.updatedAt
      };
    });
  }

  /** Lightweight today snapshot for widgets / pollers. */
  getTodayBrief() {
    const date = this.dayKey();
    const view = this.getDayView(date);
    const g = view.global || {};
    return {
      date,
      sampleCount: view.sampleCount || 0,
      uploaded: g.uploaded || 0,
      downloaded: g.downloaded || 0,
      ratio: g.ratio,
      upSpeedMax: (g.upSpeed && g.upSpeed.max) || 0,
      dlSpeedMax: (g.dlSpeed && g.dlSpeed.max) || 0,
      torrentCountMax: g.torrentCountMax || 0,
      trackerCount: (view.trackers || []).length,
      updatedAt: view.updatedAt || null,
      lastSampleAt: this.lastSampleAt || null,
      lastSampleSource: this.lastSampleSource || null
    };
  }

  /**
   * Aggregate per-tracker traffic across recent days.
   * @param {{ days?: number, limit?: number }} opts
   */
  getTopTrackers({ days = 7, limit = 20 } = {}) {
    const rawDays = Math.floor(Number(days));
    const rawLimit = Math.floor(Number(limit));
    const nDays = Number.isFinite(rawDays) ? Math.max(1, Math.min(90, rawDays)) : 7;
    const nLimit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;
    const dayKeys = this.listDays().slice(0, nDays);
    const map = new Map();
    for (const date of dayKeys) {
      const view = this.getDayView(date);
      for (const t of view.trackers || []) {
        const host = String(t.host || "").trim() || "未知";
        let row = map.get(host);
        if (!row) {
          row = {
            host,
            uploaded: 0,
            downloaded: 0,
            daysActive: 0,
            peakUploaded: 0,
            peakDownloaded: 0
          };
          map.set(host, row);
        }
        const up = numberOrAny(t.uploaded);
        const dl = numberOrAny(t.downloaded);
        row.uploaded += up;
        row.downloaded += dl;
        if (up > 0 || dl > 0) row.daysActive += 1;
        if (up > row.peakUploaded) row.peakUploaded = up;
        if (dl > row.peakDownloaded) row.peakDownloaded = dl;
      }
    }
    return {
      days: nDays,
      dayKeys,
      trackers: [...map.values()]
        .map((r) => ({
          ...r,
          ratio: safeRatio(r.uploaded, r.downloaded),
          traffic: r.uploaded + r.downloaded
        }))
        .sort((a, b) => b.traffic - a.traffic)
        .slice(0, nLimit)
    };
  }

  /** Rollup totals for the last N collected days (newest first list). */
  getRollup({ days = 7 } = {}) {
    const rawDays = Math.floor(Number(days));
    const nDays = Number.isFinite(rawDays) ? Math.max(1, Math.min(90, rawDays)) : 7;
    const summary = this.getSummary({ limit: nDays });
    let uploaded = 0;
    let downloaded = 0;
    let sampleCount = 0;
    let peakUp = null;
    let peakDl = null;
    for (const d of summary) {
      uploaded += numberOrAny(d.uploaded);
      downloaded += numberOrAny(d.downloaded);
      sampleCount += numberOrAny(d.sampleCount);
      if (!peakUp || numberOrAny(d.uploaded) > peakUp.uploaded) {
        peakUp = { date: d.date, uploaded: numberOrAny(d.uploaded) };
      }
      if (!peakDl || numberOrAny(d.downloaded) > peakDl.downloaded) {
        peakDl = { date: d.date, downloaded: numberOrAny(d.downloaded) };
      }
    }
    const count = summary.length || 0;
    return {
      days: nDays,
      dayCount: count,
      dayKeys: summary.map((d) => d.date),
      uploaded,
      downloaded,
      ratio: safeRatio(uploaded, downloaded),
      sampleCount,
      avgUploaded: count ? uploaded / count : 0,
      avgDownloaded: count ? downloaded / count : 0,
      peakUploadDay: peakUp,
      peakDownloadDay: peakDl
    };
  }

  async sampleSafe(opts = {}) {
    const force = Boolean(opts.force);
    if (force) {
      const now = Date.now();
      if (now - this.lastForceAt < this.forceMinIntervalMs) {
        const wait = this.forceMinIntervalMs - (now - this.lastForceAt);
        const err = new Error(`\u91c7\u6837\u8fc7\u4e8e\u9891\u7e41\uff0c\u8bf7 ${Math.ceil(wait / 1000)} \u79d2\u540e\u518d\u8bd5`);
        err.status = 429;
        throw err;
      }
    }

    if (this.inflight) {
      const result = await this.inflight;
      if (force) this.lastForceAt = Date.now();
      return result;
    }
    this.inflight = this._sample({ forceApi: force })
      .then((view) => {
        if (force) this.lastForceAt = Date.now();
        return view;
      })
      .catch((error) => {
        this.logger(`[stats] sample failed: ${error.message}`);
        throw error;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  sample() {
    return this.sampleSafe({ force: false });
  }

  async _sample(opts = {}) {
    const forceApi = Boolean(opts.forceApi);
    const started = Date.now();
    const now = started;
    const date = this.dayKey();
    let torrents = [];
    let transfer = {};
    let source = "api";
    const liveAge = this.lastIngestAt ? now - this.lastIngestAt : Infinity;
    // Only use dashboard-fed cache when it is fresh AND at least as new as last sample
    // (or no sample yet). Prevents reusing a stale API snapshot as "live".
    const liveFresh =
      !forceApi &&
      Array.isArray(this.liveTorrents) &&
      this.liveTorrents.length > 0 &&
      this.lastIngestAt > 0 &&
      liveAge <= this.sampleMs * 2.5 &&
      (this.lastSampleAt <= 0 || this.lastIngestAt >= this.lastSampleAt);

    try {
      if (liveFresh) {
        torrents = this.liveTorrents;
        transfer = this.liveTransfer || {};
        source = "maindata_cache";
      } else {
        const [torrentsRaw, transferRaw] = await Promise.all([
          this.fetchTorrents(),
          this.fetchTransfer().catch(() => ({}))
        ]);
        torrents = Array.isArray(torrentsRaw) ? torrentsRaw : [];
        transfer = transferRaw || {};
        source = "api";
        // Refresh tracker/live maps for health display, but do NOT bump lastIngestAt.
        // lastIngestAt is owned by ingestLive (dashboard maindata). Bumping it here
        // would freeze scheduled samples on the same API payload for ~sampleMs*2.5.
        this.liveTorrents = torrents;
        if (transfer && typeof transfer === "object") {
          this.liveTransfer = {
            ...(this.liveTransfer || {}),
            ...transfer
          };
        }
        for (const t of torrents) {
          const hash = String(t.hash || "").toLowerCase();
          const tr = String(t.tracker || "").trim();
          if (hash && tr) this.trackerByHash.set(hash, tr);
        }
      }
    } catch (error) {
      this.failCount += 1;
      this.failStreak += 1;
      this.lastError = error.message || String(error);
      this.lastSampleSource = "error";
      this.lastSampleDurationMs = Date.now() - started;
      throw error;
    }

    const day = this.loadDay(date, { keepSnapshot: true });

    const snapTorrents = Object.create(null);
    for (const t of torrents) {
      const hash = String(t.hash || "").toLowerCase();
      if (!hash) continue;
      let tracker = String(t.tracker || "").trim();
      if (!tracker && this.trackerByHash.has(hash)) tracker = this.trackerByHash.get(hash);
      if (tracker) this.trackerByHash.set(hash, tracker);
      snapTorrents[hash] = {
        u: numberOrAny(t.uploaded),
        d: numberOrAny(t.downloaded),
        t: trackerHost(tracker),
        dlspeed: Math.max(0, numberOrAny(t.dlspeed)),
        upspeed: Math.max(0, numberOrAny(t.upspeed)),
        kind: statusKind(t.state, t.progress)
      };
    }

    const transferSnap = {
      alltime_dl: numberOrAny(transfer.alltime_dl ?? transfer.alltimeDl),
      alltime_ul: numberOrAny(transfer.alltime_ul ?? transfer.alltimeUl),
      dl_info_speed: Math.max(0, numberOrAny(transfer.dl_info_speed ?? transfer.dl_info_speed)),
      up_info_speed: Math.max(0, numberOrAny(transfer.up_info_speed)),
      free_space_on_disk:
        transfer.free_space_on_disk != null ? numberOrAny(transfer.free_space_on_disk) : null
    };

    // Prefer today's snapshot; if first sample of the day, carry yesterday's
    // lastSnapshot so short gaps across midnight do not drop torrent deltas.
    // Overnight bytes land on the day of the first post-gap sample (no true midnight split).
    let prev = day.lastSnapshot;
    let prevSource = prev && prev.at ? "today" : null;
    if (!prev || !prev.at || !prev.torrents || !Object.keys(prev.torrents).length) {
      const ydayKey = shiftDayKey(date, -1);
      if (ydayKey) {
        const yday = this.loadDay(ydayKey, { keepSnapshot: true });
        if (yday.lastSnapshot && yday.lastSnapshot.at && yday.lastSnapshot.torrents) {
          prev = yday.lastSnapshot;
          prevSource = "yesterday";
        }
      }
    }
    const prevTorrents = prev && prev.torrents ? slimSnapshotTorrents(prev.torrents) : null;
    const hasPrev = Boolean(prev && prev.at && prevTorrents && Object.keys(prevTorrents).length);
    const dtMs = hasPrev ? now - parseSnapshotAt(prev.at) : 0;
    const acceptDelta = hasPrev && dtMs > 0 && dtMs <= this.maxGapMs;
    const dtSec = acceptDelta ? dtMs / 1000 : 0;
    if (acceptDelta && prevSource === "yesterday") {
      this.logger(`[stats] day ${date}: delta carried from previous day snapshot (gap ${Math.round(dtMs / 1000)}s)`);
    }

    pushSpeed(day.global.dlSpeed, transferSnap.dl_info_speed);
    pushSpeed(day.global.upSpeed, transferSnap.up_info_speed);

    if (transferSnap.free_space_on_disk != null) {
      if (day.global.freeSpaceMin === null || transferSnap.free_space_on_disk < day.global.freeSpaceMin) {
        day.global.freeSpaceMin = transferSnap.free_space_on_disk;
      }
      if (day.global.freeSpaceMax === null || transferSnap.free_space_on_disk > day.global.freeSpaceMax) {
        day.global.freeSpaceMax = transferSnap.free_space_on_disk;
      }
    }

    if (day.global.alltimeDlStart === null && transferSnap.alltime_dl > 0) {
      day.global.alltimeDlStart = transferSnap.alltime_dl;
    }
    if (day.global.alltimeUlStart === null && transferSnap.alltime_ul > 0) {
      day.global.alltimeUlStart = transferSnap.alltime_ul;
    }
    if (transferSnap.alltime_dl > 0) day.global.alltimeDlEnd = transferSnap.alltime_dl;
    if (transferSnap.alltime_ul > 0) day.global.alltimeUlEnd = transferSnap.alltime_ul;
    if (day.global.alltimeDlStart != null && day.global.alltimeDlEnd != null) {
      day.global.alltimeDownloaded = Math.max(0, numberOrAny(day.global.alltimeDlEnd) - numberOrAny(day.global.alltimeDlStart));
    }
    if (day.global.alltimeUlStart != null && day.global.alltimeUlEnd != null) {
      day.global.alltimeUploaded = Math.max(0, numberOrAny(day.global.alltimeUlEnd) - numberOrAny(day.global.alltimeUlStart));
    }

    const totalCount = Object.keys(snapTorrents).length;
    day.global.torrentCountSum += totalCount;
    if (totalCount > day.global.torrentCountMax) day.global.torrentCountMax = totalCount;

    const globalStatusCounts = emptyCountsMap();
    const trackerTraffic = new Map();
    const trackerLive = new Map();

    for (const [hash, cur] of Object.entries(snapTorrents)) {
      globalStatusCounts[cur.kind] = (globalStatusCounts[cur.kind] || 0) + 1;

      let live = trackerLive.get(cur.t);
      if (!live) {
        live = { n: 0, dlSpeed: 0, upSpeed: 0, counts: emptyCountsMap() };
        trackerLive.set(cur.t, live);
      }
      live.n += 1;
      live.dlSpeed += cur.dlspeed;
      live.upSpeed += cur.upspeed;
      live.counts[cur.kind] = (live.counts[cur.kind] || 0) + 1;

      if (acceptDelta && prevTorrents[hash]) {
        const p = prevTorrents[hash];
        const dDl = cur.d >= numberOrAny(p.d) ? cur.d - numberOrAny(p.d) : 0;
        const dUl = cur.u >= numberOrAny(p.u) ? cur.u - numberOrAny(p.u) : 0;
        const attrHost = p.t || cur.t || "\u672a\u6c47\u62a5";
        let acc = trackerTraffic.get(attrHost);
        if (!acc) {
          acc = { dlDelta: 0, ulDelta: 0 };
          trackerTraffic.set(attrHost, acc);
        }
        acc.dlDelta += dDl;
        acc.ulDelta += dUl;
      }
    }

    if (!day.global.statusWallSeconds) day.global.statusWallSeconds = emptyStatusMap();
    if (dtSec > 0) {
      for (const k of STATUS_KEYS) {
        const n = globalStatusCounts[k] || 0;
        day.global.statusSeconds[k] += n * dtSec;
        if (n > 0) day.global.statusWallSeconds[k] += dtSec;
        day.global.statusCountSum[k] += n;
      }
    } else {
      for (const k of STATUS_KEYS) {
        day.global.statusCountSum[k] += globalStatusCounts[k] || 0;
      }
    }

    const allHosts = new Set([...trackerLive.keys(), ...trackerTraffic.keys()]);
    let sumDl = 0;
    let sumUl = 0;
    for (const host of allHosts) {
      if (!day.trackers[host]) day.trackers[host] = emptyTrackerBucket();
      const bucket = day.trackers[host];
      const live = trackerLive.get(host);
      const traffic = trackerTraffic.get(host);
      if (live && live.n > 0) {
        bucket.sampleCount += 1;
        bucket.torrentCountSum += live.n;
        if (live.n > bucket.torrentCountMax) bucket.torrentCountMax = live.n;
        pushSpeed(bucket.dlSpeed, live.dlSpeed);
        pushSpeed(bucket.upSpeed, live.upSpeed);
        if (!bucket.statusWallSeconds) bucket.statusWallSeconds = emptyStatusMap();
        if (dtSec > 0) {
          for (const k of STATUS_KEYS) {
            const n = live.counts[k] || 0;
            bucket.statusSeconds[k] += n * dtSec;
            if (n > 0) bucket.statusWallSeconds[k] += dtSec;
            bucket.statusCountSum[k] += n;
          }
        } else {
          for (const k of STATUS_KEYS) {
            bucket.statusCountSum[k] += live.counts[k] || 0;
          }
        }
      }
      if (acceptDelta && traffic) {
        bucket.downloaded += traffic.dlDelta;
        bucket.uploaded += traffic.ulDelta;
        sumDl += traffic.dlDelta;
        sumUl += traffic.ulDelta;
      }
    }

    // Primary traffic: torrent deltas only (aligned with per-tracker totals).
    if (acceptDelta) {
      day.global.downloaded += sumDl;
      day.global.uploaded += sumUl;
    }

    day.sampleCount += 1;
    day.updatedAt = new Date().toISOString();
    day.trafficSource = "torrent_delta";
    day.lastSnapshot = {
      at: now,
      transfer: transferSnap,
      torrents: Object.fromEntries(
        Object.entries(snapTorrents).map(([hash, row]) => [hash, { u: row.u, d: row.d, t: row.t }])
      )
    };

    // Drop tracker cache entries for hashes no longer present (bound memory)
    if (this.trackerByHash.size > Object.keys(snapTorrents).length * 2) {
      for (const hash of [...this.trackerByHash.keys()]) {
        if (!snapTorrents[hash]) this.trackerByHash.delete(hash);
      }
    }

    this.cache.set(date, day);
    this.markDirty(date);
    this.successCount += 1;
    this.failStreak = 0;
    this.lastError = null;
    this.lastSampleAt = now;
    this.lastSampleDurationMs = Date.now() - started;
    this.lastSampleSource = source;
    return finalizeDayView(day);
  }
}

export const STATS_STATUS_KEYS = STATUS_KEYS;
