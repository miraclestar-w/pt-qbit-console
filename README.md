# PT qB Console

中文 PT / qBittorrent 管理控制台 + 桌面监控小组件。

- **Web 控制台**：Vite 前端 + Express 代理，解决浏览器跨域，对接 qBittorrent Web API
- **桌面小组件**：`widget-web/`（pywebview），常驻桌面显示上传/下载速度与任务概览

两者共用同一套环境变量命名：`QBIT_*`（小组件兼容旧名 `QB_*`）。

## 功能概览

### Web 控制台
- 种子列表、搜索、状态/分类筛选
- `/api/dashboard` 基于 `sync/maindata` 的 **rid 增量刷新**
- 全局上传/下载速度与任务概览
- 添加磁力链接或种子 URL
- 批量：开始、暂停、汇报 Tracker、强制校验、删除
- 优先展示低分享率、卡住、异常任务

### 桌面小组件（`widget-web/`）
- 实时下载/上传速度（KB/s、MB/s）
- 下载中 / 做种 / 停止 / 错误任务数
- 全局分享率（`global_ratio`）、总下载/总上传、剩余磁盘
- 无边框窗口：左键拖动、右键菜单、滚轮透明度
- 系统托盘图标；任务栏按钮隐藏（Windows `ITaskbarList`）
- 单实例锁，避免多开 WebView2

## 目录结构

```text
.
├── index.html          # Web 控制台入口（纯 HTML/CSS/JS）
├── server/index.mjs     # Express 代理 + API
├── widget-web/          # 桌面小组件
│   ├── widget.py
│   ├── index.html
│   ├── requirements.txt
│   ├── run_widget.pyw
│   └── start_widget.vbs
├── package.json
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

代理默认监听：`http://127.0.0.1:8787`（前端通过 Vite 转发 `/api/*`）。

## 环境变量

复制 `.env.example` 为 `.env`：

```env
QBIT_URL=http://192.168.1.27:8085
# 可选：主地址不可达时尝试的备用地址
QBIT_URL_EXT=
QBIT_USERNAME=admin
QBIT_PASSWORD=admin
PORT=8787
QBIT_TIMEOUT_MS=8000
APP_INFO_TTL_MS=3600000
```

| 变量 | 说明 |
|------|------|
| `QBIT_URL` | qBittorrent WebUI 地址 |
| `QBIT_URL_EXT` | 备用地址（仅 Web 代理） |
| `QBIT_USERNAME` / `QBIT_PASSWORD` | WebUI 账号密码 |
| `PORT` | Express 端口（默认 8787） |
| `QBIT_TIMEOUT_MS` | 请求超时（毫秒） |
| `APP_INFO_TTL_MS` | app 信息缓存 TTL |

> 不要提交真实 `.env`（已在 `.gitignore` 中）。

## 生产部署

```powershell
npm run build
npm start
```

打开：http://127.0.0.1:8787/

## 桌面小组件

详见 [widget-web/README.md](widget-web/README.md)。

```powershell
cd widget-web
pip install -r requirements.txt
# 可选：设置与控制台相同的 QBIT_*
python widget.py
```

Windows 无控制台启动：双击 `start_widget.vbs` 或 `run_widget.pyw`。

默认窗口：**280 × 214**。

## 主要 API（代理）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | 前端可见配置 |
| GET | `/api/dashboard?rid=` | 增量 dashboard |
| GET | `/api/torrents` | 种子列表 |
| GET | `/api/transfer` | 传输信息 |
| GET | `/api/categories` / `/api/tags` | 分类与标签 |
| POST | `/api/torrents/add` | 添加种子 |
| POST | `/api/torrents/action` | 批量操作 |
| POST | `/api/transfer/limits` | 全局限速 |

## 开发脚本

```text
npm run dev      # 同时启动 Express + Vite
npm run client   # 仅 Vite
npm run server   # 仅 Express
npm run build    # 构建到 dist/
npm start        # 生产：Express 静态托管 + API
```

## 注意

- 需要先开启 qBittorrent WebUI，并确保 `QBIT_URL` 本机可达
- 小组件在 Windows 上依赖 WebView2（一般系统自带）
- 小组件直连 qBittorrent，**不依赖** 本地 Express 代理

## License

Private / personal use.
