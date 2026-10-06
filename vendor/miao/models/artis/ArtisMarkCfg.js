import lodash from 'lodash'
import ArtisMark from './ArtisMark.js'
import { Meta } from '#miao'

const weaponCfg = {
  磐岩结绿: {
    attr: 'hp',
    abbr: '绿剑',
    max: 30,
    min: 15
  },
  猎人之径: {
    attr: 'mastery'
  },
  薙草之稻光: {
    attr: 'recharge',
    abbr: '薙刀'
  },
  护摩之杖: {
    attr: 'hp',
    abbr: '护摩',
    max: 18,
    min: 10
  }
}

const ArtisMarkCfg = {
  getCharArtisCfg (profile) {
    let { attr, weapon, elem, char, artis, game } = profile
    let { isGs } = char
    let { usefulAttr } = Meta.getMeta(game, 'arti')

    let rule = function (title, attrWeight) {
      return {
        title,
        attrWeight
      }
    }

    let def = function (attrWeight, title = [], isDefaultWeight = false) {
      /* 本项目加：这一份权重是**专属规则自己手写的**吗（而不是照抄权重表那一行）？
         两者都叫「通用」（title 为空 → 通用），页面上分不出来：
         内核只在「命中特判分支」时才给自定义名字，迪希雅这种
         `def({hp:75,...,recharge:75})` 手写一整套却也叫「迪希雅-通用」——
         看着像查表来的，实际 recharge 是 55→75、mastery 被整个去掉。
         判据：attrWeight 是**显式传入**的（专属规则自己写的），且与权重表那一行不等。
         无专属规则时内核走的是 def(usefulAttr[char.name] || default)，
         传进来的就是表里那一行引用 → 恒等，不算手写。 */
      let isCustomWeight = false
      if (attrWeight && !isDefaultWeight) {
        let table = usefulAttr[char.name] || {}
        /* 缺失的键与 0 视为等价：专属规则常写 def({hp:50,...}) 不写满 10 个键，
           而总表写满（不要的项显式给 0）。语义上「没给」=「给 0」。
           逐键比而不是 JSON.stringify —— 后者会把「缺 4 个 0」判成不一致。 */
        let diff = [...new Set([...Object.keys(attrWeight), ...Object.keys(table)])]
          .some(k => (attrWeight[k] || 0) !== (table[k] || 0))
        isCustomWeight = diff
      }
      let weight = lodash.extend({}, attrWeight || usefulAttr[char.name] || {})
      let check = (key, max = 75, maxPlus = 75, isWeapon = true) => {
        let original = weight[key] || 0
        if (original < max) {
          let plus = isWeapon ? maxPlus * (1 + weapon.affix / 5) / 2 : maxPlus
          weight[key] = Math.min(Math.round(original + plus), max)
          return true
        }
        return false
      }

      /* maxAffix_attr 精5武器权重
      minAffix_attr 精1武器权重 */
      let weaponCheck = (key, maxAffix_attr = 20, minAffix_attr = 10, max = 100) => {
        let original = weight[key] || 0
        if (original == max) {
          return false
        } else {
          let plus = minAffix_attr + (maxAffix_attr - minAffix_attr) * (weapon.affix - 1) / 4
          weight[key] = Math.min(Math.round(original + plus), max)
          return true
        }
      }

      let wn = weapon?.name || ''

      if (isGs) {
        // 对原神一些特殊情况做适配与判定

        // 增加攻击力或直接伤害类武器判定
        if (weight.atk > 0 && weaponCfg[wn]) {
          let wCfg = weaponCfg[wn]
          if (weaponCheck(wCfg.attr, wCfg.max || 20, wCfg.min || 10)) {
            title.push(wCfg.abbr || wn)
          }
        }

        // 圣遗物判定，如果是绝缘4，将充能权重拉高至沙漏圣遗物当前最高权重齐平
        let maxWeight = Math.max(weight.atk || 0, weight.hp || 0, weight.def || 0, weight.mastery || 0)
        if (artis.is('绝缘4') && check('recharge', maxWeight, 75, false)) {
          title.push('绝缘4')
        }

        // 西风系列武器判定。如果携带西风系列武器，则暴击权重强制提高至 100
        if (/^西风(长枪|大剑|剑|猎弓|秘典)$/.test(wn) && weight.cpct < 100) {
          weight['cpct'] = 100
          title.push('西风')
        }
      }

      title = title.length > 0 ? title.join('|') : '通用'
      return {
        title: `${char.abbr}-${title}`,
        attrWeight: weight,
        /* 本项目加：这一份权重是「上游权重表里没有该角色、只能拿通用表兜底」吗？
           表现层要靠它把标题从「妮莎-通用」改成「默认-通用」——
           不然用户会以为那把权重表真的写着沃雅妮莎。isDefaultWeight 由 def 的调用方传入，
           角色专属规则（artis.js）自己调 def 时不传，恒为 false。
           isCustomWeight 见 def() 里的注释：专属规则默认分支手写了权重。
           ⚠️ 只在「通用」时为 true：命中特判分支的角色标题已经自带场景名
             （「可莉-纯火」），再改前缀成「自定义-纯火」是重复信息。 */
        isDefaultWeight,
        isCustomWeight: title === '通用' && isCustomWeight
      }
    }

    let charRule = char.getArtisCfg() || function ({ def }) {
      let defaultAttrWeight = isGs ? { atk: 75, cpct: 100, cdmg: 100, dmg: 100, phy: 100 } : { atk: 75, cpct: 100, cdmg: 100, dmg: 100, speed: 100 }
      return def(usefulAttr[char.name] || defaultAttrWeight, [], !usefulAttr[char.name])
    }

    if (charRule) {
      return charRule({ attr, elem, artis, rule, def, weapon, cons: profile.cons })
    }
  },

  getCfg (profile) {
    let { char } = profile
    let { game } = char
    let { attrWeight, title, isDefaultWeight, isCustomWeight } = ArtisMarkCfg.getCharArtisCfg(profile)
    let attrs = {}
    let baseAttr = char.baseAttr || { hp: 14000, atk: 230, def: 700 }
    let { attrMap } = Meta.getMeta(game, 'arti')
    lodash.forEach(attrMap, (attr, key) => {
      let k = attr.base || ''
      let weight = attrWeight[k || key]
      if (!weight || weight * 1 === 0) {
        return true
      }
      let ret = {
        ...attr, weight, fixWeight: weight, mark: weight / attr.value
      }
      if (!k) {
        ret.mark = weight / attr.value
      } else {
        let plus = k === 'atk' ? 520 : 0
        ret.mark = weight / attrMap[k].value / (baseAttr[k] + plus) * 100
        ret.fixWeight = weight * attr.value / attrMap[k].value / (baseAttr[k] + plus) * 100
      }
      attrs[key] = ret
    })
    let posMaxMark = ArtisMark.getMaxMark(attrs, game)
    // 返回内容待梳理简化
    return {
      attrs,
      classTitle: title,
      posMaxMark,
      /* 本项目加：往上传，交给 view 层决定怎么写标题 */
      isDefaultWeight: !!isDefaultWeight,
      isCustomWeight: !!isCustomWeight
    }
  }
}
export default ArtisMarkCfg
