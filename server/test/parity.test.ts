import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountRegistry } from '../account/modules.ts'
import { controlRegistry } from '../control/modules.ts'

const all = [...accountRegistry.actions.values(), ...controlRegistry.actions.values()]

test('every action has a description and describes each of its inputs', () => {
  const missing: string[] = []
  for (const action of all) {
    if (!action.description) missing.push(`${action.name}: description`)
    const shape = (action.input as { shape?: Record<string, { description?: string }> }).shape
    if (!shape) {
      missing.push(`${action.name}: input must be a z.object`)
      continue
    }
    for (const [key, field] of Object.entries(shape)) if (!field.description) missing.push(`${action.name}: input.${key}`)
  }
  assert.deepEqual(missing, [])
})

test('action names are unique and dot-separated', () => {
  const names = all.map((a) => a.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of names) assert.match(name, /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/)
})

test('REST paths do not collide and MCP tool names are unique', () => {
  const seen = new Map<string, string>()
  for (const action of all) {
    if (!action.rest) continue
    const key = `${action.rest.method} ${action.rest.path.replace(/:[^/]+/g, ':p')}`
    assert.equal(seen.get(key), undefined, `${action.name} collides with ${seen.get(key)} on ${key}`)
    seen.set(key, action.name)
  }
  const tools = all.filter((a) => a.mcp).map((a) => a.name.replace(/\./g, '_'))
  assert.equal(new Set(tools).size, tools.length)
})

test('newsletter-scoped actions name the resource in their input', () => {
  for (const action of all) {
    if (!action.resource) continue
    const shape = (action.input as unknown as { shape: Record<string, unknown> }).shape
    assert.ok(action.resource.param in shape, `${action.name} must accept ${action.resource.param}`)
  }
})
