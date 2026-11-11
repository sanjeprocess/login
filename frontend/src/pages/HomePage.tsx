import { Link } from 'react-router-dom';
import { config } from '../config';
import { MOCK } from '../api/mockApi';
import { Layout } from '../components/Layout';
import { Guide, SecTitle } from '../components/ui';

/** Landing page. In production the finance user starts at /start and everyone else arrives by an emailed link. */
export function HomePage() {
  const req = MOCK.requestNo;
  const screens = [
    { to: '/start', t: 'Start Request', d: 'Finance user · new insurance request', r: 'Screen 1' },
    { to: `/insurer/respond?req=${req}`, t: 'Insurer Response', d: 'Insurer · pick or enter a package', r: 'Screen 2' },
    { to: `/finance/compare?req=${req}`, t: 'Comparison and Selection', d: 'Finance user · compare packages, customer OTP', r: 'Screen 3' },
    { to: `/insurer/binding?req=${req}`, t: 'Binding Upload', d: 'Selected insurer · quotation and policy', r: 'Screen 4' },
    { to: `/insurer/payment?req=${req}`, t: 'Confirm Payment', d: 'Insurer · record the premium payment', r: 'Screen 5' },
  ];
  return (
    <Layout hero={{ eyebrow: 'Motor Insurance Gateway', title: 'Insurance for financed vehicles.', lede: 'Finance users request cover, insurers respond, and the customer confirms their choice by OTP.' }}>
      <div className="aside">
        <SecTitle title="Screens" num="01–05" desc="Finance users start a request here. Insurers and finance users open the other screens from the links in their emails." />
        {config.useMockApi ? (
          <Guide
            title="Trying it with the mock API"
            tips={[
              `Sign in as ${MOCK.financeEmail} (finance) or ${MOCK.insurerEmail} (insurer).`,
              `Every sign-in code is ${MOCK.signInCode}. The customer OTP is ${MOCK.customerCode}.`,
              `Links use request ${MOCK.requestNo}. ${MOCK.notAuthorisedRequest} shows “not authorised” and ${MOCK.closedRequest} shows “request closed”.`,
              `Chassis ${MOCK.existingChassis} triggers the duplicate check.`,
            ]}
          />
        ) : null}
      </div>
      <div className="form">
        <nav className="home" aria-label="Screens">
          {screens.map((s, i) => (
            <Link key={s.to} to={s.to}>
              <span className="n">0{i + 1}</span>
              <span>
                <span className="t">{s.t}</span>
                <span className="d">{s.d}</span>
              </span>
              <span className="r">{s.r}</span>
            </Link>
          ))}
        </nav>
      </div>
    </Layout>
  );
}

export function NotFoundPage() {
  return (
    <Layout hero={{ eyebrow: 'Not found', title: 'Page not found.', lede: 'Check the link in your email, or start a new request.' }}>
      <div className="aside">
        <SecTitle title="Not found" num="404" />
      </div>
      <div className="form">
        <p>
          <Link to="/start" className="link">
            Start a new request
          </Link>
        </p>
      </div>
    </Layout>
  );
}
