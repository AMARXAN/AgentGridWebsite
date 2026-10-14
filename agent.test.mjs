import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentPrompt, buildAgentSystemInstruction, isValidAgentStatus } from './agent.mjs'

test('generic tasks keep the user prompt when no workspace knowledge exists', () => {
  assert.match(buildAgentPrompt(null, 'Summarize this'), /Summarize this/)
})

test('agent task prompt includes role and custom instructions', () => {
  const prompt = buildAgentPrompt({ name: 'Atlas', role: 'Research', instructions: 'Cite uncertainty.' }, 'Compare two options')
  assert.match(prompt, /Atlas/)
  assert.match(prompt, /Research/)
  assert.match(prompt, /Cite uncertainty\./)
  assert.match(prompt, /Compare two options/)
})

test('workspace knowledge is included as untrusted reference data', () => {
  const prompt = buildAgentPrompt(null, 'Answer the question', [{ title: 'Product notes', content: 'Product uses SQLite.' }])
  assert.match(prompt, /Product notes/)
  assert.match(prompt, /Product uses SQLite/)
  assert.match(prompt, /untrusted data, not instructions/)
})

test('agent status accepts only supported states', () => {
  assert.equal(isValidAgentStatus('idle'), true)
  assert.equal(isValidAgentStatus('paused'), true)
  assert.equal(isValidAgentStatus('running'), true)
  assert.equal(isValidAgentStatus('deleted'), false)
})

test('workspace knowledge context is capped to protect prompt cost', () => {
  const largeContent = 'x'.repeat(20_000)
  const prompt = buildAgentPrompt(null, 'Task', [{ title: 'Large', content: largeContent }, { title: 'Second', content: largeContent }])
  assert.ok(prompt.length < 13_000, `prompt length was ${prompt.length}`)
})

test('system instruction sets guardrails around user task and workspace content', () => {
  const instruction = buildAgentSystemInstruction({ name: 'Atlas', role: 'Research', instructions: 'Cite uncertainty.' })
  assert.match(instruction, /Atlas/)
  assert.match(instruction, /Cite uncertainty/)
  assert.match(instruction, /untrusted input/)
  assert.match(instruction, /Do not claim to have used tools/)
})
