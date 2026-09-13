/**
 * 根据文件路径计算miao-plugin路径及yunzai路径
 * 规避在外部import，在非yunzai根目录执行时，使用process.cwd()查找文件有可能错误的问题
 */
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// miao-plugin根路径
const miaoPath = path.join(__dirname, '..')
// 云崽根路径 —— 本项目没有云崽宿主，root 即 miao 根
// （Data.getRoot 里 '' / 'root' / 'yunzai' 三个分支会用到）
const rootPath = miaoPath

export { miaoPath, rootPath }
