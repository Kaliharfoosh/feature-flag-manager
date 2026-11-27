import { useEffect, useRef, useState } from 'react'
import * as api from './api'
import './KeysPage.css'

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const when = (value) => value ? date.format(new Date(value)) : 'Never used'
const environmentNames = { dev: 'Development', staging: 'Staging', prod: 'Production' }

function KeyMark() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="m11.5 11.5 9 9m-3-3 2-2m-5-1 2-2" /></svg>
}

function RevokeDialog({ item, pending, error, onCancel, onConfirm }) {
  const dialog = useRef(null)
  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])
  return (
    <dialog className="key-dialog" ref={dialog} aria-labelledby="revoke-title" aria-describedby="revoke-description"
      onCancel={(event) => { event.preventDefault(); if (!pending) onCancel() }}>
      <div className="key-dialog-icon"><KeyMark /></div>
      <h2 id="revoke-title">Revoke this API key?</h2>
      <p id="revoke-description">Applications using <strong>{item.name}</strong> in {environmentNames[item.env]} will lose access immediately. This cannot be undone.</p>
      <code>{item.prefix}…</code>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="key-actions">
        <button type="button" className="secondary" disabled={pending} onClick={onCancel} autoFocus>Keep key</button>
        <button type="button" className="key-danger" disabled={pending} onClick={onConfirm}>{pending ? 'Revoking…' : 'Revoke key'}</button>
      </div>
    </dialog>
  )
}

function KeysWorkspace({ session }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [name, setName] = useState('')
  const [env, setEnv] = useState('staging')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [created, setCreated] = useState(null)
  const [copyMessage, setCopyMessage] = useState('')
  const [query, setQuery] = useState('')
  const [environment, setEnvironment] = useState('all')
  const [status, setStatus] = useState('all')
  const [revoking, setRevoking] = useState(null)
  const [pendingRevoke, setPendingRevoke] = useState(false)
  const [revokeError, setRevokeError] = useState('')
  const [notice, setNotice] = useState('')
  const creatingRef = useRef(false)
  const revokingRef = useRef(false)
  const resultHeading = useRef(null)
  const nameInput = useRef(null)
  const refreshButton = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    api.listKeys(controller.signal).then((result) => {
      if (!controller.signal.aborted) { setItems(result.items); setLoading(false) }
    }).catch((error) => {
      if (!controller.signal.aborted) { setLoadError(error.message); setLoading(false) }
    })
    return () => controller.abort()
  }, [refresh])

  useEffect(() => { if (created) resultHeading.current?.focus() }, [created])

  function reload() {
    setLoading(true)
    setLoadError('')
    setRefresh((current) => current + 1)
  }

  async function create(event) {
    event.preventDefault()
    if (creatingRef.current || created) return
    creatingRef.current = true
    setCreating(true)
    setCreateError('')
    setNotice('')
    try {
      const result = await api.createKey({ name: name.trim(), env }, session.csrfToken)
      const { key, ...item } = result
      setCreated({ ...item, key })
      setCopyMessage('')
      setName('')
      setItems((current) => [item, ...current])
      reload()
    } catch (error) {
      setCreateError(`${error.message} If the request was interrupted, refresh the list before trying again.`)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.key)
      setCopyMessage('Copied. Store this key somewhere private.')
    } catch {
      setCopyMessage('Copy is unavailable. Select the key and copy it manually.')
    }
  }

  async function revoke() {
    if (revokingRef.current) return
    revokingRef.current = true
    setPendingRevoke(true)
    setRevokeError('')
    try {
      await api.revokeKey(revoking.id, session.csrfToken)
      setItems((current) => current.map((item) => item.id === revoking.id ? { ...item, revokedAt: new Date().toISOString() } : item))
      if (created?.id === revoking.id) setCreated(null)
      setNotice(`“${revoking.name}” was revoked. Applications can no longer use it.`)
      setRevoking(null)
      reload()
      refreshButton.current?.focus()
    } catch (error) {
      setRevokeError(error.message)
    } finally {
      revokingRef.current = false
      setPendingRevoke(false)
    }
  }

  const active = items.filter((item) => !item.revokedAt).length
  const filtered = items.filter((item) => {
    const match = `${item.name} ${item.prefix}`.toLowerCase().includes(query.trim().toLowerCase())
    return match && (environment === 'all' || item.env === environment)
      && (status === 'all' || (status === 'revoked') === Boolean(item.revokedAt))
  })

  return (
    <div className="keys-view">
      <section className="keys-intro" aria-labelledby="keys-title">
        <div><p className="key-eyebrow">Application access</p><h1 id="keys-title">API keys</h1><p>Connect your applications. Keep each environment in its own lane.</p></div>
        <div className="keys-intro-mark"><KeyMark /><span>Admin access</span></div>
      </section>

      <div className="key-stats" aria-label="Key summary">
        <div><span>Active keys</span><strong>{loading ? '—' : active}<i className="key-signal" /></strong></div>
        <div><span>Revoked keys</span><strong>{loading ? '—' : items.length - active}</strong></div>
        <div><span>Environment scope</span><strong>One per key</strong></div>
      </div>

      {notice && <p className="key-notice" role="status">{notice}</p>}
      {created && (
        <section className="key-secret" aria-labelledby="new-key-title">
          <p className="key-eyebrow">Created successfully · shown once</p>
          <h2 id="new-key-title" tabIndex={-1} ref={resultHeading}>Save your new key</h2>
          <p>This is the only time you can view the full key for <strong>{created.name}</strong>. Copy it before leaving this page.</p>
          <label htmlFor="new-api-key">New API key</label>
          <div className="key-secret-row"><input id="new-api-key" value={created.key} readOnly autoComplete="off" spellCheck={false} onFocus={(event) => event.target.select()} /><button type="button" className="primary" onClick={copy}>Copy key</button></div>
          <p role="status" className="key-copy-status">{copyMessage || 'Keep this key on your application’s server. Never put it in browser code.'}</p>
          <button type="button" className="secondary" onClick={() => { setCreated(null); setCopyMessage(''); nameInput.current?.focus() }}>I saved it. Hide key</button>
        </section>
      )}

      <section className="keys-create" aria-labelledby="create-key-title">
        <div><h2 id="create-key-title">Create a key</h2><p>Give it a clear name and choose the environment it can read.</p></div>
        <form onSubmit={create} className="keys-create-form">
          <div><label htmlFor="key-name">Key name</label><input id="key-name" ref={nameInput} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required placeholder="e.g. Storefront staging" disabled={creating || Boolean(created)} /></div>
          <div><label htmlFor="key-env">Environment</label><select id="key-env" value={env} onChange={(event) => setEnv(event.target.value)} disabled={creating || Boolean(created)}>{Object.entries(environmentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <button className="primary" type="submit" disabled={creating || Boolean(created) || !name.trim()}>{creating ? 'Creating…' : '＋ Create key'}</button>
        </form>
        {created && <p className="key-form-hint">Save and hide your new key before creating another.</p>}
        {createError && <p className="error" role="alert">{createError}</p>}
      </section>

      <section className="keys-list" aria-labelledby="key-list-title" aria-busy={loading}>
        <div className="keys-list-title"><div><h2 id="key-list-title">Your team’s keys</h2><p>Safe prefixes only. Revoked keys stay here for your records.</p></div><button type="button" className="secondary" ref={refreshButton} onClick={() => reload()} disabled={loading}>↻ Refresh</button></div>
        <div className="key-filters">
          <div className="key-search"><label className="sr-only" htmlFor="key-search">Search keys</label><input id="key-search" type="search" placeholder="Search by name or prefix…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <select aria-label="Filter by environment" value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="all">All environments</option>{Object.entries(environmentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="revoked">Revoked</option></select>
        </div>
        {loading ? <p className="keys-empty" role="status">Loading your keys…</p>
          : loadError ? <div className="keys-empty"><p className="error" role="alert">{loadError}</p><button className="secondary" type="button" onClick={() => reload()}>Try again</button></div>
            : !filtered.length ? <div className="keys-empty"><KeyMark /><h3>{items.length ? 'No matching keys' : 'Your next connection starts here'}</h3><p>{items.length ? 'Try another search or filter.' : 'Create your first key to let an application read feature flags.'}</p></div>
              : <div className="keys-table-wrap"><table className="keys-table"><thead><tr><th scope="col">Name / prefix</th><th scope="col">Environment</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>
                {filtered.map((item) => <tr key={item.id} className={item.revokedAt ? 'key-row-revoked' : ''}>
                  <td><strong>{item.name}</strong><code>{item.prefix}…</code></td><td><span className={`key-env key-env-${item.env}`}>{environmentNames[item.env]}</span></td>
                  <td><span className={`key-status ${item.revokedAt ? 'is-revoked' : 'is-active'}`}>{item.revokedAt ? 'Revoked' : 'Active'}</span>{item.revokedAt && <time className="key-revoked-time" dateTime={item.revokedAt}>{when(item.revokedAt)}</time>}</td>
                  <td><time dateTime={item.createdAt}>{when(item.createdAt)}</time></td><td>{item.lastUsedAt ? <time dateTime={item.lastUsedAt}>{when(item.lastUsedAt)}</time> : 'Never used'}</td>
                  <td>{!item.revokedAt && <button type="button" className="key-revoke" aria-label={`Revoke ${item.name}`} onClick={() => { setRevokeError(''); setRevoking(item) }}>Revoke</button>}</td>
                </tr>)}
              </tbody></table></div>}
        {!loading && !loadError && <p className="key-list-foot" role="status">{filtered.length} of {items.length} keys · Only your team’s keys are shown.</p>}
      </section>
      {revoking && <RevokeDialog item={revoking} pending={pendingRevoke} error={revokeError} onCancel={() => setRevoking(null)} onConfirm={revoke} />}
    </div>
  )
}

export default function KeysPage({ session }) {
  if (session.user.role !== 'admin') return <section className="panel"><h1>Admin access required</h1><p>Only team administrators can manage API keys.</p></section>
  return <KeysWorkspace session={session} />
}

