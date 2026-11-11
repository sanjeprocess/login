import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api/client';
import { ApiError, type CompareView, type Offer, type Session } from '../api/types';
import { Dialog } from '../components/Dialog';
import { Layout } from '../components/Layout';
import { LinkError } from '../components/LinkError';
import { OtpGate } from '../components/OtpGate';
import { OtpInput } from '../components/OtpInput';
import { Actions, Button, Callout, Card, DefList, Guide, Loading, NextSteps, ProgressBar, SecTitle, TextButton } from '../components/ui';
import { dateTime, longDate, money, pad2 } from '../lib/format';
import { sessionKey, useSession } from '../lib/session';
import { useLoad } from '../lib/useLoad';

export function ComparePage() {
  const [params] = useSearchParams();
  const requestNo = params.get('req') || '';
  const { session, setSession, expired } = useSession(sessionKey('compare', requestNo));
  if (!requestNo) return <LinkError code="LINK_INVALID" />;
  if (!session) return <OtpGate purpose="finance_signin" requestNo={requestNo} onVerified={setSession} sessionEnded={expired} context={`Request ${requestNo}`} />;
  return <Compare requestNo={requestNo} session={session} onSessionEnd={() => setSession(null)} />;
}

const STAGES = ['Compare and select', 'Customer OTP', 'Confirmed'];

function Compare({ requestNo, session, onSessionEnd }: { requestNo: string; session: Session; onSessionEnd: () => void }) {
  const api = useApi();
  const { data, error, loading, reload } = useLoad(() => api.getCompare(session.token, requestNo), [requestNo, session.token]);
  const [customerVerified, setCustomerVerified] = useState(false);
  const partner = [session.user.partner, session.user.branch].filter(Boolean).join(' · ');
  const sess = { email: session.user.email, expiresAt: session.expiresAt, scope: `This link is for ${requestNo} only` };

  useEffect(() => {
    if (error?.code === 'SESSION_EXPIRED') onSessionEnd();
  }, [error, onSessionEnd]);
  if (error?.code === 'SESSION_EXPIRED') return null;
  if (error) return <LinkError code={error.code} requestNo={requestNo} />;
  if (loading || !data)
    return (
      <Layout partner={partner} session={sess} hero={{ eyebrow: `Request ${requestNo}`, title: 'Compare packages.', lede: 'Loading the packages insurers sent for this request.' }}>
        <Loading text="Loading packages" />
      </Layout>
    );

  if (customerVerified) return <Confirmed view={{ ...data, status: 'confirmed' }} partner={partner} />;
  if (data.status === 'confirmed') return <Confirmed view={data} partner={partner} />;
  if (data.status === 'otp_locked') return <OtpLocked view={data} partner={partner} sess={sess} />;
  if (data.status === 'awaiting_customer_otp') return <CustomerOtp view={data} token={session.token} partner={partner} sess={sess} onDone={() => setCustomerVerified(true)} onSessionEnd={onSessionEnd} />;
  return <ChooseOffer view={data} token={session.token} partner={partner} sess={sess} onSelected={reload} onSessionEnd={onSessionEnd} />;
}

type Sess = { email: string; expiresAt: string; scope: string };

function CustomerCard({ view }: { view: CompareView }) {
  return (
    <Card title="Customer">
      <DefList
        className="facts"
        rows={[
          ['Name', view.customer.name],
          ['Mobile', `Ending in ${view.customer.mobileLast3}`],
          ['Vehicle', view.request.vehicle],
          ['Cover', `${view.request.coverType} · LKR ${money(view.request.sumInsured)}`],
        ]}
      />
    </Card>
  );
}

const ROWS: [string, (o: Offer) => string][] = [
  ['Premium', (o) => `LKR ${money(o.premium)}`],
  ['Taxes', (o) => `LKR ${money(o.taxes)}`],
  ['Sum insured', (o) => `LKR ${money(o.sumInsured)}`],
  ['Excess', (o) => `LKR ${money(o.excess)}`],
  ['Standard covers', (o) => o.standardCovers],
  ['Optional covers', (o) => o.optionalCovers.join(', ') || 'None'],
  ['Valid until', (o) => longDate(o.validUntil)],
  ['Insurer remarks', (o) => o.remarks || '–'],
];

function ChooseOffer(p: { view: CompareView; token: string; partner: string; sess: Sess; onSelected: () => void; onSessionEnd: () => void }) {
  const api = useApi();
  const offers = [...p.view.offers].sort((a, b) => a.total - b.total);
  const [sel, setSel] = useState<number | null>(null);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const chosen = sel === null ? null : offers[sel];

  async function send() {
    if (!chosen) return;
    setBusy(true);
    setBanner('');
    try {
      await api.selectPackage(p.token, p.view.request.requestNo, { insurer: chosen.insurer, packageRef: chosen.packageRef });
      setDialog(false);
      p.onSelected();
    } catch (e) {
      const er = e as ApiError;
      setDialog(false);
      if (er.code === 'SESSION_EXPIRED') return p.onSessionEnd();
      setBanner(er.message || 'The OTP could not be sent. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout
      partner={p.partner}
      session={p.sess}
      hero={{ eyebrow: `Request ${p.view.request.requestNo} · ${p.view.customer.name}`, title: 'Compare packages.', lede: 'Go through each package with the customer. When they choose, an OTP goes to their mobile to confirm it.' }}
      progress={<ProgressBar index={0} total={3} label={`Step 1 of 3 · ${STAGES[0]}`} />}
    >
      <div className="aside">
        <SecTitle title="Packages" num="03" desc={`${offers.length} package${offers.length === 1 ? '' : 's'} received.`} />
        <Guide
          title="How to choose"
          tips={[
            'Go through each column with the customer. The total premium includes taxes.',
            'Point out the excess: the amount the customer pays towards each claim.',
            'Select the package the customer chooses, then send them the OTP. The choice cannot be changed after that.',
          ]}
          ready={['Customer present', 'Customer’s mobile']}
        />
        <CustomerCard view={p.view} />
      </div>

      <form
        className="form"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (chosen) setDialog(true);
          else setBanner('Select the package the customer chose.');
        }}
      >
        {banner ? (
          <div className="summary" role="alert">
            <strong>{banner}</strong>
          </div>
        ) : null}
        <div className="cmp-wrap">
          <table className="cmp">
            <caption className="sr-only">Packages from insurers, sorted by total premium, lowest first</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="hint">Sorted by total premium, lowest first</span>
                </th>
                {offers.map((o, i) => (
                  <th scope="col" key={o.insurer + o.packageRef} className={sel === i ? 'on' : ''}>
                    <span className="rank">{pad2(i + 1)}</span>
                    <span className="ins">{o.insurer}</span>
                    <span className="src">
                      {o.packageName} · {o.source === 'api' ? 'API' : 'Webform'}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Total premium</th>
                {offers.map((o, i) => (
                  <td key={o.insurer} className={sel === i ? 'on' : ''}>
                    <span className="big">LKR {money(o.total)}</span>
                  </td>
                ))}
              </tr>
              {ROWS.map(([label, fn]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {offers.map((o, i) => (
                    <td key={o.insurer} className={sel === i ? 'on' : ''}>
                      {fn(o)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row">Select</th>
                {offers.map((o, i) => (
                  <td key={o.insurer} className={sel === i ? 'on' : ''}>
                    <label className="choose">
                      <input type="radio" name="sel" checked={sel === i} onChange={() => setSel(i)} />
                      Choose {o.insurer}
                    </label>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <Callout tag="Neutral view">No package is recommended. Order is by total premium only.</Callout>
        <Actions left={<span className="note">{chosen ? `Selected: ${chosen.insurer} · LKR ${money(chosen.total)}` : 'No package selected yet'}</span>}>
          <Button disabled={!chosen}>Select and send OTP to customer</Button>
        </Actions>
      </form>

      {dialog && chosen ? (
        <Dialog
          eyebrow="Confirm selection"
          title="Send the OTP to the customer?"
          onClose={() => !busy && setDialog(false)}
          actions={
            <>
              <TextButton onClick={() => setDialog(false)} disabled={busy}>
                Cancel
              </TextButton>
              <Button type="button" loading={busy} onClick={send}>
                Send OTP
              </Button>
            </>
          }
        >
          <DefList
            rows={[
              ['Insurer', chosen.insurer],
              ['Package', chosen.packageName],
              ['Total premium', `LKR ${money(chosen.total)}`],
              ['Customer mobile', `Ending in ${p.view.customer.mobileLast3}`],
            ]}
          />
          <Callout tag="Final" variant="warn">
            The selection cannot be changed after the OTP is sent.
          </Callout>
        </Dialog>
      ) : null}
    </Layout>
  );
}

function CustomerOtp(p: { view: CompareView; token: string; partner: string; sess: Sess; onDone: () => void; onSessionEnd: () => void }) {
  const api = useApi();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(3);
  const [msg, setMsg] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const sel = p.view.selected;
  const offer = p.view.offers.find((o) => o.insurer === sel?.insurer && o.packageRef === sel?.packageRef);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setMsg('Enter all 6 digits of the customer’s code.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.verifyCustomerOtp(p.token, p.view.request.requestNo, code);
      if (r.result === 'verified') return p.onDone();
      setCode('');
      setAttempts(r.attemptsLeft);
      setMsg(r.result === 'new_code_sent'
        ? 'The code was entered incorrectly 3 times. A new code has been sent to the customer.'
        : 'That code is not correct. Ask the customer to read it again.');
    } catch (e2) {
      const er = e2 as ApiError;
      if (er.code === 'SESSION_EXPIRED') return p.onSessionEnd();
      if (er.code === 'OTP_LOCKED') setLocked(true);
      setMsg(er.message || 'The code could not be checked. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout
      partner={p.partner}
      session={p.sess}
      hero={{ eyebrow: `Request ${p.view.request.requestNo} · ${p.view.customer.name}`, title: 'Confirm with the customer.', lede: 'Ask the customer to read out the code they just received.' }}
      progress={<ProgressBar index={1} total={3} label={`Step 2 of 3 · ${STAGES[1]}`} />}
    >
      <div className="aside">
        <SecTitle title="Customer OTP" num="03" desc="The customer confirms their choice with this code." />
        <Guide title="How to confirm" tips={['The customer has received a 6-digit code by SMS.', 'Ask them to read it to you, then type it in.', 'After 3 wrong attempts, the flow sends a new code.']} />
        <Card title="Selected package">
          <DefList
            className="facts"
            rows={[
              ['Insurer', sel?.insurer ?? ''],
              ['Total premium', `LKR ${money(sel?.total ?? 0)}`],
              ['Excess', offer ? `LKR ${money(offer.excess)}` : '–'],
              ['Valid until', offer ? longDate(offer.validUntil) : '–'],
            ]}
          />
        </Card>
      </div>
      <form className="form" noValidate onSubmit={onSubmit}>
        {locked ? (
          <div className="summary" role="alert">
            <strong>Please contact the broker.</strong>
          </div>
        ) : (
          <div className="sent" style={{ padding: '14px 16px', background: 'var(--accent-soft)', fontSize: 14 }}>
            OTP sent to the customer’s mobile ending in <strong>{p.view.customer.mobileLast3}</strong>.
          </div>
        )}
        {msg && !locked ? (
          <div className="summary" role="alert">
            <strong>{msg}</strong>
          </div>
        ) : null}
        {!locked ? <div className="field">
          <span className="legend" id="cotp-l">
            Customer’s 6-digit code
            <span className="req" aria-hidden="true">
              *
            </span>
          </span>
          <OtpInput value={code} onChange={setCode} labelledBy="cotp-l" autoFocus />
          <span className="hint">The code expires in 5 minutes.</span>
        </div> : null}
        {!locked ? <div className="row">
          <span className="note">Attempts remaining: {attempts} of 3</span>
        </div> : null}
        {!locked ? <Actions left={<span className="note">Selection: {sel?.insurer} · locked</span>}>
          <Button loading={busy}>Verify code</Button>
        </Actions> : null}
      </form>
    </Layout>
  );
}

function OtpLocked({ view, partner, sess }: { view: CompareView; partner: string; sess: Sess }) {
  return (
    <Layout
      partner={partner}
      session={sess}
      hero={{ eyebrow: `Request ${view.request.requestNo} · ${view.customer.name}`, title: 'Verification locked.', lede: 'Please contact the broker for help completing this request.' }}
    >
      <div className="summary" role="alert">
        <strong>Please contact the broker.</strong>
      </div>
    </Layout>
  );
}

function Confirmed({ view, partner }: { view: CompareView; partner: string }) {
  const sel = view.selected;
  return (
    <Layout
      wide
      partner={partner}
      hero={{ eyebrow: `Request ${view.request.requestNo} · ${view.customer.name}`, title: 'Package confirmed.', lede: 'The customer’s choice is recorded. The insurer will now issue the policy.' }}
      progress={<ProgressBar index={3} total={3} label="Complete" />}
    >
      <div className="refno">
        <span className="eyebrow">Accepted package</span>
        <span className="num">{sel?.insurer}</span>
        <p>
          Total premium LKR {money(sel?.total ?? 0)}
          {sel?.acceptedAt ? ` · Confirmed by customer OTP on ${dateTime(sel.acceptedAt)}` : ''}
        </p>
      </div>
      <div>
        <h2 className="sec-title" style={{ fontSize: 'clamp(28px,3vw,40px)' }}>
          What happens next<sup>(01–03)</sup>
        </h2>
        <NextSteps
          items={[
            { title: 'The customer gets a confirmation SMS', text: 'It shows the insurer and total premium they accepted.' },
            { title: 'The insurer issues the policy', text: 'They upload the quotation, policy number and policy documents.' },
            { title: 'You get the policy confirmation', text: 'An email arrives with the policy number once it is issued.' },
          ]}
        />
      </div>
    </Layout>
  );
}
