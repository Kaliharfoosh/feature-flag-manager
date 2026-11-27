// Monitoring page (S3, Admin only): a threat level, security numbers for a time window, a timeline
// chart, bar charts of attacks by type, refused endpoints and attacking IPs, a live mode, the alert
// queue's dead letters (Replay, Floci only), the alerts with their GitHub issue status (Retry for
// failed ones), and the three alert rules. The API refuses all of this to Developers with 403.
import { useEffect, useState } from 'react'
import '../flags/FlagsPage.css'
import './AuditPages.css'
import * as api from './api'

const WINDOWS = [[1, '1 hour'], [24, '24 hours'], [168, '7 days']]
const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const hourLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const minuteLabel = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const LIVE_MS = 10000

// The bar chart "Attacks by type": every kind of refused or failed request the API records.
const ATTACK_TYPES = [
  ['failedLogins', 'Failed logins (brute force)'],
  ['forbidden', 'Refused, wrong role (403)'],
  ['botCheckFailures', 'Bot check failed'],
  ['rateLimited', 'Rate limited (429)'],
  ['serverErrors', 'Server errors (5xx)'],
]

const TILES = [
  ['botCheckFailures', 'Bot checks failed'],
  ['failedLogins', 'Failed logins'],
  ['forbidden', 'Refused (403)'],
  ['serverErrors', 'Server errors (5xx)'],
  ['rateLimited', 'Rate limited (429)'],
  ['alertFailures', 'GitHub issues failed'],
]

// Chart series in a fixed order; the colours are the validated categorical slots 1-5
// (index.css: lightness band, CVD and normal-vision separation all pass on the dark surface).
const SERIES = [
  ['failedLogins', 'Failed logins'],
  ['forbidden', 'Refused (403)'],
  ['serverErrors', 'Server errors'],
  ['botCheckFailures', 'Bot checks failed'],
  ['rateLimited', 'API key rate limited'],
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
const loadDeadLetters = (_, signal) => api.getDeadLetters(signal)
const loadMonitoring = (key, signal) => api.getMonitoring(Number(key.split(':')[0]), signal)

// The Vercel Firewall rules that run BEFORE the app (vercel.com → project → Firewall). Requests they
// block never reach the API, so they cannot be counted here; their hits are in Vercel's Firewall view.
const EDGE_RULES = [
  ['FW1', 'Login rate limit', '20 POST /api/v1/auth/login per minute per IP → 429'],
  ['FW2', 'Evaluation traffic', 'requests to /api/v1/evaluations are logged at the edge'],
  ['FW3', 'Scanner paths', '/.env, /.git, /wp-admin, /wp-login.php, /phpmyadmin, /xmlrpc.php → 403'],
]

// One live probe when the page opens: ask our own origin for /.env, a path FW3 must deny at the
// edge. "X-Vercel-Mitigated: deny" proves the firewall answered, not our code. Same origin, so the
// CSP (connect-src 'self') allows it and every response header is readable.
async function probeEdge(signal) {
  const response = await fetch(`${window.location.origin}/.env`, { cache: 'no-store', credentials: 'omit', signal })
  const mitigated = response.headers.get('x-vercel-mitigated')
  if (mitigated) return { state: 'active', detail: `/.env → ${response.status}, x-vercel-mitigated: ${mitigated}` }
  if (response.headers.get('server') === 'Vercel') return { state: 'missing', detail: `/.env → ${response.status} with no firewall header` }
  return { state: 'local', detail: `/.env → ${response.status} (not served by Vercel, so no edge firewall here)` }
}

function EdgeFirewall() {
  const [probe, setProbe] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    probeEdge(controller.signal).then(setProbe).catch((error) => {
      if (error.name !== 'AbortError') setProbe({ state: 'unknown', detail: 'The probe could not run.' })
    })
    return () => controller.abort()
  }, [])
  const label = { active: 'Edge firewall active', missing: 'Edge firewall NOT answering', local: 'No edge firewall on this deployment', unknown: 'Edge firewall unknown' }
  return (
    <section className="flags-card" aria-labelledby="edge-heading">
      <div className="flags-toolbar">
        <h2 id="edge-heading" className="audit-heading">Blocked at the edge</h2>
        <p className="audit-hint">These requests are stopped by the Vercel Firewall before they reach the app, so the numbers above never include them. Their hits are in Vercel → project → Firewall.</p>
      </div>
      <div className={`edge-probe edge-${probe?.state ?? 'checking'}`} role="status">
        <span className="edge-dot" aria-hidden="true" />
        <b>{probe ? label[probe.state] : 'Checking the edge firewall…'}</b>
        {probe && <code>{probe.detail}</code>}
      </div>
      <ul className="edge-rules">
        {EDGE_RULES.map(([id, name, what]) => (
          <li key={id}><span className="edge-id">{id}</span><span><b>{name}</b><span className="audit-meta">{what}</span></span></li>
        ))}
      </ul>
    </section>
  )
}

// One-hue horizontal bars, largest first, each value written on its bar (no legend needed).
function BarList({ title, rows, empty, mono = false }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <figure className="bar-list">
      <figcaption>{title}</figcaption>
      {rows.length === 0
        ? <p className="audit-meta">{empty}</p>
        : (
          <ol>
            {rows.map((r) => (
              <li key={r.label} title={`${r.label}: ${r.value}`}>
                <span className={mono ? 'bar-label bar-mono' : 'bar-label'}>{r.label}</span>
                <b>{r.value.toLocaleString('en')}</b>
                <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
              </li>
            ))}
          </ol>
        )}
    </figure>
  )
}

// How worried to be, from the numbers in this window. Shown with an icon and a word, never colour alone.
function threat(team) {
  // Attacks that belong to no team (unknown emails, anonymous bots) count too.
  const data = {
    ...team,
    failedLogins: team.failedLogins + (team.unattributed?.failedLogins ?? 0),
    botCheckFailures: team.botCheckFailures + (team.unattributed?.botCheckFailures ?? 0),
    serverErrors: team.serverErrors + (team.unattributed?.serverErrors ?? 0),
  }
  if (data.failedLogins >= 10 || data.rateLimited > 0 || data.serverErrors >= 5) return ['high', '▲', 'High', 'brute force or rate limiting in progress']
  if (data.failedLogins >= 3 || data.forbidden >= 5 || data.botCheckFailures >= 3) return ['elevated', '◆', 'Elevated', 'repeated refusals: someone is probing']
  return ['normal', '●', 'Normal', 'nothing unusual']
}

function ThreatLevel({ data }) {
  const [level, icon, word, why] = threat(data)
  return (
    <div className={`threat threat-${level}`} role="status">
      <span className="threat-icon" aria-hidden="true">{icon}</span>
      <span><b>Threat level: {word}</b> <span className="threat-why">· {why}</span></span>
      <span className="threat-rule">High: 10+ failed logins, any 429, or 5+ server errors · Elevated: 3+ failed logins, 5+ refusals or 3+ failed bot checks</span>
    </div>
  )
}

function HourlyChart({ series, bucketMinutes = 60 }) {
  const label = (iso) => (bucketMinutes < 60 ? minuteLabel : hourLabel).format(new Date(iso))
  const [hovered, setHovered] = useState(null)
  const totals = series.map((point) => SERIES.reduce((sum, [key]) => sum + point[key], 0))
  const max = Math.max(1, ...totals)
  const point = hovered === null ? null : series[hovered]
  const tipLeft = hovered === null ? 0 : Math.min(85, Math.max(15, ((hovered + 0.5) / series.length) * 100))

  return (
    <figure className="hour-chart">
      <figcaption>Security events per {bucketMinutes < 60 ? `${bucketMinutes} minutes` : bucketMinutes === 60 ? 'hour' : `${bucketMinutes / 60} hours`}</figcaption>
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
              aria-label={`${label(p.hour)}: ${SERIES.map(([key, label]) => `${label} ${p[key]}`).join(', ')}`}
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
            <strong>{label(point.hour)}</strong>
            {SERIES.map(([key, label], s) => (
              <span key={key}><span className={`swatch series-${s + 1}`} aria-hidden="true" />{label}<b>{point[key]}</b></span>
            ))}
          </div>
        )}
      </div>
      <div className="hour-chart-axis" aria-hidden="true">
        <span>{label(series[0].hour)}</span>
        <span>now</span>
      </div>
      <details className="audit-raw">
        <summary>Show as a table</summary>
        <div className="flags-table-scroll">
          <table className="flags-table chart-table">
            <thead><tr><th scope="col">{bucketMinutes < 60 ? 'Time' : 'Hour'}</th>{SERIES.map(([key, label]) => <th key={key} scope="col">{label}</th>)}</tr></thead>
            <tbody>
              {series.filter((_, i) => totals[i] > 0).map((p) => (
                <tr key={p.hour}><th scope="row">{label(p.hour)}</th>{SERIES.map(([key]) => <td key={key}>{p[key]}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {totals.every((t) => t === 0) && <p className="flags-message">Nothing in this window.</p>}
        </div>
      </details>
    </figure>
  )
}

// The team's alerts that failed 3 times in the worker (Floci's SQS dead-letter queue), with a
// Replay button that gives them 3 more tries. On Vercel there is no queue and the card says so.
function DeadLetters({ csrfToken, refreshKey, onReplayed }) {
  const [current, setLoaded] = useLoad(loadDeadLetters, refreshKey)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const data = current?.data

  async function replay() {
    setBusy(true)
    setMessage(null)
    try {
      const { replayed } = await api.replayDeadLetters(csrfToken)
      setLoaded((prev) => ({ ...prev, data: { ...prev.data, deadLetters: 0 } }))
      setMessage({ kind: 'ok', text: replayed === 1 ? '1 alert is back in the queue.' : `${replayed} alerts are back in the queue.` })
      onReplayed()
    } catch (error) {
      setMessage({ kind: 'error', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flags-card" aria-labelledby="outbox-heading">
      <div className="flags-toolbar">
        <h2 id="outbox-heading" className="audit-heading">Alert queue</h2>
        <p className="audit-hint">Alerts wait in a queue (Amazon SQS) and a worker opens the GitHub issue. After 3 failed tries an alert moves to the dead-letter queue.</p>
      </div>
      {!current && <p className="flags-message" role="status">Loading…</p>}
      {current?.error && <p className="flags-message" role="alert">{current.error}</p>}
      {data && !data.enabled && <p className="flags-message" role="status">This deployment sends alerts directly, without a queue.</p>}
      {data?.enabled && (
        <div className="outbox-row">
          <dl className="stat-tiles">
            <div className="stat-tile">
              <dt>In the dead-letter queue</dt>
              <dd>{data.deadLetters.toLocaleString('en')}{data.complete ? '' : '+'}</dd>
            </div>
          </dl>
          <div className="rule-actions">
            <button type="button" className="flag-button audit-apply" onClick={replay} disabled={busy || data.deadLetters === 0}>
              {busy ? 'Replaying…' : 'Replay'}
            </button>
            {message && <p className={message.kind === 'ok' ? 'audit-ok' : 'alert-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}
          </div>
        </div>
      )}
    </section>
  )
}

function AlertList({ csrfToken, refreshKey }) {
  const [current, setLoaded] = useLoad(loadAlerts, refreshKey)
  const [busy, setBusy] = useState(null)
  const [messages, setMessages] = useState({})

  async function retry(alert) {
    setBusy(alert.alertId)
    setMessages({ ...messages, [alert.alertId]: null })
    try {
      const updated = await api.retryAlert(alert.auditEventId, csrfToken)
      if (updated.status === 'sent') {
        setLoaded((prev) => ({ ...prev, data: { items: prev.data.items.map((a) => (a.alertId === updated.alertId ? updated : a)) } }))
      } else {
        // 202 on Floci: queued for the worker, which opens the issue in a few seconds.
        setLoaded((prev) => ({ ...prev, data: { items: prev.data.items.map((a) => (a.alertId === alert.alertId ? { ...a, status: 'open' } : a)) } }))
        setMessages({ ...messages, [alert.alertId]: { kind: 'ok', text: 'Queued. Reload in a few seconds to see the issue.' } })
      }
    } catch (error) {
      // 502: GitHub refused or timed out. The alert stays "failed" with the reason; show both.
      setMessages({ ...messages, [alert.alertId]: { kind: 'error', text: error.message } })
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
                {messages[alert.alertId]?.kind === 'ok' && <span className="audit-ok" role="status">{messages[alert.alertId].text}</span>}
                {messages[alert.alertId]?.kind === 'error' && alert.status !== 'failed' && <span className="alert-error" role="alert">{messages[alert.alertId].text}</span>}
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
  const [refresh, setRefresh] = useState(0) // bumped after a replay, to reload the alert list
  const [live, setLive] = useState(false)
  const [tick, setTick] = useState(0)
  const [current] = useLoad(loadMonitoring, `${hours}:${tick}`)
  // While a live refresh is loading, keep showing the last answer for the same window (no flicker).
  const [last, setLast] = useState(null)
  useEffect(() => { if (current?.data) setLast({ hours, data: current.data }) }, [current, hours])
  const data = current?.data ?? (last?.hours === hours ? last.data : null)

  // Live mode: reload every 10 s, so an attack shows up on the dashboard while it happens.
  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(() => { if (!document.hidden) setTick((t) => t + 1) }, LIVE_MS)
    return () => clearInterval(timer)
  }, [live])

  return (
    <section className="flags-view audit-view" aria-labelledby="monitoring-title">
      <div className="flags-intro">
        <h1 id="monitoring-title">Monitoring</h1>
        <p>Refused and failed requests for your team, and the alerts they raised.</p>
      </div>

      <section className="flags-card" aria-labelledby="security-heading">
        <div className="flags-toolbar">
          <h2 id="security-heading" className="audit-heading">Security</h2>
          <div className="monitoring-controls">
            <button type="button" className={live ? 'live-toggle live-on' : 'live-toggle'} aria-pressed={live} onClick={() => setLive((on) => !on)}>
              <span className="live-dot" aria-hidden="true" /> {live ? 'Live · every 10 s' : 'Go live'}
            </button>
            <div className="flag-filters" role="group" aria-label="Time window">
              {WINDOWS.map(([h, label]) => (
                <button key={h} type="button" aria-pressed={hours === h} onClick={() => setHours(h)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        {!data && !current && <p className="flags-message" role="status">Loading…</p>}
        {current?.error && <p className="flags-message" role="alert">{current.error}</p>}
        {data && (
          <>
            <ThreatLevel data={data} />
            <dl className="stat-tiles">
              {TILES.map(([key, label]) => (
                <div key={key} className="stat-tile"><dt>{label}</dt><dd>{data[key].toLocaleString('en')}</dd></div>
              ))}
            </dl>
            {data.unattributed && (
              <div className="unattributed" role="note">
                <span className="unattributed-title">Not tied to any team</span>
                <span>Failed logins with unknown emails <b>{data.unattributed.failedLogins}</b></span>
                <span>Bot checks failed <b>{data.unattributed.botCheckFailures}</b></span>
                <span>Server errors <b>{data.unattributed.serverErrors}</b></span>
                <span className="unattributed-note">Counts only: these requests could come from anyone, so no IPs are shown.</span>
              </div>
            )}
            <div className="monitoring-grid">
              <HourlyChart series={data.series} bucketMinutes={data.bucketMinutes ?? 60} />
              <BarList
                title="Attacks by type"
                rows={ATTACK_TYPES.map(([key, label]) => ({ label, value: data[key] ?? 0 })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value)}
                empty="Nothing refused in this window."
              />
            </div>
            <div className="monitoring-grid monitoring-grid-even">
              <BarList
                title="Most refused endpoints (403)"
                mono
                rows={(data.topRefusedEndpoints ?? []).map(({ endpoint, count }) => ({ label: endpoint || '(unknown)', value: count }))}
                empty="No refused requests in this window."
              />
              <BarList
                title="Most failed logins by IP"
                mono
                rows={data.topFailedLoginIps.map(({ ip, count }) => ({ label: ip, value: count }))}
                empty="No failed logins in this window."
              />
            </div>
          </>
        )}
      </section>

      <EdgeFirewall />
      <DeadLetters csrfToken={session.csrfToken} refreshKey="dead-letters" onReplayed={() => setRefresh((n) => n + 1)} />
      <AlertList csrfToken={session.csrfToken} refreshKey={`alerts-${refresh}`} />
      <AlertRules csrfToken={session.csrfToken} />
    </section>
  )
}
