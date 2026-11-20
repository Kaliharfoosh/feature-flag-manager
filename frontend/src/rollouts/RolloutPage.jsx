// Rollout page (S2): set the percentage per environment, manage the allow/block list, and
// preview what one user would get. Prod is locked for Developers here AND rejected by the API
// (the UI lock is only for convenience; the API is what actually enforces it).
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import '../flags/FlagsPage.css'
import './RolloutPage.css'
import * as api from './api'

const ENVIRONMENTS = [
  ['dev', 'Development'],
  ['staging', 'Staging'],
  ['prod', 'Production'],
]
const percent = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })
const REASONS = {
  archived: 'The flag is archived, so it is off for everyone.',
  disabled: 'The flag is turned off in this environment.',
  blocklisted: 'This user is on the block list.',
  allowlisted: 'This user is on the allow list.',
  'in-percentage': 'This user falls inside the rollout percentage.',
  'out-of-percentage': 'This user falls outside the rollout percentage.',
}

function isLocked(env, role) {
  return env === 'prod' && role !== 'admin'
}

// One environment: a slider plus a number box, saved with the version we last read.
function EnvironmentRollout({ flagId, env, label, enabled, rollout, locked, csrfToken, onSaved, onStale }) {
  // null = nothing typed, so show the saved value (it updates by itself after a save or reload)
  const [typed, setTyped] = useState(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const draft = typed ?? String(rollout.percentage)
  const setDraft = setTyped

  const value = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 100
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9
  const changed = valid && value !== rollout.percentage

  async function save(event) {
    event.preventDefault()
    if (!changed || saving) return
    setSaving(true)
    setMessage(null)
    try {
      const saved = await api.setRollout(flagId, env, value, rollout.version, csrfToken)
      onSaved(env, saved)
      setTyped(null)
      setMessage({ kind: 'ok', text: `Saved: ${percent.format(saved.percentage)}%.` })
    } catch (error) {
      if (error.code === 'STALE_VERSION') {
        setMessage({ kind: 'error', text: 'Someone else changed this rollout. The latest value is shown; check it and save again.' })
        setTyped(null)
        onStale()
      } else {
        setMessage({ kind: 'error', text: error.message })
      }
    } finally {
      setSaving(false)
    }
  }

  const inputId = `rollout-${env}`
  return (
    <form className="env-card" onSubmit={save} aria-labelledby={`${inputId}-label`}>
      <div className="env-card-head">
        <h3 id={`${inputId}-label`}>{label}</h3>
        <span className={enabled ? 'flag-state flag-state-on' : 'flag-state'}>{enabled ? 'On' : 'Off'}</span>
      </div>
      <p className="env-card-big" aria-live="polite">{valid ? percent.format(value) : '–'}<span>%</span></p>
      <input
        type="range" min="0" max="100" step="1"
        aria-label={`${label} rollout percentage`}
        value={valid ? value : rollout.percentage}
        disabled={locked || saving}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="env-card-row">
        <label htmlFor={inputId} className="sr-only">{label} percentage</label>
        <input
          id={inputId} type="number" min="0" max="100" step="0.01" inputMode="decimal"
          value={draft} disabled={locked || saving}
          aria-invalid={!valid}
          onChange={(event) => setDraft(event.target.value)}
        />
        <span>%</span>
        <button type="submit" className="primary env-save" disabled={locked || saving || !changed}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {!valid && <p className="env-note env-note-error">Use a number from 0 to 100, with at most 2 decimals.</p>}
      {locked && <p className="env-note">Only Admins can change Production.</p>}
      {!enabled && !locked && <p className="env-note">The flag is off here, so nobody gets it until it is turned on.</p>}
      {message && <p className={message.kind === 'ok' ? 'env-note env-note-ok' : 'env-note env-note-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}
    </form>
  )
}

// Allow / block list for one environment at a time.
function UserRules({ flagId, role, csrfToken, onChange }) {
  const [env, setEnv] = useState('staging')
  const [reload, setReload] = useState(0)
  // The last answer, tagged with the request it belongs to; an older answer counts as "loading".
  const [loaded, setLoaded] = useState(null)
  const [userId, setUserId] = useState('')
  const [kind, setKind] = useState('allow')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const locked = isLocked(env, role)
  const requestKey = `${env}:${reload}`
  const current = loaded?.key === requestKey ? loaded : null
  const rules = current?.items ?? null
  const loadError = current?.error ?? ''
  const setRules = (update) => setLoaded((prev) => ({ ...prev, items: update(prev.items) }))

  useEffect(() => {
    const controller = new AbortController()
    api.listRules(flagId, env, controller.signal).then((data) => {
      if (!controller.signal.aborted) setLoaded({ key: requestKey, items: data.items })
    }).catch((error) => {
      if (!controller.signal.aborted) setLoaded({ key: requestKey, error: error.message })
    })
    return () => controller.abort()
  }, [flagId, env, requestKey])

  function pick(next) {
    setEnv(next)
    setMessage(null)
  }

  async function add(event) {
    event.preventDefault()
    const id = userId.trim()
    if (!id || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const rule = await api.addRule(flagId, env, id, kind, csrfToken)
      setRules((current) => [...(current ?? []), rule])
      setUserId('')
      setMessage({ kind: 'ok', text: `${rule.userId} added to the ${rule.kind} list.` })
      onChange()
    } catch (error) {
      setMessage({ kind: 'error', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  async function remove(rule) {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      await api.deleteRule(rule.id, csrfToken)
      setMessage({ kind: 'ok', text: `${rule.userId} removed from the ${rule.kind} list.` })
    } catch (error) {
      setMessage({ kind: 'error', text: error.status === 404 ? 'That rule was already removed.' : error.message })
    } finally {
      setBusy(false)
      setReload((n) => n + 1)
      onChange()
    }
  }

  return (
    <section className="flags-card rollout-section" aria-labelledby="rules-heading">
      <div className="rollout-section-head">
        <div>
          <h2 id="rules-heading">Allow and block lists</h2>
          <p>Pick specific users. Block always wins; allow turns the flag on for that user even at 0%.</p>
        </div>
        <div className="flag-filters" role="group" aria-label="Environment for the lists">
          {ENVIRONMENTS.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={env === key} onClick={() => pick(key)}>{label}</button>
          ))}
        </div>
      </div>

      <form className="rule-form" onSubmit={add}>
        <label htmlFor="rule-user" className="sr-only">User id</label>
        <input
          id="rule-user" type="text" placeholder="User id, e.g. u-981" maxLength={100}
          value={userId} onChange={(event) => setUserId(event.target.value)} disabled={locked || busy}
        />
        <label htmlFor="rule-kind" className="sr-only">List</label>
        <select id="rule-kind" value={kind} onChange={(event) => setKind(event.target.value)} disabled={locked || busy}>
          <option value="allow">Allow list</option>
          <option value="block">Block list</option>
        </select>
        <button type="submit" className="primary" disabled={locked || busy || !userId.trim()}>Add</button>
      </form>
      {locked && <p className="env-note rule-note">Only Admins can change Production lists. You can still see them.</p>}
      {message && <p className={message.kind === 'ok' ? 'env-note env-note-ok rule-note' : 'env-note env-note-error rule-note'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}

      <div aria-busy={rules === null && !loadError}>
        {rules === null && !loadError && <p className="flags-message" role="status">Loading…</p>}
        {loadError && <p className="flags-message" role="alert">{loadError}</p>}
        {rules?.length === 0 && <p className="flags-message">No users on these lists yet.</p>}
        {rules?.length > 0 && (
          <ul className="rule-list">
            {rules.map((rule) => (
              <li key={rule.id}>
                <code>{rule.userId}</code>
                <span className={rule.kind === 'allow' ? 'rule-kind rule-allow' : 'rule-kind rule-block'}>{rule.kind}</span>
                <button type="button" className="flag-button" disabled={locked || busy} onClick={() => remove(rule)}
                  aria-label={`Remove ${rule.userId} from the ${rule.kind} list`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// "Would user X see this flag?" Uses the same logic as the real evaluation API.
function Preview({ flagKey, role, csrfToken, refresh }) {
  const [env, setEnv] = useState('staging')
  const [userId, setUserId] = useState('')
  const [answer, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = isLocked(env, role)
  // A change saved after the check makes the old answer wrong, so it is hidden.
  const result = answer?.refresh === refresh ? answer : null

  async function run(event) {
    event.preventDefault()
    const id = userId.trim()
    if (!id || busy || locked) return
    setBusy(true)
    setError('')
    try {
      setResult({ ...(await api.preview(flagKey, env, id, csrfToken)), refresh })
    } catch (err) {
      setResult(null)
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flags-card rollout-section" aria-labelledby="preview-heading">
      <div className="rollout-section-head">
        <div>
          <h2 id="preview-heading">Preview</h2>
          <p>Check what one user would get, without changing anything.</p>
        </div>
      </div>
      <form className="rule-form" onSubmit={run}>
        <label htmlFor="preview-user" className="sr-only">User id</label>
        <input id="preview-user" type="text" placeholder="User id, e.g. u-981" maxLength={100}
          value={userId} onChange={(event) => setUserId(event.target.value)} disabled={busy} />
        <label htmlFor="preview-env" className="sr-only">Environment</label>
        <select id="preview-env" value={env} disabled={busy}
          onChange={(event) => { setEnv(event.target.value); setResult(null) }}>
          {ENVIRONMENTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <button type="submit" className="primary" disabled={busy || locked || !userId.trim()}>
          {busy ? 'Checking…' : 'Check'}
        </button>
      </form>
      {locked && <p className="env-note rule-note">Only Admins can preview Production.</p>}
      {error && <p className="env-note env-note-error rule-note" role="alert">{error}</p>}
      {result && (
        <div className={result.enabled ? 'preview-result preview-on' : 'preview-result'} role="status">
          <p className="preview-answer">
            <code>{result.userId}</code> {result.enabled ? 'gets' : 'does not get'} the flag in {ENVIRONMENTS.find(([k]) => k === result.env)[1]}.
          </p>
          <p>{REASONS[result.reason]}</p>
          <p className="preview-bucket">Bucket {result.bucket} of 10,000 (users with a bucket below percentage × 100 are in)</p>
        </div>
      )}
    </section>
  )
}

export default function RolloutPage({ flagId, session }) {
  const passedFlag = useLocation().state?.flag
  const [flag, setFlag] = useState(passedFlag?.id === flagId ? passedFlag : undefined)
  const [rollouts, setRollouts] = useState(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [changes, setChanges] = useState(0) // bumps after any saved change, to clear the preview
  const { role } = session.user
  const csrfToken = session.csrfToken

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      api.getRollouts(flagId, controller.signal),
      flag === undefined ? api.findFlag(flagId, controller.signal) : Promise.resolve(flag),
    ]).then(([data, found]) => {
      if (controller.signal.aborted) return
      setRollouts(data.environments)
      setFlag(found)
    }).catch((err) => {
      if (!controller.signal.aborted) setError(err.status === 404 ? 'This flag does not exist.' : err.message)
    })
    return () => controller.abort()
    // flag is read once to skip a lookup we don't need; reloading never depends on it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagId, reload])

  const saved = useCallback((env, result) => {
    setRollouts((current) => ({ ...current, [env]: { percentage: result.percentage, version: result.version } }))
    setChanges((n) => n + 1)
  }, [])
  const stale = useCallback(() => setReload((n) => n + 1), [])

  return (
    <section className="flags-view rollout-view" aria-labelledby="rollout-page-heading">
      <p className="rollout-back"><Link to="/">← All flags</Link></p>
      <div className="flags-intro">
        <div>
          {flag?.key && <code className="rollout-key">{flag.key}</code>}
          <h1 id="rollout-page-heading">{flag?.name ?? 'Rollout'}</h1>
          <p>Choose who gets this flag in each environment.</p>
        </div>
      </div>

      {error && (
        <div className="flags-card flags-message">
          <p role="alert">{error}</p>
          <button type="button" className="flag-button" onClick={() => { setError(''); setReload((n) => n + 1) }}>Try again</button>
        </div>
      )}
      {!error && !rollouts && <p className="flags-message" role="status">Loading rollout…</p>}

      {rollouts && (
        <>
          {flag?.archived && <p className="workspace-error" role="status">This flag is archived, so every evaluation answers off.</p>}
          <section aria-labelledby="percent-heading">
            <h2 id="percent-heading" className="rollout-heading-plain">Rollout percentage</h2>
            <div className="env-grid">
              {ENVIRONMENTS.map(([env, label]) => (
                <EnvironmentRollout
                  key={env} flagId={flagId} env={env} label={label}
                  enabled={flag?.environments?.[env]?.enabled ?? false}
                  rollout={rollouts[env]} locked={isLocked(env, role)} csrfToken={csrfToken}
                  onSaved={saved} onStale={stale}
                />
              ))}
            </div>
          </section>
          <UserRules flagId={flagId} role={role} csrfToken={csrfToken} onChange={() => setChanges((n) => n + 1)} />
          {flag?.key && <Preview flagKey={flag.key} role={role} csrfToken={csrfToken} refresh={changes} />}
        </>
      )}
    </section>
  )
}
