import express from 'express'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoogleGenAI } from '@google/genai'
import { hashPassword, verifyPassword, issueToken, verifyToken } from './auth.mjs'
import { buildAgentPrompt, buildAgentSystemInstruction, isValidAgentStatus } from './agent.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const app = express()
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1)
const port = Number(process.env.PORT || 3001)
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
const apiKey = process.env.GEMINI_API_KEY
const databasePath = resolve(process.env.DATABASE_PATH || resolve(here, '../data/agentgrid.sqlite'))
const tokenSecret = process.env.AUTH_SECRET
const maxPromptChars = 12_000
const rateWindowMs = 60_000
const requestsByIp = new Map()

if (process.env.NODE_ENV === 'production' && (!tokenSecret || tokenSecret.length < 32)) {
  throw new Error('AUTH_SECRET must be at least 32 characters in production.')
}
if (!process.env.AUTH_SECRET) console.warn('AUTH_SECRET is not set; using a local-development-only secret. Set a random 32+ character secret before deployment.')
const secret = tokenSecret || 'local-development-only-change-this-secret-please'

import { mkdirSync } from 'node:fs'
mkdirSync(dirname(databasePath), { recursive: true })
const db = new Database(databasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
    PRIMARY KEY(user_id, workspace_id)
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, role TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','paused')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge_sources (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_records (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id), task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK(source IN ('task','playground')), model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agents_workspace_created ON agents(workspace_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS knowledge_workspace_created ON knowledge_sources(workspace_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS usage_workspace_created ON usage_records(workspace_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id), agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
    input TEXT NOT NULL, output TEXT, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id), event_type TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_workspace_created ON tasks(workspace_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS events_workspace_created ON activity_events(workspace_id, created_at DESC);
`)
const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name)
if (!taskColumns.includes('agent_id')) db.exec('ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL')

app.disable('x-powered-by')
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'")
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
})
app.use(express.json({ limit: '32kb', strict: true }))
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

function rateLimit({ max, keyPrefix = 'general' }) {
  return (req, res, next) => {
    const now = Date.now()
    const key = `${keyPrefix}:${req.ip || 'unknown'}`
    const recent = (requestsByIp.get(key) || []).filter(ts => now - ts < rateWindowMs)
    if (recent.length >= max) return res.status(429).json({ error: 'Хүсэлтийн хязгаарт хүрлээ. Нэг минутын дараа дахин оролдоно уу.' })
    recent.push(now)
    requestsByIp.set(key, recent)
    if (requestsByIp.size > 10_000) {
      for (const [ip, timestamps] of requestsByIp) if (!timestamps.some(ts => now - ts < rateWindowMs)) requestsByIp.delete(ip)
    }
    next()
  }
}
// API responses can contain workspace data, credentials, or AI output. Prevent
// browsers and intermediary caches from storing authenticated responses.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  next()
})
app.use('/api', rateLimit({ max: 60 }))
app.use('/api/auth', rateLimit({ max: 10, keyPrefix: 'auth' }))
app.use('/api/chat', rateLimit({ max: 12, keyPrefix: 'ai' }))

function publicUser(row) {
  return { id: row.id, email: row.email, workspaceId: row.workspace_id, role: row.role, workspaceName: row.workspace_name }
}
function userFromId(id) {
  return db.prepare(`SELECT u.id, u.email, m.workspace_id, m.role, w.name AS workspace_name
    FROM users u JOIN memberships m ON m.user_id = u.id JOIN workspaces w ON w.id = m.workspace_id WHERE u.id = ? LIMIT 1`).get(id)
}
function requireAuth(req, res, next) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const payload = verifyToken(token, secret)
  if (!payload) return res.status(401).json({ error: 'Нэвтрэх шаардлагатай. Дахин нэвтэрнэ үү.' })
  const user = userFromId(payload.sub)
  if (!user || user.workspace_id !== payload.workspaceId) return res.status(401).json({ error: 'Сесс хүчингүй болсон байна.' })
  req.user = publicUser(user)
  next()
}
function requireWriteRole(req, res, next) {
  if (req.user.role === 'viewer') return res.status(403).json({ error: 'Таны workspace эрх зөвхөн унших боломжтой.' })
  next()
}
function dailyUsage(workspaceId) {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
  return db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens,
    COALESCE(SUM(output_tokens),0) AS outputTokens FROM usage_records WHERE workspace_id = ? AND created_at >= ?`)
    .get(workspaceId, dayStart.toISOString())
}
const parsedDailyLimit = Number.parseInt(process.env.DAILY_AI_REQUEST_LIMIT || '50', 10)
const DAILY_AI_REQUEST_LIMIT = Number.isFinite(parsedDailyLimit) && parsedDailyLimit > 0 ? Math.min(parsedDailyLimit, 100_000) : 50
function reserveUsage({ workspaceId, userId, taskId = null, source }) {
  // Count + insert run in one SQLite transaction so parallel requests cannot
  // all pass the daily quota check before any of them are recorded.
  return db.transaction(() => {
    const usage = dailyUsage(workspaceId)
    if (usage.requests >= DAILY_AI_REQUEST_LIMIT) return null
    const id = randomUUID()
    db.prepare(`INSERT INTO usage_records (id, workspace_id, user_id, task_id, source, model, input_tokens, output_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`)
      .run(id, workspaceId, userId, taskId, source, model, new Date().toISOString())
    return id
  })()
}
function quotaExceeded(res) {
  res.status(429).json({ error: `Өдрийн AI хүсэлтийн хязгаарт хүрлээ (${DAILY_AI_REQUEST_LIMIT}). Маргааш дахин оролдоно уу.` })
}
function updateUsage(id, inputTokens = 0, outputTokens = 0) {
  db.prepare('UPDATE usage_records SET input_tokens = ?, output_tokens = ? WHERE id = ?')
    .run(Math.max(0, Number(inputTokens) || 0), Math.max(0, Number(outputTokens) || 0), id)
}
function recordEvent(workspaceId, userId, type, detail) {
  db.prepare('INSERT INTO activity_events (id, workspace_id, user_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), workspaceId, userId, type, detail.slice(0, 500), new Date().toISOString())
}

// A synchronous HTTP-based worker cannot resume an in-flight provider call after
// a process restart. Mark interrupted tasks as failed instead of leaving them
// permanently in the running state; users can explicitly retry them.
const interruptedTasks = db.prepare("SELECT id, workspace_id, created_by, title FROM tasks WHERE status = 'running'").all()
if (interruptedTasks.length) {
  const recoveredAt = new Date().toISOString()
  db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE status = 'running'").run(recoveredAt)
  for (const task of interruptedTasks) {
    recordEvent(task.workspace_id, task.created_by, 'task.interrupted', `Task marked failed after server restart: ${task.title}`)
  }
  console.warn(`Recovered ${interruptedTasks.length} interrupted task(s); they were marked failed for explicit retry.`)
}

app.get('/api/health', (_req, res) => res.json({ ok: true, model, configured: Boolean(apiKey), database: 'connected' }))

app.post('/api/auth/register', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const workspaceName = typeof req.body?.workspaceName === 'string' ? req.body.workspaceName.trim() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Зөв имэйл хаяг оруулна уу.' })
  if (password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Нууц үг 12–128 тэмдэгт байх ёстой.' })
  if (workspaceName.length < 2 || workspaceName.length > 80) return res.status(400).json({ error: 'Workspace нэр 2–80 тэмдэгт байх ёстой.' })
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Энэ имэйл бүртгэлтэй байна. Нэвтэрнэ үү.' })
  const userId = randomUUID(), workspaceId = randomUUID(), now = new Date().toISOString()
  const create = db.transaction(() => {
    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(userId, email, hashPassword(password), now)
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(workspaceId, workspaceName, now)
    db.prepare('INSERT INTO memberships (user_id, workspace_id, role) VALUES (?, ?, ?)').run(userId, workspaceId, 'owner')
    recordEvent(workspaceId, userId, 'workspace.created', 'Workspace created')
  })
  try { create() } catch (error) {
    if (String(error).includes('UNIQUE')) return res.status(409).json({ error: 'Энэ имэйл бүртгэлтэй байна.' })
    throw error
  }
  const user = { id: userId, email, workspaceId, role: 'owner', workspaceName }
  res.status(201).json({ token: issueToken(user, secret), user })
})

app.post('/api/auth/login', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!email || email.length > 254 || password.length < 1 || password.length > 128) {
    return res.status(400).json({ error: 'Имэйл эсвэл нууц үгийн формат буруу байна.' })
  }
  const row = db.prepare(`SELECT u.id, u.email, u.password_hash, m.workspace_id, m.role, w.name AS workspace_name
    FROM users u JOIN memberships m ON m.user_id = u.id JOIN workspaces w ON w.id = m.workspace_id WHERE u.email = ? LIMIT 1`).get(email)
  if (!row || !verifyPassword(password, row.password_hash)) return res.status(401).json({ error: 'Имэйл эсвэл нууц үг буруу байна.' })
  const user = publicUser(row)
  res.json({ token: issueToken(user, secret), user })
})

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }))

app.get('/api/knowledge', requireAuth, (req, res) => {
  const sources = db.prepare(`SELECT id, title, content, created_at AS createdAt, updated_at AS updatedAt
    FROM knowledge_sources WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100`).all(req.user.workspaceId)
  res.json({ sources })
})
app.post('/api/knowledge', requireAuth, requireWriteRole, (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  if (title.length < 2 || title.length > 160) return res.status(400).json({ error: 'Эх сурвалжийн нэр 2–160 тэмдэгт байх ёстой.' })
  if (content.length < 1 || content.length > 20_000) return res.status(400).json({ error: 'Агуулга хоосон эсвэл 20,000 тэмдэгтээс урт байна.' })
  const id = randomUUID(), now = new Date().toISOString()
  db.prepare('INSERT INTO knowledge_sources (id, workspace_id, created_by, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user.workspaceId, req.user.id, title, content, now, now)
  recordEvent(req.user.workspaceId, req.user.id, 'knowledge.created', `Added knowledge source: ${title}`)
  res.status(201).json({ source: { id, title, content, createdAt: now, updatedAt: now } })
})
app.delete('/api/knowledge/:id', requireAuth, requireWriteRole, (req, res) => {
  const source = db.prepare('SELECT id, title FROM knowledge_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, req.user.workspaceId)
  if (!source) return res.status(404).json({ error: 'Эх сурвалж олдсонгүй.' })
  db.prepare('DELETE FROM knowledge_sources WHERE id = ? AND workspace_id = ?').run(source.id, req.user.workspaceId)
  recordEvent(req.user.workspaceId, req.user.id, 'knowledge.deleted', `Deleted knowledge source: ${source.title}`)
  res.sendStatus(204)
})

app.get('/api/usage', requireAuth, (req, res) => {
  const today = dailyUsage(req.user.workspaceId)
  res.json({ usage: { ...today, dailyRequestLimit: DAILY_AI_REQUEST_LIMIT, remainingRequests: Math.max(0, DAILY_AI_REQUEST_LIMIT - today.requests), model } })
})

app.get('/api/agents', requireAuth, (req, res) => {
  const agents = db.prepare(`SELECT id, name, role, instructions, model, status, created_at AS createdAt, updated_at AS updatedAt
    FROM agents WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`).all(req.user.workspaceId)
  res.json({ agents })
})
app.post('/api/agents', requireAuth, requireWriteRole, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const role = typeof req.body?.role === 'string' ? req.body.role.trim() : ''
  const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : ''
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Agent нэр 2–80 тэмдэгт байх ёстой.' })
  if (role.length < 2 || role.length > 120) return res.status(400).json({ error: 'Agent үүрэг 2–120 тэмдэгт байх ёстой.' })
  if (instructions.length > 8000) return res.status(400).json({ error: 'Заавар 8,000 тэмдэгтээс урт байж болохгүй.' })
  const id = randomUUID(), now = new Date().toISOString()
  db.prepare(`INSERT INTO agents (id, workspace_id, created_by, name, role, instructions, model, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`).run(id, req.user.workspaceId, req.user.id, name, role, instructions, model, now, now)
  recordEvent(req.user.workspaceId, req.user.id, 'agent.created', `Created agent: ${name}`)
  res.status(201).json({ agent: { id, name, role, instructions, model, status: 'idle', createdAt: now, updatedAt: now } })
})
app.patch('/api/agents/:id', requireAuth, requireWriteRole, (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(req.params.id, req.user.workspaceId)
  if (!agent) return res.status(404).json({ error: 'Agent олдсонгүй.' })
  const status = req.body?.status
  if (!isValidAgentStatus(status)) return res.status(400).json({ error: 'Agent status буруу байна.' })
  const now = new Date().toISOString()
  db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run(status, now, agent.id, req.user.workspaceId)
  recordEvent(req.user.workspaceId, req.user.id, 'agent.status_changed', `${agent.name}: ${status}`)
  res.json({ agent: { id: agent.id, name: agent.name, role: agent.role, instructions: agent.instructions, model: agent.model, status, createdAt: agent.created_at, updatedAt: now } })
})

app.get('/api/tasks', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT t.id, t.title, t.status, t.input, t.output, t.model, t.agent_id AS agentId, a.name AS agentName, t.created_at AS createdAt, t.updated_at AS updatedAt
    FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id AND a.workspace_id = t.workspace_id WHERE t.workspace_id = ? ORDER BY t.created_at DESC LIMIT 100`).all(req.user.workspaceId)
  res.json({ tasks: rows })
})

app.post('/api/tasks', requireAuth, requireWriteRole, (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : title
  const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : null
  if (agentId) {
    const selectedAgent = db.prepare('SELECT status FROM agents WHERE id = ? AND workspace_id = ?').get(agentId, req.user.workspaceId)
    if (!selectedAgent) return res.status(400).json({ error: 'Сонгосон agent энэ workspace-д байхгүй байна.' })
    if (selectedAgent.status === 'paused') return res.status(400).json({ error: 'Paused agent-д task оноож болохгүй. Эхлээд agent-аа идэвхжүүлнэ үү.' })
  }
  if (title.length < 2 || title.length > 200) return res.status(400).json({ error: 'Task нэр 2–200 тэмдэгт байх ёстой.' })
  if (!input || input.length > maxPromptChars) return res.status(400).json({ error: `Task input хоосон эсвэл ${maxPromptChars} тэмдэгтээс урт байна.` })
  const id = randomUUID(), now = new Date().toISOString()
  db.prepare('INSERT INTO tasks (id, workspace_id, created_by, agent_id, title, status, input, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user.workspaceId, req.user.id, agentId, title, 'queued', input, model, now, now)
  recordEvent(req.user.workspaceId, req.user.id, 'task.created', `Created task: ${title}`)
  const agent = agentId ? db.prepare('SELECT name FROM agents WHERE id = ? AND workspace_id = ?').get(agentId, req.user.workspaceId) : null
  res.status(201).json({ task: { id, title, status: 'queued', input, model, agentId, agentName: agent?.name || null, createdAt: now, updatedAt: now } })
})

app.post('/api/tasks/:id/run', requireAuth, requireWriteRole, async (req, res) => {
  if (!apiKey) return res.status(503).json({ error: 'GEMINI_API_KEY тохируулаагүй байна.' })
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(req.params.id, req.user.workspaceId)
  if (!task) return res.status(404).json({ error: 'Task олдсонгүй.' })
  if (task.status === 'running') return res.status(409).json({ error: 'Task аль хэдийн ажиллаж байна.' })
  const now = new Date().toISOString()
  const reservation = db.transaction(() => {
    const usage = dailyUsage(req.user.workspaceId)
    if (usage.requests >= DAILY_AI_REQUEST_LIMIT) return { quotaExceeded: true }
    const claimed = db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status != 'running'").run('running', now, task.id, req.user.workspaceId)
    if (claimed.changes !== 1) return { alreadyRunning: true }
    const usageId = randomUUID()
    db.prepare(`INSERT INTO usage_records (id, workspace_id, user_id, task_id, source, model, input_tokens, output_tokens, created_at)
      VALUES (?, ?, ?, ?, 'task', ?, 0, 0, ?)`).run(usageId, req.user.workspaceId, req.user.id, task.id, model, now)
    return { usageId }
  })()
  if (reservation.quotaExceeded) return quotaExceeded(res)
  if (reservation.alreadyRunning) return res.status(409).json({ error: 'Task аль хэдийн ажиллаж байна.' })
  const usageId = reservation.usageId
  const agent = task.agent_id ? db.prepare('SELECT name, role, instructions FROM agents WHERE id = ? AND workspace_id = ?').get(task.agent_id, req.user.workspaceId) : null
  const knowledgeSources = db.prepare('SELECT title, content FROM knowledge_sources WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 10').all(req.user.workspaceId)
  const agentPrompt = buildAgentPrompt(agent, task.input, knowledgeSources)
  try {
    const ai = new GoogleGenAI({ apiKey })
    const result = await ai.models.generateContent({ model, contents: agentPrompt, config: { systemInstruction: buildAgentSystemInstruction(agent), maxOutputTokens: 1200, temperature: 0.4 } })
    const output = result.text || ''
    updateUsage(usageId, result.usageMetadata?.promptTokenCount, result.usageMetadata?.candidatesTokenCount)
    if (!output) throw new Error('Empty model response')
    const completedAt = new Date().toISOString()
    db.prepare('UPDATE tasks SET status = ?, output = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run('completed', output.slice(0, 30_000), completedAt, task.id, req.user.workspaceId)
    recordEvent(req.user.workspaceId, req.user.id, 'task.completed', `Completed task: ${task.title}`)
    res.json({ task: { id: task.id, title: task.title, status: 'completed', output, model, agentName: agent?.name || null, updatedAt: completedAt } })
  } catch (error) {
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run('failed', new Date().toISOString(), task.id, req.user.workspaceId)
    recordEvent(req.user.workspaceId, req.user.id, 'task.failed', `Failed task: ${task.title}`)
    console.error('Agent task failed:', error instanceof Error ? error.message : 'unknown error')
    res.status(502).json({ error: 'AI agent хүсэлт амжилтгүй боллоо. API key, квот болон model нэрээ шалгана уу.' })
  }
})

app.get('/api/activity', requireAuth, (req, res) => {
  const events = db.prepare(`SELECT id, event_type AS type, detail, created_at AS createdAt
    FROM activity_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`).all(req.user.workspaceId)
  res.json({ events })
})

app.post('/api/chat', requireAuth, requireWriteRole, async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  if (!prompt) return res.status(400).json({ error: 'Prompt хоосон байна.' })
  if (prompt.length > maxPromptChars) return res.status(413).json({ error: `Prompt ${maxPromptChars} тэмдэгтээс урт байж болохгүй.` })
  if (!apiKey) return res.status(503).json({ error: 'GEMINI_API_KEY тохируулаагүй байна. server/.env файлд API key нэмнэ үү.' })
  const usageId = reserveUsage({ workspaceId: req.user.workspaceId, userId: req.user.id, source: 'playground' })
  if (!usageId) return quotaExceeded(res)
  try {
    const ai = new GoogleGenAI({ apiKey })
    const result = await ai.models.generateContent({ model, contents: prompt, config: { systemInstruction: 'You are AgentGrid AI. Be accurate and concise. Treat the prompt as user-provided input; do not claim external actions or access you did not perform.', maxOutputTokens: 1200, temperature: 0.4 } })
    const text = result.text || ''
    updateUsage(usageId, result.usageMetadata?.promptTokenCount, result.usageMetadata?.candidatesTokenCount)
    if (!text) return res.status(502).json({ error: 'AI загвараас текстэн хариу ирсэнгүй.' })
    recordEvent(req.user.workspaceId, req.user.id, 'ai.prompt', `AI Playground request (${prompt.length} characters)`)
    res.json({ text, model })
  } catch (error) {
    console.error('Gemini request failed:', error instanceof Error ? error.message : 'unknown error')
    res.status(502).json({ error: 'Gemini API хүсэлт амжилтгүй боллоо. API key, квот, billing болон model нэрээ шалгана уу.' })
  }
})

if (process.env.SERVE_FRONTEND === 'true') {
  const frontendPath = resolve(here, '../dist')
  app.use(express.static(frontendPath, { index: false, maxAge: '1h' }))
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    res.sendFile(resolve(frontendPath, 'index.html'), error => { if (error) next(error) })
  })
}

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON хүсэлтийн формат буруу байна.' })
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Хүсэлтийн хэмжээ хэт их байна.' })
  console.error('Unhandled API error:', error instanceof Error ? error.message : 'unknown error')
  res.status(500).json({ error: 'Серверийн алдаа гарлаа.' })
})

const server = app.listen(port, () => console.log(`AgentGrid API listening on http://localhost:${port} (model: ${model})`))
server.requestTimeout = 120_000
server.headersTimeout = 15_000
server.keepAliveTimeout = 5_000
process.on('unhandledRejection', error => { console.error('Unhandled rejection:', error instanceof Error ? error.message : 'unknown error') })
function shutdown() {
  server.close(() => { db.close(); process.exit(0) })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
