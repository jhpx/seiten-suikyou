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
sudo useradd --system --home /opt/seiten-suikyou --shell /usr/sbin/nologin sss
sudo mkdir -p /opt/seiten-suikyou/releases /var/lib/seiten-suikyou
sudo chown -R sss:sss /var/lib/seiten-suikyou
```

`/var/lib/seiten-suikyou` 必须归 `sss`：服务以这个用户跑，SQLite 要在该目录里建
`gs.db` 和它的 `-wal` / `-shm`。库文件本身**第一次启动时自动建**，不用手动初始化，
没有跑 SQL 这一步。（库结构变了会直接报错提示删库重抓，见 `config/schema.ts` 的 `SCHEMA_VERSION`。）

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
npm pack                          # → seiten-suikyou-0.1.0.tgz（1.1MB / 697 个文件）
npm pack --pack-destination ..    # 想让它落在别处就加这个
```

**包里只有两样**（外加 npm 自动捎上的 `README.md`，无害）：

| 进包 | 为什么 |
|---|---|
| `src/` | 后端源码，Node 直接跑 |
| `vendor/` | miao 内核 + 官方文案表（663 个文件），少了评分算不出来 |
| `package.json` | `engines`、`#miao` 那三个 import 别名、依赖清单 |

`test/`、`tools/`、`docs/`、`web/`、`data/` **一个都不在**——白名单写在 `package.json`
的 `files` 字段里，只列了 `src` 和 `vendor`。
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

### 3.4 传上去、解开

```bash
# 本机
scp seiten-suikyou-0.1.0.tgz root@<服务器>:/tmp/

# 服务器
sudo mkdir -p /opt/seiten-suikyou/releases/20261018
sudo tar -xzf /tmp/seiten-suikyou-0.1.0.tgz \
         --strip-components=1 -C /opt/seiten-suikyou/releases/20261018
cd /opt/seiten-suikyou/releases/20261018 && ls     # src  vendor  package.json
```

`--strip-components=1` 不能省：npm 的包是为 `npm install x.tgz` 设计的，
所有文件套在一层 `package/` 下，剥掉这层才是正常的工程结构。

### 3.5 装依赖、挂软链

```bash
cd /opt/seiten-suikyou/releases/20261018 && sudo npm install --omit=dev
sudo ln -sfn /opt/seiten-suikyou/releases/20261018 /opt/seiten-suikyou/current
```

**是 `npm install` 不是 `npm ci`**：包里没有锁定文件（npm 打包时硬排除，见 3.3），
`npm ci` 会直接报 `EUSAGE`。版本确定性靠 `package.json` 里写死的精确版本。

生产依赖只有 5 个、全是纯 JS（`node:sqlite` 是 Node 自带，不编译原生模块），装起来很快。
`node_modules` **不进包**的理由就是这个：让服务器按自己的平台装，别把本机的东西空运过去。

到这儿进程还没起：`npm install` 只装依赖，`current` 只是给 systemd 一个稳定入口。

#### 先手动跑一次，确认能起来

别急着配 systemd，先用同一个用户、同一组参数前台跑一遍（出错信息直接打在眼前）：

```bash
cd /opt/seiten-suikyou/current
sudo -u sss node --disable-warning=ExperimentalWarning src/server/index.ts \
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

`/etc/systemd/system/seiten-suikyou.service`：

```ini
[Unit]
Description=seiten-suikyou - 星天水镜接口服务
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sss
WorkingDirectory=/opt/seiten-suikyou/current
Environment=PORT=8787
Environment=CORS_ORIGIN=https://<用户名>.github.io
Environment=TRUST_PROXY=1
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server/index.ts \
          --host 127.0.0.1 --db /var/lib/seiten-suikyou/gs.db
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

每个参数都在管一件事：

| 项 | 为什么这么写 |
|---|---|
| `--host 127.0.0.1` | 只让本机的 nginx 转发进来，不直接对公网开端口 |
| `CORS_ORIGIN` | 只放行 Pages 那个源跨域；不配则浏览器全部拦掉。调通阶段可写 `*`（谁都行），域名定了再收紧 |
| `TRUST_PROXY=1` | 挂反代后认 `X-Forwarded-For`，否则限流把全网当同一个 IP |
| `--db` | 库落 `/var/lib/...`，切版本、删 releases 都不影响数据 |
| `--disable-warning=ExperimentalWarning` | 屏蔽 `node:sqlite` 与剥类型的实验警告，纯粹让日志干净 |
| `Restart=always` | 进程崩了自动拉起；上游抖动不会让服务躺着 |

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now seiten-suikyou
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

前端仓库里重新导一次，把后端地址写进 `env.js`：

```bash
python tools/export_pages.py --out dist/pages --api-base https://api.example.com
```

推上去之后，`CORS_ORIGIN` 里配的那个源要和页面实际域名**一字不差**
（`https://<用户名>.github.io`，项目站也不要带仓库名 —— Origin 头不带路径）。

### 3.9 升级与回滚

新版本一律开新目录，装完再切软链：

```bash
# 本机
npm pack
scp seiten-suikyou-0.1.0.tgz root@<服务器>:/tmp/

# 服务器
sudo mkdir -p /opt/seiten-suikyou/releases/20261101
sudo tar -xzf /tmp/seiten-suikyou-0.1.0.tgz \
         --strip-components=1 -C /opt/seiten-suikyou/releases/20261101
cd /opt/seiten-suikyou/releases/20261101 && sudo npm install --omit=dev
sudo ln -sfn /opt/seiten-suikyou/releases/20261101 /opt/seiten-suikyou/current
sudo systemctl restart seiten-suikyou
```

> 包文件名带的是 `package.json` 里的 `version`。升级时把它一起往上抬一位（`0.1.1`），
> 本地就不会出现两个同名包互相覆盖；服务器侧靠 `releases/<日期>` 区分版本，文件名其实不重要。

回滚 —— 软链指回旧目录再重启，数据自始至终没动：

```bash
sudo ln -sfn /opt/seiten-suikyou/releases/20261018 /opt/seiten-suikyou/current
sudo systemctl restart seiten-suikyou
```

不做「就地覆盖 `current/`」是因为 `src/` 与 `vendor/` 会被拆成两次写，
中间那几秒新旧混着，正好有请求进来就可能读到半套代码。开新目录再切链，切换是原子的。
旧目录攒多了随手删（`releases/20261018` 整个 `rm -rf` 即可，库不在里面）。

**改了库结构**（`SCHEMA_VERSION` 变了）不能这样热切：老库会直接抛错。要么删库重抓，
要么先备份再按新结构重建 —— 抓取数据随时能从上游重来，所以通常就是删了重抓。

### 3.10 备份 SQLite

库是 WAL 模式，`gs.db` 旁边有 `-wal` / `-shm`，**只拷 `gs.db` 会丢最近的写入**。
在线安全备份用 `VACUUM INTO`（服务不用停，一条命令出单个自洽文件）：

```bash
sudo -u sss node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('/var/lib/seiten-suikyou/gs.db')
db.exec(\"VACUUM INTO '/var/lib/seiten-suikyou/gs-\$(date +%F).db'\")
db.close()
"
```

挂 crontab 每天一份就够（这库全是能重抓的缓存数据，丢了不致命）：
`0 4 * * * sudo -u sss node --input-type=module -e "..."`

### 3.11 服务器不能联外网怎么办

`npm install` 要访问 npm registry（首次实测几十秒到几分钟，看网络）。真没外网就在本机装好一起搬：

```bash
npm install --omit=dev                   # 本机，装生产依赖（版本由 package.json 写死）
npm pack                                 # 还是先出包，解开后是 src/ vendor/ package.json
tar -czf /tmp/deps.tar.gz -C . node_modules   # 再单独把 node_modules 压一份
```

传上去解到同一个 `releases/<日期>/` 目录里即可。
生产依赖全是纯 JS、没有 `.node` 原生模块，Windows 上装的直接能在 Linux 跑。
代价是体积从约 1MB 变成约 8MB。
以后升级依赖记得连这份 `node_modules` 一起换（它不会再经过任何校验）。

---

## 附：日常开发里的两个仓库

| 动作 | 在哪跑 |
|---|---|
| 改页面 / 样式 / 素材 | 前端仓库 `web/`（改完在子仓库里 commit + push） |
| 更新子模块指针 | 母仓库：`git add web && git commit`（指针随母仓库走） |
| 同步上游素材 | 母仓库 `python tools/sync.py assets`（落盘进 `web/assets/`，再去子仓库提交） |
| 两边一起更新到最新 | 母仓库：`git submodule update --remote`（按需） |
