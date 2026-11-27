/** `base` with every key of `patch` that is not undefined laid over it: the way an update keeps a stored value the caller left out. */
export function withPatch<T extends object>(base: T, patch: Partial<T> | undefined): T {
  const next = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) if (value !== undefined) (next as Record<string, unknown>)[key] = value
  return next
}
