import { useEffect, useRef, useState } from 'react'
import { API_BASE, CREDENTIALS } from '../apiBase'

export default function CreateFlagDialog({ csrfToken, onCreated, onClose }) {
  const dialog = useRef(null)
  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [fields, setFields] = useState({ key: '', name: '', description: '' })

  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal()
  }, [])

  function updateField(event) {
    setFields((current) => ({ ...current, [event.target.name]: event.target.value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    setError('')
    try {
      const response = await fetch(`${API_BASE}/api/v1/flags`, {
        method: 'POST',
        credentials: CREDENTIALS,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(fields),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body) {
        const message = response.status === 401
          ? 'Your session has expired. Refresh the page to sign in again.'
          : response.status >= 500
            ? 'Couldn’t create the flag. Please try again.'
            : body?.error?.message ?? 'The server returned an unexpected response.'
        throw new Error(message)
      }
      onCreated(body)
    } catch (error) {
      setError(error instanceof TypeError ? 'Could not reach the server. Please try again.' : error.message)
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="rollout-dialog create-flag-dialog"
      aria-labelledby="create-flag-title"
      onClose={onClose}
      onCancel={(event) => { if (submitting.current) event.preventDefault() }}
    >
      <header className="rollout-heading">
        <h2 id="create-flag-title">Create a feature flag</h2>
        <button type="button" className="flag-button" disabled={pending} onClick={() => dialog.current.close()}>Cancel</button>
      </header>
      <p className="rollout-description">New flags start Off with a 0% rollout in every environment.</p>
      <form onSubmit={handleSubmit} aria-busy={pending}>
        <label htmlFor="flag-key">Flag key</label>
        <input
          id="flag-key" name="key" autoFocus required minLength={3} maxLength={50}
          pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]"
          aria-describedby="flag-key-hint" autoComplete="off" spellCheck={false}
          value={fields.key} onChange={updateField} readOnly={pending}
        />
        <p id="flag-key-hint" className="field-hint">Use 3–50 lowercase letters, digits or hyphens. Start and end with a letter or digit.</p>
        <label htmlFor="flag-name">Name</label>
        <input id="flag-name" name="name" required maxLength={100} value={fields.name} onChange={updateField} readOnly={pending} />
        <label htmlFor="flag-description">Description <span className="field-optional">(optional)</span></label>
        <textarea id="flag-description" name="description" rows={3} maxLength={500} value={fields.description} onChange={updateField} readOnly={pending} />
        {error && <p className="create-flag-error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={pending}>{pending ? 'Creating…' : 'Create flag'}</button>
      </form>
    </dialog>
  )
}
