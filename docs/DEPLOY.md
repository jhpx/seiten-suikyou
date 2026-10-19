# 星天水镜 · 部署文档

项目是**两个仓库的级联**：

- **前端**：独立仓库 [seiten-suikyou-web](https://github.com/jhpx/seiten-suikyou-web)，纯静态（原生 ES 模块、零构建），
  含约 101MB 图片素材。母仓库以 git submodule 把它挂在 `web/`。
- **后端**：本仓库，`npm run server` 起的 Node 进程，提供 `/api/*`（评分 / 伤害要跑 miao 内核 + 读 SQLite，浏览器做不到，所以数据离不开它）。

两种部署形态：**本地运行**（一台机器全包）和 **前后端分离**（前端丢静态托管，后端另放一台机器）。
没有「同源部署」这种独立概念 —— 本地运行天然同源，无需任何额外配置。

前端已经在 GitHub Pages 上的话，直接看第二节（怎么连）和第三节（后端那台机器怎么上线）。

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
  调通阶段可以先写 `--cors-origin '*'`（任何来源都放行），等域名定了再换成具体那一个。
  **引号别省**：`*` 在 shell 里是通配符，不引起来可能被展开成当前目录的文件名。
- `--trust-proxy`：认 `CF-Connecting-IP` / `X-Forwarded-For` 分桶限流；直接暴露时**别**开（那是请求头，可伪造）。
- 这台机器**不需要** `web/`（前端不会向后端要图片，见 2.3），clone 时甚至可以不带 `--recursive`。

### 2.2 前端（静态托管）

前端是独立仓库，零构建、没有打包编译，发布物就是它整仓：

- 把 `env.js` 里的 `API_BASE` 改成接口根地址（**含 /api 这一段**，如 `'https://api.example.com/api'`，末尾别带 `/`）；
  前后端同域名（nginx 把 `/api` 反代到本服务）就**不用放这个文件**，页面会自动走同源 `/api`；
- 约 101MB 图片素材 `assets/` 必须跟着一起发布；
- 整仓推到 GitHub Pages（`gh-pages` 分支或仓库里的 `docs/`），在 Pages 设置里选它；
- 后端要加 `--cors-origin=<前端地址>` 放行跨域，否则浏览器拦掉请求。

素材 1900+ 文件，首次 push 慢一点，之后增量。

前端接口地址的取值顺序：**有 `env.js` 就用它的 `API_BASE`；没有这个文件（请求 404）就退回同源 `/api`**。
`core.js` 用动态 `import()` 去加载它，所以文件缺失不会把整个页面带崩（静态 import 会）。
`API_BASE` 留空也等同于同源。`PAGE_BASE`（页面所在目录，在 `core.js` 里算）只用于改写地址栏，保证子路径下刷新不出 404，不参与资源加载。

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

## 三、后端上线（打包 → systemd）

这一节是形态二里「后端那台机器」的落地细节，Linux 云服务器 + systemd 版本。
前端已经在 GitHub Pages 上，所以后端**不需要 `web/`**，只出 `/api/*`。

### 3.0 先说清楚：没有 build

项目零构建，Node 22.18+ 运行时自己剥类型，`src/*.ts` **就是**运行产物。
所以「打包」不是编译，只是**挑文件**：从仓库里挑出跑起来真正要的那几样，压成一个 tar.gz。
没有产物目录、没有 sourcemap、没有「改了源码忘了 build」这种事故。
下面五步：建目录 → 装 Node → 打包 → 装依赖 → systemd。

### 3.1 目录怎么摆（数据独立于版本）

```
/opt/seiten-suikyou/
├── releases/20261018/     ← 一份代码（clone 出来或解压出来的），一个版本一个目录
├── current -> releases/20261018
/var/lib/seiten-suikyou/
└── gs.db                  ← SQLite 库放外面，换版本不碰数据
```

```bash
sudo mkdir -p /opt/seiten-suikyou/releases /var/lib/seiten-suikyou
```

服务默认以 **root** 跑（VPS 上只有一个 root 的情况最常见）。想降权就在 unit 里加一行
`User=xxx`，再把这两个目录 `chown` 给它 —— 但 SQLite 要在 `/var/lib/seiten-suikyou`
里建 `gs.db` 和它的 `-wal` / `-shm`，权限得给对。

库文件**第一次启动时自动建**，不用手动初始化，没有跑 SQL 这一步。（库结构变了会直接报错
提示删库重抓，见 `config/schema.ts` 的 `SCHEMA_VERSION`。）

### 3.2 服务器上装 Node

要 **22.18 以上**（剥类型从这个版本开始默认开），推荐 24 LTS：

```bash
node -v                       # 先看有没有，低于 v22.18 就装
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

> 用 nvm 装的 Node 也能跑，但 systemd 不读 shell 配置，unit 里的 `ExecStart`
> 必须写绝对路径（`~/.nvm/versions/node/v24.x.x/bin/node`）。新手直接用 NodeSource 省事。

### 3.3 打包：`npm pack`

在仓库根目录一条命令：

```bash
npm pack                          # → seiten-suikyou-0.1.0.tgz（1.1MB / 699 个文件）
npm pack --pack-destination ..    # 想让它落在别处就加这个
```

**包里三样**（外加 npm 自动捎上的 `README.md`，无害）：

| 进包 | 为什么 |
|---|---|
| `src/` | 后端源码，Node 直接跑 |
| `vendor/` | miao 内核 + 官方文案表（663 个文件），少了评分算不出来 |
| `scripts/` | 部署用的两个文件：`unpack.sh`、`seiten-suikyou.service` |
| `package.json` | `engines`、`#miao` 那三个 import 别名、依赖清单 |

`test/`、`tools/`、`docs/`、`web/`、`data/` **一个都不在**——白名单写在 `package.json`
的 `files` 字段里，只列了 `src`、`vendor`、`scripts`。
所以哪怕仓库里再多一堆开发期目录，也不会被卷进发布物（不加 `files` 时实测打出来 98MB，
把 `web/` 的 1940 个文件和 `test/`、`tools/`、`docs/` 全带上了）。

#### 锁定文件为什么不进包

npm 打包时**硬性排除** `package-lock.json`（写进 `files` 白名单也不进，实测）。
所以服务器上拿到的是没有锁的 `package.json`，装依赖用 `npm install` 而不是 `npm ci`
（`npm ci` 没有锁会直接报 EUSAGE）。

**版本靠 `package.json` 里写死的精确版本保证**：5 个生产依赖都不带 `^`，
比如 `"hono": "4.13.13"` 而不是 `"^4.13.13"`。
这样即便没有锁，`npm install` 也只能装这一版；带 `^` 的话实测会漂
（`drizzle-orm` 从 `1.0.0-rc.4` 装成 `1.0.0-rc.5-ab785fc`）。

> 改依赖版本就改 `package.json` 里的数字，别再写回 `^`——发布包能复现靠的就是这一条。

### 3.4 传上去、解开（一条命令）

```bash
# 本机
npm pack
scp seiten-suikyou-0.1.0.tgz root@<服务器>:/tmp/

# 服务器：包里自带的 unpack.sh 直接抽出来执行
tar -xzOf /tmp/seiten-suikyou-0.1.0.tgz package/scripts/unpack.sh | bash -s /tmp/seiten-suikyou-0.1.0.tgz
```

它干三件事：建 `releases/今天/`（日期取当天，如 `20261019`）、把包解进去、把
`current` 软链指过去。输出长这样：

```
✓ 代码  /opt/seiten-suikyou/releases/20261019
✓ current -> /opt/seiten-suikyou/releases/20261019
```

同一天发两次会撞目录，那时加 `-f` 覆盖：`bash unpack.sh xxx.tgz -f`。
装好之后脚本自己也留在 `current/scripts/` 里，以后不必再从包里抽。

它等价于手动这两条（`--strip-components=1` 不能省：npm 的包是为 `npm install x.tgz`
设计的，所有文件套在一层 `package/` 下，剥掉才是正常工程结构）：

```bash
sudo mkdir -p /opt/seiten-suikyou/releases/20261019
sudo tar -xzf /tmp/seiten-suikyou-0.1.0.tgz --strip-components=1 -C /opt/seiten-suikyou/releases/20261019
sudo ln -sfn /opt/seiten-suikyou/releases/20261019 /opt/seiten-suikyou/current
```

### 3.5 装依赖

```bash
cd /opt/seiten-suikyou/current && sudo npm install --omit=dev
```

**是 `npm install` 不是 `npm ci`**：包里没有锁定文件（npm 打包时硬排除，见 3.3），
`npm ci` 会直接报 `EUSAGE`。版本确定性靠 `package.json` 里写死的精确版本。

> 国内机器在这条命令后面加 `--registry=https://registry.npmmirror.com` 能少等很多，
> 原因见下面「卡住了」那一节。`cd current` 是软链，npm 会写进真实目录，这样命令永远不用改日期。

生产依赖只有 5 个、全是纯 JS（`node:sqlite` 是 Node 自带，不编译原生模块），装起来很快。
`node_modules` **不进包**的理由就是这个：让服务器按自己的平台装，别把本机的东西空运过去。

到这儿进程还没起：`npm install` 只装依赖，`current` 只是给 systemd 一个稳定入口。

#### 卡住了？先看是不是这两件事

**一、别对 tgz 本身跑 `npm install`。**

```bash
npm install seiten-suikyou-0.1.0.tgz    # ✗ 这不是安装这个程序
```

它是把 tgz 当成一个**依赖**装进当前工程 —— 得到的是 `node_modules/seiten-suikyou/`，
顶层没有 `src/`，跑不起来。

更坑的是 npm 会**向上找 `package.json`**：当前目录没有，就一层层往上找，找到哪个工程就装进哪个。
所以在 `~`、`/opt` 这类目录里跑，包可能被塞进一个你根本没想到的工程里，
`package.json` 里还多出一行 `"seiten-suikyou": "file:xxx.tgz"`。
看起来的"卡死"，很多时候就是它在爬目录树、等 registry、再改别人家的清单。

正确顺序永远是 **先 `tar` 解开，再在解开的目录里装依赖**（3.4 → 3.5）。

**二、`--omit=dev` 不能省。**

包里 `package.json` 带着 `devDependencies`（`typescript`、`drizzle-kit`、`@types/node`）。
不 omit 的话 npm 会连它们一起装，而 `drizzle-kit` 拖着 **25 个跨平台的 esbuild 二进制**
（`@esbuild/android-arm64`、`@esbuild/darwin-x64`、`@esbuild/freebsd-arm64`…… 每个几 MB），
在生产依赖 5 个的基础上膨胀到 **42 个包**。国内拉这些就是「卡死」的观感来源。

> 老教程里的 `npm install --production` 效果一模一样（都是只装生产依赖），但它是 npm 6 时代的
> 写法，npm 7 之后转成了 `--omit=dev` 的别名。npm 10 跑前者会多打一行
> `npm warn config production Use --omit=dev instead.`，所以文档统一写 `--omit=dev`。

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 光标一直转，几分钟没输出 | 国内直连 `registry.npmjs.org`（实测同一台机器：npmjs 15 秒还不出结果，npmmirror 2.6 秒） | 换镜像，见下 |
| 十几分钟一个字都不出，像死机 | npm 默认 `fetch-timeout` 5 分钟、失败还重试 2 次，一个请求最坏要等 **15 分钟**才吐错 | 换镜像；想快点看到错就加 `--fetch-timeout=15000 --fetch-retries=1` |
| 一长串 `@esbuild/...` 往下刷 | 漏了 `--omit=dev` | 补上；生产只要 5 个包 |
| 断开 SSH 后进程没了 | 前台进程跟着 shell 死 | `nohup` 或 `tmux` |

先花 5 秒分清是**网络**问题还是 **npm** 问题 —— 两条 `curl` 打同一个包，谁慢一眼就看出来：

```bash
curl -sS -o /dev/null -w 'npmjs   %{http_code}  %{time_total}s\n' --max-time 10 https://registry.npmjs.org/hono
curl -sS -o /dev/null -w 'mirror  %{http_code}  %{time_total}s\n' --max-time 10 https://registry.npmmirror.com/hono
```

国内机器一条能直接用的（实测 59 秒装完 5 个包，版本与 `package.json` 完全一致）：

```bash
cd /opt/seiten-suikyou/releases/20261018
sudo npm install --omit=dev --no-audit --no-fund \
     --registry=https://registry.npmmirror.com
```

想长期生效就写进 `/root/.npmrc`（或跑服务的那个用户的 `~/.npmrc`）：

```ini
registry=https://registry.npmmirror.com
```

**为什么中途一个字都不打？** npm 默认只输出 `notice` 级别，而且**过程中什么都不打**，只在结束时
给一行 `added N packages`；那个转圈的进度条只在真正的终端（TTY）里才画，被 `nohup`、`| tee`、
`sudo` 之类接管输出时彻底静默。实测装完一次 4 秒，全程 0 行输出 —— 所以「没输出」不等于「卡死」，
要看它在等什么必须自己开日志。

看它到底在等哪个地址，加 `--loglevel=http`，会一条条打出请求 URL 和耗时 —— 卡住时最后一行
就是嫌疑人：

```
npm http fetch GET 200 https://registry.npmjs.org/hono 3001ms
npm http fetch GET 200 https://registry.npmjs.org/lodash 3002ms
                                            ↑ 停在这行不动 = 下一个包在等
```

`--timing` 只在结束时给各阶段总耗时（`command:install Completed in 1894ms`），看不了实时进度。

#### 依赖只在服务器上装

`npm install` 是**唯一**的安装方式。`node_modules` 不从本机搬 —— 搬过去的树绕过了 npm 的版本
校验，升级时容易半新半旧，现场也没法复现。装不上就是网络问题，按上面那张表排查：换镜像、
加 `--fetch-timeout` 让它快点报错、实在不通就找运维开代理或配企业源。

> 这条是硬约定，不要在它旁边另开一条「离线搬包」的小路。

#### 先手动跑一次，确认能起来

别急着配 systemd，先按 unit 里那组参数前台跑一遍（出错信息直接打在眼前）：

```bash
cd /opt/seiten-suikyou/current
node --disable-warning=ExperimentalWarning src/server/index.ts \
     --port 8787 --host 127.0.0.1 --cors-origin '*' --db /var/lib/seiten-suikyou/gs.db
```

另开一个终端验三件事：

```bash
curl -s localhost:8787/api/health                       # 起来了
curl -s -D - -o /dev/null -H 'Origin: https://foo.github.io' \
     localhost:8787/api/meta | grep -i allow-origin     # 跨域头是 *
curl -s -X POST localhost:8787/api/accounts/101242308/refresh | head -c 200   # 真能抓
```

`--cors-origin '*'` 是调通阶段的临时设置：**任何来源的页面都能读这个接口**。
等 `docs/DEPLOY.md` 2.2 那步把前端推到 Pages、知道了确切域名，就换成
`--cors-origin https://<用户名>.github.io`（CORS 只认字面量，多一个斜杠都算不匹配）。

启动日志里 `serveStatic: root path .../web is not found` 这句**可以无视**：
这是生产形态（不带 `web/`）的正常现象，静态请求一律 404，接口不受影响。

### 3.6 systemd 常驻

包里带着样例 `scripts/seiten-suikyou.service`，拷过去、改两处（node 绝对路径、前端域名）就能用：

```bash
sudo cp /opt/seiten-suikyou/current/scripts/seiten-suikyou.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now seiten-suikyou
```

它就是下面这个样子：

```ini
[Unit]
Description=seiten-suikyou - 星天水镜接口服务
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/seiten-suikyou/current
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server/index.ts \
          --host 127.0.0.1 --port 8787 \
          --db /var/lib/seiten-suikyou/gs.db \
          --cors-origin *
Environment=TRUST_PROXY=1
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

每个参数都在管一件事：

| 项 | 为什么这么写 |
|---|---|
| `--host 127.0.0.1` | 只让本机的 nginx 转发进来，不直接对公网开端口 |
| `--cors-origin` | 只放行 Pages 那个源跨域；不配则浏览器全部拦掉。调通阶段可写 `*`（谁都行），域名定了再收紧 |
| `TRUST_PROXY=1` | 挂反代后认 `X-Forwarded-For`，否则限流把全网当同一个 IP |
| `--db` | 库落 `/var/lib/...`，切版本、删 releases 都不影响数据 |
| `--disable-warning=ExperimentalWarning` | 屏蔽 `node:sqlite` 与剥类型的实验警告，纯粹让日志干净 |
| `Restart=always` | 进程崩了自动拉起；上游抖动不会让服务躺着 |

`ExecStart` 里 `/usr/bin/node` 要换成 `which node` 的实际结果（nvm 装的尤其要注意，
systemd 不读 shell 配置）。

```bash
systemctl status seiten-suikyou          # 看是否 active (running)
journalctl -u seiten-suikyou -f          # 跟日志，Ctrl+C 退出
curl -s localhost:8787/api/meta | head   # 本机自测
```

### 3.7 nginx 反代 + HTTPS

```nginx
server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;      # 抓上游最坏 8s，留足余量
    }
}
```

**HTTPS 不是可选项**：前端 Pages 是 `https://`，页面去调 `http://` 接口会被浏览器按
混合内容直接拦掉（控制台报 Mixed Content，请求根本不发出去）。所以
`sudo certbot --nginx -d api.example.com` 这条要跟上，然后确认：

```bash
curl -s https://api.example.com/api/meta | head    # 通了就成
```

### 3.8 把前端指过来

前端仓库里把 `env.js` 的 `API_BASE` 改成后端地址（含 /api，如 `https://api.example.com/api`），重新推上去：

推上去之后，`CORS_ORIGIN` 里配的那个源要和页面实际域名**一字不差**
（`https://<用户名>.github.io`，项目站也不要带仓库名 —— Origin 头不带路径）。

### 3.9 升级与回滚

升级就是再跑一遍 3.4 + 3.5：`unpack.sh` 会按**当天日期**建新目录、切好软链，旧目录原地留着。

```bash
# 本机
npm version patch && npm pack          # 0.1.0 → 0.1.1，文件名就是版本凭证
scp seiten-suikyou-0.1.1.tgz root@<服务器>:/tmp/

# 服务器
tar -xzOf /tmp/seiten-suikyou-0.1.1.tgz package/scripts/unpack.sh | bash -s /tmp/seiten-suikyou-0.1.1.tgz
cd /opt/seiten-suikyou/current && sudo npm install --omit=dev --registry=https://registry.npmmirror.com
sudo systemctl restart seiten-suikyou
```

依赖没改也照装：新目录里本来就没有 `node_modules`，而且 npm 有缓存，几秒的事。

回滚 —— 软链指回旧目录再重启，数据自始至终没动：

```bash
ls /opt/seiten-suikyou/releases/                  # 看有哪些版本
sudo ln -sfn /opt/seiten-suikyou/releases/20261019 /opt/seiten-suikyou/current
sudo systemctl restart seiten-suikyou
```

不做「就地覆盖 `current/`」是因为 `src/` 与 `vendor/` 会被拆成两次写，中间那几秒新旧混着，
正好有请求进来就可能读到半套代码。开新目录再切链，切换是原子的。旧目录攒多了随手删
（`rm -rf /opt/seiten-suikyou/releases/<旧日期>`，库不在里面）。

验证是否真的换上了：

```bash
curl -s http://127.0.0.1:8787/api/meta | head -c 200
journalctl -u seiten-suikyou -n 20 --no-pager
```


**改了库结构**（`SCHEMA_VERSION` 变了）不能这样热切：老库会直接抛错。要么删库重抓，
要么先备份再按新结构重建 —— 抓取数据随时能从上游重来，所以通常就是删了重抓。

### 3.10 备份 SQLite

库是 WAL 模式，`gs.db` 旁边有 `-wal` / `-shm`，**只拷 `gs.db` 会丢最近的写入**。
在线安全备份用 `VACUUM INTO`（服务不用停，一条命令出单个自洽文件）：

```bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('/var/lib/seiten-suikyou/gs.db')
db.exec(\"VACUUM INTO '/var/lib/seiten-suikyou/gs-\$(date +%F).db'\")
db.close()
"
```

挂 crontab 每天一份就够（这库全是能重抓的缓存数据，丢了不致命）：
`0 4 * * * node --input-type=module -e "..."`

---

## 附：日常开发里的两个仓库

| 动作 | 在哪跑 |
|---|---|
| 改页面 / 样式 / 素材 | 前端仓库 `web/`（改完在子仓库里 commit + push） |
| 更新子模块指针 | 母仓库：`git add web && git commit`（指针随母仓库走） |
| 同步上游素材 | 母仓库 `python tools/sync.py assets`（落盘进 `web/assets/`，再去子仓库提交） |
| 两边一起更新到最新 | 母仓库：`git submodule update --remote`（按需） |
