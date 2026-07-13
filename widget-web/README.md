# qBittorrent Desktop Widget

基于 **pywebview** 的 qBittorrent 桌面监控小组件：深色 HUD、下载红 / 上传绿，适合常驻桌面。

## 功能

- 实时下载 / 上传速度（`B/s`、`KB/s`、`MB/s`、`GB/s`）
- 下载中、做种、停止、错误任务数量
- **下载进度**：仅统计「下载中」任务的平均完成度（红色进度条 + 百分比）
- 任务数量条：下载 / 做种 / 停止 / 错误
- 全局分享率（qB `global_ratio`，与 WebUI 一致）
- 累计总下载 / 总上传（优先 `alltime_*`，否则会话流量）
- 磁盘剩余空间
- **左键拖动**、**右键菜单**（打开 WebUI / 隐藏到托盘 / 退出）
- 滚轮调节窗口透明度
- 系统托盘图标；Windows 任务栏不显示窗口按钮
- 会话过期自动重新登录
- `sync/maindata` 增量轮询（默认约 2 秒）
- 单实例锁（`.widget.lock`）

## 安装依赖

```bash
pip install -r requirements.txt
```

依赖：`pywebview`、`requests`、`pystray`、`Pillow`。

## 配置


启动时会自动加载环境变量文件（**不覆盖**已存在的环境变量）：

1. `widget-web/.env`
2. 项目根目录 `../.env`（与 Web 控制台共用）

也可继续用系统环境变量 `QBIT_*` / `QB_*`。


环境变量与 Web 控制台代理对齐（优先 `QBIT_*`，兼容旧名 `QB_*`）：

```powershell
$env:QBIT_URL = "http://localhost:8080"
$env:QBIT_USERNAME = "admin"
$env:QBIT_PASSWORD = "your_password"
$env:QBIT_DEBUG = "true"
# 可选，毫秒；会换算为请求超时秒数
$env:QBIT_TIMEOUT_MS = "8000"
```

兼容旧变量：`QB_URL` / `QB_USER` / `QB_PASS` / `QB_DEBUG`。

也可直接改 [widget.py](widget.py) 里 `Config` 默认值。

| 项 | 默认 |
|----|------|
| 窗口尺寸 | **自适应内容（宽约 276）** |
| 轮询间隔 | 2 秒 |
| 请求超时 | 10 秒（可由 `QBIT_TIMEOUT_MS` 覆盖） |

## 运行

```bash
python widget.py
```

Windows 无控制台窗口：

```text
start_widget.vbs
```

或双击 `run_widget.pyw`。

## 交互

| 操作 | 作用 |
|------|------|
| 左键拖动 | 移动窗口 |
| 右键 | 菜单：打开 WebUI / 隐藏到托盘 / 退出 |
| 滚轮 | 调节透明度 |
| 托盘图标 | 显示 / 隐藏 / 打开 WebUI / 退出 |

## 文件结构

```text
widget-web/
├── widget.py            # 主程序：API、窗口、托盘、轮询
├── index.html           # UI + 数据展示
├── requirements.txt
├── run_widget.pyw       # pythonw 入口
├── start_widget.vbs     # 无控制台启动
└── README.md
```

## 常见问题

连不上 qBittorrent 时：

1. 确认 WebUI 已开启
2. 确认 `QBIT_URL` / `QBIT_USERNAME` / `QBIT_PASSWORD` 正确
3. 先用浏览器打开 WebUI，确认本机可达

窗口无法显示时：

- Windows：需要 WebView2 Runtime（一般已预装）
- 不要对窗口设置 `ShowInTaskbar=False`（会重建 HWND 导致 WebView2 白屏）；本项目使用 `ITaskbarList.DeleteTab`
- 若提示已有实例运行：先关闭旧进程，或删除失效的 `.widget.lock`

上传卡片变小圆点：

- 已修复：活跃状态 class 不再使用 `live`（与状态圆点冲突），改为 `active`
