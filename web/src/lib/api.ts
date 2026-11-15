import { useMutation, useQuery, useQueryClient, type UseMutationOptions, type UseQueryOptions } from '@tanstack/react-query'
import type { ActionInput, ActionName, ActionOutput } from '../../../server/registry.ts'

export class ApiError extends Error {
  status: number
  code: string
  details: unknown
  constructor(message: string, status: number, code = 'error', details: unknown = null) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

let csrf = ''
/** The session's CSRF token, set once the bootstrap call answers. */
export const setCsrf = (token: string) => void (csrf = token)

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (csrf && method !== 'GET') headers['x-mc-csrf'] = csrf
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0, 'network')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/api/auth/')) window.dispatchEvent(new Event('mc:signed-out'))
    if (data?.code === 'limit_reached' && data?.details?.billingUrl === '/settings/billing') window.dispatchEvent(new Event('mc:plan-limit'))
    throw new ApiError(data?.error || `Request failed (${response.status}).`, response.status, data?.code, data?.details)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', `/api${path}`),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', `/api${path}`, body),
}

/** Every dashboard operation goes through one action. Types come from the server registry. */
export function callAction<K extends ActionName>(name: K, input: ActionInput<K>): Promise<ActionOutput<K>> {
  return request<ActionOutput<K>>('POST', `/api/actions/${name}`, input ?? {})
}

export const actionKey = <K extends ActionName>(name: K, input: ActionInput<K>) => ['action', name, input] as const

export function useActionQuery<K extends ActionName>(name: K, input: ActionInput<K>, options: Omit<UseQueryOptions<ActionOutput<K>, ApiError>, 'queryKey' | 'queryFn'> = {}) {
  return useQuery<ActionOutput<K>, ApiError>({ queryKey: actionKey(name, input), queryFn: () => callAction(name, input), ...options })
}

export function useAction<K extends ActionName>(name: K, options: Omit<UseMutationOptions<ActionOutput<K>, ApiError, ActionInput<K>>, 'mutationFn'> & { invalidate?: ActionName[] } = {}) {
  const client = useQueryClient()
  const { invalidate, ...rest } = options
  return useMutation<ActionOutput<K>, ApiError, ActionInput<K>>({
    mutationFn: (input) => callAction(name, input),
    ...rest,
    onSuccess: (data, variables, context, mutation) => {
      for (const key of invalidate ?? []) void client.invalidateQueries({ queryKey: ['action', key] })
      return rest.onSuccess?.(data, variables, context, mutation)
    },
  })
}
