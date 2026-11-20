// Monitoring page (S3, Admin only): security numbers for a time window, an hourly chart, the IPs
// with the most failed logins, the alerts with their GitHub issue status (Retry for failed ones),
// and the three alert rules. The API refuses all of this to Developers with 403.
import { useEffect, useState } from 'react'
import '../flags/FlagsPage.css'
import './AuditPages.css'
import * as api from './api'

const WINDOWS = [[1, '1 hour'], [24, '24 hours'], [168, '7 days']]
const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const hourLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })

const TILES = [
  ['failedLogins', 'Failed logins'],
  ['forbidden', 'Refused (403)'],
  ['serverErrors', 'Server errors (5xx)'],
  ['rateLimited', 'Rate limited (429)'],
  ['alertFailures', 'GitHub issues failed'],
]

// Chart series in a fixed order; the colours are the validated categorical slots 1-3.
const SERIES = [
  ['failedLogins', 'Failed logins'],
  ['forbidden', 'Refused (403)'],
  ['serverErrors', 'Server errors'],
]

const RULES = {
  prod_change: ['Production changes', 'Any change in Production: a toggle, a rollout or a rule.'],
  key_change: ['API key changes', 'An API key is created or revoked.'],
  login_failures: ['Repeated failed logins', 'Many failed sign-ins for this team in a short time.'],
}

const STATUS = {
  open: 'Waiting',
  sending: 'Sending',
  sent: 'Issue opened',
  failed: 'Failed',
}

// Calls load(key, signal) once per `key`; an answer for an older key counts as still loading.
// `load` must be a module-level function (api.*), so it never changes between renders.
function useLoad(load, key) {
  const [loaded, setLoaded] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    load(key, controller.signal).then((data) => {
      if (!controller.signal.aborted) setLoaded({ key, data })
    }).catch((error) => {
      if (!controller.signal.aborted) setLoaded({ key, error: error.message })
    })
    return () => controller.abort()
  }, [load, key])
  return [loaded?.key === key ? loaded : null, setLoaded]
}

const loadAlerts = (_, signal) => api.listAlerts(signal)
const loadRules = (_, signal) => api.getAlertRules(signal)

function HourlyChart({ series }) {
  const [hovered, setHovered] = useState(null)
  const totals = series.map((point) => SERIES.reduce((sum, [key]) => sum + point[key], 0))
  const max = Math.max(1, ...totals)
  const point = hovered === null ? null : series[hovered]
  const tipLeft = hovered === null ? 0 : Math.min(85, Math.max(15, ((hovered + 0.5) / series.length) * 100))

  return (
    <figure className="hour-chart">
      <figcaption>Security events per hour</figcaption>
      <ul className="chart-legend" aria-label="Legend">
        {SERIES.map(([key, label], i) => (
          <li key={key}><span className={`swatch series-${i + 1}`} aria-hidden="true" />{label}</li>
        ))}
      </ul>
      <div className="hour-chart-plot" onMouseLeave={() => setHovered(null)}>
        <span className="hour-chart-max" aria-hidden="true">{max}</span>
        <div className="hour-chart-columns">
          {series.map((p, i) => (
            <button
              key={p.hour}
              type="button"
              className="hour-column"
              aria-label={`${hourLabel.format(new Date(p.hour))}: ${SERIES.map(([key, label]) => `${label} ${p[key]}`).join(', ')}`}
              onMouseEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
            >
              <span className="hour-stack" style={{ height: `${(totals[i] / max) * 100}%` }}>
                {SERIES.map(([key], s) => (p[key] > 0
                  ? <span key={key} className={`hour-segment series-${s + 1}`} style={{ flexGrow: p[key] }} />
                  : null))}
              </span>
            </button>
          ))}
        </div>
        {point && (
          <div className="hour-tooltip" style={{ left: `${tipLeft}%` }} role="status">
            <strong>{hourLabel.format(new Date(point.hour))}</strong>
            {SERIES.map(([key, label], s) => (
              <span key={key}><span className={`swatch series-${s + 1}`} aria-hidden="true" />{label}<b>{point[key]}</b></span>
            ))}
          </div>
        )}
      </div>
      <div className="hour-chart-axis" aria-hidden="true">
        <span>{hourLabel.format(new Date(series[0].hour))}</span>
        <span>now</span>
      </div>
      <details className="audit-raw">
        <summary>Show as a table</summary>
        <div className="flags-table-scroll">
          <table className="flags-table chart-table">
            <thead><tr><th scope="col">Hour</th>{SERIES.map(([key, label]) => <th key={key} scope="col">{label}</th>)}</tr></thead>
            <tbody>
              {series.filter((_, i) => totals[i] > 0).map((p) => (
                <tr key={p.hour}><th scope="row">{hourLabel.format(new Date(p.hour))}</th>{SERIES.map(([key]) => <td key={key}>{p[key]}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {totals.every((t) => t === 0) && <p className="flags-message">Nothing in this window.</p>}
        </div>
      </details>
    </figure>
  )
}

function AlertList({ csrfToken }) {
  const [current, setLoaded] = useLoad(loadAlerts, 'alerts')
  const [busy, setBusy] = useState(null)
  const [messages, setMessages] = useState({})

  async function retry(alert) {
    setBusy(alert.alertId)
    setMessages({ ...messages, [alert.alertId]: null })
    try {
      const updated = await api.retryAlert(alert.auditEventId, csrfToken)
      setLoaded((prev) => ({ ...prev, data: { items: prev.data.items.map((a) => (a.alertId === updated.alertId ? updated : a)) } }))
    } catch (error) {
      // 502: GitHub refused or timed out. The alert stays "failed" with the reason; show both.
      setMessages({ ...messages, [alert.alertId]: error.message })
      if (error.status === 502) {
        setLoaded((prev) => ({ ...prev, data: { items: prev.data.items.map((a) => (a.alertId === alert.alertId ? { ...a, status: 'failed', lastError: error.message } : a)) } }))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="flags-card" aria-labelledby="alerts-heading">
      <div className="flags-toolbar">
        <h2 id="alerts-heading" className="audit-heading">Alerts</h2>
        <p className="audit-hint">A GitHub issue opens automatically when a rule fires. Retry only if it failed.</p>
      </div>
      {!current && <p className="flags-message" role="status">Loading alerts…</p>}
      {current?.error && <p className="flags-message" role="alert">{current.error}</p>}
      {current?.data?.items.length === 0 && <p className="flags-message" role="status">No alerts yet.</p>}
      {current?.data?.items.length > 0 && (
        <ul className="alert-list">
          {current.data.items.map((alert) => (
            <li key={alert.alertId} className="alert-item">
              <div className="alert-main">
                <strong>{alert.title}</strong>
                <span className="audit-meta">
                  {RULES[alert.rule]?.[0] ?? alert.rule} · <time dateTime={alert.createdAt}>{when.format(new Date(alert.createdAt))}</time> · audit event #{alert.auditEventId}
                </span>
                {alert.status === 'failed' && alert.lastError && <span className="alert-error">{alert.lastError}</span>}
                {messages[alert.alertId] && alert.status !== 'failed' && <span className="alert-error" role="alert">{messages[alert.alertId]}</span>}
              </div>
              <div className="alert-side">
                <span className={`audit-badge alert-status-${alert.status}`}>{STATUS[alert.status] ?? alert.status}</span>
                {alert.status === 'sent' && alert.githubIssueUrl && (
                  <a href={alert.githubIssueUrl} target="_blank" rel="noreferrer">Issue #{alert.githubIssueNumber}</a>
                )}
                {(alert.status === 'failed' || alert.status === 'open') && (
                  <button type="button" className="flag-button" onClick={() => retry(alert)} disabled={busy === alert.alertId}>
                    {busy === alert.alertId ? 'Sending…' : 'Retry'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AlertRules({ csrfToken }) {
  const [current, setLoaded] = useLoad(loadRules, 'rules')
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const saved = current?.data?.rules
  const rules = draft ?? saved
  const changed = draft && JSON.stringify(draft) !== JSON.stringify(saved)

  function toggle(rule) {
    setMessage(null)
    setDraft(rules.map((r) => (r.rule === rule ? { ...r, enabled: !r.enabled } : r)))
  }

  async function save(event) {
    event.preventDefault()
    if (!changed || saving) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await api.saveAlertRules(draft, csrfToken)
      setLoaded((prev) => ({ ...prev, data: result }))
      setDraft(null)
      setMessage({ kind: 'ok', text: 'Alert rules saved.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flags-card" aria-labelledby="rules-heading">
      <div className="flags-toolbar">
        <h2 id="rules-heading" className="audit-heading">Alert rules</h2>
      </div>
      {!current && <p className="flags-message" role="status">Loading rules…</p>}
      {current?.error && <p className="flags-message" role="alert">{current.error}</p>}
      {rules && (
        <form className="rule-form" onSubmit={save}>
          {rules.map(({ rule, enabled }) => (
            <label key={rule} className="rule-row">
              <input type="checkbox" checked={enabled} onChange={() => toggle(rule)} disabled={saving} />
              <span>
                <strong>{RULES[rule]?.[0] ?? rule}</strong>
                <span className="audit-meta">{RULES[rule]?.[1]}</span>
              </span>
            </label>
          ))}
          <div className="rule-actions">
            <button type="submit" className="flag-button audit-apply" disabled={!changed || saving}>{saving ? 'Saving…' : 'Save rules'}</button>
            {message && <p className={message.kind === 'ok' ? 'audit-ok' : 'alert-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}
          </div>
        </form>
      )}
    </section>
  )
}

// Developers get a message without any API call, so opening the page doesn't write an
// access.denied event every time. The API still refuses them (403) if they call it directly.
export default function MonitoringPage({ session }) {
  if (session.user.role !== 'admin') {
    return (
      <section className="panel" aria-labelledby="monitoring-denied">
        <h1 id="monitoring-denied">Monitoring</h1>
        <p>Only Admins can see the security dashboard. The audit log is open to everyone on the team.</p>
      </section>
    )
  }
  return <MonitoringDashboard session={session} />
}

function MonitoringDashboard({ session }) {
  const [hours, setHours] = useState(24)
  const [current] = useLoad(api.getMonitoring, hours)
  const data = current?.data
  return (
    <section className="flags-view audit-view" aria-labelledby="monitoring-title">
      <div className="flags-intro">
        <h1 id="monitoring-title">Monitoring</h1>
        <p>Refused and failed requests for your team, and the alerts they raised.</p>
      </div>

      <section className="flags-card" aria-labelledby="security-heading">
        <div className="flags-toolbar">
          <h2 id="security-heading" className="audit-heading">Security</h2>
          <div className="flag-filters" role="group" aria-label="Time window">
            {WINDOWS.map(([h, label]) => (
              <button key={h} type="button" aria-pressed={hours === h} onClick={() => setHours(h)}>{label}</button>
            ))}
          </div>
        </div>
        {!current && <p className="flags-message" role="status">Loading…</p>}
        {current?.error && <p className="flags-message" role="alert">{current.error}</p>}
        {data && (
          <>
            <dl className="stat-tiles">
              {TILES.map(([key, label]) => (
                <div key={key} className="stat-tile"><dt>{label}</dt><dd>{data[key].toLocaleString('en')}</dd></div>
              ))}
            </dl>
            <div className="monitoring-grid">
              <HourlyChart series={data.series} />
              <div className="top-ips">
                <h3>Most failed logins by IP</h3>
                {data.topFailedLoginIps.length === 0
                  ? <p className="audit-meta">None in this window.</p>
                  : (
                    <ol>
                      {data.topFailedLoginIps.map(({ ip, count }) => (
                        <li key={ip}><code>{ip}</code><b>{count}</b></li>
                      ))}
                    </ol>
                  )}
              </div>
            </div>
          </>
        )}
      </section>

      <AlertList csrfToken={session.csrfToken} />
      <AlertRules csrfToken={session.csrfToken} />
    </section>
  )
}
