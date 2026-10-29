# 星天水镜 · 架构重构规划

**这篇讲「架构为什么乱、改成什么样、改到哪一步了」。** 现状是怎么设计出来的看
[`DESIGN.md`](DESIGN.md)（为什么内嵌 miao）与 [`DESIGN-DATA-MODEL.md`](DESIGN-DATA-MODEL.md)
（数据层论证）。本篇是**重构**的施工图 + 进度记录。

> 状态：**已完成**。五步重构全部落地，`npm test` 全绿、评分与 miao 逐字一致。

---

## 一、诊断：乱在哪

一句话：**分层没塌，是「数据对象」的身份没理清——数据库对象（dbo）、给前端的传输对象（dto）、
还有把它们连起来的组装器，全挤在 `service/` 一个目录里，谁都没独立身份。**

三个病根：

1. **service 层三责混在一起**：`character.service.ts` 单文件 792 行，同时干"用例编排
   （`characterDamage`/`characterSim`/`simCatalogOf`）+ 组装（`shapeCharacter` 等）+ 口径
   （词条叫法/舍入）"，改业务、改版式、改口径都要动同一个文件。
2. **dto 没有独立身份**：给前端的对象（`AvatarView`/`DamageView`/`SimView` 等）是一堆
   `ReturnType<typeof shapeCharacter>` 反推的类型，散落无名字。
3. **名实不符**：`domain/` 本质是数据库对象（字段映射 + `ofEnka` + 落库，零业务规则），
   却叫"领域"；`kernel/` 是 miao 引擎适配层，却叫"内核"。真正的领域规则在 vendored 的 miao 里。

**本质**：读多写少的服务（唯一写路径 `POST /refresh`），没有独立的领域层（领域逻辑在 miao
引擎里），所以 gateway 架在 repository 之上会"没有东西返回"——这就是为什么不能照搬 DDD 四层。

---

## 二、目标架构（三层半）

```
rest          控制器：收参数，调 service，原样返回 dto
service       编排 + 组装 + dto（编排用例 + assembler 组装器 + dto 传输类型）
repository    持久化：行读写
dbo           数据库对象（原 domain）：聚合，零依赖孤岛
gateway       外部系统隔离（原 kernel + upstream）：
  miao/       引擎适配（materialize / damage / simulate）
  enka/       数据源（抓取 + 原始响应→dbo）
common        i18n / names / ui / util
config        constants / schema / db / store
```

依赖方向（无环）：

```
rest → service → { dto, assembler, gateway, repository }
                 assembler → { dto, gateway/miao 结果, dbo, i18n }
                 gateway/miao → { dbo }    gateway/enka → { dbo, config/constants }
                 repository → { dbo }
                 dbo → { common/util }（零依赖孤岛）
```

**定调**：`dbo/` 是"原文"（数据库对象，贫血是它的正确形态），`dto/` 是"翻译+算分后的结果"，
assembler 是两者的合流点（miao 计算 + i18n 翻译）。领域规则在外部 miao 引擎，`gateway/miao/`
是它的适配层。

---

## 三、进度

| 步 | 动作 | 状态 |
|---|---|---|
| 1 | kernel → gateway/miao | ✅ 完成 |
| 2 | upstream → gateway/enka | ✅ 完成 |
| 3 | domain → dbo（目录 + 类名加 Dbo 后缀） | ✅ 完成 |
| 4 | 建 service/dto + service/assembler，拆编排/组装 | ✅ 完成 |
| 5 | 读接口粒度对齐（loadCharacter 替代整包 find） | ✅ 完成 |

每一步都跑 `npm test`（typecheck → smoke → arch → enka → pipeline → i18n → server → cli →
regression → verify）验证，评分与 miao 逐字一致（verify diff 为空）才算过。

**已完成改动的验证结果**：`npm test` 全绿，评分结果与基线逐字一致（芙宁娜 149.4 / 纳西妲 206.1 /
钟离 199.9 / 班尼特 157.0），arch 断言 72 项全过。

---

## 四、第 4、5 步的实际落地（service 层内聚拆分）

### 第 4 步：dto 与 assembler

`character.service.ts`（原 792 行）按"变化原因"拆成三块：

| 内容 | 去向 | 行数 |
|---|---|---|
| 编排用例（`characterDamage`/`characterSim`/`simCatalogOf`/`weightFilterOptions`） | `character.service.ts` | 80 行 |
| 组装逻辑（`shapeCharacter`/`attrTableOf`/`classTitleOf`/`charImgs`/`damageOf`/`damageToView`/`simCharacterOf`/`simViewOf`/`simCatalogToDto` 等） | `assembler/character.assembler.ts` | 440 行 |
| 传输类型（`CharacterDto`/`AttrRow`/`MarkDetail`/`DamageView`/`SimView`/`SimCatalog` 等） | `dto/character.dto.ts` | 157 行 |

关键点：
- `shapeCharacter` 返回类型从 `ReturnType` 改成显式 `CharacterDto`
- `damageOf` 和 `characterSim` 里重复的伤害组装抽成 `damageToView(dmg)`，消除重复
- `gateway/miao/damage.ts` 的 `DamageResult`/`DamageEntry` 改名 `MiaoDamage`/`MiaoDamageEntry`，
  避免和 dto 的用例判别联合 `DamageResult` 重名（一个指"引擎原始伤害"，一个指"用例结果"）

### 第 5 步：读接口粒度对齐

`characterDamage`/`characterSim`/`simCatalogOf` 改调 `repo.loadCharacter(db, uid, avatarId)`，
不再整包加载后内存 find。

---

## 五、明确的"不做"清单

- 不建独立的领域层（领域逻辑在 miao 引擎，gateway 封住它）
- 不做命令总线 / 领域事件 / CQRS 写模型——唯一写操作是 `refresh`
- 不把 dbo 改充血实体——硬塞业务方法是造假充血
- 不引入 DI 容器——`createApp` 手动装配更透明
- 不改 SQLite 表名——表名是持久化的游戏术语，与 dbo 命名无关
- enka.ts（上游形状类型）暂留 dbo，待第 4 步时再决定是否移 gateway/enka

---

## 六、与 COLA Java 框架对照

| COLA v4 | 本项目 | 说明 |
|---|---|---|
| adapter.web | `rest/` + `server/` | 控制器 + 装配 |
| app（Executor/Assembler） | `service/`（编排 + assembler） | 应用层 |
| domain（entity/aggregate） | `dbo/` | 数据库对象（贫血，正确的） |
| client.dto.vo | `service/dto/` | 传输对象 |
| infrastructure | `repository/` + `config/` + `gateway/` | 存储 + 外部系统适配 |

差异：COLA 的领域逻辑在 domain 层（充血），本项目在外部 miao 引擎（`gateway/miao/` 适配它）。
这是最大的结构差异，也是 dbo 贫血的**正确**解释。
