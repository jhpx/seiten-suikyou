/*
 * 「库行 ↔ 领域对象」的列映射 —— 每个模型只声明一张 FIELDS，其余全由它派生
 *
 * 加一列只动两处：模型的 FIELDS + schema.sql（DDL 没法省）。以前 COLS（列名清单）/ toValues
 * （有序列值）/ fromRow（列名→字段）是分开写的三份，顺序一致只靠注释约束，加一列要改三处。
 *
 * 模型上剩的 `COLS` **不是「第二份列定义」**，而是 `toValues` 的**名字面** —— 同一张 FIELDS 的两面，
 * 拼 INSERT 时必须成对（`COLS[i]` 就是 `toValues()[i]` 的列名）。它由 colsOf() 派生、不是手写清单，
 * 所以不会漂移；Weapon / Artifact 再在它前面接上 `uid` / `avatar_id` 两个键列（子行的键取自父对象）
 * —— 这份「表结构怎么拼」的知识属于模型，别漏进 store 层。
 *
 * 列名与字段名为什么不靠 snake_case ↔ camelCase 自动推：两边现在确实只差一次大小写变换，
 * 但配对写出来，「这列在库里叫什么」就明摆在定义处，`grep main_stat_value` 也能找到它。
 *
 * 放这儿而不是 store：存储契约本来就住在领域模型里（见 docs/DESIGN-DATA-MODEL.md §2.1），
 * 而且领域层只许引 `./` 与 `../shared/`，这张表跟着模型走才引得到。
 */
import { encodeJson, parseJson } from '../shared/util.ts'

/** 一列 = [库里的列名, 领域字段名]；第三个 `'json'` 表示这一列在库里存的是 JSON 文本 */
export type Field = [col: string, prop: string, kind?: 'json']

/** 列名清单（拼 SQL 用） */
export const colsOf = (fields: Field[]): string[] => fields.map(f => f[0])

/**
 * 领域对象 → 一行各列的值（按 FIELDS 顺序，JSON 列在这儿编码）。
 * overrides 给「值不来自字段」的列 —— 比如 fetched_at 换成这次落库的 stamp。
 */
export const rowValuesOf = (obj: object, fields: Field[], overrides: Record<string, unknown> = {}): unknown[] => {
  const self = obj as Record<string, unknown>
  return fields.map(([, prop, kind]) => {
    const value = prop in overrides ? overrides[prop] : self[prop]
    return kind === 'json' ? encodeJson(value) : value
  })
}

/*
 * 库行 → 模型 constructor 的入参（列名 → 字段名，JSON 列在这儿解码）。
 *
 * 返回值故意是 `any`：行本来就没有类型（SQLite 给回来的就是一包原始值），收窄是模型 constructor 的活
 * —— num / str / 数组兜底都在那儿，那才是唯一的收敛点。真映射错了由 test/pipeline.ts 的
 * 「落库 → 读回 → 分数一致」兜住。
 */
export const rowArgsOf = (row: Record<string, unknown>, fields: Field[]): any =>
  Object.fromEntries(fields.map(([col, prop, kind]) => [prop, kind === 'json' ? parseJson(row[col]) : row[col]]))
