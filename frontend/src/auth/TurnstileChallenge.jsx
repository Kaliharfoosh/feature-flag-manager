import { useEffect, useRef, useState } from 'react'
import { getLoginConfig } from './api'

let scriptPromise

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      const timer = setTimeout(() => {
        script.remove()
        reject(new Error('Verification could not load. Please try again.'))
      }, 12000)
      script.onload = () => {
        clearTimeout(timer)
        if (window.turnstile) {
          resolve(window.turnstile)
        } else {
          script.remove()
          reject(new Error('Couldn’t load sign-in verification.'))
        }
      }
      script.onerror = () => {
        clearTimeout(timer)
        script.remove()
        reject(new Error('Couldn’t load sign-in verification. Check your connection and try again.'))
      }
      document.head.append(script)
    }).catch((error) => {
      scriptPromise = undefined
      throw error
    })
  }
  return scriptPromise
}

export default function TurnstileChallenge({ onToken }) {
  const container = useRef(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let api
    let widget
    const controller = new AbortController()

    async function render() {
      try {
        const config = await getLoginConfig(controller.signal)
        api = await loadTurnstile()
        if (!active) return
        setStatus('checking')
        widget = api.render(container.current, {
          sitekey: config.siteKey,
          action: config.action,
          theme: 'dark',
          size: container.current.clientWidth < 300 ? 'compact' : 'flexible',
          callback: (token) => {
            if (!active) return
            onToken(token)
            setStatus('ready')
            setError('')
          },
          'expired-callback': () => {
            if (!active) return
            onToken('')
            setStatus('error')
            setError('Verification expired. Please verify again.')
          },
          'error-callback': () => {
            if (!active) return
            onToken('')
            setStatus('error')
            setError('Verification could not finish. Please try again.')
          },
          'timeout-callback': () => {
            if (!active) return
            onToken('')
            setStatus('error')
            setError('Verification timed out. Please try again.')
          },
        })
      } catch (error) {
        if (!active || error.name === 'AbortError') return
        setStatus('error')
        setError(error.message)
      }
    }
    render()
    return () => {
      active = false
      controller.abort()
      if (api && widget !== undefined) api.remove(widget)
    }
  }, [attempt, onToken])

  return (
    <div className="sign-in-verification">
      <div ref={container} />
      {status === 'loading' && <p className="verification-status" role="status">Loading sign-in verification…</p>}
      {error && (
        <>
          <p className="error" role="alert">{error}</p>
          <button type="button" className="secondary" onClick={() => {
            onToken('')
            setStatus('loading')
            setError('')
            setAttempt((current) => current + 1)
          }}>Retry verification</button>
        </>
      )}
    </div>
  )
}
