import { FormEvent, ReactElement, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Gauge,
  HardDrive,
  Layers,
  Link2,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  RotateCw,
  Search,
  Server,
  Sun,
  Trash2,
  Upload,
  Wifi,
  X
} from "lucide-react";

type Torrent = {
  added_on: number;
  amount_left: number;
  category: string;
  completed: number;
  dlspeed: number;
  downloaded: number;
  eta: number;
  hash: string;
  name: string;
  num_leechs: number;
  num_seeds: number;
  progress: number;
  ratio: number;
  save_path: string;
  size: number;
  state: string;
  tags: string;
  tracker: string;
  upspeed: number;
  uploaded: number;
};

type Transfer = {
  dl_info_speed: number;
  up_info_speed: number;
  dl_rate_limit: number;
  up_rate_limit: number;
};

type Health = {
  ok: boolean;
  qbitUrl: string;
  version: string;
  apiVersion: string;
  transfer: Transfer;
};

type CategoryMap = Record<string, { name: string; savePath: string }>;
type FilterId = (typeof filters)[number]["id"];

const filters = [
  { id: "all", label: "全部", icon: Layers },
  { id: "downloading", label: "下载", icon: Download },
  { id: "seeding", label: "做种", icon: Upload },
  { id: "paused", label: "暂停", icon: Pause },
  { id: "stalled", label: "卡住", icon: AlertTriangle },
  { id: "checking", label: "校验", icon: CheckCircle2 },
  { id: "error", label: "异常", icon: AlertTriangle },
  { id: "completed", label: "完成", icon: CheckCircle2 }
] as const;

const statusText: Record<string, string> = {
  downloading: "下载中",
  forcedDL: "强制下载",
  stalledDL: "等待下载",
  metaDL: "取元数据",
  uploading: "做种中",
  forcedUP: "强制做种",
  stalledUP: "等待上传",
  pausedDL: "已暂停",
  pausedUP: "已暂停",
  stoppedDL: "已停止",
  stoppedUP: "已停止",
  queuedDL: "下载排队",
  queuedUP: "做种排队",
  checkingDL: "校验中",
  checkingUP: "校验中",
  checkingResumeData: "检查恢复",
  moving: "移动中",
  error: "错误",
  missingFiles: "文件缺失",
  unknown: "未知"
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message || `请求失败：${response.status}`);
  }
  return response.json();
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

function formatSpeed(bytes = 0) {
  return `${formatBytes(bytes)}/s`;
}

function formatEta(seconds = 0) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 8640000) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}天${hours}小时`;
  if (hours) return `${hours}小时${minutes}分`;
  return `${Math.max(1, minutes)}分`;
}

function statusKind(torrent: Torrent) {
  if (["error", "missingFiles"].includes(torrent.state)) return "error";
  if (torrent.state.includes("checking")) return "checking";
  if (torrent.state.includes("paused") || torrent.state.includes("stopped")) return "paused";
  if (torrent.state.includes("stalled")) return "stalled";
  if (torrent.state.includes("uploading") || torrent.state.includes("forcedUP") || torrent.state.includes("queuedUP")) return "seeding";
  if (torrent.state.includes("downloading") || torrent.state.includes("forcedDL") || torrent.state.includes("metaDL") || torrent.state.includes("queuedDL")) return "downloading";
  if (torrent.progress >= 1) return "completed";
  return "all";
}

function torrentHealth(torrent: Torrent) {
  const kind = statusKind(torrent);
  if (kind === "error") return "bad";
  if (kind === "stalled") return "warn";
  if (torrent.progress >= 1 && torrent.ratio < 1) return "need";
  if (kind === "seeding") return "good";
  return "neutral";
}

function sortByRisk(a: Torrent, b: Torrent) {
  const score = (torrent: Torrent) => {
    if (statusKind(torrent) === "error") return 5;
    if (statusKind(torrent) === "stalled") return 4;
    if (torrent.progress >= 1 && torrent.ratio < 1) return 3;
    if (statusKind(torrent) === "downloading") return 2;
    return 1;
  };
  return score(b) - score(a) || b.added_on - a.added_on;
}

function trackerHost(value: string) {
  if (!value) return "未汇报";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0] || value;
  }
}

export function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = window.localStorage.getItem("pt-qb-theme");
    return saved === "light" ? "light" : "dark";
  });
  const [health, setHealth] = useState<Health | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [torrents, setTorrents] = useState<Torrent[]>([]);
  const [categories, setCategories] = useState<CategoryMap>({});
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTorrent, setNewTorrent] = useState({
    urls: "",
    category: "",
    tags: "",
    savepath: "",
    paused: false
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("pt-qb-theme", theme);
  }, [theme]);

  async function refresh(silent = false) {
    if (!silent) setLoading(true);
    try {
      const [nextHealth, nextTorrents, nextCategories, nextTags] = await Promise.all([
        apiJson<Health>("/api/health"),
        apiJson<Torrent[]>("/api/torrents?sort=added_on&reverse=true"),
        apiJson<CategoryMap>("/api/categories"),
        apiJson<string[]>("/api/tags")
      ]);
      setHealth(nextHealth);
      setTransfer(nextHealth.transfer);
      setTorrents(nextTorrents);
      setCategories(nextCategories);
      setTags(nextTags);
      setError("");
      setSelected((prev) => new Set([...prev].filter((hash) => nextTorrents.some((torrent) => torrent.hash === hash))));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "连接失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return torrents
      .filter((torrent) => filter === "all" || statusKind(torrent) === filter || (filter === "completed" && torrent.progress >= 1))
      .filter((torrent) => category === "all" || torrent.category === category)
      .filter((torrent) => {
        if (!lower) return true;
        return [torrent.name, torrent.category, torrent.tags, torrent.save_path, torrent.tracker].some((value) => (value || "").toLowerCase().includes(lower));
      })
      .sort(sortByRisk);
  }, [torrents, filter, category, query]);

  const stats = useMemo(() => {
    const completed = torrents.filter((torrent) => torrent.progress >= 1);
    const lowRatio = completed.filter((torrent) => torrent.ratio < 1);
    return {
      total: torrents.length,
      downloading: torrents.filter((torrent) => statusKind(torrent) === "downloading").length,
      seeding: torrents.filter((torrent) => statusKind(torrent) === "seeding").length,
      stalled: torrents.filter((torrent) => statusKind(torrent) === "stalled").length,
      error: torrents.filter((torrent) => statusKind(torrent) === "error").length,
      lowRatio: lowRatio.length,
      ratio: completed.length ? completed.reduce((sum, torrent) => sum + torrent.ratio, 0) / completed.length : 0,
      downloaded: torrents.reduce((sum, torrent) => sum + torrent.downloaded, 0),
      uploaded: torrents.reduce((sum, torrent) => sum + torrent.uploaded, 0),
      totalSize: torrents.reduce((sum, torrent) => sum + torrent.size, 0)
    };
  }, [torrents]);

  const filterCounts = useMemo(() => {
    return filters.reduce((acc, item) => {
      acc[item.id] =
        item.id === "all"
          ? torrents.length
          : item.id === "completed"
            ? torrents.filter((torrent) => torrent.progress >= 1).length
            : torrents.filter((torrent) => statusKind(torrent) === item.id).length;
      return acc;
    }, {} as Record<FilterId, number>);
  }, [torrents]);

  const categoryItems = useMemo(() => {
    return Object.keys(categories)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        count: torrents.filter((torrent) => torrent.category === name).length
      }));
  }, [categories, torrents]);

  const trackerItems = useMemo(() => {
    const counts = new Map<string, number>();
    torrents.forEach((torrent) => {
      const host = trackerHost(torrent.tracker);
      counts.set(host, (counts.get(host) || 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([host, count]) => ({ host, count }));
  }, [torrents]);

  const selectedCount = selected.size;
  const allVisibleSelected = visible.length > 0 && visible.every((torrent) => selected.has(torrent.hash));
  const incidentCount = stats.stalled + stats.error + stats.lowRatio;

  function toggle(hash: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((torrent) => next.delete(torrent.hash));
      else visible.forEach((torrent) => next.add(torrent.hash));
      return next;
    });
  }

  async function runAction(action: string, extra: Record<string, unknown> = {}) {
    if (selectedCount === 0) return;
    if (action === "delete" && !window.confirm(`确定删除 ${selectedCount} 个任务？默认只删任务，不删文件。`)) return;
    try {
      await apiJson("/api/torrents/action", {
        method: "POST",
        body: JSON.stringify({ action, hashes: [...selected], ...extra })
      });
      await refresh(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    }
  }

  async function addTorrent(event: FormEvent) {
    event.preventDefault();
    setAdding(true);
    try {
      await apiJson("/api/torrents/add", {
        method: "POST",
        body: JSON.stringify(newTorrent)
      });
      setNewTorrent({ urls: "", category: "", tags: "", savepath: "", paused: false });
      setShowAdd(false);
      await refresh(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "添加失败");
    } finally {
      setAdding(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Activity size={20} />
          </div>
          <div>
            <span className="system-label">qBittorrent PT Pro</span>
            <strong>种子控制台</strong>
          </div>
          <span className={health?.ok ? "node-pill ok" : "node-pill"}>{health?.ok ? "SYS_OK" : "CONNECTING"}</span>
        </div>

        <div className="header-metrics" aria-label="传输状态">
          <HeaderMetric label="下载" value={formatSpeed(transfer?.dl_info_speed || 0)} tone="down" />
          <HeaderMetric label="上传" value={formatSpeed(transfer?.up_info_speed || 0)} tone="up" />
          <HeaderMetric label="分享率" value={stats.ratio.toFixed(2)} />
          <HeaderMetric label="风险" value={`${incidentCount}`} tone={incidentCount > 0 ? "warn" : "up"} />
        </div>

        <div className="top-actions">
          <a className="ghost-button" href={health?.qbitUrl || "http://192.168.1.27:8085/"} target="_blank" rel="noreferrer">
            <ExternalLink size={15} /> WebUI
          </a>
          <button className="ghost-button" onClick={() => refresh()} disabled={loading} title="刷新">
            <RefreshCcw size={15} /> 刷新
          </button>
          <button className="ghost-button icon-text" onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))} title={theme === "dark" ? "切换到亮色" : "切换到暗色"}>
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />} {theme === "dark" ? "亮色" : "暗色"}
          </button>
          <button className="primary-button" onClick={() => setShowAdd(true)}>
            <Plus size={16} /> 添加
          </button>
        </div>
      </header>

      {error && (
        <section className="alert-strip">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </section>
      )}

      <div className="console-layout">
        <aside className="sidebar">
          <section className="side-section">
            <span className="side-title">种子状态</span>
            <nav className="side-nav">
              {filters.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>
                    <span><Icon size={15} /> {item.label}</span>
                    <b>{filterCounts[item.id]}</b>
                  </button>
                );
              })}
            </nav>
          </section>

          <section className="side-section">
            <span className="side-title">分类库</span>
            <nav className="side-nav compact">
              <button className={category === "all" ? "active" : ""} onClick={() => setCategory("all")}>
                <span>// 全部分类</span>
                <b>{stats.total}</b>
              </button>
              {categoryItems.length === 0 ? (
                <span className="side-empty">暂无分类</span>
              ) : (
                categoryItems.map((item) => (
                  <button key={item.name} className={category === item.name ? "active" : ""} onClick={() => setCategory(item.name)}>
                    <span title={item.name}>// {item.name}</span>
                    <b>{item.count}</b>
                  </button>
                ))
              )}
            </nav>
          </section>

          <section className="side-section">
            <span className="side-title">Tracker 聚合</span>
            <div className="tracker-list">
              {trackerItems.length === 0 ? (
                <span className="side-empty">等待数据</span>
              ) : (
                trackerItems.map((item) => (
                  <div key={item.host}>
                    <span title={item.host}>{item.host}</span>
                    <b>{item.count}</b>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="side-health">
            <div>
              <span>节点</span>
              <strong>{health?.version ? `qB ${health.version}` : "未连接"}</strong>
            </div>
            <div>
              <span>Web API</span>
              <strong>{health?.apiVersion || "-"}</strong>
            </div>
            <div>
              <span>数据量</span>
              <strong>{formatBytes(stats.totalSize)}</strong>
            </div>
          </section>
        </aside>

        <section className="workspace">
          <section className="metrics-grid">
            <Metric icon={<Download />} label="下载速率" value={formatSpeed(transfer?.dl_info_speed || 0)} hint={transfer?.dl_rate_limit ? `限速 ${formatSpeed(transfer.dl_rate_limit)}` : "未限速"} tone="info" />
            <Metric icon={<Upload />} label="上传速率" value={formatSpeed(transfer?.up_info_speed || 0)} hint={transfer?.up_rate_limit ? `限速 ${formatSpeed(transfer.up_rate_limit)}` : "未限速"} tone="ok" />
            <Metric icon={<Server />} label="任务总数" value={`${stats.total}`} hint={`下载 ${stats.downloading} · 做种 ${stats.seeding}`} />
            <Metric icon={<Gauge />} label="平均分享率" value={stats.ratio.toFixed(2)} hint={`低于 1.0：${stats.lowRatio}`} tone={stats.lowRatio > 0 ? "warn" : "ok"} />
            <Metric icon={<HardDrive />} label="累计传输" value={formatBytes(stats.uploaded + stats.downloaded)} hint={`上传 ${formatBytes(stats.uploaded)}`} />
          </section>

          <section className="toolbar">
            <div className="search-box">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索种子名称、分类、标签、路径、Tracker" />
            </div>
            <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="分类筛选">
              <option value="all">全部分类</option>
              {categoryItems.map((item) => (
                <option key={item.name} value={item.name}>{item.name}</option>
              ))}
            </select>
            <div className="toolbar-actions">
              <button className="ghost-button" onClick={() => runAction("pause")} disabled={selectedCount === 0}>批量暂停</button>
              <button className="ghost-button" onClick={() => runAction("recheck")} disabled={selectedCount === 0}>强制校验</button>
              <button className="danger-button" onClick={() => runAction("delete")} disabled={selectedCount === 0}>安全删除</button>
            </div>
          </section>

          <section className="table-panel">
            <div className="table-head">
              <label className="check-row">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
                <span>当前 {visible.length} 个</span>
              </label>
              <span>{selectedCount ? `已选 ${selectedCount} 个` : "按风险优先排序：异常、卡住、低分享率会排在前面"}</span>
            </div>

            <div className="torrent-grid" role="table" aria-label="种子列表">
              <div className="torrent-grid-head" role="row">
                <span></span>
                <span>种子名称 / 站点信息</span>
                <span>大小</span>
                <span>种 / 客</span>
                <span>实时速度</span>
                <span>分享率</span>
                <span>状态 / ETA</span>
              </div>

              <div className="torrent-table">
                {loading && torrents.length === 0 ? (
                  <div className="empty-state">正在读取种子列表...</div>
                ) : visible.length === 0 ? (
                  <div className="empty-state">没有匹配的种子</div>
                ) : (
                  visible.map((torrent) => (
                    <TorrentRow key={torrent.hash} torrent={torrent} checked={selected.has(torrent.hash)} onToggle={() => toggle(torrent.hash)} />
                  ))
                )}
              </div>
            </div>
          </section>
        </section>
      </div>

      <section className={`batch-bar ${selectedCount ? "show" : ""}`} aria-live="polite">
        <strong>已选 {selectedCount} 个</strong>
        <button onClick={() => runAction("resume")}><Play size={15} /> 开始</button>
        <button onClick={() => runAction("pause")}><Pause size={15} /> 暂停</button>
        <button onClick={() => runAction("reannounce")}><RotateCw size={15} /> 汇报 Tracker</button>
        <button onClick={() => runAction("recheck")}><CheckCircle2 size={15} /> 强制校验</button>
        <button className="danger" onClick={() => runAction("delete")}><Trash2 size={15} /> 删除任务</button>
        <button className="icon-only" onClick={() => setSelected(new Set())} title="清空选择"><X size={16} /></button>
      </section>

      {showAdd && (
        <div className="modal-backdrop" onMouseDown={() => setShowAdd(false)}>
          <form className="modal" onSubmit={addTorrent} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title">
              <div>
                <h2>添加种子</h2>
                <p>支持磁力链接、种子 URL，一行一个更好整理。</p>
              </div>
              <button type="button" className="icon-only" onClick={() => setShowAdd(false)} title="关闭"><X size={18} /></button>
            </div>
            <textarea value={newTorrent.urls} onChange={(event) => setNewTorrent((prev) => ({ ...prev, urls: event.target.value }))} placeholder="magnet:?xt=urn:btih:..." required />
            <div className="form-grid">
              <label>
                分类
                <select value={newTorrent.category} onChange={(event) => setNewTorrent((prev) => ({ ...prev, category: event.target.value }))}>
                  <option value="">不指定</option>
                  {categoryItems.map((item) => (
                    <option key={item.name} value={item.name}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label>
                标签
                <input value={newTorrent.tags} list="tag-options" onChange={(event) => setNewTorrent((prev) => ({ ...prev, tags: event.target.value }))} placeholder="例如：PT, 动画" />
                <datalist id="tag-options">
                  {tags.map((tag) => <option key={tag} value={tag} />)}
                </datalist>
              </label>
              <label className="wide">
                保存路径
                <input value={newTorrent.savepath} onChange={(event) => setNewTorrent((prev) => ({ ...prev, savepath: event.target.value }))} placeholder="留空使用 qB 默认路径" />
              </label>
              <label className="toggle-line">
                <input type="checkbox" checked={newTorrent.paused} onChange={(event) => setNewTorrent((prev) => ({ ...prev, paused: event.target.checked }))} />
                添加后先暂停
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setShowAdd(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={adding}><Link2 size={16} /> {adding ? "添加中" : "添加到 qB"}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function HeaderMetric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "warn" }) {
  return (
    <div className={`header-metric ${tone || ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ icon, label, value, hint, tone }: { icon: ReactElement; label: string; value: string; hint: string; tone?: "warn" | "ok" | "info" }) {
  return (
    <article className={`metric-card ${tone || ""}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
      </div>
    </article>
  );
}

function TorrentRow({ torrent, checked, onToggle }: { torrent: Torrent; checked: boolean; onToggle: () => void }) {
  const health = torrentHealth(torrent);
  const kind = statusKind(torrent);
  const status = statusText[torrent.state] || torrent.state;
  const progress = Math.max(0, Math.min(100, torrent.progress * 100));
  const ratioRisk = torrent.progress >= 1 && torrent.ratio < 1;
  return (
    <article className={`torrent-row ${checked ? "selected" : ""} ${health}`} role="row">
      <label className="row-check">
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </label>
      <div className="torrent-main">
        <div className="torrent-name-line">
          <span className={`status-dot ${health}`} />
          <strong title={torrent.name}>{torrent.name}</strong>
        </div>
        <div className="torrent-meta">
          <span className={`tracker-chip ${health}`}>{trackerHost(torrent.tracker)}</span>
          <span>Hash: {torrent.hash.slice(0, 8)}...</span>
          <span>{torrent.category || "未分类"}</span>
        </div>
      </div>
      <div className="size-cell mono">{formatBytes(torrent.size)}</div>
      <div className="peer-cell mono">
        <strong>{torrent.num_seeds}</strong>
        <span>({torrent.num_leechs})</span>
      </div>
      <div className="speed-cell mono">
        <span className="down">↓ {formatSpeed(torrent.dlspeed)}</span>
        <span className="up">↑ {formatSpeed(torrent.upspeed)}</span>
      </div>
      <div className="ratio-cell mono">
        <strong className={ratioRisk ? "low-ratio" : ""}>{torrent.ratio.toFixed(2)}</strong>
      </div>
      <div className="status-cell">
        <div className={`status-text ${health}`}>{status}</div>
        <div className="eta-line">
          <span>{progress.toFixed(progress % 1 ? 1 : 0)}%</span>
          <span>{kind === "seeding" || progress >= 100 ? `累计 ${formatBytes(torrent.uploaded)}` : `ETA ${formatEta(torrent.eta)}`}</span>
        </div>
        <div className="progress-line">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
    </article>
  );
}
