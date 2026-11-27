import { useRef, useState } from 'react'
import TurnstileChallenge from './TurnstileChallenge'

export default function LoginForm({ onSignIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const [challengeAttempt, setChallengeAttempt] = useState(0)
  const submitting = useRef(false)

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitting.current || !turnstileToken) return

    submitting.current = true
    setPending(true)
    setError('')
    try {
      await onSignIn(email.trim(), password, turnstileToken)
    } catch (error) {
      setError(error.message)
    } finally {
      setPassword('')
      submitting.current = false
      setPending(false)
      setTurnstileToken('')
      setChallengeAttempt((current) => current + 1)
    }
  }

  return (
    <section className="panel" aria-labelledby="sign-in-heading">
      <p className="panel-kicker" aria-hidden="true">// authenticate</p>
      <h1 id="sign-in-heading">Sign in</h1>
      <p className="panel-description">Sign in to manage your team’s feature flags.</p>

      <form onSubmit={handleSubmit} aria-busy={pending}>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          maxLength={254}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          readOnly={pending}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          readOnly={pending}
        />

        <TurnstileChallenge key={challengeAttempt} onToken={setTurnstileToken} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={pending || !turnstileToken}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  )
}
