import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api/client';
import { ApiError, type PaymentView, type Session } from '../api/types';
import { Layout } from '../components/Layout';
import { LinkError } from '../components/LinkError';
import { OtpGate } from '../components/OtpGate';
import { Actions, Button, Callout, Card, DefList, ErrorSummary, Guide, Loading, NextSteps, SecTitle, TextAreaField, TextField } from '../components/ui';
import { focusSummary, useForm, type Rule } from '../lib/form';
import { formatAmountInput, longDate, money } from '../lib/format';
import { sessionKey, useSession } from '../lib/session';
import { useLoad } from '../lib/useLoad';
import { parseAmount, todayIso, V } from '../lib/validators';

export function PaymentPage() {
  const [params] = useSearchParams();
  const requestNo = params.get('req') || '';
  const { session, setSession, expired } = useSession(sessionKey('payment', requestNo));
  if (!requestNo) return <LinkError code="LINK_INVALID" />;
  if (!session) return <OtpGate purpose="insurer_signin" requestNo={requestNo} screen="payment"onVerified={setSession} sessionEnded={expired} context={`Request ${requestNo}`} />;
  return <Payment requestNo={requestNo} session={session} onSessionEnd={() => setSession(null)} />;
}

function Payment({ requestNo, session, onSessionEnd }: { requestNo: string; session: Session; onSessionEnd: () => void }) {
  const api = useApi();
  const { data, error, loading, reload } = useLoad(() => api.getPayment(session.token, requestNo), [requestNo, session.token]);
  const partner = [session.user.insurer, session.user.department].filter(Boolean).join(' · ');
  const sess = { email: session.user.email, expiresAt: session.expiresAt, scope: `This link is for ${requestNo} only` };

  useEffect(() => {
    if (error?.code === 'SESSION_EXPIRED') onSessionEnd();
  }, [error, onSessionEnd]);
  if (error?.code === 'SESSION_EXPIRED') return null;
  if (error) return <LinkError code={error.code} requestNo={requestNo} />;
  if (loading || !data)
    return (
      <Layout partner={partner} session={sess} hero={{ eyebrow: `Request ${requestNo}`, title: 'Confirm payment.', lede: 'Loading the policy.' }}>
        <Loading text="Loading the policy" />
      </Layout>
    );
  if (data.status === 'Paid') return <PaymentDone view={data} partner={partner} />;
  return <PaymentForm view={data} token={session.token} partner={partner} sess={sess} onDone={reload} onSessionEnd={onSessionEnd} />;
}

function PaymentDone({ view, partner }: { view: PaymentView; partner: string }) {
  return (
    <Layout wide partner={partner} hero={{ eyebrow: `Policy ${view.policyNumber} · ${view.insurerName}`, title: 'Payment recorded.', lede: 'The policy is now marked as paid.' }}>
      <div className="refno">
        <span className="eyebrow">Payment status</span>
        <span className="num">Paid</span>
        <p>
          {view.paid ? `LKR ${money(view.paid.amount)} received on ${longDate(view.paid.paidDate)} · Ref ${view.paid.reference}` : ''}
        </p>
        <div>
          <span className="badge ok">Paid</span>
        </div>
      </div>
      <div>
        <h2 className="sec-title" style={{ fontSize: 'clamp(28px,3vw,40px)' }}>
          Request complete<sup>(✓)</sup>
        </h2>
        <NextSteps
          items={[
            { title: 'The request is closed', text: `Request ${view.requestNo} is complete. The policy record is kept in the gateway.` },
            { title: 'Renewal reminder', text: 'The finance partner gets a renewal alert before the policy expires.' },
          ]}
        />
      </div>
    </Layout>
  );
}

function PaymentForm(p: { view: PaymentView; token: string; partner: string; sess: { email: string; expiresAt: string; scope: string }; onDone: () => void; onSessionEnd: () => void }) {
  const api = useApi();
  const f = useForm({ 'p-date': todayIso(), 'p-ref': '', 'p-amt': money(p.view.premiumDue), 'p-rem': '' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const v = f.values;

  const R: Rule[] = [
    { id: 'p-date', label: 'Paid date', rules: [V.dateUpToToday] },
    { id: 'p-ref', label: 'Payment reference', rules: [V.required] },
    { id: 'p-amt', label: 'Amount received', rules: [V.amount] },
  ];
  const byId = Object.fromEntries(R.map((x) => [x.id, x]));
  const amount = parseAmount(v['p-amt']);
  const differs = amount > 0 && Math.abs(amount - p.view.premiumDue) > 0.004;
  const errors = f.forced ? f.allErrors(R) : [];

  const bind = (id: string, isMoney = false) => ({
    id,
    value: v[id] ?? '',
    onChange: (x: string) => f.set(id, x),
    onBlur: () => {
      if (isMoney) f.set(id, formatAmountInput(v[id] ?? ''));
      f.touch(id);
    },
    error: f.errorOf(byId[id]),
    valid: byId[id] ? f.isValid(byId[id]) : false,
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (f.allErrors(R).length) {
      f.setForced(true);
      focusSummary();
      return;
    }
    setBusy(true);
    setBanner('');
    try {
      await api.submitPayment(p.token, p.view.requestNo, { paidDate: v['p-date'], reference: v['p-ref'].trim(), amount, remarks: v['p-rem'].trim() || undefined });
      p.onDone();
    } catch (e2) {
      const er = e2 as ApiError;
      if (er.code === 'SESSION_EXPIRED') return p.onSessionEnd();
      if (er.code === 'ALREADY_SUBMITTED') return p.onDone();
      setBanner(er.message || 'The payment could not be recorded. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout partner={p.partner} session={p.sess} hero={{ eyebrow: `Policy ${p.view.policyNumber} · ${p.view.insurerName}`, title: 'Confirm payment.', lede: 'Record the premium you received for this policy.' }}>
      <div className="aside">
        <SecTitle title="Payment" num="05" desc="Record the premium received for this policy." />
        <Guide
          title="How to record payment"
          tips={['Enter the date the premium reached your account and the payment reference.', 'Enter the amount received. If it differs from the premium due, you will see a warning. You can still submit.']}
          ready={['Bank or receipt reference']}
        />
        <Card title="Policy">
          <DefList
            className="facts"
            rows={[
              ['Request No', p.view.requestNo],
              ['Policy number', p.view.policyNumber],
              ['Customer', p.view.customerName],
              ['Due date', longDate(p.view.dueDate)],
            ]}
          />
        </Card>
      </div>
      <form className="form" noValidate onSubmit={onSubmit}>
        {banner ? (
          <div className="summary" role="alert">
            <strong>{banner}</strong>
          </div>
        ) : null}
        <ErrorSummary errors={errors} />
        <div className="row" style={{ paddingBottom: 16, borderBottom: '1px solid var(--ink)' }}>
          <div>
            <span className="legend">Total premium due</span>
            <div className="calc" style={{ border: 0, fontSize: 32, padding: '4px 0 0' }}>
              LKR {money(p.view.premiumDue)}
            </div>
          </div>
          <span className={`badge ${p.view.status === 'Paid' ? 'ok' : 'out'}`}>{p.view.status}</span>
        </div>
        <span className="legend-key">
          <span className="req">*</span> Required field
        </span>
        <div className="grid">
          <TextField {...bind('p-date')} label="Paid date" type="date" hint="Not later than today" required />
          <TextField {...bind('p-ref')} label="Payment reference" fmt="Bank or receipt reference" required />
          <TextField {...bind('p-amt', true)} label="Amount received" prefix="LKR" inputMode="decimal" hint="Pre-filled with the premium due" required />
          <div />
          <TextAreaField id="p-rem" label="Remarks" value={v['p-rem']} onChange={(x) => f.set('p-rem', x)} maxLength={300} hint={differs ? 'Explain the difference in the amount' : 'Up to 300 characters'} optional full />
        </div>
        {differs ? (
          <Callout tag="Check amount" variant="warn">
            LKR {money(amount)} is different from the premium due of LKR {money(p.view.premiumDue)}. You can still confirm, so add a remark explaining the difference.
          </Callout>
        ) : null}
        <Actions left={<span className="note">Confirming locks this screen</span>}>
          <Button loading={busy}>Confirm payment</Button>
        </Actions>
      </form>
    </Layout>
  );
}
