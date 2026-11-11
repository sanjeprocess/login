import { useState, type FormEvent } from 'react';
import { useApi } from '../api/client';
import { ApiError, type ApiErrorCode, type Purpose, type Session, type SignInScreen } from '../api/types';
import { mmss } from '../lib/format';
import { useCountdown } from '../lib/session';
import { V } from '../lib/validators';
import { Layout } from './Layout';
import { LinkError, isLinkError } from './LinkError';
import { OtpInput } from './OtpInput';
import { Actions, Button, Callout, Guide, SecTitle, TextButton, TextField } from './ui';

const HOW = [
  'Enter the email your company registered with the broker.',
  'We text a 6-digit code to the mobile on record. It is valid for 5 minutes.',
  'Enter the code. You get 3 attempts per code, then you can request a new one.',
  'Your session lasts 30 minutes or until you submit.',
];

/** Email + SMS code sign-in shown in front of every screen. */
export function OtpGate(p: { purpose: Purpose; requestNo?: string; screen?: SignInScreen; onVerified: (s: Session) => void; sessionEnded?: boolean; context?: string }) {
  const api = useApi();
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [attemptsLeft, setAttemptsLeft] = useState(3);
  const [locked, setLocked] = useState(false);
  const [resendFrom, setResendFrom] = useState(60);
  const [sendCount, setSendCount] = useState(0);
  const [linkError, setLinkError] = useState<ApiErrorCode | null>(null);
  const resendLeft = useCountdown(stage === 'code' ? resendFrom : 0, sendCount);

  const emailError = emailTouched ? V.emailRequired(email, 'email') : '';

  async function send() {
    setBusy(true);
    setFormError('');
    try {
      const r = await api.requestOtp({ email: email.trim(), purpose: p.purpose, requestNo: p.requestNo, screen: p.screen });
      setResendFrom(r.resendAfterSeconds);
      setSendCount((n) => n + 1);
      setAttemptsLeft(3);
      setLocked(false);
      setCode('');
      setStage('code');
    } catch (e) {
      const err = e as ApiError;
      if (err.code && isLinkError(err.code) && err.code !== 'NETWORK') setLinkError(err.code);
      else setFormError(err.message || 'The code could not be sent. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onEmail(e: FormEvent) {
    e.preventDefault();
    setEmailTouched(true);
    if (V.emailRequired(email, 'email')) return;
    await send();
  }

  async function onCode(e: FormEvent) {
    e.preventDefault();
    if (V.otp(code, 'code')) {
      setFormError('Enter all 6 digits of the code.');
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      const s = await api.verifyOtp({ email: email.trim(), code, purpose: p.purpose, requestNo: p.requestNo, screen: p.screen });
      p.onVerified(s);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'OTP_LOCKED' || err.code === 'OTP_EXPIRED') {
        setLocked(true);
        setAttemptsLeft(0);
        setFormError(err.code === 'OTP_EXPIRED' ? 'This code has expired. Request a new code.' : 'Too many incorrect attempts. Request a new code.');
      } else if (err.code === 'OTP_INCORRECT') {
        setAttemptsLeft(err.attemptsLeft ?? Math.max(0, attemptsLeft - 1));
        setFormError('That code is not correct. Check the SMS and try again.');
      } else if (err.code && isLinkError(err.code) && err.code !== 'NETWORK') {
        setLinkError(err.code);
      } else {
        setFormError(err.message || 'The code could not be checked. Try again.');
      }
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (linkError) return <LinkError code={linkError} requestNo={p.requestNo} />;

  const hero =
    stage === 'email'
      ? { eyebrow: p.context || 'Secure access', title: 'Verify it’s you.', lede: 'Enter your registered email. We will text a one-time code to the mobile on record.' }
      : { eyebrow: p.context || 'Secure access', title: 'Enter your code.', lede: 'We sent a 6-digit code to the mobile on record. It expires in 5 minutes.' };

  return (
    <Layout hero={hero}>
      <div className="aside">
        <SecTitle
          title="Sign in"
          num={stage === 'email' ? '01' : '02'}
          desc={stage === 'email' ? 'No passwords. Each visit is unlocked with a one-time code.' : 'If this email is registered, a code has been sent to the mobile on record.'}
        />
        <Guide title="How sign-in works" tips={HOW} />
      </div>

      {stage === 'email' ? (
        <form className="form" noValidate onSubmit={onEmail}>
          {p.sessionEnded ? (
            <Callout tag="Session ended" variant="warn">
              Your session ended after 30 minutes. Verify again to continue. Anything you had not submitted was not sent.
            </Callout>
          ) : null}
          {formError ? (
            <div className="summary" role="alert">
              <strong>{formError}</strong>
            </div>
          ) : null}
          <div className="grid">
            <TextField
              id="email"
              label="Registered email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="name@company.lk"
              value={email}
              onChange={setEmail}
              onBlur={() => setEmailTouched(true)}
              error={emailError}
              fmt="name@company.lk"
              required
              full
            />
          </div>
          <Callout tag="Privacy">For your security we will not confirm whether an email is registered. If it is, the code arrives within a minute.</Callout>
          <Actions left={<span className="note">Can’t access your mobile? Contact the broker.</span>}>
            <Button loading={busy}>Send code</Button>
          </Actions>
        </form>
      ) : (
        <form className="form" noValidate onSubmit={onCode}>
          {formError ? (
            <div className="summary" role="alert">
              <strong>{formError}</strong>
            </div>
          ) : null}
          <div className="field">
            <span className="legend" id="otp-l">
              6-digit code
              <span className="req" aria-hidden="true">
                *
              </span>
            </span>
            <OtpInput value={code} onChange={setCode} labelledBy="otp-l" autoFocus disabled={locked} />
            <span className="hint">You can paste the full code into the first box.</span>
          </div>
          <div className="row">
            <span className="note">Attempts remaining: {attemptsLeft} of 3</span>
            {resendLeft > 0 ? (
              <span className="note">Resend available in {mmss(resendLeft)}</span>
            ) : (
              <TextButton onClick={send} disabled={busy}>
                Resend code
              </TextButton>
            )}
          </div>
          <Callout tag="No code?">Check that the phone has signal and wait a minute. After 60 seconds you can request a new code.</Callout>
          <Actions
            left={
              <TextButton
                onClick={() => {
                  setStage('email');
                  setFormError('');
                }}
              >
                ← Use a different email
              </TextButton>
            }
          >
            <Button loading={busy} disabled={locked}>
              Verify
            </Button>
          </Actions>
        </form>
      )}
    </Layout>
  );
}
