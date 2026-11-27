import { useEffect, useRef, useState } from 'react'
import { getFlagHistory, getRecoverableFlags, restoreFlag } from './api'
import './FlagHistory.css'

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const actions = { 'flag.created': 'Created', 'flag.updated': 'Details updated', 'flag.toggled': 'Environment changed', 'flag.archived': 'Archived', 'flag.unarchived': 'Unarchived', 'flag.deleted': 'Deleted', 'flag.restored': 'Version restored' }

export function FlagHistory({ flagId, version, role, csrfToken, onRestored, onBusy }) {
  const [cursors, setCursors] = useState([null])
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState(null)
  const [selected, setSelected] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)
  const cursor = cursors.at(-1)
  const key = `${flagId}:${cursor ?? ''}:${refresh}`
  const current = result?.key === key ? result : null

  useEffect(() => {
    const controller = new AbortController()
    getFlagHistory(flagId, cursor, controller.signal).then((page) => {
      if (!controller.signal.aborted) setResult({ key, page })
    }).catch((error) => { if (!controller.signal.aborted) setResult({ key, error: error.message }) })
    return () => controller.abort()
  }, [flagId, cursor, key])

  async function restore() {
    if (saving.current) return
    saving.current = true
    setPending(true)
    onBusy?.(true)
    setError('')
    try {
      const flag = await restoreFlag(flagId, { versionId: selected.versionId, version }, csrfToken)
      setSelected(null)
      onRestored(flag)
    } catch (error) { setError(error.message) }
    finally { saving.current = false; setPending(false); onBusy?.(false) }
  }

  return <section className="flag-history" aria-label="Flag version history">
    <div className="history-heading"><div><h3>Version history</h3><p>Encrypted snapshots from your AWS deployment.</p></div><button type="button" className="flag-button" disabled={pending} onClick={() => setRefresh((value) => value + 1)}>Refresh history</button></div>
    {!current && <p role="status">Loading history…</p>}
    {current?.error && <p role="alert" className="toggle-error">{current.error}</p>}
    {current?.page?.enabled === false && <p className="history-empty">History and recovery are available on the AWS deployment when snapshot storage is configured. This deployment keeps working without it.</p>}
    {current?.page?.enabled && !current.page.items.length && <p className="history-empty">No snapshots yet. Changes made after snapshot storage is enabled appear here.</p>}
    {current?.page?.items.length > 0 && <ol className="history-list">
      {current.page.items.map((item) => <li key={item.versionId}>
        <div className="history-version"><span>v{item.version}</span><strong>{actions[item.action] ?? item.action}</strong><time dateTime={item.at}>{date.format(new Date(item.at))}</time></div>
        <p>{item.actor}</p><p className="history-name">{item.name}{item.archived ? ' · Archived' : ''}</p>
        <div className="history-environments">{Object.entries(item.environments).map(([env, setting]) => <span key={env}>{env}: {setting.enabled ? 'On' : 'Off'} · {setting.percentage}%</span>)}</div>
        {role === 'admin' && <button type="button" className="flag-button" disabled={pending} onClick={() => { setSelected(item); setError('') }}>Review version {item.version}</button>}
      </li>)}
    </ol>}
    {current?.page?.enabled && <div className="flag-action-row">
      <button className="flag-button" type="button" disabled={pending || cursors.length === 1} onClick={() => { setSelected(null); setCursors((value) => value.slice(0, -1)) }}>Newer versions</button>
      <button className="flag-button" type="button" disabled={pending || !current.page.nextCursor} onClick={() => { setSelected(null); setCursors((value) => [...value, current.page.nextCursor]) }}>Older versions</button>
    </div>}
    {role !== 'admin' && current?.page?.enabled && <p className="environment-permission">Only an Admin can restore a version.</p>}
    {selected && <section className="history-confirm" aria-labelledby="restore-version-title">
      <h3 id="restore-version-title">Restore version {selected.version}?</h3>
      <p>This replaces the name, description, environment settings, rollout percentages and user rules, including Production.</p>
      {version === null && <p>The deleted flag will be recovered as archived. Review its settings before unarchiving it.</p>}
      <div className="flag-action-row"><button type="button" className="flag-button flag-button-primary" disabled={pending} onClick={restore}>{pending ? 'Restoring…' : 'Confirm restore'}</button><button type="button" className="flag-button" disabled={pending} onClick={() => setSelected(null)}>Cancel restore</button></div>
      {error && <p role="alert" className="toggle-error">{error}</p>}
    </section>}
  </section>
}

export function RecoveryDialog({ csrfToken, onRestored, onClose }) {
  const dialog = useRef(null)
  const [cursors, setCursors] = useState([null])
  const [result, setResult] = useState(null)
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const cursor = cursors.at(-1)
  const key = `${cursor ?? ''}:${refresh}`
  const current = result?.key === key ? result : null
  useEffect(() => { dialog.current.showModal() }, [])
  useEffect(() => {
    const controller = new AbortController()
    getRecoverableFlags(cursor, controller.signal).then((page) => { if (!controller.signal.aborted) setResult({ key, page }) })
      .catch((error) => { if (!controller.signal.aborted) setResult({ key, error: error.message }) })
    return () => controller.abort()
  }, [cursor, key])
  return <dialog ref={dialog} className="rollout-dialog recovery-dialog" aria-labelledby="recovery-title" onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault() }}>
    <header className="rollout-heading"><div><p className="history-eyebrow">Recovery</p><h2 id="recovery-title">Recover a deleted flag</h2></div><button type="button" className="flag-button" disabled={busy} onClick={() => dialog.current.close()}>Close</button></header>
    {selected ? <>
      <button type="button" className="flag-button" disabled={busy} onClick={() => setSelected(null)}>← All recoverable flags</button>
      <p><strong>{selected.name}</strong> <code>{selected.key}</code></p>
      <FlagHistory flagId={selected.flagId} version={null} role="admin" csrfToken={csrfToken} onBusy={setBusy} onRestored={(flag) => { dialog.current.close(); onRestored(flag) }} />
    </> : <>
      <p>Snapshots can recover deleted flags for your team. Recovered flags stay archived until you review them.</p>
      <button type="button" className="flag-button" onClick={() => setRefresh((value) => value + 1)}>Refresh recovery list</button>
      {!current && <p role="status">Loading recoverable flags…</p>}
      {current?.error && <p role="alert" className="toggle-error">{current.error}</p>}
      {current?.page?.enabled === false && <p className="history-empty">Recovery is available on the AWS deployment when snapshot storage is configured.</p>}
      {current?.page?.enabled && !current.page.items.length && <p className="history-empty">No recoverable flags on this page. Only flags with saved snapshots can be recovered.</p>}
      <ul className="recovery-list">{current?.page?.items.map((item) => <li key={item.flagId}><div><strong>{item.name}</strong><code>{item.key}</code></div><button className="flag-button" type="button" onClick={() => setSelected(item)}>View history</button></li>)}</ul>
      {current?.page?.enabled && <div className="flag-action-row"><button className="flag-button" type="button" disabled={cursors.length === 1} onClick={() => setCursors((value) => value.slice(0, -1))}>Previous page</button><button className="flag-button" type="button" disabled={!current.page.nextCursor} onClick={() => setCursors((value) => [...value, current.page.nextCursor])}>Next page</button></div>}
    </>}
  </dialog>
}
