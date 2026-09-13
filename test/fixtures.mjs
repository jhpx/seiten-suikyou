/*
 * 测试用数据 —— 圣遗物名必须是 miao meta 里的真实部件名，
 * 否则 Artifact.get() 查不到，详情模式会炸。
 */
import { Artis, Character } from '../src/index.js'

/** idx 1花 2羽 3沙 4杯 5头 */
export const HUTAO_ARTIS = [
  { name: '魔女的炎之花', set: '炽烈的炎之魔女', main: { key: 'hp', value: 4780 }, attrs: [{ key: 'cdmg', value: 14.8 }, { key: 'cpct', value: 7.8 }, { key: 'mastery', value: 23 }, { key: 'atkPlus', value: 33 }] },
  { name: '魔女常燃之羽', set: '炽烈的炎之魔女', main: { key: 'atk', value: 311 }, attrs: [{ key: 'cdmg', value: 21.8 }, { key: 'cpct', value: 3.5 }, { key: 'hpPlus', value: 4.7 }, { key: 'recharge', value: 5.2 }] },
  { name: '魔女破灭之时', set: '炽烈的炎之魔女', main: { key: 'mastery', value: 187 }, attrs: [{ key: 'cdmg', value: 14 }, { key: 'cpct', value: 10.9 }, { key: 'hpPlus', value: 9.3 }, { key: 'defPlus', value: 5.8 }] },
  { name: '魔女的心之火', set: '炽烈的炎之魔女', main: { key: 'dmg', value: 46.6 }, attrs: [{ key: 'cpct', value: 13.2 }, { key: 'cdmg', value: 6.6 }, { key: 'atkPlus', value: 18 }, { key: 'hpPlus', value: 4.1 }] },
  { name: '焦灼的魔女帽', set: '炽烈的炎之魔女', main: { key: 'cpct', value: 31.1 }, attrs: [{ key: 'cdmg', value: 28.8 }, { key: 'mastery', value: 42 }, { key: 'hpPlus', value: 5.3 }, { key: 'atkPlus', value: 14 }] }
]

export const ATTR = {
  hp: 28000, atk: 1300, def: 800, cpct: 70, cdmg: 220,
  mastery: 250, recharge: 110, dmg: 46.6, heal: 0, phy: 0
}

export function buildArtis (list) {
  const a = new Artis('gs', true)
  list.forEach((ds, i) => {
    a.artis[String(i + 1)] = {
      name: ds.name, set: ds.set, level: 20, star: 5,
      main: ds.main, attrs: ds.attrs
    }
  })
  return a
}

export function buildProfile (charName, weapon, cons, attr, artisList = HUTAO_ARTIS) {
  const char = Character.get(charName)
  if (!char) throw new Error(`角色不存在: ${charName}`)
  return {
    isProfile: true,
    isGs: true,
    game: 'gs',
    id: char.id,
    elem: char.elem,
    char,
    weapon,
    attr,
    cons,
    artis: buildArtis(artisList)
  }
}
