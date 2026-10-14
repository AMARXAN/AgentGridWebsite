import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
let runtimeDependenciesAvailable = true
let Database = null
try {
  require.resolve('express')
  require.resolve('better-sqlite3')
  require.resolve('@google/genai')
  Database = require('better-sqlite3')
} catch { runtimeDependenciesAvailable = false }
if (process.env.REQUIRE_INTEGRATION_TESTS === 'true' && !runtimeDependenciesAvailable) {
  throw new Error('REQUIRE_INTEGRATION_TESTS=true but runtime dependencies are missing. Install npm dependencies before running CI tests.')
}
const testSecret = 'integration-test-secret-at-least-32-characters-long'

async function getFreePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
  return port
}

async function waitForHealth(baseUrl, child) {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error(`API server exited early with code ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* server is still starting */ }
    await delay(100)
  }
  throw new Error('API server did not become healthy in time')
}

async function request(baseUrl, path, { token, ...options } = {}) {
  const headers = new Headers(options.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers })
  const body = response.status === 204 ? null : await response.json()
  return { response, body }
}

test('HTTP integration: registration, auth, workspace isolation, agent/task/knowledge and quota endpoints', { skip: !runtimeDependenciesAvailable && 'Install npm dependencies to run the HTTP integration test' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agentgrid-integration-'))
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      AUTH_SECRET: testSecret,
      DATABASE_PATH: join(dir, 'integration.sqlite'),
      DAILY_AI_REQUEST_LIMIT: '3',
      GEMINI_API_KEY: '',
      SERVE_FRONTEND: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  t.after(async () => {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), delay(3000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  })

  await waitForHealth(baseUrl, child).catch(error => { throw new Error(`${error.message}\n${stderr}`) })

  const first = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: 'one@example.com', password: 'a-strong-password-123', workspaceName: 'Workspace One' }),
  })
  assert.equal(first.response.status, 201)
  assert.equal(first.response.headers.get('cache-control'), 'no-store', 'auth responses must not be cached')
  assert.equal(first.response.headers.get('pragma'), 'no-cache')
  assert.ok(first.body.token)
  const tokenOne = first.body.token

  const duplicate = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: 'ONE@example.com', password: 'a-strong-password-123', workspaceName: 'Duplicate Workspace' }),
  })
  assert.equal(duplicate.response.status, 409, 'email uniqueness must be case-insensitive')

  const login = await request(baseUrl, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'ONE@example.com', password: 'a-strong-password-123' }),
  })
  assert.equal(login.response.status, 200)
  assert.ok(login.body.token)
  const wrongLogin = await request(baseUrl, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'one@example.com', password: 'wrong-password-123' }),
  })
  assert.equal(wrongLogin.response.status, 401)

  const second = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: 'two@example.com', password: 'another-strong-password-456', workspaceName: 'Workspace Two' }),
  })
  assert.equal(second.response.status, 201)
  const tokenTwo = second.body.token

  const me = await request(baseUrl, '/api/auth/me', { token: tokenOne })
  assert.equal(me.response.status, 200)
  assert.equal(me.body.user.workspaceName, 'Workspace One')
  assert.equal((await request(baseUrl, '/api/auth/me')).response.status, 401)

  const agent = await request(baseUrl, '/api/agents', {
    method: 'POST', token: tokenOne,
    body: JSON.stringify({ name: 'Researcher', role: 'Research analyst', instructions: 'Be concise.' }),
  })
  assert.equal(agent.response.status, 201)
  assert.equal(agent.body.agent.status, 'idle')
  const hiddenAgents = await request(baseUrl, '/api/agents', { token: tokenTwo })
  assert.equal(hiddenAgents.response.status, 200)
  assert.equal(hiddenAgents.body.agents.length, 0)
  const crossWorkspaceAgentMutation = await request(baseUrl, `/api/agents/${agent.body.agent.id}`, {
    method: 'PATCH', token: tokenTwo, body: JSON.stringify({ status: 'paused' }),
  })
  assert.equal(crossWorkspaceAgentMutation.response.status, 404)

  const knowledge = await request(baseUrl, '/api/knowledge', {
    method: 'POST', token: tokenOne,
    body: JSON.stringify({ title: 'Internal notes', content: 'Workspace one only.' }),
  })
  assert.equal(knowledge.response.status, 201)
  const otherKnowledge = await request(baseUrl, '/api/knowledge', { token: tokenTwo })
  assert.equal(otherKnowledge.response.status, 200)
  assert.equal(otherKnowledge.body.sources.length, 0)
  const crossWorkspaceKnowledgeDelete = await request(baseUrl, `/api/knowledge/${knowledge.body.source.id}`, { method: 'DELETE', token: tokenTwo })
  assert.equal(crossWorkspaceKnowledgeDelete.response.status, 404)

  const task = await request(baseUrl, '/api/tasks', {
    method: 'POST', token: tokenOne,
    body: JSON.stringify({ title: 'Summarize notes', input: 'Summarize internal notes', agentId: agent.body.agent.id }),
  })
  assert.equal(task.response.status, 201)
  const invalidAgentTask = await request(baseUrl, '/api/tasks', {
    method: 'POST', token: tokenOne, body: JSON.stringify({ title: 'Bad assignment', input: 'Do not run', agentId: 'not-in-this-workspace' }),
  })
  assert.equal(invalidAgentTask.response.status, 400)
  const otherTasks = await request(baseUrl, '/api/tasks', { token: tokenTwo })
  assert.equal(otherTasks.body.tasks.length, 0)

  const usage = await request(baseUrl, '/api/usage', { token: tokenOne })
  assert.equal(usage.response.status, 200)
  assert.equal(usage.body.usage.dailyRequestLimit, 3)

  const noKeyRun = await request(baseUrl, `/api/tasks/${task.body.task.id}/run`, { method: 'POST', token: tokenOne })
  assert.equal(noKeyRun.response.status, 503)

  const invalidPassword = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: 'weak@example.com', password: 'short', workspaceName: 'Weak Workspace' }),
  })
  assert.equal(invalidPassword.response.status, 400)

  const malformedJson = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid json',
  })
  assert.equal(malformedJson.status, 400)
  const malformedBody = await malformedJson.json()
  assert.match(malformedBody.error, /JSON/)

  // Change the second account's workspace role to viewer to verify that
  // read access remains available while all write routes are rejected.
  const db = new Database(join(dir, 'integration.sqlite'))
  try {
    db.prepare('UPDATE memberships SET role = ? WHERE user_id = ? AND workspace_id = ?')
      .run('viewer', second.body.user.id, second.body.user.workspaceId)
  } finally {
    db.close()
  }
  const viewerRead = await request(baseUrl, '/api/agents', { token: tokenTwo })
  assert.equal(viewerRead.response.status, 200)
  const viewerWrite = await request(baseUrl, '/api/agents', {
    method: 'POST', token: tokenTwo,
    body: JSON.stringify({ name: 'Blocked agent', role: 'Read-only test' }),
  })
  assert.equal(viewerWrite.response.status, 403)
  const viewerKnowledgeWrite = await request(baseUrl, '/api/knowledge', {
    method: 'POST', token: tokenTwo,
    body: JSON.stringify({ title: 'Blocked source', content: 'Viewer cannot write.' }),
  })
  assert.equal(viewerKnowledgeWrite.response.status, 403)
})
