import { useEffect, type ReactNode } from 'react';
import { config } from '../config';
import { MOCK } from '../api/mockApi';
import { mmss } from '../lib/format';
import { useSecondsLeft } from '../lib/session';

export interface Hero {
  eyebrow: string;
  title: string;
  lede: string;
}

function SessionBar({ email, expiresAt, scope }: { email: string; expiresAt: string; scope?: string }) {
  const left = useSecondsLeft(expiresAt);
  return (
    <div className="session" aria-live="off">
      <span>
        Verified as <strong>{email}</strong>
      </span>
      <span>
        Session ends in <span className="mono">{mmss(left)}</span>
        {scope ? ` · ${scope}` : ' · Progress is kept until then'}
      </span>
    </div>
  );
}

function DevBar() {
  return (
    <div className="devbar" role="note">
      <strong>Mock API</strong>
      <span>Sign-in code {MOCK.signInCode}</span>
      <span>Customer OTP {MOCK.customerCode}</span>
      <span>Finance: {MOCK.financeEmail}</span>
      <span>Insurer: {MOCK.insurerEmail}</span>
      <span>Request {MOCK.requestNo}</span>
    </div>
  );
}

export function Layout(p: {
  hero: Hero;
  partner?: string;
  session?: { email: string; expiresAt: string; scope?: string };
  progress?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${p.hero.title.replace(/\.$/, '')} · Motor Insurance Gateway`;
  }, [p.hero.title]);

  return (
    <>
      {config.useMockApi ? <DevBar /> : null}
      <div className="page">
        <nav className="top" aria-label="Site">
          <span className="brand">
            <i aria-hidden="true" />
            Motor Insurance Gateway
          </span>
          {p.partner ? <span className="partner">{p.partner}</span> : <span />}
          <a className="help" href="#help">
            Help
          </a>
        </nav>
        {p.session ? <SessionBar {...p.session} /> : null}
        <header className="hero">
          <span className="eyebrow">
            <b aria-hidden="true" />
            {p.hero.eyebrow}
          </span>
          <h1 className="enter">{p.hero.title}</h1>
          <p className="lede">{p.hero.lede}</p>
        </header>
        <hr className="rule" />
        {p.progress}
        <main className={p.wide ? 'done-wrap' : 'main'}>{p.children}</main>
        <footer id="help">
          <h2>Questions about a request?</h2>
          <div className="foot-cols">
            <dl>
              <dt>Broker</dt>
              <dd>{config.brokerName}</dd>
            </dl>
            <dl>
              <dt>Support</dt>
              <dd>{config.supportPhone}</dd>
            </dl>
            <dl>
              <dt>Email</dt>
              <dd>{config.supportEmail}</dd>
            </dl>
          </div>
          <div className="legal">
            <span>© {new Date().getFullYear()} Motor Insurance Gateway · Pilot</span>
            <span>Secured by one-time codes. No passwords stored.</span>
          </div>
        </footer>
      </div>
    </>
  );
}
