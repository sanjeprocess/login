import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api/client';
import { ApiError, type BindingView, type Session } from '../api/types';
import { config } from '../config';
import { FileDrop } from '../components/FileDrop';
import { Layout } from '../components/Layout';
import { LinkError } from '../components/LinkError';
import { OtpGate } from '../components/OtpGate';
import { Actions, Button, Card, DefList, ErrorSummary, GroupHead, Guide, Loading, NextSteps, PendingNotice, SecTitle, TextAreaField, TextField, type FieldError } from '../components/ui';
import { focusSummary, useForm, type Rule } from '../lib/form';
import { dateTime, longDate, money } from '../lib/format';
import { sessionKey, useSession } from '../lib/session';
import { useLoad } from '../lib/useLoad';
import { fileError, V } from '../lib/validators';

export function BindingPage() {
  const [params] = useSearchParams();
  const requestNo = params.get('req') || '';
  const { session, setSession, expired } = useSession(sessionKey('binding', requestNo));
  if (!requestNo) return <LinkError code="LINK_INVALID" />;
  if (!session) return <OtpGate purpose="insurer_signin" requestNo={requestNo} screen="binding"onVerified={setSession} sessionEnded={expired} context={`Request ${requestNo}`} />;
  return <Binding requestNo={requestNo} session={session} onSessionEnd={() => setSession(null)} />;
}

function Binding({ requestNo, session, onSessionEnd }: { requestNo: string; session: Session; onSessionEnd: () => void }) {
  const api = useApi();
  const { data, error, loading, pending } = useLoad(() => api.getBinding(session.token, requestNo), [requestNo, session.token]);
  const [submitted, setSubmitted] = useState<NonNullable<BindingView['submitted']>>();
  const partner = [session.user.insurer, session.user.department].filter(Boolean).join(' · ');
  const sess = { email: session.user.email, expiresAt: session.expiresAt, scope: `This link is for ${requestNo} only` };
  const hero = { eyebrow: `Request ${requestNo} · ${session.user.insurer ?? ''}`, title: 'Issue the policy.', lede: 'The customer accepted your package. Upload the quotation and policy documents to complete binding.' };

  useEffect(() => {
    if (error?.code === 'SESSION_EXPIRED') onSessionEnd();
  }, [error, onSessionEnd]);
  if (error?.code === 'SESSION_EXPIRED') return null;
  if (error) return <LinkError code={error.code} requestNo={requestNo} />;
  if (pending)
    return (
      <Layout hero={hero} partner={partner} session={sess}>
        <PendingNotice pending={pending} />
      </Layout>
    );
  if (loading || !data)
    return (
      <Layout hero={hero} partner={partner} session={sess}>
        <Loading text="Loading the accepted package" />
      </Layout>
    );
  if (submitted) return <BindingDone view={{ ...data, submitted }} partner={partner} />;
  if (data.submitted) return <BindingDone view={data} partner={partner} />;
  return <BindingForm view={data} token={session.token} partner={partner} sess={sess} hero={hero} onDone={setSubmitted} onSessionEnd={onSessionEnd} />;
}

function BindingDone({ view, partner }: { view: BindingView; partner: string }) {
  const s = view.submitted!;
  // What WorkHub24 does after binding. Payment is not part of the pilot (config.paymentEnabled).
  const steps = [
    { title: 'The customer gets an SMS that the policy is issued' },
    { title: 'The finance partner gets the policy by email' },
    ...(config.paymentEnabled
      ? [{ title: 'You confirm the premium payment', text: 'You will get an email with a link to record the payment once it is received.' }]
      : []),
  ];
  return (
    <Layout wide partner={partner} hero={{ eyebrow: `Request ${view.request.requestNo} · ${view.insurerName}`, title: 'Policy submitted.', lede: 'The customer and the finance partner have been notified.' }}>
      <div className="refno">
        <span className="eyebrow">Policy number</span>
        {/* The policy number the insurer typed on this screen (WF-01 J3 policyNumber), never the request number. */}
        <span className="num" data-testid="policy-number">{s.policyNumber}</span>
        <p>
          Valid {longDate(view.policyStartDate)} to {longDate(s.expiryDate)} · {s.documents} document{s.documents === 1 ? '' : 's'} uploaded · Submitted {dateTime(s.submittedAt)}
        </p>
      </div>
      <div>
        <h2 className="sec-title" style={{ fontSize: 'clamp(28px,3vw,40px)' }}>
          What happens next<sup>(01–{String(steps.length).padStart(2, '0')})</sup>
        </h2>
        <NextSteps items={steps} />
      </div>
    </Layout>
  );
}

function BindingForm(p: {
  view: BindingView;
  token: string;
  partner: string;
  sess: { email: string; expiresAt: string; scope: string };
  hero: { eyebrow: string; title: string; lede: string };
  onDone: (submitted: NonNullable<BindingView['submitted']>) => void;
  onSessionEnd: () => void;
}) {
  const api = useApi();
  const f = useForm({ 'b-qref': '', 'b-pol': '', 'b-start': p.view.policyStartDate, 'b-exp': '', 'b-rem': '' });
  const [qFiles, setQFiles] = useState<File[]>([]);
  const [pFiles, setPFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const v = f.values;

  const R: Rule[] = [
    { id: 'b-qref', label: 'Quotation ref No', rules: [V.required] },
    { id: 'b-pol', label: 'Policy number', rules: [V.required] },
    { id: 'b-start', label: 'Policy start date', rules: [V.date] },
    { id: 'b-exp', label: 'Policy expiry date', rules: [V.date] },
  ];
  const byId = Object.fromEntries(R.map((x) => [x.id, x]));
  const extra: Record<string, string> = {};
  if (v['b-exp'] && v['b-start'] && v['b-exp'] <= v['b-start']) extra['b-exp'] = 'Expiry date must be after the start date';

  const fileErrors = (): FieldError[] => {
    const out: FieldError[] = [];
    if (!qFiles.length) out.push({ id: 'b-qfile', label: 'Quotation document', msg: 'Upload the quotation document' });
    else {
      const m = fileError(qFiles[0], ['pdf'], config.maxFileBytes);
      if (m) out.push({ id: 'b-qfile', label: 'Quotation document', msg: m });
    }
    if (!pFiles.length) out.push({ id: 'b-pfiles', label: 'Policy documents', msg: 'Upload at least one policy document' });
    else {
      const m = pFiles.map((x) => fileError(x, ['pdf', 'jpg', 'jpeg', 'png'], config.maxFileBytes)).find(Boolean);
      if (m) out.push({ id: 'b-pfiles', label: 'Policy documents', msg: m });
    }
    return out;
  };
  const showFileErr = f.forced || qFiles.length > 0 || pFiles.length > 0;
  const fe = showFileErr ? fileErrors() : [];
  const feOf = (id: string) => (f.forced || (id === 'b-qfile' ? qFiles.length : pFiles.length) ? fe.find((e) => e.id === id)?.msg : undefined);
  const errors = f.forced ? [...f.allErrors(R, extra), ...fileErrors()] : [];

  const bind = (id: string) => ({
    id,
    value: v[id] ?? '',
    onChange: (x: string) => f.set(id, x),
    onBlur: () => f.touch(id),
    error: f.errorOf(byId[id], f.touched[id] || f.forced ? extra : {}),
    valid: byId[id] ? f.isValid(byId[id]) && !extra[id] : false,
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (f.allErrors(R, extra).length || fileErrors().length) {
      f.setForced(true);
      focusSummary();
      return;
    }
    setBusy(true);
    setBanner('');
    try {
      await api.submitBinding(p.token, p.view.request.requestNo, {
        quotationRef: v['b-qref'].trim(),
        quotationFile: qFiles[0],
        policyNumber: v['b-pol'].trim(),
        policyStartDate: v['b-start'],
        policyExpiryDate: v['b-exp'],
        policyFiles: pFiles,
        remarks: v['b-rem'].trim() || undefined,
      });
      p.onDone({
        policyNumber: v['b-pol'].trim(),
        submittedAt: new Date().toISOString(),
        expiryDate: v['b-exp'],
        documents: pFiles.length + 1,
      });
    } catch (e2) {
      const er = e2 as ApiError;
      if (er.code === 'SESSION_EXPIRED') return p.onSessionEnd();
      if (er.code === 'ALREADY_SUBMITTED') {
        setBanner('This step has already been submitted.');
        return;
      }
      setBanner(er.message || 'The policy could not be submitted. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const a = p.view.accepted;
  return (
    <Layout hero={p.hero} partner={p.partner} session={p.sess}>
      <div className="aside">
        <SecTitle title="Binding" num="04" desc="Issue the policy for the accepted package." />
        <Guide
          title="How to complete binding"
          tips={['Check the accepted package and customer details below.', 'Upload the quotation for the accepted package and enter its reference.', 'Enter the policy number and dates, then upload the policy schedule and any cover note.']}
          ready={['Quotation PDF', 'Policy schedule', 'Cover note']}
        />
        <Card title="Accepted package">
          <DefList
            className="facts"
            rows={[
              ['Package', `${a.packageName} · ${a.packageRef}`],
              ['Total premium', `LKR ${money(a.total)}`],
              ['Accepted', dateTime(a.acceptedAt)],
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
        <div className="group-head">
          <h4>Policyholder</h4>
          <span>Now shared with you to issue the policy</span>
        </div>
        <DefList
          rows={[
            ['Customer name', p.view.customer.name],
            ['NIC / BR No', p.view.customer.idNumber],
            ['Mobile', p.view.customer.mobile],
            ['Address', p.view.customer.address],
            ['Vehicle', `${p.view.vehicle.description}${p.view.vehicle.registrationNo ? ' · ' + p.view.vehicle.registrationNo : ''}`],
            ['Chassis No', p.view.vehicle.chassisNo],
            ['Engine No', p.view.vehicle.engineNo],
            ['Interested party', p.view.interestedParty],
          ]}
        />
        <span className="legend-key">
          <span className="req">*</span> Required field
        </span>
        <div className="grid">
          <GroupHead title="Quotation" sub="For the accepted package" />
          <TextField {...bind('b-qref')} label="Quotation ref No" fmt="As on your quotation" required />
          <div />
          <FileDrop id="b-qfile" label="Quotation document" hint="PDF · up to 10 MB" accept={['pdf']} files={qFiles} onChange={setQFiles} error={feOf('b-qfile')} />
          <GroupHead title="Policy" sub="Dates drive the renewal alert" />
          <TextField {...bind('b-pol')} label="Policy number" fmt="As issued" required />
          <div />
          <TextField {...bind('b-start')} label="Policy start date" type="date" hint="From the request" required />
          <TextField {...bind('b-exp')} label="Policy expiry date" type="date" hint="Must be after the start date" required />
          <FileDrop
            id="b-pfiles"
            label="Policy documents"
            hint="Policy schedule, cover note · PDF, JPG or PNG · up to 10 MB each"
            accept={['pdf', 'jpg', 'jpeg', 'png']}
            multiple
            files={pFiles}
            onChange={setPFiles}
            error={feOf('b-pfiles')}
          />
          <TextAreaField {...bind('b-rem')} label="Remarks" maxLength={300} hint="Up to 300 characters" optional full />
        </div>
        <Actions left={<span className="note">Submitting locks this screen</span>}>
          <Button loading={busy}>Submit policy</Button>
        </Actions>
      </form>
    </Layout>
  );
}
