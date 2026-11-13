import { useEffect, useRef, useState } from 'react'
import './FlagsPage.css'

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

function RolloutChart({ flag, onClose }) {
  const dialog = useRef(null)

  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal()
  }, [])

  return (
    <dialog ref={dialog} className="rollout-dialog" aria-labelledby="rollout-title" onClose={onClose}>
      <header className="rollout-heading">
        <div>
          <code>{flag.key}</code>
          <h2 id="rollout-title">{flag.name}</h2>
        </div>
        <button type="button" className="flag-button" onClick={() => dialog.current.close()}>Close</button>
      </header>
      {flag.description && <p className="rollout-description">{flag.description}</p>}
      <figure className="rollout-chart">
        <figcaption>Configured rollout by environment</figcaption>
        {environments.map(([key, label]) => {
          const setting = flag.environments[key]
          return (
            <div className="rollout-chart-row" key={key}>
              <div className="rollout-chart-label">
                <strong>{label}</strong>
                <EnvironmentStatus enabled={setting.enabled} />
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
    </dialog>
  )
}

async function fetchFlags(filters, signal) {
  const params = new URLSearchParams({ archived: String(filters.archived) })
  if (filters.q) params.set('q', filters.q)
  const cursor = filters.cursors.at(-1)
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(`/api/v1/flags?${params}`, { signal })

  if (response.status === 401) {
    throw new Error('Your session has expired. Refresh the page to sign in again.')
  }
  if (!response.ok) throw new Error('Couldn’t load flags. Please try again.')
  return response.json()
}

export default function FlagsPage() {
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
      </div>

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
                        <td key={key}><EnvironmentStatus enabled={flag.environments[key].enabled} /></td>
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
      {selectedFlag && <RolloutChart flag={selectedFlag} onClose={() => setSelectedFlag(null)} />}
    </section>
  )
}

