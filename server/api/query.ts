import type { z } from 'zod'

type Schema = z.core.JSONSchema.JSONSchema | boolean

export function queryUsesJson(schema: Schema | undefined): boolean {
  if (!schema || typeof schema === 'boolean') return false
  if (schema.anyOf) return schema.anyOf.every((item) => queryUsesJson(item))
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  return types.every((type) => type !== undefined && type !== 'string')
}
