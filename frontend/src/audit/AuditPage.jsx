// Audit log page (S3): the summary card, filters, the newest-first event table with "Load more",
// and the CSV export for Admins. Developers see the log too; only the export is Admin-only
// (hidden here AND refused by the API with 403, which is what actually enforces it).
import { useEffect, useState } from 'react'
import '../flags/FlagsPage.css'
import './AuditPages.css'
import * as api from './api'

const EMPTY_FILTERS = { actor: '', action: '', category: '', from: '', to: '' }
const SUMMARY_DAYS = [1, 7, 30, 90]
const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

const SUMMARY_TILES = [
  ['changes', 'Changes'],
  ['prodChanges', 'Production changes'],
  ['securityEvents', 'Security events'],
  ['failedLogins', 'Failed logins'],
  ['alertsOpen', 'Open alerts'],
]

// One readable line per changed field, e.g. "percentage: 25 → 50".
function describeChange(details) {
  const before = details?.before ?? {}
  const after = details?.after ?? {}
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => typeof (after[field] ?? before[field]) !== 'object')
  return fields.map((field) => {
    if (!(field in before)) return `${field}: ${String(after[field])}`
    if (!(field in after)) return `${field}: ${String(before[field])} → removed`
    return `${field}: ${String(before[field])} → ${String(after[field])}`
  })
}

function SummaryCard() {
  const [days, setDays] = useState(7)
  const [loaded, setLoaded] = useState(null)
  const current = loaded?.days === days ? loaded : null

  useEffect(() => {
    const controller = new AbortController()
    api.getSummary(days, controller.signal).then((data) => {
      if (!controller.signal.aborted) setLoaded({ days, data })
    }).catch((error) => {
      if (!controller.signal.aborted) setLoaded({ days, error: error.message })
    })
    return () => controller.abort()
  }, [days])

  return (
    <section className="flags-card audit-summary" aria-labelledby="summary-heading">
      <div className="flags-toolbar">
        <h2 id="summary-heading" className="audit-heading">Summary</h2>
        <div className="flag-filters" role="group" aria-label="Summary period">
          {SUMMARY_DAYS.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
              {d === 1 ? '24 hours' : `${d} days`}
            </button>
          ))}
        </div>
      </div>
      {!current && <p className="flags-message" role="status">Loading summary…</p>}
      {current?.error && <p className="flags-message" role="alert">{current.error}</p>}
      {current?.data && (
        <dl className="stat-tiles">
          {SUMMARY_TILES.map(([key, label]) => (
            <div key={key} className="stat-tile">
              <dt>{label}</dt>
              <dd>{current.data[key].toLocaleString('en')}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function FilterForm({ applied, onApply }) {
  const [draft, setDraft] = useState(applied)
  const set = (field) => (event) => setDraft({ ...draft, [field]: event.target.value })
  const changed = JSON.stringify(draft) !== JSON.stringify(applied)
  const filled = Object.values(applied).some(Boolean)

  function submit(event) {
    event.preventDefault()
    onApply({ ...draft, actor: draft.actor.trim(), action: draft.action.trim() })
  }

  function clear() {
    setDraft(EMPTY_FILTERS)
    onApply(EMPTY_FILTERS)
  }

  return (
    <form className="audit-filters" onSubmit={submit} aria-label="Filter the audit log">
      <label>
        Actor
        <input type="text" value={draft.actor} onChange={set('actor')} placeholder="dev@acme.test" maxLength={254} />
      </label>
      <label>
        Action
        <input type="text" value={draft.action} onChange={set('action')} placeholder="flag.toggled" maxLength={60} />
      </label>
      <label>
        Category
        <select value={draft.category} onChange={set('category')}>
          <option value="">All</option>
          <option value="change">Changes</option>
          <option value="security">Security</option>
        </select>
      </label>
      <label>
        From
        <input type="date" value={draft.from} onChange={set('from')} max={draft.to || undefined} />
      </label>
      <label>
        To
        <input type="date" value={draft.to} onChange={set('to')} min={draft.from || undefined} />
      </label>
      <div className="audit-filter-actions">
        <button type="submit" className="flag-button audit-apply" disabled={!changed}>Apply</button>
        {filled && <button type="button" className="flag-button" onClick={clear}>Clear</button>}
      </div>
    </form>
  )
}

function EventRow({ event }) {
  const changes = describeChange(event.details)
  return (
    <tr>
      <td className="audit-when"><time dateTime={event.at}>{when.format(new Date(event.at))}</time></td>
      <td className="audit-actor">{event.actorLabel}</td>
      <td>
        <code className="audit-action">{event.action}</code>
        {event.category === 'security' && <span className="audit-badge audit-badge-security">Security</span>}
      </td>
      <td className="audit-target">
        {event.targetType ? <>{event.targetType}{event.details?.key ? <> · <code>{event.details.key}</code></> : null}{event.details?.env ? <> · {event.details.env}</> : null}</> : '—'}
      </td>
      <td>
        {changes.length > 0 && <ul className="audit-changes">{changes.map((line) => <li key={line}>{line}</li>)}</ul>}
        <details className="audit-raw">
          <summary>Details</summary>
          <pre>{JSON.stringify(event.details, null, 2)}</pre>
          <p>Request ID <code>{event.requestId ?? '—'}</code></p>
        </details>
      </td>
    </tr>
  )
}

export default function AuditPage({ session }) {
  const isAdmin = session.user.role === 'admin'
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  // The first page for the current filters; later pages are appended by "Load more".
  const [loaded, setLoaded] = useState(null)
  const [more, setMore] = useState({ busy: false, error: '' })
  const [exporting, setExporting] = useState({ busy: false, error: '' })
  const filterKey = JSON.stringify(filters)
  const current = loaded?.key === filterKey ? loaded : null

  useEffect(() => {
    const controller = new AbortController()
    api.listAudit(filters, undefined, controller.signal).then((page) => {
      if (!controller.signal.aborted) setLoaded({ key: filterKey, items: page.items, nextCursor: page.nextCursor })
    }).catch((error) => {
      if (!controller.signal.aborted) setLoaded({ key: filterKey, error: error.message })
    })
    return () => controller.abort()
  }, [filters, filterKey])

  async function loadMore() {
    if (more.busy || !current?.nextCursor) return
    setMore({ busy: true, error: '' })
    try {
      const page = await api.listAudit(filters, current.nextCursor)
      setLoaded((prev) => (prev.key === filterKey
        ? { ...prev, items: [...prev.items, ...page.items], nextCursor: page.nextCursor }
        : prev))
      setMore({ busy: false, error: '' })
    } catch (error) {
      setMore({ busy: false, error: error.message })
    }
  }

  async function exportCsv() {
    setExporting({ busy: true, error: '' })
    try {
      await api.downloadAuditCsv(filters)
      setExporting({ busy: false, error: '' })
    } catch (error) {
      setExporting({ busy: false, error: error.message })
    }
  }

  return (
    <section className="flags-view audit-view" aria-labelledby="audit-title">
      <div className="flags-intro">
        <h1 id="audit-title">Audit log</h1>
        <p>Every change to flags, rollouts, rules, keys and alert rules, and every refused request. The log can only be added to.</p>
      </div>

      <SummaryCard />

      <div className="flags-card">
        <div className="flags-toolbar">
          <h2 className="audit-heading">Events</h2>
          {isAdmin && (
            <button type="button" className="flag-button" onClick={exportCsv} disabled={exporting.busy}>
              {exporting.busy ? 'Preparing CSV…' : 'Export CSV'}
            </button>
          )}
        </div>
        {exporting.error && <p className="flags-message" role="alert">{exporting.error}</p>}
        <FilterForm key={filterKey} applied={filters} onApply={setFilters} />

        <div aria-busy={!current}>
          {!current && <p className="flags-message" role="status">Loading events…</p>}
          {current?.error && (
            <div className="flags-message">
              <p role="alert">{current.error}</p>
              <button type="button" className="flag-button" onClick={() => setFilters({ ...filters })}>Try again</button>
            </div>
          )}
          {current?.items?.length === 0 && (
            <p className="flags-message" role="status">No events match these filters.</p>
          )}
          {current?.items?.length > 0 && (
            <div className="flags-table-scroll" role="region" aria-label="Audit events" tabIndex={0}>
              <table className="flags-table audit-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Who</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target</th>
                    <th scope="col">What changed</th>
                  </tr>
                </thead>
                <tbody>
                  {current.items.map((event) => <EventRow key={event.id} event={event} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {current?.items && (
          <div className="flags-footer">
            <p role="status">{current.items.length} {current.items.length === 1 ? 'event' : 'events'} shown, newest first</p>
            {current.nextCursor && (
              <button type="button" className="flag-button" onClick={loadMore} disabled={more.busy}>
                {more.busy ? 'Loading…' : 'Load more'}
              </button>
            )}
            {more.error && <p role="alert">{more.error}</p>}
          </div>
        )}
      </div>
    </section>
  )
}
