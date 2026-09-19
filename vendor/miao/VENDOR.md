# vendor/miao 来源记录

本目录由 `python tools/sync_miao.py` 从 miao-plugin 自动生成，**请勿手工编辑**（改动会被下次同步覆盖）。要改行为，改 sync 脚本里的清单或补丁。

- 上游: `E:/Workspace-Private/workspace-javascript/miao-plugin`（miao-plugin v2.3.3）
- 同步时间: 2026-09-13T17:34:13
- 文件数: 505 个（另生成 2 个）
- 体积: 3588.1 KB
- 处置方式: 原样搬运 498 个 / 定点改写 7 个 / 本地生成 2 个
- 相对上一版: 相对提交 8e5465d：新增 0 / 移除 0 / 内容变化 0

## 别名映射（package.json `imports` 字段，import 语句本身不改写）

```
#miao         → ./vendor/miao/components/index.js
#miao.models  → ./vendor/miao/models/index.js
#miao.path    → ./vendor/miao/tools/path.js
```

## 同步了什么、改了什么

见 `docs/reports/sync-report.md`（完整清单 + 增量 + 改动说明）。
逐字节核对用 `git log -p -- vendor/miao`。