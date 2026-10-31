/*
 * 评分规则接口测试 —— 用户「选一个 miao 内置规则」这件事，从落库到整包视图到接口全链路验证。
 *
 * 验证点：
 *   ① 规则列表接口（GET /rubrics）返回 src/gateway/miao/rubrics.json 里那个角色的全部规则，初始 current=null；
 *   ② 选中后整包视图里该角色被换成那套权重（classTitle = 规则名、分数随之变化）；
 *   ③ 选回 null 后回到 miao 自动选（classTitle / 分数还原）；
 *   ④ 非法规则名 → 400 bad_rubric；不存在的角色 / 不存在的账号 → 404。
 *
 * 用真实 enka 响应播种内存库；断言里直接出现真实角色与规则名。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startServer } from '../src/server/index.ts'
import { ingestPayload } from '../src/gateway/enka/enka.service.ts'
import * as repo from '../src/config/store.ts'
import { getRubrics } from '../src/gateway/miao/rubric.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'enka-real.json'), 'utf8'))

let failed = 0
let passed = 0
function ok (cond: unknown, label: string, extra = ''): void {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}` + (cond || !extra ? '' : `\n        ${extra}`))
  cond ? passed++ : failed++
}
function eq (a: unknown, b: unknown, label: string): void {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`)
}

/* 播种：真实响应过一遍 ingest 落进内存库 */
const summary = ingestPayload(REAL, { source: 'enka' })
const UID = summary.account.uid!
const app = await startServer({ port: 0, dbFile: ':memory:' })
repo.saveFetch(app.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })

const get = (p: string): Promise<Response> => fetch(app.url + p)
const post = (p: string, body: unknown): Promise<Response> =>
  fetch(app.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const json = async (p: string): Promise<any> => (await get(p)).json()
const jsonPost = async (p: string, body: unknown): Promise<any> => (await post(p, body)).json()

/* 在账号里找一个有多套规则的角色（这样才有「非默认」可选，能验证覆盖生效） */
const avatars = (await json(`/api/accounts/${UID}`)).data.avatars as Array<{ avatarId: number }>
let pick: number | null = null
for (const a of avatars) {
  if ((getRubrics(a.avatarId) || []).length >= 2) { pick = a.avatarId; break }
}
ok(pick !== null, '账号里至少有一个角色有多套评分规则')
const avatarId = pick as number

const sceneBefore = (await json(`/api/accounts/${UID}`)).data.avatars.find((a: any) => a.avatarId === avatarId)
const miaoAuto = sceneBefore.score.classTitle
const autoMark = sceneBefore.score.markValue

console.log(`\n=== 角色 ${avatarId}（miao 自动选 = "${miaoAuto}"）===\n`)

/* ① 列表接口 */
{
  const r = await json(`/api/accounts/${UID}/characters/${avatarId}/rubrics`)
  ok(r.ok, 'GET /rubrics 成功')
  eq(r.data.rubrics.length, (getRubrics(avatarId) || []).length, '规则数与 src/gateway/miao/rubrics.json 一致')
  eq(r.data.current, null, '初始未选（current=null）')
  ok(r.data.rubrics.some((s: any) => s.isBase), '规则里包含一套通用/兜底规则')
}

/* ② 选一个非默认规则 */
const target = (getRubrics(avatarId) || []).find(s => s.name !== miaoAuto)?.name ?? (getRubrics(avatarId) || [])[0].name
{
  const r = await jsonPost(`/api/accounts/${UID}/characters/${avatarId}/rubric`, { rubric: target })
  ok(r.ok, `POST /rubric 选中「${target}」成功`)
  eq(r.data.current, target, '返回 current=选中规则')
}
{
  const after = (await json(`/api/accounts/${UID}`)).data.avatars.find((a: any) => a.avatarId === avatarId)
  eq(after.score.classTitle, target, `整包视图里该角色的评分规则名变成「${target}」`)
  if (target !== miaoAuto) {
    ok(after.score.markValue !== autoMark, `分数随规则切换而变化（${autoMark} → ${after.score.markValue}）`)
  }
  const r = await json(`/api/accounts/${UID}/characters/${avatarId}/rubrics`)
  eq(r.data.current, target, '再次拉列表，current 已持久化')
}

/* ③ 选回 null → 退回 miao 自动选 */
{
  const r = await jsonPost(`/api/accounts/${UID}/characters/${avatarId}/rubric`, { rubric: null })
  ok(r.ok, 'POST /rubric 传 null 成功（清除选择）')
  eq(r.data.current, null, '返回 current=null')
  const after = (await json(`/api/accounts/${UID}`)).data.avatars.find((a: any) => a.avatarId === avatarId)
  eq(after.score.classTitle, miaoAuto, '整包视图回到 miao 自动选的规则')
}

/* ④ 非法规则名 */
{
  const r = await jsonPost(`/api/accounts/${UID}/characters/${avatarId}/rubric`, { rubric: '__不存在__' })
  ok(!r.ok, '选中一个不存在的规则名被拒')
  eq(r.error.code, 'bad_rubric', '错误码是 bad_rubric')
}

/* 不存在的角色 / 账号 */
{
  const r = await json(`/api/accounts/${UID}/characters/99999999/rubrics`)
  ok(!r.ok, '查一个账号里没有的角色被拒')
  eq(r.error.code, 'no_character', '错误码是 no_character')
  const r2 = await json(`/api/accounts/987654321/characters/${avatarId}/rubrics`)
  ok(!r2.ok, '查一个不存在的账号被拒')
  eq(r2.error.code, 'no_data', '错误码是 no_data')
}

/* ⑤ 多语言：规则名（角色名-规则名）跟着 locale 走，条件句保持中文（不在页面上显示） */
{
  const zh = await json(`/api/accounts/${UID}/characters/${avatarId}/rubrics?locale=chs`)
  const en = await json(`/api/accounts/${UID}/characters/${avatarId}/rubrics?locale=en`)
  const ja = await json(`/api/accounts/${UID}/characters/${avatarId}/rubrics?locale=ja`)
  const ko = await json(`/api/accounts/${UID}/characters/${avatarId}/rubrics?locale=ko`)
  /* name 是规范名（落库用），各语言都一样；label 是展示名，必须变 */
  eq(en.data.rubrics.map((s: any) => s.name), zh.data.rubrics.map((s: any) => s.name), '各语言的 name 不变（落库仍用中文规范名）')
  ok(en.data.rubrics.every((s: any) => /^[A-Za-z]/.test(s.label)), '英文 label 以英文角色名开头', JSON.stringify(en.data.rubrics[0]?.label))
  ok(ja.data.rubrics.every((s: any) => !/^[\u4e00-\u9fa5]{2,3}-/.test(s.label)), '日文 label 的角色名前缀也翻了', JSON.stringify(ja.data.rubrics[0]?.label))
  ok(ko.data.rubrics.every((s: any) => /[가-힣]/.test(s.label)), '韩文 label 含韩文', JSON.stringify(ko.data.rubrics[0]?.label))
  ok(en.data.rubrics.some((s: any) => s.label !== zh.data.rubrics.find((z: any) => z.name === s.name)?.label), '英文 label 确实和中文不同')

  /* 评分视图里的规则名同样跟着 locale（页面那条「评分规则：xxx」显示的是它） */
  const viewEn = (await json(`/api/accounts/${UID}?locale=en`)).data.avatars.find((a: any) => a.avatarId === avatarId)
  ok(/^[A-Za-z]/.test(viewEn.score.rubricLabel), 'score.rubricLabel 在英文下是英文', viewEn.score.rubricLabel)
  ok(viewEn.score.classTitle === miaoAuto, 'classTitle 仍是 miao 的中文原文（诊断用，不受 locale 影响）')
}

app.server.close()
console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)
