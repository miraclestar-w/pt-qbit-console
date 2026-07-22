/**
 * Lightweight mock unit test for DailyStatsCollector.
 * Run: node server/_test_daily_stats.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DailyStatsCollector,
  safeRatio,
  STATUS_KEYS
} from "./daily-stats.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || "eq"}: ${sa} !== ${sb}`);
}

// --- safeRatio ---
assertEq(safeRatio(100, 50), 2, "ratio 2");
assertEq(safeRatio(0, 0), 0, "ratio zero");
assertEq(safeRatio(10, 0), null, "ratio pure upload null");
assert(safeRatio(1, 3) > 0 && safeRatio(1, 3) < 1, "ratio fraction");

// --- collector with mock qB ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qb-stats-"));
let currentDay = "2099-01-15";
const dayKey = () => currentDay;

let tick = 0;
const torrentsByTick = [
  [
    {
      hash: "aaa",
      name: "t1",
      tracker: "https://a.example/announce",
      state: "uploading",
      progress: 1,
      downloaded: 1000,
      uploaded: 2000,
      dlspeed: 0,
      upspeed: 100
    },
    {
      hash: "bbb",
      name: "t2",
      tracker: "https://b.example/announce",
      state: "stalledDL",
      progress: 0.5,
      downloaded: 500,
      uploaded: 0,
      dlspeed: 0,
      upspeed: 0
    }
  ],
  [
    {
      hash: "aaa",
      name: "t1",
      tracker: "https://a.example/announce",
      state: "stalledUP",
      progress: 1,
      downloaded: 1000,
      uploaded: 3500,
      dlspeed: 0,
      upspeed: 0
    },
    {
      hash: "bbb",
      name: "t2",
      tracker: "https://b.example/announce",
      state: "downloading",
      progress: 0.6,
      downloaded: 800,
      uploaded: 50,
      dlspeed: 50,
      upspeed: 10
    }
  ],
  // day+1 first sample — further growth for carry-from-yesterday
  [
    {
      hash: "aaa",
      name: "t1",
      tracker: "https://a.example/announce",
      state: "uploading",
      progress: 1,
      downloaded: 1000,
      uploaded: 4000,
      dlspeed: 0,
      upspeed: 20
    },
    {
      hash: "bbb",
      name: "t2",
      tracker: "https://b.example/announce",
      state: "downloading",
      progress: 0.7,
      downloaded: 900,
      uploaded: 50,
      dlspeed: 10,
      upspeed: 0
    }
  ]
];

const logs = [];
const collector = new DailyStatsCollector({
  dataDir: tmp,
  dayKey,
  sampleMs: 60_000,
  retentionDays: 30,
  forceMinIntervalMs: 60_000,
  logger: (m) => logs.push(m),
  fetchTorrents: async () => torrentsByTick[Math.min(tick, torrentsByTick.length - 1)],
  fetchTransfer: async () => ({
    alltime_dl: 10_000 + tick * 100,
    alltime_ul: 20_000 + tick * 200,
    free_space_on_disk: 1_000_000_000
  })
});

await collector.sampleSafe();
tick = 1;
const day = collector.loadDay("2099-01-15");
assert(day.lastSnapshot, "has snapshot after first sample");
day.lastSnapshot.at = Date.now() - 60_000;
await collector.sampleSafe();

const view = collector.getDayView("2099-01-15");
assert(view.sampleCount >= 2, "sampleCount>=2 got " + view.sampleCount);
assertEq(view.global.uploaded, 1550, "global uploaded delta");
assertEq(view.global.downloaded, 300, "global downloaded delta");
assertEq(view.global.ratio, safeRatio(1550, 300), "global ratio");

const byHost = Object.fromEntries(view.trackers.map((t) => [t.host, t]));
assert(byHost["a.example"], "tracker a");
assert(byHost["b.example"], "tracker b");
assertEq(byHost["a.example"].uploaded, 1500, "a uploaded");
assertEq(byHost["b.example"].downloaded, 300, "b downloaded");
assertEq(byHost["b.example"].uploaded, 50, "b uploaded");

for (const k of STATUS_KEYS) {
  assert(k in view.global.statusSeconds, "status key " + k);
}
assert(view.global.statusSeconds.stalled_up > 0, "stalled_up duration");
assert(view.global.statusSeconds.downloading > 0, "downloading duration");

// force rate limit (success updates lastForceAt)
await collector.sampleSafe({ force: true });
let hit429 = false;
try {
  await collector.sampleSafe({ force: true });
} catch (e) {
  hit429 = e.status === 429;
}
assert(hit429, "force rate limit 429");

// flush & ISO reload
collector.flushSync();
const file = path.join(tmp, "2099-01-15.json");
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
raw.lastSnapshot.at = new Date(raw.lastSnapshot.at).toISOString();
fs.writeFileSync(file, JSON.stringify(raw));
collector.cache.clear();
collector.viewCache.clear();
const reloaded = collector.loadDay("2099-01-15");
assert(typeof reloaded.lastSnapshot.at === "number" && reloaded.lastSnapshot.at > 0, "ISO at parsed");

// --- cross-day carry ---
// ensure yesterday snapshot is numeric and recent
const yday = collector.loadDay("2099-01-15", { keepSnapshot: true });
assert(yday.lastSnapshot, "yday snap");
yday.lastSnapshot.at = Date.now() - 45_000;
// freeze counters as end-of-day baseline (tick 1 state on disk)
// advance day + counters
currentDay = "2099-01-16";
tick = 2;
await collector.sampleSafe();
const day2 = collector.getDayView("2099-01-16");
// deltas from tick1 -> tick2: aaa +500 up, bbb +100 dl
assertEq(day2.global.uploaded, 500, "cross-day carried uploaded");
assertEq(day2.global.downloaded, 100, "cross-day carried downloaded");
assert(
  logs.some((m) => String(m).includes("carried from previous day")),
  "should log carry-from-yesterday"
);

// gap too large: no carry delta
currentDay = "2099-01-17";
const d16 = collector.loadDay("2099-01-16", { keepSnapshot: true });
if (d16.lastSnapshot) d16.lastSnapshot.at = Date.now() - 20 * 60_000; // > maxGap 15m
tick = 2; // same counters -> if accepted would be 0 delta anyway; bump counters
const torrentsGap = [
  {
    hash: "aaa",
    tracker: "https://a.example/announce",
    state: "uploading",
    progress: 1,
    downloaded: 1000,
    uploaded: 5000,
    dlspeed: 0,
    upspeed: 0
  }
];
const origFetch = collector.fetchTorrents;
collector.fetchTorrents = async () => torrentsGap;
await collector.sampleSafe();
collector.fetchTorrents = origFetch;
const day3 = collector.getDayView("2099-01-17");
assertEq(day3.global.uploaded, 0, "large gap rejects delta");
assertEq(day3.sampleCount, 1, "day3 baseline sample");

// wall seconds: status with n>=1 advances wall by dtSec only once
assert(view.global.statusWallSeconds, "has statusWallSeconds");
assert(view.global.statusWallSeconds.stalled_up > 0, "wall stalled_up");
assert(view.global.statusWallSeconds.downloading > 0, "wall downloading");
// task-seconds should be >= wall when concurrent tasks > 1 possible; at least wall <= task for same key
assert(
  view.global.statusSeconds.stalled_up >= view.global.statusWallSeconds.stalled_up - 1e-6,
  "task-seconds >= wall for stalled_up"
);
assert(
  typeof view.global.seedingRelatedWallSeconds === "number",
  "seedingRelatedWallSeconds present"
);

// --- ingestLive + maindata_cache path ---
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "qb-stats2-"));
let apiHits = 0;
const c2 = new DailyStatsCollector({
  dataDir: tmp2,
  dayKey: () => "2099-02-01",
  sampleMs: 60_000,
  retentionDays: 30,
  forceMinIntervalMs: 1,
  logger: () => {},
  fetchTorrents: async () => {
    apiHits += 1;
    return [
      {
        hash: "ccc",
        tracker: "https://c.example/announce",
        state: "uploading",
        progress: 1,
        downloaded: 0,
        uploaded: 100,
        dlspeed: 0,
        upspeed: 10
      }
    ];
  },
  fetchTransfer: async () => ({ alltime_dl: 1, alltime_ul: 2, free_space_on_disk: 9 })
});
await c2.sampleSafe(); // api
assertEq(apiHits, 1, "first sample hits API");
// set snapshot age so next sample accepts delta
const d201 = c2.loadDay("2099-02-01");
d201.lastSnapshot.at = Date.now() - 60_000;
c2.ingestLive({
  torrents: [
    {
      hash: "ccc",
      tracker: "https://c.example/announce",
      state: "uploading",
      progress: 1,
      downloaded: 0,
      uploaded: 250,
      dlspeed: 0,
      upspeed: 20
    }
  ],
  transfer: { alltime_dl: 1, alltime_ul: 2 },
  serverState: { free_space_on_disk: 8 }
});
assert(c2.getHealth().liveTorrentCount === 1, "live torrent count");
assert(c2.getHealth().lastIngestAt, "lastIngestAt set");
const beforeHits = apiHits;
// non-force sample should use cache (fresh)
await c2.sampleSafe({ force: false });
assertEq(apiHits, beforeHits, "fresh live cache avoids API");
const v2 = c2.getDayView("2099-02-01");
assertEq(v2.global.uploaded, 150, "cache path uploaded delta");
assert(v2.global.statusWallSeconds.seeding > 0 || v2.global.statusSeconds.seeding > 0, "seeding time from cache");
// forceApi always hits API
await c2.sampleSafe({ force: true });
assert(apiHits > beforeHits, "force sample hits API");
const health = c2.getHealth();
assert(health.lastSampleSource === "api" || health.lastSampleSource === "maindata_cache", "sample source set");
assert(typeof health.successCount === "number" && health.successCount >= 2, "successCount");

// --- forceApi / fail streak backoff schedule ---
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "qb-stats3-"));
let failMode = true;
const c3 = new DailyStatsCollector({
  dataDir: tmp3,
  dayKey: () => "2099-03-01",
  sampleMs: 60_000,
  retentionDays: 30,
  forceMinIntervalMs: 1,
  logger: () => {},
  fetchTorrents: async () => {
    if (failMode) throw new Error("boom");
    return [];
  },
  fetchTransfer: async () => ({})
});
let threw = false;
try {
  await c3.sampleSafe();
} catch {
  threw = true;
}
assert(threw, "sample throws on fetch fail");
assert(c3.getHealth().failStreak >= 1, "failStreak increments");
c3._scheduleNext();
assert(c3.currentIntervalMs >= 120_000, "backoff doubles interval after fail");
failMode = false;
await c3.sampleSafe();
assertEq(c3.getHealth().failStreak, 0, "success resets failStreak");
c3._scheduleNext();
assertEq(c3.currentIntervalMs, 60_000, "interval resets to sampleMs");
c3.stop();
c2.stop();

// --- today brief / rollup / top trackers ---
// Persist in-memory days so listDays() sees multi-day history.
collector.flushSync();
// Point "today" at a day with known traffic for brief snapshot.
currentDay = "2099-01-15";
const brief = collector.getTodayBrief();
assertEq(brief.date, "2099-01-15", "today brief date");
assert(brief.uploaded > 0, "today brief uploaded");
assert(brief.downloaded > 0, "today brief downloaded");
assertEq(brief.ratio, safeRatio(brief.uploaded, brief.downloaded), "today brief ratio");
assert(typeof brief.sampleCount === "number" && brief.sampleCount >= 2, "today brief samples");
assert(typeof brief.trackerCount === "number" && brief.trackerCount >= 2, "today brief trackers");
assert("upSpeedMax" in brief && "dlSpeedMax" in brief, "today brief speed max");

const rollup = collector.getRollup({ days: 7 });
assertEq(rollup.days, 7, "rollup window");
assert(rollup.dayCount >= 2, "rollup has multiple days");
assert(Array.isArray(rollup.dayKeys) && rollup.dayKeys.length === rollup.dayCount, "rollup dayKeys");
assert(rollup.uploaded >= 1550, "rollup uploaded includes day1");
assert(rollup.downloaded >= 300, "rollup downloaded includes day1");
assertEq(rollup.ratio, safeRatio(rollup.uploaded, rollup.downloaded), "rollup ratio");
assert(rollup.avgUploaded > 0 && rollup.avgDownloaded > 0, "rollup avgs");
assert(rollup.peakUploadDay && rollup.peakUploadDay.date, "peak upload day");
assert(rollup.peakDownloadDay && rollup.peakDownloadDay.date, "peak download day");
assert(rollup.sampleCount >= 3, "rollup sampleCount sum");

const top = collector.getTopTrackers({ days: 7, limit: 5 });
assertEq(top.days, 7, "top days window");
assert(Array.isArray(top.dayKeys) && top.dayKeys.length >= 1, "top dayKeys");
assert(top.trackers.length >= 1, "top trackers non-empty");
assert(top.trackers.length <= 5, "top limit");
// Sorted by traffic desc
for (let i = 1; i < top.trackers.length; i++) {
  assert(top.trackers[i - 1].traffic >= top.trackers[i].traffic, "top sorted by traffic");
}
const topHosts = Object.fromEntries(top.trackers.map((t) => [t.host, t]));
assert(topHosts["a.example"], "top includes a.example");
assert(topHosts["a.example"].uploaded >= 1500, "a.example cum uploaded");
assertEq(
  topHosts["a.example"].ratio,
  safeRatio(topHosts["a.example"].uploaded, topHosts["a.example"].downloaded),
  "top tracker ratio"
);
assert(topHosts["a.example"].daysActive >= 1, "daysActive");
assert(topHosts["a.example"].peakUploaded >= 1500, "peakUploaded");

// clamp days/limit
const topClamp = collector.getTopTrackers({ days: 999, limit: 1 });
assertEq(topClamp.days, 90, "days clamp max 90");
assertEq(topClamp.trackers.length, 1, "limit clamp");
const rollupClamp = collector.getRollup({ days: 0 });
assertEq(rollupClamp.days, 1, "rollup days min 1");

// summary includes wall seconds fields
const sum = collector.getSummary({ limit: 5 });
assert(sum.length >= 1, "summary length");
assert("statusWallSeconds" in sum[0], "summary statusWallSeconds");
assert("seedingRelatedWallSeconds" in sum[0], "summary seedingRelatedWallSeconds");

collector.stop();
assert(fs.existsSync(file), "day file exists after stop");
const raw2 = JSON.parse(fs.readFileSync(file, "utf8"));
assert(raw2.trafficSource === "torrent_delta", "trafficSource");
const first = Object.values(raw2.lastSnapshot.torrents)[0];
assert("u" in first && "d" in first, "slim snapshot shape");

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
fs.rmSync(tmp3, { recursive: true, force: true });
console.log("ALL TESTS PASSED");
