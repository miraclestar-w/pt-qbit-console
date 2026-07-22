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

collector.stop();
assert(fs.existsSync(file), "day file exists after stop");
const raw2 = JSON.parse(fs.readFileSync(file, "utf8"));
assert(raw2.trafficSource === "torrent_delta", "trafficSource");
const first = Object.values(raw2.lastSnapshot.torrents)[0];
assert("u" in first && "d" in first, "slim snapshot shape");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL TESTS PASSED");
