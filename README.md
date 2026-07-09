# PT qB 控制台

一个给 qBittorrent Web API 套的中文 PT 管理前端。前端跑在 Vite，后端 Express 负责登录 qBittorrent 并代理 `/api/*`，避免浏览器跨域问题。

## 启动

```powershell
npm install
npm run dev
```

打开：http://127.0.0.1:5173/

默认连接：

```env
QBIT_URL=http://192.168.1.27:8085
QBIT_USERNAME=admin
QBIT_PASSWORD=admin
PORT=8787
```

要改配置就复制 `.env.example` 为 `.env` 后编辑。

## 生产模式

```powershell
npm run build
npm start
```

然后打开：http://127.0.0.1:8787/

## 已有功能

- 种子列表、搜索、状态筛选、分类筛选
- 全局上传/下载速度和任务概览
- 添加磁力链接或种子 URL
- 批量开始、暂停、汇报 Tracker、强制校验、删除任务
- 低分享率、卡住、异常任务优先显示
