# 星天水镜 · 部署文档

服务有两块：

- **前端**：纯静态（原生 ES 模块、零构建），是 `src/server/public/` 整目录，含约 101MB 图片素材。
- **后端**：`npm run server` 起的 Node 进程，提供 `/api/*`（评分 / 伤害要跑 miao 内核 + 读 SQLite，浏览器做不到，所以数据离不开它）。

两种部署形态：**本地运行**（一台机器全包）和 **前后端分离**（前端丢静态托管，后端另放一台机器）。
没有「同源部署」这种独立概念 —— 本地运行天然同源，无需任何额外配置。

---

## 一、本地运行（一台机器全包）

最简单：后端进程既给页面又给接口，全在根路径下。

```bash
npm run server                       # 默认 http://127.0.0.1:8787
npm run server -- --port 9000       # 换端口
npm run server -- --host 0.0.0.0     # 让局域网其他设备也能访问
```

- 浏览器打开 `http://<host>:<port>/` 即可，页面和 `/api/*`、图片全从根路径取。
- 无需 CORS（同源），无需任何基址配置，相对路径天然正确。
- 限流三档默认开；调试想全关加 `--no-rate-limit`。
- 接口契约见 [`docs/API.md`](API.md)。

---

## 二、前后端分离（前端静态托管 + 后端另跑）

场景：前端丢 GitHub Pages（或任意静态主机），后端放到一台有公网地址的机器上。

### 2.1 后端（接口机器）

```bash
# 挂在 nginx / Cloudflare Tunnel 后面必须加 --trust-proxy，否则限流把所有人当同一 IP
# 多个前端 origin 用逗号分隔，也能用环境变量 CORS_ORIGIN=...
npm run server -- --port 8787 --trust-proxy \
  --cors-origin https://<用户名>.github.io
```

- `--cors-origin`：只放行白名单里的源跨域调接口；不配默认不开。
- `--trust-proxy`：认 `CF-Connecting-IP` / `X-Forwarded-For` 分桶限流；直接暴露时**别**开（那是请求头，可伪造）。
- 这台机器**不需要** `assets/`（前端不会向后端要图片，见 2.3）。

### 2.2 前端（静态托管）

```bash
# 导一份可发布目录，并把后端地址写进 index.html 的 <meta name="api-base">
python tools/export_pages.py --out dist/pages --api-base https://<你的后端地址>
#   导出 = 复制文件（前端零构建）；--no-assets 可跳过 101MB 素材，仅改样式时图快用
```

把 `dist/pages/` 整个推上去（`gh-pages` 分支或仓库里的 `docs/`），在 Pages 设置里选它。
素材 1900+ 文件，首次 push 慢一点，之后增量。

前端通过 `index.html` 的 `<meta name="api-base">` 指到后端；**留空 = 同源**（仅本地形态会用）。
`PAGE_BASE`（页面所在目录，在 `core.js` 里算）只用于改写地址栏，保证子路径下刷新不出 404，不参与资源加载。

### 2.3 为什么不需要任何图片改写

页面和图片**都用相对路径**（如 `assets/common/elem/Anemo.png`、`/style.css` 这类不带前导 `/` 的引用）。
相对路径由浏览器**按页面所在目录**解析：

- 本地根路径 `http://host:8787/` → `http://host:8787/assets/...`
- Pages 项目站 `https://user.github.io/<仓库名>/` → `https://user.github.io/<仓库名>/assets/...`

两边都能自动落对位置，**不需要 `assetUrl` 改写函数、`ASSET_BASE` 之类配置**。
接口返回的图片地址本来就是相对路径，前端原样塞进 `<img src>` 或 CSS `background-image` 即可。

> 推论：**`assets/` 必须跟着前端一起进发布仓库**（导出时**不要**加 `--no-assets`）。
> 后端机器上根本不需要 `assets/`。

### 2.4 安全提醒

免费 Pages 站点是**公开**的，而本服务**没有登录鉴权** —— 后端那台机器等于对全网开放
`POST /api/accounts/:uid/refresh`（别人能用你的服务去打 enka）。能接受就接受（展柜数据本来就是公开的），
不能接受就在反向代理上加一层 Basic Auth 或 IP 白名单，或把 `fetch` 限流调更小。
