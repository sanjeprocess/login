import { useState, type FormEvent } from 'react';
import { useApi } from '../api/client';
import { ApiError, type CoverType, type CustomerType, type FacilityType, type RequestPayload, type VehicleCondition, type VehicleUsage } from '../api/types';
import { Layout } from '../components/Layout';
import { OtpGate } from '../components/OtpGate';
import {
  Actions,
  Button,
  Callout,
  Checkbox,
  Chips,
  DefList,
  ErrorSummary,
  GroupHead,
  Guide,
  NextSteps,
  ProgressBar,
  SecTitle,
  Segmented,
  SelectField,
  StepList,
  TextAreaField,
  TextButton,
  TextField,
  type FieldError,
  type StepState,
} from '../components/ui';
import { focusSummary, useForm, type Rule } from '../lib/form';
import { formatAmountInput, formatMobile, longDate, money, pad2 } from '../lib/format';
import { sessionKey, useSession } from '../lib/session';
import { parseAmount, V } from '../lib/validators';

export const VEHICLE_CATEGORIES = ['Motor car', 'Dual purpose (van / cab)', 'SUV / Jeep', 'Motorcycle', 'Three-wheeler', 'Lorry', 'Bus'];
export const OPTIONAL_COVERS = ['SRCC', 'Terrorism', 'Flood'];

const STEPS = [
  {
    title: 'Customer',
    desc: 'Who the policy is for',
    tips: [
      'Enter details exactly as they appear on the customer’s NIC or business registration certificate.',
      'Check the mobile number with the customer. It receives the OTP they use to confirm their package.',
      'Email is optional. Leave it blank if the customer has none.',
    ],
    ready: ['NIC or BR certificate', 'Customer mobile', 'Customer address'],
  },
  {
    title: 'Vehicle',
    desc: 'The vehicle to insure',
    tips: [
      'Take details from the CR book. For a brand-new vehicle, use the dealer invoice.',
      'The chassis number is checked so the same vehicle is not requested twice.',
      'Vehicle value is what the vehicle is worth today, in LKR.',
    ],
    ready: ['CR book or dealer invoice', 'Chassis and engine numbers'],
  },
  {
    title: 'Finance',
    desc: 'Lease or loan details',
    tips: ['Use the facility reference from your loan system so the policy links to the right facility.', 'These details stay with the broker and your company. Insurers never see them.'],
    ready: ['Facility reference No', 'Approved facility amount', 'Tenure'],
  },
  {
    title: 'Cover',
    desc: 'What to insure and when',
    tips: [
      'Insurers price their packages on cover type and sum insured, so confirm both with the customer.',
      'Sum insured is pre-filled from the vehicle value. Change it only if the customer asks.',
      'Optional covers are add-ons. Insurers state which ones each package includes.',
    ],
    ready: ['Customer’s cover choice', 'Policy start date'],
  },
  {
    title: 'Declaration',
    desc: 'Customer consent',
    tips: ['Read the consent statement to the customer before you tick it.', 'You cannot submit without consent.'],
    ready: ['Customer present or consent on file'],
  },
];

const EMPTY = {
  'c-name': '',
  'c-id': '',
  'c-mobile': '',
  'c-email': '',
  'c-addr': '',
  'v-cat': VEHICLE_CATEGORIES[0],
  'v-year': '',
  'v-make': '',
  'v-model': '',
  'v-reg': '',
  'v-chassis': '',
  'v-engine': '',
  'v-value': '',
  'f-ref': '',
  'f-amt': '',
  'f-ten': '',
  'cv-sum': '',
  'cv-start': '',
  'cv-rem': '',
};

export function StartRequestPage() {
  const key = sessionKey('start');
  const { session, setSession, expired } = useSession(key);
  if (!session) return <OtpGate purpose="finance_signin" onVerified={setSession} sessionEnded={expired} context="New insurance request" />;
  return <RequestForm token={session.token} user={session.user} expiresAt={session.expiresAt} onSessionEnd={() => setSession(null)} />;
}

function RequestForm(p: { token: string; user: { name: string; email: string; partner?: string; branch?: string }; expiresAt: string; onSessionEnd: () => void }) {
  const api = useApi();
  const f = useForm(EMPTY);
  const [view, setView] = useState<'step' | 'review' | 'submitted'>('step');
  const [step, setStep] = useState(0);
  const [custType, setCustType] = useState<CustomerType>('Individual');
  const [cond, setCond] = useState<VehicleCondition>('Registered');
  const [usage, setUsage] = useState<VehicleUsage>('Private');
  const [fac, setFac] = useState<FacilityType>('Lease');
  const [cover, setCover] = useState<CoverType>('Comprehensive');
  const [opts, setOpts] = useState<string[]>([]);
  const [decl, setDecl] = useState(false);
  const [declShown, setDeclShown] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState('');
  const [requestNo, setRequestNo] = useState('');
  const [copied, setCopied] = useState(false);

  const co = custType === 'Company';
  const R: Record<string, Rule> = {
    'c-name': { id: 'c-name', label: co ? 'Company name' : 'Customer name', rules: [V.required] },
    'c-id': { id: 'c-id', label: co ? 'Business Reg. No' : 'NIC', rules: [V.required, co ? V.brn : V.nic] },
    'c-mobile': { id: 'c-mobile', label: 'Customer mobile', rules: [V.required, V.mobile] },
    'c-email': { id: 'c-email', label: 'Customer email', rules: [V.email] },
    'c-addr': { id: 'c-addr', label: 'Customer address', rules: [V.required] },
    'v-year': { id: 'v-year', label: 'Year of manufacture', rules: [V.required, V.year] },
    'v-make': { id: 'v-make', label: 'Make', rules: [V.required] },
    'v-model': { id: 'v-model', label: 'Model', rules: [V.required] },
    'v-reg': { id: 'v-reg', label: 'Registration No', rules: [V.required], when: () => cond === 'Registered' },
    'v-chassis': { id: 'v-chassis', label: 'Chassis No', rules: [V.required] },
    'v-engine': { id: 'v-engine', label: 'Engine No', rules: [V.required] },
    'v-value': { id: 'v-value', label: 'Vehicle value', rules: [V.amount] },
    'f-ref': { id: 'f-ref', label: 'Facility reference No', rules: [V.required] },
    'f-amt': { id: 'f-amt', label: 'Facility amount', rules: [V.amount] },
    'f-ten': { id: 'f-ten', label: 'Tenure', rules: [V.tenure] },
    'cv-sum': { id: 'cv-sum', label: 'Sum insured', rules: [V.amount] },
    'cv-start': { id: 'cv-start', label: 'Policy start date', rules: [V.dateFromToday] },
  };
  const STEP_FIELDS = [
    ['c-name', 'c-id', 'c-mobile', 'c-email', 'c-addr'],
    ['v-year', 'v-make', 'v-model', 'v-reg', 'v-chassis', 'v-engine', 'v-value'],
    ['f-ref', 'f-amt', 'f-ten'],
    ['cv-sum', 'cv-start'],
    [],
  ];
  const stepRules = (i: number) => STEP_FIELDS[i].map((id) => R[id]);

  const v = f.values;
  const err = (id: string) => f.errorOf(R[id], server);
  const ok = (id: string) => (R[id] ? f.isValid(R[id]) : false);
  const bind = (id: string, fmtOpts: { money?: boolean; mobile?: boolean } = {}) => ({
    id,
    value: v[id] ?? '',
    onChange: (x: string) => {
      f.set(id, x);
      if (server[id]) setServer((s) => ({ ...s, [id]: '' }));
    },
    onBlur: () => {
      if (fmtOpts.money) f.set(id, formatAmountInput(v[id] ?? ''));
      if (fmtOpts.mobile) f.set(id, formatMobile(v[id] ?? ''));
      f.touch(id);
    },
    error: err(id),
    valid: ok(id),
  });

  function goStep(i: number) {
    f.setForced(false);
    setBanner('');
    if (i === 3 && !v['cv-sum'] && v['v-value']) f.set('cv-sum', v['v-value']);
    setStep(i);
    setView('step');
    window.scrollTo?.(0, 0);
  }

  const errorsNow: FieldError[] =
    view === 'step' && (f.forced || declShown)
      ? step === 4
        ? decl
          ? []
          : [{ id: 'decl', label: 'Declaration', msg: 'Tick the declaration to continue' }]
        : f.allErrors(stepRules(step), server)
      : [];

  async function onContinue(e: FormEvent) {
    e.preventDefault();
    if (step === 4) {
      if (!decl) {
        setDeclShown(true);
        focusSummary();
        return;
      }
      setView('review');
      window.scrollTo?.(0, 0);
      return;
    }
    const errs = f.allErrors(stepRules(step), server);
    if (errs.length) {
      f.setForced(true);
      focusSummary();
      return;
    }
    if (step === 1) {
      setBusy(true);
      try {
        const r = await api.checkChassis(p.token, v['v-chassis'].trim());
        if (r.exists) {
          setServer((s) => ({ ...s, 'v-chassis': 'A request already exists for this chassis number' }));
          f.setForced(true);
          focusSummary();
          return;
        }
      } catch (e2) {
        if ((e2 as ApiError).code === 'SESSION_EXPIRED') return p.onSessionEnd();
      } finally {
        setBusy(false);
      }
    }
    goStep(step + 1);
  }

  function payload(): RequestPayload {
    return {
      customer: { type: custType, name: v['c-name'].trim(), idNumber: v['c-id'].trim().toUpperCase(), mobile: v['c-mobile'].replace(/\s/g, ''), email: v['c-email'].trim() || undefined, address: v['c-addr'].trim() },
      vehicle: {
        category: v['v-cat'],
        make: v['v-make'].trim(),
        model: v['v-model'].trim(),
        year: Number(v['v-year']),
        condition: cond,
        registrationNo: cond === 'Registered' ? v['v-reg'].trim().toUpperCase() : undefined,
        chassisNo: v['v-chassis'].trim().toUpperCase(),
        engineNo: v['v-engine'].trim().toUpperCase(),
        value: parseAmount(v['v-value']),
        usage,
      },
      finance: { facilityType: fac, referenceNo: v['f-ref'].trim().toUpperCase(), amount: parseAmount(v['f-amt']), tenureMonths: Number(v['f-ten']) },
      cover: { coverType: cover, sumInsured: parseAmount(v['cv-sum']), optionalCovers: opts, policyStartDate: v['cv-start'], remarks: v['cv-rem'].trim() || undefined },
      consent: true,
    };
  }

  async function onSubmit() {
    if (!confirm) return;
    setBusy(true);
    setBanner('');
    try {
      const r = await api.submitRequest(p.token, payload());
      setRequestNo(r.requestNo);
      setView('submitted');
      window.scrollTo?.(0, 0);
    } catch (e) {
      const er = e as ApiError;
      if (er.code === 'SESSION_EXPIRED') return p.onSessionEnd();
      if (er.code === 'DUPLICATE_CHASSIS' || er.fields) {
        setServer(er.fields ?? { 'v-chassis': 'A request already exists for this chassis number' });
        goStep(1);
        f.setForced(true);
        return;
      }
      setBanner(er.message || 'The request could not be submitted. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    f.setValues(EMPTY);
    setCustType('Individual');
    setCond('Registered');
    setUsage('Private');
    setFac('Lease');
    setCover('Comprehensive');
    setOpts([]);
    setDecl(false);
    setDeclShown(false);
    setConfirm(false);
    setServer({});
    setCopied(false);
    goStep(0);
  }

  const partner = [p.user.partner, p.user.branch].filter(Boolean).join(' · ');
  const sessionInfo = { email: p.user.email, expiresAt: p.expiresAt };

  /* ---------- submitted ---------- */
  if (view === 'submitted') {
    return (
      <Layout wide partner={partner} hero={{ eyebrow: `Submitted · ${requestNo}`, title: 'Request sent.', lede: 'The broker now has your request and will collect packages from insurers.' }}>
        <div className="refno">
          <span className="eyebrow">Request No</span>
          <span className="num" data-testid="request-no">
            {requestNo}
          </span>
          <p>Quote this number if you contact the broker about this request.</p>
          <div>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                navigator.clipboard?.writeText(requestNo).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy request number'}
            </button>
          </div>
        </div>
        <div>
          <h2 className="sec-title" style={{ fontSize: 'clamp(28px,3vw,40px)' }}>
            What happens next<sup>(01–03)</sup>
          </h2>
          <NextSteps
            items={[
              { title: 'The broker reviews your request', text: 'They check the details and choose which insurers to send it to.' },
              { title: 'Insurers send their packages', text: 'Each selected insurer responds with a package for this vehicle and cover.' },
              { title: 'You get an email to compare', text: 'Open the link, review the packages with the customer, and confirm the choice with the customer’s OTP.' },
            ]}
          />
          <div style={{ marginTop: 32 }}>
            <Button type="button" onClick={reset}>
              Start another request
            </Button>
          </div>
        </div>
      </Layout>
    );
  }

  /* ---------- review ---------- */
  if (view === 'review') {
    const groups: [string, number, [string, string][]][] = [
      [
        'Customer',
        0,
        [
          ['Customer type', custType],
          [R['c-name'].label, v['c-name']],
          [R['c-id'].label, v['c-id'].toUpperCase()],
          ['Mobile', v['c-mobile']],
          ['Email', v['c-email'] || 'Not given'],
          ['Address', v['c-addr']],
        ],
      ],
      [
        'Vehicle',
        1,
        [
          ['Vehicle', `${v['v-make']} ${v['v-model']}, ${v['v-year']}`],
          ['Category', v['v-cat']],
          ['Condition', cond],
          ...(cond === 'Registered' ? ([['Registration No', v['v-reg'].toUpperCase()]] as [string, string][]) : []),
          ['Chassis No', v['v-chassis'].toUpperCase()],
          ['Engine No', v['v-engine'].toUpperCase()],
          ['Vehicle value', `LKR ${money(parseAmount(v['v-value']))}`],
          ['Usage', usage],
        ],
      ],
      [
        'Finance',
        2,
        [
          ['Facility', `${fac}, ${v['f-ten']} months`],
          ['Reference No', v['f-ref'].toUpperCase()],
          ['Amount', `LKR ${money(parseAmount(v['f-amt']))}`],
        ],
      ],
      [
        'Cover',
        3,
        [
          ['Cover type', cover],
          ['Sum insured', `LKR ${money(parseAmount(v['cv-sum']))}`],
          ['Optional covers', opts.length ? opts.join(', ') : 'None'],
          ['Policy start date', longDate(v['cv-start'])],
          ...(v['cv-rem'] ? ([['Remarks', v['cv-rem']]] as [string, string][]) : []),
        ],
      ],
    ];
    return (
      <Layout
        partner={partner}
        session={sessionInfo}
        hero={{ eyebrow: `New request · ${p.user.name}`, title: 'Review and submit.', lede: 'Check every detail. Nothing is sent until you submit.' }}
        progress={<ProgressBar index={5} total={5} label="All steps complete · Review" />}
      >
        <div className="aside">
          <SecTitle title="Summary" num="06" desc="Use Edit to change a section, then continue back to this page." />
          <StepList items={STEPS.map((s) => ({ title: s.title, state: 'done' as StepState }))} onGo={goStep} />
          <Guide
            title="Before you submit"
            tips={[
              'Check the customer mobile with the customer. Their confirmation OTP goes to it.',
              'Check the chassis number against the CR book.',
              'After you submit, the request goes to the broker and can no longer be edited.',
            ]}
          />
        </div>
        <div className="form">
          {banner ? (
            <div className="summary" role="alert">
              <strong>{banner}</strong>
            </div>
          ) : null}
          <div className="rev">
            {groups.map(([title, i, rows]) => (
              <section key={title}>
                <header>
                  <h3>
                    <span className="mono">{pad2(i + 1)}</span>
                    {title}
                  </h3>
                  <TextButton onClick={() => goStep(i)}>Edit</TextButton>
                </header>
                <DefList className="" rows={rows} />
              </section>
            ))}
          </div>
          <Callout tag="Consent">Customer consent to share details with insurers is recorded.</Callout>
          <Checkbox id="confirm" checked={confirm} onChange={setConfirm} note="Submit becomes available once you tick this.">
            I confirm these details are correct and complete.
          </Checkbox>
          <Actions left={<TextButton onClick={() => goStep(4)}>← Back</TextButton>}>
            <Button type="button" disabled={!confirm} loading={busy} onClick={onSubmit}>
              Submit request
            </Button>
          </Actions>
        </div>
      </Layout>
    );
  }

  /* ---------- steps ---------- */
  const meta = STEPS[step];
  const stepStates: StepState[] = STEPS.map((_, i) => (i < step ? 'done' : i === step ? (errorsNow.length ? 'error' : 'current') : 'todo'));

  return (
    <Layout
      partner={partner}
      session={sessionInfo}
      hero={{ eyebrow: `New request · ${p.user.name}`, title: 'Start a cover request.', lede: 'Five short steps. The broker collects packages from insurers for you, and you compare them with the customer later.' }}
      progress={<ProgressBar index={step} total={5} label={`Step ${step + 1} of 5 · ${meta.title}`} />}
    >
      <div className="aside">
        <SecTitle title={meta.title} num={pad2(step + 1)} desc={`${meta.desc}.`} />
        <Guide title="How to complete this step" tips={meta.tips} ready={meta.ready} />
        <StepList items={STEPS.map((s, i) => ({ title: s.title, state: stepStates[i] }))} onGo={(i) => i < step && goStep(i)} />
      </div>

      <form className="form" noValidate onSubmit={onContinue} aria-label={`${meta.title} details`}>
        <ErrorSummary errors={errorsNow} />

        {step === 0 && (
          <>
            <span className="legend-key">
              <span className="req">*</span> Required field
            </span>
            <div className="grid">
              <GroupHead title="Identity" sub="As on the NIC or registration certificate" />
              <Segmented id="c-type" label="Customer type" options={['Individual', 'Company'] as CustomerType[]} value={custType} onChange={setCustType} full />
              <TextField {...bind('c-name')} label={R['c-name'].label} placeholder={co ? 'Registered company name' : 'Full name as on NIC'} required full />
              <TextField {...bind('c-id')} label={R['c-id'].label} placeholder={co ? 'PV 00123456' : '199012345678'} fmt={co ? 'PV 00123456' : '123456789V or 199012345678'} required upper />
              <GroupHead title="Contact" sub="Used for the customer’s OTP and confirmation SMS" />
              <TextField {...bind('c-mobile', { mobile: true })} label="Customer mobile" type="tel" inputMode="tel" placeholder="+94 7X XXX XXXX" fmt="+94 7X XXX XXXX" hint="The customer’s confirmation OTP goes here" required />
              <TextField {...bind('c-email')} label="Customer email" type="email" inputMode="email" placeholder="name@example.com" fmt="name@example.com" optional />
              <TextAreaField {...bind('c-addr')} label="Customer address" placeholder="House no, street, city, postal code" hint="Printed on the policy by the selected insurer" required full />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <span className="legend-key">
              <span className="req">*</span> Required field
            </span>
            <div className="grid">
              <GroupHead title="Vehicle" sub="From the CR book or dealer invoice" />
              <SelectField id="v-cat" label="Vehicle category" value={v['v-cat']} onChange={(x) => f.set('v-cat', x)} options={VEHICLE_CATEGORIES} hint="Pilot covers one category" required />
              <TextField {...bind('v-year')} label="Year of manufacture" inputMode="numeric" placeholder="YYYY" maxLength={4} fmt="YYYY" required />
              <TextField {...bind('v-make')} label="Make" placeholder="e.g. Toyota" required />
              <TextField {...bind('v-model')} label="Model" placeholder="e.g. Aqua" required />
              <Segmented id="v-cond" label="Vehicle condition" options={['Brand new', 'Registered'] as VehicleCondition[]} value={cond} onChange={setCond} full />
              {cond === 'Registered' ? <TextField {...bind('v-reg')} label="Registration No" placeholder="e.g. CAB-4521" fmt="ABC-1234" required full upper /> : null}
              <GroupHead title="Identification and value" sub="Chassis No is checked for duplicates" />
              <TextField {...bind('v-chassis')} label="Chassis No" hint="Letters are converted to capitals" required upper />
              <TextField {...bind('v-engine')} label="Engine No" required upper />
              <TextField {...bind('v-value', { money: true })} label="Vehicle value" prefix="LKR" inputMode="decimal" placeholder="0.00" fmt="8,500,000.00" required />
              <Segmented id="v-usage" label="Vehicle usage" options={['Private', 'Hiring', 'Commercial'] as VehicleUsage[]} value={usage} onChange={setUsage} />
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <span className="legend-key">
              <span className="req">*</span> Required field
            </span>
            <div className="grid">
              <GroupHead title="Facility" sub="Internal: never shown to insurers" />
              <Segmented id="f-type" label="Facility type" options={['Lease', 'Loan'] as FacilityType[]} value={fac} onChange={setFac} full />
              <TextField {...bind('f-ref')} label="Facility reference No" placeholder="e.g. LF/KDY/2026/00418" fmt="As in your loan system" required full upper />
              <TextField {...bind('f-amt', { money: true })} label="Facility amount" prefix="LKR" inputMode="decimal" placeholder="0.00" required />
              <TextField {...bind('f-ten')} label="Tenure" suffix="months" inputMode="numeric" placeholder="e.g. 60" fmt="1–120" maxLength={3} required />
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <span className="legend-key">
              <span className="req">*</span> Required field
            </span>
            <div className="grid">
              <GroupHead title="Cover requested" sub="Insurers match packages on these two fields" />
              <Segmented id="cv-type" label="Cover type" options={['Comprehensive', 'Third Party'] as CoverType[]} value={cover} onChange={setCover} full />
              <TextField {...bind('cv-sum', { money: true })} label="Sum insured" prefix="LKR" inputMode="decimal" hint="Pre-filled from vehicle value" required />
              <TextField {...bind('cv-start')} label="Policy start date" type="date" hint="Today or later" required />
              <GroupHead title="Add-ons and notes" sub="Optional" />
              <Chips id="cv-opt" label="Optional covers" options={OPTIONAL_COVERS} values={opts} onChange={setOpts} optional full hint="SRCC: strikes, riots and civil commotion" />
              <TextAreaField {...bind('cv-rem')} label="Remarks" placeholder="Anything the broker or insurers should know" maxLength={300} hint="Up to 300 characters" optional full />
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="group-head">
              <h4>What will be shared</h4>
              <span>Read this to the customer</span>
            </div>
            <div className="share">
              <div>
                <h5>All selected insurers</h5>
                <p>Vehicle details and the cover requested, so they can price a package.</p>
              </div>
              <div>
                <h5>The insurer the customer chooses</h5>
                <p>Customer name, NIC, mobile and address, to issue the policy.</p>
              </div>
              <div>
                <h5>Never shared with insurers</h5>
                <p>Lease or loan details, including the facility amount.</p>
              </div>
            </div>
            <Checkbox id="decl" checked={decl} onChange={setDecl} required note="Required. You cannot submit without the customer’s consent.">
              The customer has consented to their details being shared with insurers for quotation and policy issue.
            </Checkbox>
          </>
        )}

        <Actions left={step > 0 ? <TextButton onClick={() => goStep(step - 1)}>← Back</TextButton> : <span className="note">Step 1 of 5</span>}>
          <Button loading={busy}>{step === 4 ? 'Review request' : `Continue to ${STEPS[step + 1].title}`}</Button>
        </Actions>
      </form>
    </Layout>
  );
}
