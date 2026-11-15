// Expectations are reviewed independently of action metadata.
// owner/installAdmin deny teammates; user allows outsiders; teammate permits leaving.
export type PermissionEntries = Record<string, {
  role: 'member' | 'admin' | 'owner' | 'user' | 'installAdmin' | 'teammate'
  input?: Record<string, unknown>
}>
