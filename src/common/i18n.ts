/*
 * i18n —— 两张文案表的统一出口
 *
 * 名字表（names.ts）是官方游戏文案，从 `vendor/i18n/names.json` 读；界面文字表（ui.ts）是我们自己
 * 页面的按钮/标题，手写。两者查表方式不同（一个按 hash/id，一个按固定键），但「语言代码怎么认、
 * 认不出退到哪」必须是同一套 —— 就在这里包一层：先认语言，再查表。
 *
 * 为什么要单独一个文件：包这层以前写在 names.ts 里，于是 names → ui（要那两张入口）、
 * ui → names（要默认语言），两个文件互相 import。挪出来以后方向是单向的：
 *   i18n → names、i18n → ui、ui → names（只取一个常量），names 谁也不引。
 */
import { DEFAULT_LOCALE } from './config.ts'
import { resolveLocale } from './names.ts'
import { t as uiT, all as uiAll } from './ui.ts'

/* 查表函数（name / avatarName / weaponName / slotName / statName / fromZh / locales …）原样转出：
   调用方一直按 `i18n.xxx` 用，拆文件不该逼它们改代码。 */
export * from './names.ts'

/* 默认语言搬去了 config.ts（部署决策），但从 i18n 出去的调用点不该跟着改。 */
export { DEFAULT_LOCALE }

/** 界面文字（按钮/标题/提示）：先按同一套规则认语言，再查手写表。
 *  统一在这儿认语言的目的是不出现「名字回落中文、界面文字回落英文」的割裂。 */
export function uiText (key: string, locale: string | null = DEFAULT_LOCALE, vars: Record<string, unknown> | null = null): string {
  return uiT(key, resolveLocale(locale), vars)
}

/** 整张界面文字表（前端一次拿全，切语言不用再问后端） */
export function uiTable (locale: string | null = DEFAULT_LOCALE): Record<string, string> {
  return uiAll(resolveLocale(locale))
}
