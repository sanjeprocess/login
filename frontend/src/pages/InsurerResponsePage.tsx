import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api/client';
import { ApiError, type CoverType, type InsurerResponseView, type RequestSummary, type Session, type StoredPackage } from '../api/types';
import { Layout } from '../components/Layout';
import { LinkError } from '../components/LinkError';
import { OtpGate } from '../components/OtpGate';
import { Actions, Button, Callout, Card, Chips, DefList, ErrorSummary, GroupHead, Guide, Loading, NextSteps, SecTitle, SelectField, TextAreaField, TextField } from '../components/ui';
import { focusSummary, useForm, type Rule } from '../lib/form';
import { dateTime, formatAmountInput, longDate, money } from '../lib/format';
import { sessionKey, useSession } from '../lib/session';
import { useLoad } from '../lib/useLoad';
import { parseAmount, V } from '../lib/validators';
import { OPTIONAL_COVERS } from './StartRequestPage';

export function RequestCard({ r, note = true }: { r: RequestSummary; note?: boolean }) {
  return (
    <Card title="This request">
      <DefList
        className="facts"
        rows={[
          ['Request No', r.requestNo],
          ['Vehicle', r.vehicle],
          ['Category', r.category],
          ['Usage', r.usage],
          ['Cover type', r.coverType],
          ['Sum insured', `LKR ${money(r.sumInsured)}`],
          ['Policy start', longDate(r.policyStartDate)],
          ['Optional covers', r.optionalCovers.length ? r.optionalCovers.join(', ') : 'None'],
        ]}
      />
      {note ? (
        <p className="hint" style={{ margin: 0 }}>
          Customer and finance details are not shared at this stage.
        </p>
      ) : null}
    </Card>
  );
}

export function InsurerResponsePage() {
  const [params] = useSearchParams();
  const requestNo = params.get('req') || '';
  const { session, setSession, expired } = useSession(sessionKey('insurer-response', requestNo));
  if (!requestNo) return <LinkError code="LINK_INVALID" />;
  if (!session) return <OtpGate purpose="insurer_signin" requestNo={requestNo} onVerified={setSession} sessionEnded={expired} context={`Request ${requestNo}`} />;
  return <InsurerResponse requestNo={requestNo} session={session} onSessionEnd={() => setSession(null)} />;
}

function InsurerResponse({ requestNo, session, onSessionEnd }: { requestNo: string; session: Session; onSessionEnd: () => void }) {
  const api = useApi();
  const { data, error, loading } = useLoad(() => api.getInsurerResponse(session.token, requestNo), [requestNo, session.token]);
  const partner = [session.user.insurer, session.user.department].filter(Boolean).join(' · ');
  const sess = { email: session.user.email, expiresAt: session.expiresAt, scope: `This link is for ${requestNo} only` };
  const hero = { eyebrow: `Request ${requestNo} · ${session.user.insurer ?? ''}`, title: 'Send your package.', lede: 'Pick one of your stored packages that matches this request, or enter a new one. Your response goes to the broker.' };

  useEffect(() => {
    if (error?.code === 'SESSION_EXPIRED') onSessionEnd();
  }, [error, onSessionEnd]);
  if (error?.code === 'SESSION_EXPIRED') return null;
  if (error) return <LinkError code={error.code} requestNo={requestNo} />;
  if (loading || !data)
    return (
      <Layout hero={hero} partner={partner} session={sess}>
        <Loading text="Loading your matching packages" />
      </Layout>
    );
  if (data.submission) return <Submitted view={data} partner={partner} />;
    return <ResponseForm view={data} requestNo={requestNo} token={session.token} submittedBy={session.user.email} partner={partner} sess={sess} hero={hero} onSessionEnd={onSessionEnd} />;
}

function Submitted({ view, partner }: { view: InsurerResponseView; partner: string }) {
  const s = view.submission!;
  const pk = s.package;
  return (
    <Layout partner={partner} hero={{ eyebrow: `Request ${view.request.requestNo} · ${view.insurerName}`, title: 'Response received.', lede: 'The broker has your package. You will get another email if the customer chooses it.' }}>
      <div className="aside">
        <SecTitle title="Submitted" num="02" desc="Your response is locked. Contact the broker if something needs to change." />
        <RequestCard r={view.request} />
      </div>
      <div className="form">
        <Callout tag="Received" variant="ok">
          {s.submittedAt ? `Submitted on ${dateTime(s.submittedAt)} by ${s.submittedBy}` : `Response saved by ${s.submittedBy}.`}
        </Callout>
        <div className="group-head">
          <h4>Your package</h4>
          <span>{pk.packageRef}</span>
        </div>
        <DefList
          rows={[
            ['Package', pk.name],
            ['Premium rate', `${pk.premiumRate.toFixed(2)}%`],
            ['Premium', `LKR ${money(pk.premium)}`],
            ['Taxes', `LKR ${money(pk.taxes)}`],
            ['Total premium', `LKR ${money(pk.total)}`],
            ['Excess', `LKR ${money(pk.excess)}`],
            ['Standard covers', pk.standardCovers],
            ['Optional covers', pk.optionalCovers.join(', ') || 'None'],
            ['Valid until', longDate(pk.validUntil)],
          ]}
        />
        <NextSteps
          items={[
            { title: 'The finance partner compares packages', text: 'They review all insurers’ packages with the customer.' },
            { title: 'If the customer chooses yours', text: 'You get an email with a link to upload the quotation and policy documents.' },
          ]}
        />
      </div>
    </Layout>
  );
}

function ResponseForm(p: {
  view: InsurerResponseView;
  requestNo: string;
  token: string;
  submittedBy: string;
  partner: string;
  sess: { email: string; expiresAt: string; scope: string };
  hero: { eyebrow: string; title: string; lede: string };
  onSessionEnd: () => void;
}) {
  const api = useApi();
  const r = p.view.request;
  const empty = p.view.recommended.length === 0;
  const [mode, setMode] = useState<'stored' | 'new'>(empty ? 'new' : 'stored');
  const [pick, setPick] = useState(p.view.recommended[0]?.packageRef ?? '');
  const [optCovers, setOptCovers] = useState<string[]>(r.optionalCovers);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [sentView, setSentView] = useState<InsurerResponseView | null>(null);
  const f = useForm({
    'n-name': '',
    'n-cover': r.coverType,
    'n-cat': r.category,
    'n-min': '',
    'n-max': '',
    'n-rate': '',
    'n-tax': '',
    'n-excess': '',
    'n-std': '',
    'n-valid': '',
    'r-rem': '',
  });
  const v = f.values;
  const isNew = mode === 'new';
  const rate = parseFloat(v['n-rate']) || 0;
  const premium = Math.round(((r.sumInsured * rate) / 100) * 100) / 100;

  const R: Rule[] = isNew
    ? [
        { id: 'n-name', label: 'Package name', rules: [V.required] },
        { id: 'n-min', label: 'Sum insured from', rules: [V.amount] },
        { id: 'n-max', label: 'Sum insured to', rules: [V.amount] },
        { id: 'n-rate', label: 'Premium rate', rules: [V.rate] },
        { id: 'n-tax', label: 'Taxes', rules: [V.amountOrZero] },
        { id: 'n-excess', label: 'Excess', rules: [V.amountOrZero] },
        { id: 'n-std', label: 'Standard covers', rules: [V.required] },
        { id: 'n-valid', label: 'Valid until', rules: [V.dateFromToday] },
      ]
    : [];
  const min = parseAmount(v['n-min']);
  const max = parseAmount(v['n-max']);
  const extra: Record<string, string> = {};
  if (isNew && min > 0 && max > 0 && max <= min) extra['n-max'] = 'Must be more than “Sum insured from”';
  const byId = Object.fromEntries(R.map((x) => [x.id, x]));
  const err = (id: string) => f.errorOf(byId[id], f.touched[id] || f.forced ? extra : {});
  const bind = (id: string, isMoney = false) => ({
    id,
    value: v[id] ?? '',
    onChange: (x: string) => f.set(id, x),
    onBlur: () => {
      if (isMoney) f.set(id, formatAmountInput(v[id] ?? ''));
      f.touch(id);
    },
    error: err(id),
    valid: byId[id] ? f.isValid(byId[id]) && !extra[id] : false,
  });
  const outOfRange = isNew && min > 0 && max > min && (r.sumInsured < min || r.sumInsured > max);
  const errors = f.forced ? f.allErrors(R, extra) : [];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (isNew && f.allErrors(R, extra).length) {
      f.setForced(true);
      focusSummary();
      return;
    }
    setBusy(true);
    setBanner('');
    try {
      let submittedPackage: StoredPackage;
      if (isNew) {
        submittedPackage = {
            packageRef: `${p.view.insurerName.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}-NEW-${p.requestNo}`,
            name: v['n-name'].trim(),
            premiumRate: rate,
            premium,
            taxes: parseAmount(v['n-tax']),
            total: Math.round((premium + parseAmount(v['n-tax'])) * 100) / 100,
            excess: parseAmount(v['n-excess']),
            validUntil: v['n-valid'],
            standardCovers: v['n-std'].trim(),
            optionalCovers: optCovers,
          };
      } else {
        const selectedPackage = p.view.recommended.find((pkg) => pkg.packageRef === pick);
        if (!selectedPackage) {
          setBanner('Choose one of the listed packages.');
          return;
        }
        submittedPackage = selectedPackage;
      }
      await api.submitInsurerResponse(
        p.token,
        p.requestNo,
        isNew
          ? {
              mode: 'new',
              remarks: v['r-rem'].trim() || undefined,
              package: {
                name: v['n-name'].trim(),
                coverType: v['n-cover'] as CoverType,
                vehicleCategory: v['n-cat'],
                sumMin: min,
                sumMax: max,
                premiumRate: rate,
                taxes: parseAmount(v['n-tax']),
                excess: parseAmount(v['n-excess']),
                standardCovers: v['n-std'].trim(),
                optionalCovers: optCovers,
                validUntil: v['n-valid'],
              },
            }
          : { mode: 'stored', packageRef: pick, remarks: v['r-rem'].trim() || undefined },
      );
      setSentView({
        ...p.view,
        submission: {
          submittedBy: p.submittedBy,
          submittedAt: new Date().toISOString(),
          package: submittedPackage,
        },
      });
    } catch (e2) {
      const er = e2 as ApiError;
      if (er.code === 'SESSION_EXPIRED') return p.onSessionEnd();
      if (er.code === 'ALREADY_SUBMITTED') {
        setBanner('This step has already been submitted.');
        return;
      }
      setBanner(er.message || 'Your response could not be sent. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (sentView) return <Submitted view={sentView} partner={p.partner} />;

  return (
    <Layout hero={p.hero} partner={p.partner} session={p.sess}>
      <div className="aside">
        <SecTitle title="Your response" num="02" desc="One response per request. You cannot edit it after you submit." />
        <Guide
          title="How to respond"
          tips={
            empty
              ? ['None of your stored packages match this vehicle and cover.', 'Enter a new package below. It is saved for future requests that match.', 'Check the premium rate. The premium is calculated from it.']
              : [
                  'Packages below are your stored packages that match this vehicle, cover type and sum insured.',
                  'Pick the one you want to offer, or choose “Enter a new package”.',
                  'A new package is saved and offered automatically on future matching requests.',
                ]
          }
          ready={['Your current rate card']}
        />
        <RequestCard r={r} />
      </div>

      <form className="form" noValidate onSubmit={onSubmit}>
        {banner ? (
          <div className="summary" role="alert">
            <strong>{banner}</strong>
          </div>
        ) : null}
        <ErrorSummary errors={errors} />

        {empty ? (
          <Callout tag="No matches" variant="warn">
            None of your stored packages match a {r.coverType} cover for a {r.category.toLowerCase()} with a sum insured of LKR {money(r.sumInsured)}. Enter a new package below.
          </Callout>
        ) : (
          <>
            <div className="group-head">
              <h4>Recommended packages</h4>
              <span>
                {p.view.recommended.length} match{p.view.recommended.length > 1 ? 'es' : ''} · calculated for LKR {money(r.sumInsured)}
              </span>
            </div>
            <div className="picker" role="radiogroup" aria-label="Recommended packages">
              {p.view.recommended.map((pk) => {
                const on = !isNew && pick === pk.packageRef;
                return (
                  <label key={pk.packageRef} className={`pick${on ? ' on' : ''}`}>
                    <input
                      type="radio"
                      name="pkg"
                      checked={on}
                      onChange={() => {
                        setMode('stored');
                        setPick(pk.packageRef);
                        f.setForced(false);
                      }}
                    />
                    <div>
                      <div className="top">
                        <span>
                          <span className="name">{pk.name}</span>
                          <span className="ref">{pk.packageRef}</span>
                        </span>
                        <span className="total">
                          <small>Total</small>LKR {money(pk.total)}
                        </span>
                      </div>
                      <dl className="figs">
                        <div>
                          <dt>Rate</dt>
                          <dd>{pk.premiumRate.toFixed(2)}%</dd>
                        </div>
                        <div>
                          <dt>Premium</dt>
                          <dd>{money(pk.premium)}</dd>
                        </div>
                        <div>
                          <dt>Taxes</dt>
                          <dd>{money(pk.taxes)}</dd>
                        </div>
                        <div>
                          <dt>Excess</dt>
                          <dd>{money(pk.excess)}</dd>
                        </div>
                        <div>
                          <dt>Valid until</dt>
                          <dd>{longDate(pk.validUntil)}</dd>
                        </div>
                      </dl>
                      <div className="covers">
                        {pk.standardCovers} · Optional: {pk.optionalCovers.join(', ') || 'None'}
                      </div>
                    </div>
                  </label>
                );
              })}
              <label className={`pick newpkg${isNew ? ' on' : ''}`}>
                <input type="radio" name="pkg" checked={isNew} onChange={() => setMode('new')} />
                <div>
                  <span className="name">None of these: enter a new package</span>
                  <div className="covers">It will be saved for future matching requests.</div>
                </div>
              </label>
            </div>
          </>
        )}

        {isNew ? (
          <div className="grid">
            <GroupHead title="New package" sub="Saved to your package list on submit" />
            <TextField {...bind('n-name')} label="Package name" hint="Shown to the finance partner" required full />
            <SelectField id="n-cover" label="Cover type" value={v['n-cover']} onChange={(x) => f.set('n-cover', x)} options={['Comprehensive', 'Third Party']} required />
            <SelectField id="n-cat" label="Applies to vehicle category" value={v['n-cat']} onChange={(x) => f.set('n-cat', x)} options={p.view.vehicleCategories} hint="Used for future matching" required />
            <TextField {...bind('n-min', true)} label="Sum insured from" prefix="LKR" inputMode="decimal" placeholder="0.00" hint="Lower end of the range this package covers" required />
            <TextField {...bind('n-max', true)} label="Sum insured to" prefix="LKR" inputMode="decimal" placeholder="0.00" hint="Upper end of the range" required />
            {outOfRange ? (
              <div className="full">
                <Callout tag="Check range" variant="warn">
                  This request’s sum insured (LKR {money(r.sumInsured)}) is outside the range you entered. The package is still offered for this request.
                </Callout>
              </div>
            ) : null}
            <GroupHead title="Pricing" sub="Premium = sum insured × rate" />
            <TextField {...bind('n-rate')} label="Premium rate" suffix="%" inputMode="decimal" placeholder="e.g. 2.95" fmt="0.01 to 10.00" required />
            <div className="field">
              <span className="legend">Premium (calculated)</span>
              <span className="calc" data-testid="calc-premium">
                LKR {money(premium)}
              </span>
              <span className="hint">
                LKR {money(r.sumInsured)} × {rate ? rate.toFixed(2) : '0.00'}%
              </span>
            </div>
            <TextField {...bind('n-tax', true)} label="Taxes" prefix="LKR" inputMode="decimal" placeholder="0.00" hint="VAT and government levies" required />
            <TextField {...bind('n-excess', true)} label="Excess" prefix="LKR" inputMode="decimal" placeholder="0.00" required />
            <GroupHead title="Cover details" sub="What the package includes" />
            <TextAreaField {...bind('n-std')} label="Standard covers" placeholder="e.g. Own damage, theft, third party liability" required full />
            <Chips id="n-opt" label="Optional covers included" options={OPTIONAL_COVERS} values={optCovers} onChange={setOptCovers} optional full />
            <TextField {...bind('n-valid')} label="Valid until" type="date" hint="Last date this price applies" required />
          </div>
        ) : null}

        <div className="grid">
          <TextAreaField
            id="r-rem"
            label="Remarks to the finance partner"
            value={v['r-rem']}
            onChange={(x) => f.set('r-rem', x)}
            placeholder="e.g. inspection requirements or conditions"
            maxLength={300}
            hint="Up to 300 characters"
            optional
            full
          />
        </div>
        <Callout tag="Before you submit">Your package is shown to the finance partner next to other insurers’ packages. Check the total premium and validity date.</Callout>
        <Actions left={<span className="note">One response per request</span>}>
          <Button loading={busy}>Submit response</Button>
        </Actions>
      </form>
    </Layout>
  );
}
