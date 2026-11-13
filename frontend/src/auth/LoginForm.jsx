import { useState } from 'react'

export default function LoginForm({ onSignIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event) {
    event.preventDefault()
    if (pending) return

    setPending(true)
    setError('')
    try {
      await onSignIn(email.trim(), password)
    } catch (error) {
      setError(error.message)
    } finally {
      setPassword('')
      setPending(false)
    }
  }

  return (
    <section className="panel" aria-labelledby="sign-in-heading">
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

        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  )
}
