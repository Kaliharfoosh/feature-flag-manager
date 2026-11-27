import { API_BASE, CREDENTIALS } from '../apiBase'

async function request(path = '', options = {}) {
  let response
  try {
    response = await fetch(`${API_BASE}/api/v1/keys${path}`, {
      credentials: CREDENTIALS, cache: 'no-store', ...options,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('Could not reach the server. Please try again.')
  }
  if (response.status === 204) return
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) {
    const message = response.status === 401
      ? 'Your session has expired. Refresh the page to sign in again.'
      : response.status >= 500 ? 'Could not load or save the API key. Please try again.'
        : body?.error?.message ?? 'The server returned an unexpected response.'
    throw Object.assign(new Error(message), { status: response.status })
  }
  return body
}

export const listKeys = (signal) => request('', { signal })
export const createKey = (input, csrfToken) => request('', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  body: JSON.stringify(input),
})
export const revokeKey = (id, csrfToken) => request(`/${encodeURIComponent(id)}`, {
  method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken },
})
