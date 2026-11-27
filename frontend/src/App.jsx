import { useEffect, useState } from 'react'
import { getSession, signIn, signOut } from './auth/api.js'
import { NavLink, matchPath, useLocation } from 'react-router-dom'
import LoginForm from './auth/LoginForm.jsx'
import FlagsPage from './flags/FlagsPage.jsx'
import RolloutPage from './rollouts/RolloutPage.jsx'
import AuditPage from './audit/AuditPage.jsx'
import MonitoringPage from './audit/MonitoringPage.jsx'
import LoginTerminal from './auth/LoginTerminal.jsx'
import StatusBar from './StatusBar.jsx'
import CommandPalette from './CommandPalette.jsx'
import './App.css'

function App() {
  const { pathname } = useLocation()
  const accountView = pathname === '/account'
  const rolloutMatch = matchPath('/flags/:flagId/rollout', pathname) // S2: rollout page
  const auditView = pathname === '/audit'           // S3: audit log
  const monitoringView = pathname === '/monitoring' // S3: security dashboard (Admin)
  const [session, setSession] = useState(undefined)
  const [sessionError, setSessionError] = useState('')
  const [sessionCheck, setSessionCheck] = useState(0)
  const [signingOut, setSigningOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Ctrl+K / ⌘K opens the command palette (signed in only).
  useEffect(() => {
    function onKey(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && session) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])

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

  async function handleSignIn(email, password, turnstileToken) {
    await signIn(email, password, turnstileToken)
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
            <span>Feature Flag Manager <span className="brand-sub">/ control plane</span></span>
          </div>
          {session && (
            <>
              <nav className="workspace-nav" aria-label="Workspace">
                <NavLink to="/" end>flags</NavLink>
                <NavLink to="/audit">audit</NavLink>
                {session.user.role === 'admin' && <NavLink to="/monitoring">monitoring</NavLink>}
                <NavLink to="/account">account</NavLink>
              </nav>
              <div className="header-actions">
                <button type="button" className="palette-hint" onClick={() => setPaletteOpen(true)} aria-label="Open the command palette (Ctrl+K)">
                  <span aria-hidden="true">⌕</span> Search <kbd>Ctrl K</kbd>
                </button>
                <button className="secondary" type="button" onClick={handleSignOut} disabled={signingOut}>
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className={session && !accountView ? "workspace-page" : "page"}>
        <div className="route-view" key={session ? pathname : 'signed-out'}>
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

        {session === null && (
          <div className="signin-layout">
            <LoginForm onSignIn={handleSignIn} />
            <div className="signin-side">
              <div className="signin-copy">
                <h2>Ship features <span>dark</span>.<br />Turn them on live.</h2>
                <p>Percentage rollouts, allow and block lists, and an audit trail for every change, served to your apps at a few milliseconds per evaluation.</p>
              </div>
              <LoginTerminal />
            </div>
          </div>
        )}

        {session && logoutError && <p className="workspace-error" role="alert">{logoutError}</p>}
        {session && rolloutMatch && (
          <RolloutPage key={rolloutMatch.params.flagId} flagId={rolloutMatch.params.flagId} session={session} />
        )}
        {session && auditView && <AuditPage key={session.user.teamId} session={session} />}
        {session && monitoringView && <MonitoringPage key={session.user.teamId} session={session} />}
        {session && !accountView && !rolloutMatch && !auditView && !monitoringView && <FlagsPage key={session.user.teamId} csrfToken={session.csrfToken} role={session.user.role} />}
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
        </div>
      </main>

      <StatusBar session={session} onOpenPalette={() => setPaletteOpen(true)} />
      {session && (
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} session={session} onSignOut={handleSignOut} />
      )}
    </>
  )
}

export default App
