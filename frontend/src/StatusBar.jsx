// Bottom status bar: live API health (GET /api/v1/health, public), its latency with a small
// sparkline, the deployed commit, who is signed in, a UTC clock and the command-palette key.
// Polls every 30 s, only while the tab is visible, so a background tab costs nothing.
import { useEffect, useState } from 'react'
import { API_BASE } from './apiBase'

const POLL_MS = 30000
const KEEP = 14

async function probe() {
  const started = performance.now()
  try {
    const response = await fetch(`${API_BASE}/api/v1/health`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    return { ok: response.ok && body.status === 'ok', db: body.db ?? 'unknown', commit: body.commit ?? '', ms: Math.round(performance.now() - started) }
  } catch {
    return { ok: false, db: 'unreachable', commit: '', ms: null }
  }
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export default function StatusBar({ session, onOpenPalette }) {
  const [health, setHealth] = useState(null)
  const [history, setHistory] = useState([])
  const now = useClock()

  useEffect(() => {
    let cancelled = false
    async function check() {
      if (document.hidden) return
      const result = await probe()
      if (cancelled) return
      setHealth(result)
      if (result.ms !== null) setHistory((h) => [...h, result.ms].slice(-KEEP))
    }
    check()
    const timer = setInterval(check, POLL_MS)
    const onVisible = () => { if (!document.hidden) check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  const max = Math.max(1, ...history)
  const state = health === null ? '' : health.ok ? 'status-ok' : 'status-bad'
  const commit = health?.commit ? (health.commit === 'local' ? 'local' : health.commit.slice(0, 7)) : '…'

  return (
    <footer className="status-bar" aria-label="System status">
      <span className={state} role="status" title="GET /api/v1/health every 30 s">
        <span className="status-dot" aria-hidden="true" />
        api <b>{health === null ? 'checking' : health.ok ? 'healthy' : 'degraded'}</b>
      </span>
      <span className="status-hide-sm">
        db <b>{health?.db ?? '…'}</b>
      </span>
      <span title="Health check round trip, last checks">
        <span className="status-spark" aria-hidden="true">
          {history.map((ms, i) => <i key={i} style={{ height: `${Math.max(12, (ms / max) * 100)}%` }} />)}
        </span>
        <b>{health?.ms != null ? `${health.ms} ms` : '…'}</b>
      </span>
      <span className="status-hide-sm">build <b>{commit}</b></span>
      {session && (
        <span className="status-hide-sm">
          <span className="status-env">●</span> {session.user.email} · <b>{session.user.role}</b>
        </span>
      )}
      <span className="status-hide-sm">{now.toISOString().slice(11, 19)} UTC</span>
      {session && (
        <button type="button" className="status-palette" onClick={onOpenPalette} aria-label="Open the command palette">
          <kbd>Ctrl</kbd><kbd>K</kbd> commands
        </button>
      )}
    </footer>
  )
}
