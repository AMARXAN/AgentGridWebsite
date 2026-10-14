import Database from 'better-sqlite3'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(process.env.DATABASE_PATH || resolve(root, 'data/agentgrid.sqlite'))
const outputPath = resolve(process.argv[2] || resolve(root, 'backups', `agentgrid-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.sqlite`))
if (sourcePath === outputPath) throw new Error('Backup path must be different from DATABASE_PATH.')
await mkdir(dirname(outputPath), { recursive: true })
const db = new Database(sourcePath, { readonly: true, fileMustExist: true })
try {
  await db.backup(outputPath)
  console.log(`SQLite backup written to ${outputPath}`)
} finally {
  db.close()
}
