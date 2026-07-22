# PT qB Console

轻量 PT / qBittorrent 控制台 + 桌面悬浮小组件。

仓库：<https://github.com/miraclestar-w/pt-qbit-console>

- **Web 控制台**：Vite 前端 + Express 代理，对接 qBittorrent Web API
- **桌面小组件**：`widget-web/`（pywebview），显示速度/会话/状态
- **每日统计**：服务端采样，按 Tracker 汇总上传/下载、速度极值均值、状态墙钟与任务·秒

Web 与小组件共用 `QBIT_*` 环境变量（兼容旧名 `QB_*`）。

## 功能概览

### Web 控制台
- 种子列表筛选、搜索、批量操作
- **虚拟列表**：大数据量流畅滚动（overscan）
- **自适应轮询**：页面可见约 5s，后台约 30s；`visibilitychange` + 链式 `setTimeout`
- `/api/dashboard` 使用 `sync/maindata` **rid 增量同步**
- 传输限速、分类/标签、添加种子
- Tracker 着色与筛选
- 可选 PWA（`manifest.json` + Service Worker）

### 每日统计
- 服务端定时采样（默认 60s），数据写入 `data/daily-stats/YYYY-MM-DD.json`
- **主流量来源**：种子计数器增量（`torrent_delta`），全局 ≡ 各 Tracker 之和
- **按 Tracker**：上传/下载、分享率、速度 min/max/avg（含活跃均速）、任务均/峰、状态时长
- **状态时长**：
  - **墙钟秒**：该状态至少有 1 个任务时累计的真实时间
  - **任务·秒**：Σ(该状态任务数 × 采样间隔)，反映“并发×时间”
- **跨日短间隔**：若与昨日最后快照间隔 < `maxGapMs`（默认 15 分钟），继承昨日快照避免午夜丢流量；超过阈值则只建立基线、不计增量
- **共享 maindata**：Dashboard 同步后 `ingestLive` 写入热缓存；定时采样在缓存新鲜时不再打全量 `torrents/info`；**强制刷新始终走真实 API**
- **失败退避**：连续失败时采样间隔指数退避（上限 10 分钟），成功后恢复
- 前端：日期切换、14 日柱状图（Shift+单击对比两日）、Tracker 搜索/排序/仅有流量、JSON/CSV 导出、健康状态、纯上传日 ∞ 高亮

### 桌面小组件（`widget-web/`）
- 上传/下载速度自适应单位
- 会话 / 全时 / 限速 / 连接状态
- 可拖动、置顶、透明度与离线原因提示
- Windows 可用 `start_widget.vbs` / `run_widget.pyw`

## 实现要点

- 当日流量基线可存 `data/traffic-baseline.json`（gitignore）
- `/api/health` 检查 `transfer/info` + 缓存 server state
- `/api/dashboard` rid 增量 + coalesce；hard fail 会重置种子映射
- 统计采集与 Dashboard 共用种子映射，降低约 3k 任务时的 API 压力
- alltime 字段优先从 `server_state` 合并（单独 `transfer/info` 常缺失）

## 目录结构

```text
.
├── index.html           # Web 控制台
├── server/
│   ├── index.mjs        # Express 代理 + 统计 API
│   ├── daily-stats.mjs  # 每日统计采集器
│   └── _test_daily_stats.mjs
├── widget-web/          # 桌面小组件
├── manifest.json / sw.js
├── package.json
├── vite.config.ts
├── data/                # 运行时数据（gitignore）
├── .env.example
└── README.md
```

## 快速开始（Web）

```powershell
npm install
copy .env.example .env
# 编辑 .env 中的 QBIT_URL / 账号密码
npm run dev
```

打开：http://127.0.0.1:5173/

API 默认：`http://127.0.0.1:8787`，Vite 代理 `/api/*`。

## 环境变量

复制 `.env.example` 为 `.env`：

| 变量 | 说明 |
|------|------|
| `QBIT_URL` | qBittorrent WebUI 地址 |
| `QBIT_URL_EXT` | 可选备用地址（Web 代理） |
| `QBIT_USERNAME` / `QBIT_PASSWORD` | WebUI 账号 |
| `PORT` | Express 端口，默认 8787 |
| `QBIT_TIMEOUT_MS` | 请求超时 |
| `APP_INFO_TTL_MS` | app 信息缓存 TTL |
| `STATS_SAMPLE_MS` | 统计采样间隔（默认 60000，最小 15000） |
| `STATS_RETENTION_DAYS` | 统计保留天数（默认 90） |
| `STATS_FORCE_MIN_INTERVAL_MS` | 强制采样最小间隔（默认 10000） |

> `.env` 已在 `.gitignore` 中。

小组件调试可用 `QBIT_DEBUG=true`（或旧名 `QB_DEBUG`）。

## 生产构建

```powershell
npm run build
npm start
```

打开：http://127.0.0.1:8787/

注意：`npm start` / `npm run server:static` 需要先 `npm run build` 生成 `dist/`。

## 测试

```powershell
npm test
# 或
npm run test:stats
```

单元测试覆盖：种子增量、跨日继承、大间隔丢弃、强制采样 429、ingestLive 缓存采样、墙钟秒、失败退避。

## 统计 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats/days` | 已采集日期列表 + sampleMs / maxGapMs / retention |
| GET | `/api/stats/daily?date=YYYY-MM-DD` | 某日全局 + 各 Tracker 明细（可选 `sample=1` 强制采样当日） |
| GET | `/api/stats/summary?limit=14` | 历史摘要（柱状图） |
| POST | `/api/stats/sample` | 强制采样（有频率限制，过频返回 429） |
| GET | `/api/stats/health` | 采集健康：来源、间隔、失败 streak、live 缓存等 |

### 其它常用 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | qB 连通性 |
| GET | `/api/config` | 前端配置 |
| GET | `/api/dashboard?rid=` | 增量 dashboard |
| GET | `/api/torrents` | 种子列表（可 hashes） |
| GET | `/api/transfer` | 传输信息 |
| GET | `/api/categories` / `/api/tags` | 分类 / 标签 |
| POST | `/api/torrents/add` | 添加种子 |
| POST | `/api/torrents/action` | 种子操作 |
| POST | `/api/transfer/limits` | 限速 |

## 桌面小组件

见 [widget-web/README.md](widget-web/README.md)。

```powershell
npm run widget
# 或
cd widget-web
pip install -r requirements.txt
python widget.py
```

## 许可证

私有项目（`private: true`），按需自用。
