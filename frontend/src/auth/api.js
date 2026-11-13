async function authRequest(path, options) {
  let response
  try {
    response = await fetch(`/api/v1/auth/${path}`, {
      credentials: 'same-origin',
      ...options,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('Could not reach the server. Please try again.')
  }

  if (response.status === 204) return

  const body = await response.json().catch(() => null)
  if (!response.ok || !body) {
    const message = response.status >= 500
      ? 'The sign-in service is temporarily unavailable. Please try again.'
      : body?.error?.message ?? 'The server returned an unexpected response.'
    throw Object.assign(new Error(message), { status: response.status })
  }

  return body
}

export function getSession(signal) {
  return authRequest('me', { signal })
}

export function signIn(email, password) {
  return authRequest('login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
}

export function signOut(csrfToken) {
  return authRequest('logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
  })
}
