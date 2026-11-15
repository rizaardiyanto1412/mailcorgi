const KEY = 'mc-chunk-reload'

/**
 * After a deploy an open tab still asks for the old build's hashed chunks, which are gone. Reload
 * once to pick up the new build; a second failure within a minute is a real error and is shown.
 */
export function reloadAfterDeploy(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return false
  }
  window.location.reload()
  return true
}

/** A `lazy()` loader that reloads the page once when its chunk no longer exists. */
export function loadChunk<T>(load: () => Promise<T>): () => Promise<T> {
  return () => load().catch((err: unknown) => {
    if (reloadAfterDeploy()) return new Promise<T>(() => {})
    throw err
  })
}
