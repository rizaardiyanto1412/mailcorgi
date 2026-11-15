// Expectations are reviewed independently of action metadata.
// owner/installAdmin deny teammates; user allows outsiders; teammate permits leaving.
export type PermissionEntries = Record<string, {
  role: 'member' | 'admin' | 'owner' | 'user' | 'installAdmin' | 'teammate'
  // An authorized call may reach a domain precondition before it can succeed.
  error?: string
  input?: Record<string, unknown>
}>
