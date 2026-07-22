# qBittorrent Desktop Widget

基于 **pywebview** 的 qBittorrent 桌面悬浮 HUD：速度 / 会话 / 全时 / 今日流量。

父项目：[PT qB Console](../README.md) · 仓库 <https://github.com/miraclestar-w/pt-qbit-console>

## 功能

- 上传 / 下载速度自适应单位（`B/s` → `GB/s`）
- 会话流量与全时流量（`alltime_*` / maindata）
- **今日↑ / 今日↓**（优先）：请求 PT Console `GET /api/stats/today`；Console 不可用时回退全时总量
- 分享率（qB `global_ratio`）与任务计数
- 限速、连接状态、剩余空间
- 可拖动、置顶、透明度；托盘菜单打开 WebUI / 控制台 / 设置
- `sync/maindata` 增量同步（约 2s）
- 单实例锁（`.widget.lock`）

## 依赖

```bash
pip install -r requirements.txt
```

主要：`pywebview`、`requests`、`pystray`、`Pillow`

## 配置

按优先级读取：

1. `widget-web/.env`
2. 上级目录 `../.env`（与 Web 控制台共用）

环境变量（与 Web 控制台一致，兼容旧名 `QB_*`）：

| 变量 | 说明 |
|------|------|
| `QBIT_URL` | qBittorrent WebUI 地址 |
| `QBIT_USERNAME` / `QBIT_PASSWORD` | 账号密码 |
| `QBIT_TIMEOUT_MS` | 请求超时（毫秒） |
| `QBIT_DEBUG` | `true` 开启调试日志 |
| `CONSOLE_URL` / `PT_CONSOLE_URL` | PT Console 地址，用于今日流量；默认 `http://127.0.0.1:8787`；设空可禁用 |

示例（PowerShell）：

```powershell
$env:QBIT_URL = "http://localhost:8080"
$env:QBIT_USERNAME = "admin"
$env:QBIT_PASSWORD = "your_password"
$env:CONSOLE_URL = "http://127.0.0.1:8787"
$env:QBIT_DEBUG = "true"
```

## 启动

```powershell
# 仓库根目录
npm run widget

# 或
cd widget-web
python widget.py
```

Windows 也可使用 `start_widget.vbs` / `run_widget.pyw`。

## 今日流量说明

- 小组件约每 15s 缓存一次 Console 的 `/api/stats/today`
- 需先启动 Express 服务（`npm run server` 或 `npm run dev`）并正常采样
- 无 Console 或请求失败时，页脚显示全时总量；tooltip 仍可看到会话数据

## 窗口

| 项 | 默认 |
|----|------|
| 默认宽度 | 约 276px |
| 高度 | 自适应（约 180–480） |
