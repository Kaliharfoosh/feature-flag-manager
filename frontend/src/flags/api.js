import { API_BASE, CREDENTIALS } from '../apiBase'

async function request(path, options = {}) {
  let response
  try {
    response = await fetch(`${API_BASE}/api/v1/flags${path}`, { credentials: CREDENTIALS, ...options })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('Could not reach the server. Please try again.')
  }
  if (response.status === 204) return
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) {
    const message = response.status === 401
      ? 'Your session has expired. Refresh the page to sign in again.'
      : response.status >= 500
        ? 'Couldn’t load or save the flag. Please try again.'
        : body?.error?.message ?? 'The server returned an unexpected response.'
    throw Object.assign(new Error(message), { status: response.status, code: body?.error?.code })
  }
  return body
}

export function fetchFlags(filters, signal) {
  const params = new URLSearchParams({ archived: String(filters.archived) })
  if (filters.q) params.set('q', filters.q)
  const cursor = filters.cursors.at(-1)
  if (cursor) params.set('cursor', cursor)
  return request(`?${params}`, { signal })
}

export function getFlag(flagId) {
  return request(`/${encodeURIComponent(flagId)}`)
}

export function toggleEnvironment(flagId, env, setting, csrfToken) {
  return request(`/${encodeURIComponent(flagId)}/environments/${env}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ enabled: !setting.enabled, version: setting.version }),
  })
}

export function updateFlag(flagId, input, csrfToken) {
  return request(`/${encodeURIComponent(flagId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(input),
  })
}

export function deleteFlag(flagId, csrfToken) {
  return request(`/${encodeURIComponent(flagId)}`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfToken },
  })
}