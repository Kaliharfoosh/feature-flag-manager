// Calls to the Rollout Service (S2). Every write sends the CSRF token from GET /auth/me.
// Errors are thrown with .status and .code from the API's { error: { code, message } } body.
import { API_BASE, CREDENTIALS } from '../apiBase'

async function request(path, { method = 'GET', body, csrfToken, signal } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken

  let response
  try {
    response = await fetch(`${API_BASE}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: CREDENTIALS,
      signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('Could not reach the server. Please try again.')
  }

  if (response.status === 204) return null
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const message = response.status === 401
      ? 'Your session has expired. Refresh the page to sign in again.'
      : response.status >= 500
        ? 'The server had a problem. Please try again.'
        : data?.error?.message ?? 'Something went wrong. Please try again.'
    throw Object.assign(new Error(message), { status: response.status, code: data?.error?.code })
  }
  return data
}

const id = encodeURIComponent

// S1's list endpoint, used to find the flag's name and key when the page is opened directly.
export async function findFlag(flagId, signal) {
  for (const archived of ['false', 'true']) {
    const page = await request(`/flags?limit=100&archived=${archived}`, { signal })
    const flag = page.items.find((f) => f.id === flagId)
    if (flag) return flag
  }
  return null
}

export const getRollouts = (flagId, signal) => request(`/rollouts/${id(flagId)}`, { signal })

export const setRollout = (flagId, env, percentage, version, csrfToken) =>
  request(`/rollouts/${id(flagId)}/${env}`, { method: 'PUT', body: { percentage, version }, csrfToken })

export const listRules = (flagId, env, signal) => request(`/rollouts/${id(flagId)}/${env}/rules`, { signal })

export const addRule = (flagId, env, userId, kind, csrfToken) =>
  request(`/rollouts/${id(flagId)}/${env}/rules`, { method: 'POST', body: { userId, kind }, csrfToken })

export const deleteRule = (ruleId, csrfToken) =>
  request(`/rules/${id(ruleId)}`, { method: 'DELETE', csrfToken })

export const preview = (flagKey, env, userId, csrfToken) =>
  request('/preview', { method: 'POST', body: { flagKey, env, userId }, csrfToken })
