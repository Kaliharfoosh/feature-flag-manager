// Decoration beside the sign-in form: an evaluation stream like the one the API serves.
// It is made-up sample traffic (no request is sent) and hidden from screen readers.
// With reduced motion it shows a still snapshot.
import { useEffect, useState } from 'react'

const FLAGS = ['new-checkout', 'dark-mode', 'apple-pay', 'search-filters-v2', 'recommendations-ml', 'gift-wrap', 'live-chat', 'express-shipping']
const USERS = ['u-981', 'u-123', 'u-2048', 'u-beta-1', 'u-7', 'qa-iphone-1', 'data-team-1']
const MAX_LINES = 13

let seq = 0
function sampleLine() {
  seq += 1
  const flag = FLAGS[Math.floor(Math.random() * FLAGS.length)]
  const user = USERS[Math.floor(Math.random() * USERS.length)]
  const limited = Math.random() < 0.05
  const on = Math.random() < 0.55
  const time = new Date().toISOString().slice(11, 23)
  return { id: seq, time, status: limited ? 429 : 200, path: `POST /evaluations ${flag} user=${user}`, result: limited ? 'rate limited' : on ? 'on' : 'off', ms: `${2 + Math.floor(Math.random() * 9)}ms` }
}

export default function LoginTerminal() {
  const [lines, setLines] = useState(() => Array.from({ length: MAX_LINES }, sampleLine))

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
    const timer = setInterval(() => setLines((current) => [...current, sampleLine()].slice(-MAX_LINES)), 850)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="terminal" aria-hidden="true">
      <div className="terminal-bar"><i /><i /><i /><span>ffm · evaluations · staging</span></div>
      <div className="terminal-body">
        {lines.map((l) => (
          <div className="term-line" key={l.id}>
            <span className="t">{l.time}</span>
            <span className={l.status === 200 ? 's' : 's err'}>{l.status}</span>
            <span className="p">{l.path}</span>
            <span className={l.result === 'on' ? 'r' : 'r off'}>{l.result} · {l.ms}</span>
          </div>
        ))}
        <div className="term-caret">$ </div>
      </div>
    </div>
  )
}
