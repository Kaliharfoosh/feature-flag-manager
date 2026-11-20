// Calls to the Audit and Monitoring service (S3). Every write sends the CSRF token from GET /auth/me.
// Errors are thrown with .status and .code from the API's { error: { code, message } } body.
import { API_BASE, CREDENTIALS } from '../apiBase'

function errorFor(response, data) {
  const message = response.status === 401
    ? 'Your session has expired. Refresh the page to sign in again.'
    : response.status === 403
      ? 'Only Admins can see this.'
      : response.status >= 500 && response.status !== 502
        ? 'The server had a problem. Please try again.'
        : data?.error?.message ?? 'Something went wrong. Please try again.'
  return Object.assign(new Error(message), { status: response.status, code: data?.error?.code })
}

async function send(path, { method = 'GET', body, csrfToken, signal } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken
  try {
    return await fetch(`${API_BASE}/api/v1${path}`, {
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
}

async function request(path, options) {
  const response = await send(path, options)
  const data = await response.json().catch(() => null)
  if (!response.ok) throw errorFor(response, data)
  return data
}

// Only the filters that are filled in go into the query string.
function query(params) {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(name, value)
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const listAudit = (filters, cursor, signal) =>
  request(`/audit${query({ ...filters, cursor, limit: 25 })}`, { signal })

export const getSummary = (days, signal) => request(`/audit/summary${query({ days })}`, { signal })

// The CSV comes back as a file. It is fetched (so the cookie is sent the same way as every other
// call) and handed to the browser as a download.
export async function downloadAuditCsv(filters) {
  const response = await send(`/audit/export.csv${query(filters)}`)
  if (!response.ok) throw errorFor(response, await response.json().catch(() => null))
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'audit.csv'
  const url = URL.createObjectURL(await response.blob())
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export const getMonitoring = (hours, signal) => request(`/monitoring${query({ hours })}`, { signal })

export const listAlerts = (signal) => request('/alerts', { signal })

export const retryAlert = (auditEventId, csrfToken) =>
  request(`/alerts/${encodeURIComponent(auditEventId)}/github-issue`, { method: 'POST', csrfToken })

export const getAlertRules = (signal) => request('/alert-rules', { signal })

export const saveAlertRules = (rules, csrfToken) =>
  request('/alert-rules', { method: 'PUT', body: { rules }, csrfToken })
