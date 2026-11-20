import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import './FlagsPage.css'
import CreateFlagDialog from './CreateFlagDialog.jsx'
import { fetchFlags, getFlag, toggleEnvironment, updateFlag, deleteFlag } from './api'

const environments = [
  ['dev', 'Development'],
  ['staging', 'Staging'],
  ['prod', 'Production'],
]
const percent = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })

function EnvironmentStatus({ enabled }) {
  return (
    <span className={enabled ? 'flag-state flag-state-on' : 'flag-state'}>
      {enabled ? 'On' : 'Off'}
    </span>
  )
}

function RolloutChart({ flag, role, csrfToken, onUpdated, onDeleted, onClose }) {
  const dialog = useRef(null)
  const saving = useRef(false)
  const [pending, setPending] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteKey, setDeleteKey] = useState('')


  function beginEdit() {
    setEditor({ name: flag.name, description: flag.description, version: flag.version })
    setError('')
    setNotice('')
  }

  async function saveDetails(input, message) {
    if (saving.current) return
    saving.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      onUpdated(await updateFlag(flag.id, input, csrfToken))
      setEditor(null)
      setNotice(message)
    } catch (error) {
      setError(error.message)
      if (error.code === 'STALE_VERSION') setNeedsReload(true)
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  async function confirmDeletion() {
    if (saving.current || deleteKey !== flag.key) return
    saving.current = true
    setPending(true)
    setError('')
    try {
      await deleteFlag(flag.id, csrfToken)
      dialog.current.close()
      onDeleted(flag)
    } catch (error) {
      setError(error.message)
      if (error.status === 409 || error.status === 404) setNeedsReload(true)
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  async function changeEnvironment(env, label) {
    if (saving.current) return
    saving.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const changed = await toggleEnvironment(flag.id, env, flag.environments[env], csrfToken)
      setNotice(`${label} is now ${changed.enabled ? 'On' : 'Off'}.`)
      // The toggle is already saved. Keep its confirmed value if the refresh fails.
      onUpdated({
        ...flag,
        environments: { ...flag.environments, [env]: { ...flag.environments[env], enabled: changed.enabled, version: changed.version } },
      })
      try {
        onUpdated(await getFlag(flag.id))
      } catch {
        setNeedsReload(true)
        setError('The change was saved. Reload details to get the latest data.')
      }
    } catch (error) {
      setError(error.message)
      if (error.code === 'STALE_VERSION') setNeedsReload(true)
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  async function reloadDetails() {
    if (saving.current) return
    saving.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      onUpdated(await getFlag(flag.id))
      setNeedsReload(false)
      setEditor(null)
      setDeleting(false)
    } catch (error) {
      setError(error.message)
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal()
  }, [])

  return (
    <dialog
      ref={dialog} className="rollout-dialog" aria-labelledby="rollout-title" onClose={onClose}
      onCancel={(event) => { if (saving.current) event.preventDefault() }}
    >
      <header className="rollout-heading">
        <div>
          <code>{flag.key}</code>
          <h2 id="rollout-title">{flag.name}</h2>
        </div>
        <button type="button" className="flag-button" disabled={pending} onClick={() => dialog.current.close()}>Close</button>
      </header>

      {flag.archived && <p className="archived-notice">Archived flags evaluate Off in every environment.</p>}
      {editor ? (
        <form className="flag-edit-form" onSubmit={(event) => {
          event.preventDefault()
          saveDetails(editor, 'Flag details saved.')
        }} aria-busy={pending}>
          <label htmlFor="edit-flag-name">Name</label>
          <input
            id="edit-flag-name" required maxLength={100} value={editor.name} readOnly={pending}
            onChange={(event) => setEditor({ ...editor, name: event.target.value })}
          />
          <label htmlFor="edit-flag-description">Description</label>
          <textarea
            id="edit-flag-description" rows={3} maxLength={500} value={editor.description} readOnly={pending}
            onChange={(event) => setEditor({ ...editor, description: event.target.value })}
          />
          <div className="flag-action-row">
            <button type="submit" className="flag-button flag-button-primary" disabled={pending || needsReload}>Save details</button>
            <button type="button" className="flag-button" disabled={pending} onClick={() => setEditor(null)}>Cancel editing</button>
          </div>
        </form>
      ) : (
        <>
          {flag.description && <p className="rollout-description">{flag.description}</p>}
          <div className="flag-action-row">
            <button type="button" className="flag-button" disabled={pending || needsReload || deleting} onClick={beginEdit}>Edit details</button>
            {role === 'admin' && (
              <button
                type="button" className="flag-button" disabled={pending || needsReload || deleting}
                onClick={() => saveDetails({ archived: !flag.archived, version: flag.version }, flag.archived ? 'Flag restored.' : 'Flag archived.')}
              >
                {flag.archived ? 'Restore flag' : 'Archive flag'}
              </button>
            )}
            {role === 'admin' && flag.archived && (
              <button type="button" className="flag-button flag-button-danger" disabled={pending || needsReload} onClick={() => { setDeleting(true); setDeleteKey(''); setError('') }}>Delete flag</button>
            )}
          </div>
        </>
      )}
      {deleting && (
        <section className="flag-delete-confirmation" aria-labelledby="delete-flag-title">
          <h3 id="delete-flag-title">Permanently delete this flag?</h3>
          <p>The flag, environment settings and user rules will be removed. Audit history is kept.</p>
          <label htmlFor="delete-flag-key">Type <code>{flag.key}</code> to confirm</label>
          <input id="delete-flag-key" autoComplete="off" value={deleteKey} readOnly={pending} onChange={(event) => setDeleteKey(event.target.value)} />
          <div className="flag-action-row">
            <button type="button" className="flag-button flag-button-danger" disabled={pending || deleteKey !== flag.key} onClick={confirmDeletion}>Delete permanently</button>
            <button type="button" className="flag-button" disabled={pending} onClick={() => setDeleting(false)}>Keep flag</button>
          </div>
        </section>
      )}
      <figure className="rollout-chart">
        <figcaption>Configured rollout by environment</figcaption>
        {environments.map(([key, label]) => {
          const setting = flag.environments[key]
          return (
            <div className="rollout-chart-row" key={key}>
              <div className="rollout-chart-label">
                <strong>{label}</strong>
                <button
                  type="button" role="switch" aria-label={label} aria-checked={setting.enabled}
                  className="environment-switch"
                  disabled={pending || needsReload || editor !== null || deleting || flag.archived || (key === 'prod' && role !== 'admin')}
                  onClick={() => changeEnvironment(key, label)}
                >
                  <span className="switch-track" aria-hidden="true" />
                  <span aria-hidden="true">{setting.enabled ? 'On' : 'Off'}</span>
                </button>
                <span className="rollout-chart-value">{percent.format(setting.percentage)}%</span>
              </div>
              <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                <rect className="rollout-track" width="100" height="8" />
                <rect className={setting.enabled ? 'rollout-fill' : 'rollout-fill rollout-fill-off'} width={setting.percentage} height="8" />
              </svg>
            </div>
          )
        })}
        <div className="rollout-scale" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div>
      </figure>
      {role !== 'admin' && <p className="environment-permission">Production changes require an Admin.</p>}
      {pending && <p className="toggle-notice" role="status">Updating…</p>}
      {!pending && notice && <p className="toggle-notice" role="status">{notice}</p>}
      {error && <p className="toggle-error" role="alert">{error}</p>}
      {needsReload && <button type="button" className="flag-button" disabled={pending} onClick={reloadDetails}>Reload details</button>}
      {/* S2: opens the rollout page (percentages, allow/block lists, preview) */}
      {!pending && !editor && !deleting && <Link className="rollout-manage" to={`/flags/${flag.id}/rollout`} state={{ flag }}>Manage rollout →</Link>}
    </dialog>
  )
}

export default function FlagsPage({ csrfToken, role }) {
  const [creating, setCreating] = useState(false)
  const [createdMessage, setCreatedMessage] = useState('')
  const [search, setSearch] = useState('')
  const [selectedFlag, setSelectedFlag] = useState(null)
  const [filters, setFilters] = useState({ q: '', archived: false, cursors: [null] })
  const [result, setResult] = useState(null)
  const current = result?.filters === filters ? result : null
  const page = current?.page

  useEffect(() => {
    const controller = new AbortController()
    fetchFlags(filters, controller.signal).then((page) => {
      if (!controller.signal.aborted) setResult({ filters, page })
    }).catch((error) => {
      if (!controller.signal.aborted) setResult({ filters, error: error.message })
    })
    return () => controller.abort()
  }, [filters])

  useEffect(() => {
    const q = search.trim()
    const timer = setTimeout(() => {
      setFilters((current) => current.q === q ? current : { ...current, q, cursors: [null] })
    }, 250)
    return () => clearTimeout(timer)
  }, [search])

  function handleUpdated(flag) {
    if (selectedFlag && (flag.archived !== selectedFlag.archived || flag.name !== selectedFlag.name || flag.description !== selectedFlag.description)) {
      setFilters((current) => ({ ...current }))
    }
    setSelectedFlag(flag)
    setResult((current) => current?.page ? {
      ...current,
      page: { ...current.page, items: current.page.items.map((item) => item.id === flag.id ? flag : item) },
    } : current)
  }

  function handleDeleted(flag) {
    setSelectedFlag(null)
    setCreatedMessage(`“${flag.name}” was deleted.`)
    setFilters((current) => ({ ...current, cursors: [null] }))
  }

  function handleCreated(flag) {
    setCreating(false)
    setCreatedMessage(`“${flag.name}” was created. All environments are Off.`)
    setSearch('')
    setFilters({ q: '', archived: false, cursors: [null] })
  }

  function clearSearch() {
    setSearch('')
    setFilters((current) => ({ ...current, q: '', cursors: [null] }))
  }

  function showArchived(archived) {
    if (archived !== filters.archived) setFilters({ ...filters, archived, cursors: [null] })
  }

  return (
    <section className="flags-view" aria-labelledby="flags-heading">
      <div className="flags-intro">
        <div>
          <h1 id="flags-heading">Feature flags</h1>
          <p>See what’s enabled across your team’s environments.</p>
        </div>
        <button type="button" className="create-flag-button" aria-haspopup="dialog" onClick={() => { setCreatedMessage(''); setCreating(true) }}>Create flag</button>
      </div>
      {createdMessage && <p className="flag-created-message" role="status">{createdMessage}</p>}

      <div className="flags-card">
        <div className="flags-toolbar">
          <div className="flag-filters" role="group" aria-label="Flag status">
            <button type="button" aria-pressed={!filters.archived} onClick={() => showArchived(false)}>Active</button>
            <button type="button" aria-pressed={filters.archived} onClick={() => showArchived(true)}>Archived</button>
          </div>
          <div className="flag-search" role="search">
            <input
              type="search"
              aria-label="Search flags by name or key"
              placeholder="Search name or key"
              maxLength={100}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && <button type="button" className="flag-button" onClick={clearSearch}>Clear</button>}
          </div>
        </div>

        <div aria-busy={!current}>
          {!current && <p className="flags-message" role="status">Loading flags…</p>}
          {current?.error && (
            <div className="flags-message">
              <p role="alert">{current.error}</p>
              <button type="button" className="flag-button" onClick={() => setFilters({ ...filters })}>Try again</button>
            </div>
          )}
          {page?.items.length === 0 && (
            <p className="flags-message" role="status">
              {filters.q ? `No flags match “${filters.q}”.` : `No ${filters.archived ? 'archived' : 'active'} flags.`}
            </p>
          )}
          {page?.items.length > 0 && (
            <div className="flags-table-scroll" role="region" aria-label="Flag environment status" tabIndex={0}>
              <table className="flags-table" aria-label={filters.archived ? 'Archived flags' : 'Active flags'}>
                <thead>
                  <tr>
                    <th scope="col">Flag</th>
                    {environments.map(([key, label]) => <th key={key} scope="col">{label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((flag) => (
                    <tr key={flag.id}>
                      <th scope="row">
                        <button type="button" className="flag-name" aria-haspopup="dialog" onClick={() => setSelectedFlag(flag)}>
                          {flag.name}
                        </button>
                      </th>
                      {environments.map(([key]) => (
                        <td key={key}><EnvironmentStatus enabled={!flag.archived && flag.environments[key].enabled} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {page && (
          <div className="flags-footer">
            <p role="status">
              {page.items.length} {page.items.length === 1 ? 'flag' : 'flags'} shown
              {filters.q && <> for “{filters.q}”</>}
            </p>
            {(filters.cursors.length > 1 || page.nextCursor) && (
              <nav className="flag-pagination" aria-label="Flag pages">
                <button
                  type="button"
                  className="flag-button"
                  disabled={filters.cursors.length === 1}
                  onClick={() => setFilters({ ...filters, cursors: filters.cursors.slice(0, -1) })}
                >
                  Previous
                </button>
                <span>Page {filters.cursors.length}</span>
                <button
                  type="button"
                  className="flag-button"
                  disabled={!page.nextCursor}
                  onClick={() => setFilters({ ...filters, cursors: [...filters.cursors, page.nextCursor] })}
                >
                  Next
                </button>
              </nav>
            )}
          </div>
        )}
      </div>
      {creating && <CreateFlagDialog csrfToken={csrfToken} onCreated={handleCreated} onClose={() => setCreating(false)} />}
      {selectedFlag && <RolloutChart flag={selectedFlag} role={role} csrfToken={csrfToken} onUpdated={handleUpdated} onDeleted={handleDeleted} onClose={() => setSelectedFlag(null)} />}
    </section>
  )
}

