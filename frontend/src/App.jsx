import { useEffect, useState } from 'react'
import { getSession, signIn, signOut } from './auth/api.js'
import { NavLink, useLocation } from 'react-router-dom'
import LoginForm from './auth/LoginForm.jsx'
import FlagsPage from './flags/FlagsPage.jsx'
import './App.css'

function App() {
  const accountView = useLocation().pathname === '/account'
  const [session, setSession] = useState(undefined)
  const [sessionError, setSessionError] = useState('')
  const [sessionCheck, setSessionCheck] = useState(0)
  const [signingOut, setSigningOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    getSession(controller.signal).then((current) => {
      if (!controller.signal.aborted) setSession(current)
    }).catch((error) => {
      if (controller.signal.aborted) return
      if (error.status === 401) {
        setSession(null)
      } else {
        setSessionError(error.message)
      }
    })

    return () => controller.abort()
  }, [sessionCheck])

  function retrySession() {
    setSessionError('')
    setSessionCheck((attempt) => attempt + 1)
  }

  async function handleSignIn(email, password) {
    await signIn(email, password)
    try {
      setSession(await getSession())
    } catch (error) {
      if (error.status === 401) {
        throw new Error('The session could not be started. Allow cookies for this site and try again.')
      }
      setSession(undefined)
      setSessionError(error.message)
    }
  }

  async function handleSignOut() {
    if (signingOut) return

    setSigningOut(true)
    setLogoutError('')
    try {
      await signOut(session.csrfToken)
      setSession(null)
    } catch (error) {
      if (error.status === 401) {
        setSession(null)
      } else {
        setLogoutError(error.status === 403
          ? 'The session has changed. Refresh this page and try again.'
          : error.message)
      }
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <>
      <header className="app-header">
        <div className={session ? "header-content signed-in-header" : "header-content"}>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Feature Flag Manager
          </div>
          {session && (
            <>
              <nav className="workspace-nav" aria-label="Workspace">
                <NavLink to="/" end>Flags</NavLink>
                <NavLink to="/account">Account</NavLink>
              </nav>
              <button className="secondary" type="button" onClick={handleSignOut} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </>
          )}
        </div>
      </header>

      <main className={session && !accountView ? "workspace-page" : "page"}>
        {session === undefined && (
          <section className="panel" aria-label="Session status">
            {sessionError ? (
              <>
                <h1>Couldn’t check your session</h1>
                <p className="error" role="alert">{sessionError}</p>
                <button className="primary" type="button" onClick={retrySession}>Try again</button>
              </>
            ) : (
              <p role="status">Checking your session…</p>
            )}
          </section>
        )}

        {session === null && <LoginForm onSignIn={handleSignIn} />}

        {session && logoutError && <p className="workspace-error" role="alert">{logoutError}</p>}
        {session && !accountView && <FlagsPage key={session.user.teamId} />}
        {session && accountView && (
          <section className="panel" aria-labelledby="account-heading">
            <h1 id="account-heading">Your account</h1>
            <dl className="account-details">
              <div><dt>Name</dt><dd>{session.user.name}</dd></div>
              <div><dt>Email</dt><dd>{session.user.email}</dd></div>
              <div><dt>Role</dt><dd className="account-role">{session.user.role}</dd></div>
            </dl>
          </section>
        )}
      </main>
    </>
  )
}

export default App
