// Command palette (Ctrl+K or ⌘K): jump to any page or sign out from the keyboard.
// Arrow keys move, Enter runs, Esc closes. Focus returns to where it was.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function CommandPalette({ open, onClose, session, onSignOut }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef(null)
  const returnFocus = useRef(null)

  const commands = useMemo(() => {
    const go = (path) => () => navigate(path)
    return [
      { id: 'flags', icon: '⚑', label: 'Flags', hint: 'all flags, toggles and rollouts', path: '/', run: go('/') },
      { id: 'audit', icon: '≡', label: 'Audit log', hint: 'who changed what, filter and export', path: '/audit', run: go('/audit') },
      session?.user.role === 'admin' && { id: 'monitoring', icon: '◉', label: 'Monitoring', hint: 'security events, alerts and the alert queue', path: '/monitoring', run: go('/monitoring') },
      session?.user.role === 'admin' && { id: 'keys', icon: '⚿', label: 'API keys', hint: 'create, list and revoke application access', path: '/keys', run: go('/keys') },
      { id: 'account', icon: '@', label: 'Account', hint: 'your name, email and role', path: '/account', run: go('/account') },
      { id: 'signout', icon: '⏻', label: 'Sign out', hint: 'end this session', path: 'session', run: onSignOut },
    ].filter(Boolean)
  }, [navigate, session, onSignOut])

  const q = query.trim().toLowerCase()
  const shown = commands.filter((c) => !q || `${c.label} ${c.hint} ${c.path}`.toLowerCase().includes(q))
  const current = Math.min(active, Math.max(0, shown.length - 1))

  useEffect(() => {
    if (!open) return undefined
    returnFocus.current = document.activeElement
    setQuery('')
    setActive(0)
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => { cancelAnimationFrame(frame); returnFocus.current?.focus?.() }
  }, [open])

  if (!open) return null

  function run(command) {
    onClose()
    command.run()
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current + 1) % Math.max(1, shown.length)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current - 1 + shown.length) % Math.max(1, shown.length)) }
    else if (event.key === 'Enter' && shown[current]) { event.preventDefault(); run(shown[current]) }
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette-input-row">
          <span aria-hidden="true">&gt;</span>
          <input
            ref={input}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            placeholder="Type a page or a command…"
            aria-label="Command"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[current] ? `palette-${shown[current].id}` : undefined}
            autoComplete="off"
          />
        </div>
        {shown.length === 0
          ? <p className="palette-empty">No command matches “{query}”.</p>
          : (
            <ul id="palette-list" role="listbox" aria-label="Commands">
              {shown.map((c, i) => (
                <li key={c.id}>
                  <button
                    id={`palette-${c.id}`}
                    type="button"
                    role="option"
                    aria-selected={i === current}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => run(c)}
                  >
                    <span className="palette-icon" aria-hidden="true">{c.icon}</span>
                    <span>{c.label}<span className="sr-only">: {c.hint}</span></span>
                    <span className="palette-path" aria-hidden="true">{c.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        <div className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
