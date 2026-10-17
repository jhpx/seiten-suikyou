# 星天水镜 · 部署文档

项目是**两个仓库的级联**：

- **前端**：独立仓库 [seiten-suikyou-web](https://github.com/jhpx/seiten-suikyou-web)，纯静态（原生 ES 模块、零构建），
  含约 101MB 图片素材。母仓库以 git submodule 把它挂在 `web/`。
- **后端**：本仓库，`npm run server` 起的 Node 进程，提供 `/api/*`（评分 / 伤害要跑 miao 内核 + 读 SQLite，浏览器做不到，所以数据离不开它）。

两种部署形态：**本地运行**（一台机器全包）和 **前后端分离**（前端丢静态托管，后端另放一台机器）。
没有「同源部署」这种独立概念 —— 本地运行天然同源，无需任何额外配置。

---

## 一、本地运行（一台机器全包）

最简单：后端进程既给页面又给接口，全在根路径下。

```bash
git clone --recursive <母仓库地址>   # 前端是 submodule，必须带上 --recursive
npm install
npm run server                       # 默认 http://127.0.0.1:8787
npm run server -- --port 9000        # 换端口
npm run server -- --host 0.0.0.0     # 让局域网其他设备也能访问
```

- 已经 clone 过、当时没带 `--recursive`：补跑 `git submodule update --init`。
  漏了这步接口照常跑，但页面（含 `/`、`/bootstrap.js`、`/assets/*`）全部 404。
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
- 这台机器**不需要** `web/`（前端不会向后端要图片，见 2.3），clone 时甚至可以不带 `--recursive`。

### 2.2 前端（静态托管）

前端是独立仓库，发布物从它里面出：

```bash
git clone --recursive https://github.com/jhpx/seiten-suikyou-web.git
cd seiten-suikyou-web
# 导一份可发布目录，--api-base 会把后端地址写进 env.js 的 API_BASE
python tools/export_pages.py --out dist/pages --api-base https://<你的后端地址>
#   导出 = 复制文件（前端零构建）；--no-assets 可跳过 101MB 素材，仅改样式时图快用
```

把 `dist/pages/` 整个推上去（`gh-pages` 分支或仓库里的 `docs/`），在 Pages 设置里选它。
素材 1900+ 文件，首次 push 慢一点，之后增量。

前端通过 `env.js` 的 `API_BASE` 指到后端；**留空 = 同源**（仅本地形态会用）。
`PAGE_BASE`（页面所在目录，在 `core.js` 里算）只用于改写地址栏，保证子路径下刷新不出 404，不参与资源加载。

### 2.3 为什么不需要任何图片改写

页面和图片**都用相对路径**（`style.css`、`assets/common/elem/Anemo.png`，都不带前导 `/`）。
相对路径由浏览器**按页面所在目录**解析：

- 本地根路径 `http://host:8787/` → `http://host:8787/assets/...`
- Pages 项目站 `https://user.github.io/<仓库名>/` → `https://user.github.io/<仓库名>/assets/...`

两边都能自动落对位置，**不需要任何路径改写函数或前缀配置**。
接口返回的图片地址本来就是相对路径，前端原样塞进 `<img src>` 或 CSS `background-image` 即可。

> 推论：**`assets/` 必须跟着前端一起进发布仓库**（导出时**不要**加 `--no-assets`）。
> 后端机器上根本不需要 `assets/`。

### 2.4 安全提醒

免费 Pages 站点是**公开**的，而本服务**没有登录鉴权** —— 后端那台机器等于对全网开放
`POST /api/accounts/:uid/refresh`（别人能用你的服务去打 enka）。能接受就接受（展柜数据本来就是公开的），
不能接受就在反向代理上加一层 Basic Auth 或 IP 白名单，或把 `fetch` 限流调更小。

---

## 附：日常开发里的两个仓库

| 动作 | 在哪跑 |
|---|---|
| 改页面 / 样式 / 素材 | 前端仓库 `web/`（改完在子仓库里 commit + push） |
| 更新子模块指针 | 母仓库：`git add web && git commit`（指针随母仓库走） |
| 同步上游素材 | 母仓库 `npm run sync:assets`（落盘进 `web/assets/`，再去子仓库提交） |
| 两边一起更新到最新 | 母仓库：`git submodule update --remote`（按需） |
