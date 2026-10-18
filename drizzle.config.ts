/*
 * drizzle-kit 的配置 —— **可选**的开发工具，不参与运行。
 *
 * 建表是 openDb 按 schema.ts 现算的（见 src/repository/ddl.ts），所以跑服务不需要它。
 * 它只在这两种时候有用：
 *   npx drizzle-kit push          改了表定义、不想删库重抓时，就地 ALTER 上去
 *   npx drizzle-kit export --sql  把表定义导成建表 SQL，看官方口径长什么样（不落文件、不记迁移历史）
 * 注意 `out` 用不到：我们不用 generate/migrate（数据能从 enka 重抓，不攒迁移）。
 */
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/repository/schema.ts',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.DB_FILE ?? 'data/gs.db' }
})
