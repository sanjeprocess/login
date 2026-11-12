import type { ReactNode } from 'react';
import type { ApiErrorCode } from '../api/types';
import { config } from '../config';
import { Layout } from './Layout';
import { DefList, SecTitle } from './ui';

const MESSAGES: Partial<Record<ApiErrorCode, [string, string, string]>> = {
  LINK_INVALID: ['Link invalid or expired', 'This link has expired or is not valid.', 'Open the most recent email about this request. If that link has also expired, contact the broker for a new one.'],
  NOT_AUTHORISED: ['Not authorised', 'This request is not assigned to you.', 'Check that you signed in with the email your company registered with the broker.'],
  ALREADY_SUBMITTED: ['Already submitted', 'This step has already been completed for this request.', 'Contact the broker if something needs to change.'],
  NOT_READY: ['Not ready yet', 'This step is not open yet for this request.', 'You will get an email when it is ready. Contact the broker if you expected it already.'],
  REQUEST_CLOSED: ['Request closed', 'This request is closed.', 'The broker closed this request, so no further action is needed.'],
  NETWORK: ['Connection problem', 'We could not reach the server.', 'Check your connection and reload the page.'],
};

export function isLinkError(code: ApiErrorCode) {
  return code in MESSAGES;
}

export function LinkError({ code, requestNo, children }: { code: ApiErrorCode; requestNo?: string; children?: ReactNode }) {
  const [title, line, next] = MESSAGES[code] ?? ['Something went wrong', 'This page could not be loaded.', 'Reload the page. If it keeps happening, contact the broker.'];
  return (
    <Layout hero={{ eyebrow: requestNo ? `Request ${requestNo}` : 'Access', title: 'This link can’t be used.', lede: 'See the reason below and what to do next.' }}>
      <div className="aside">
        <SecTitle title="Link status" num="–" desc="Shown instead of a screen when a link cannot be used." />
      </div>
      <div className="form">
        <div className="group-head">
          <h4>{title}</h4>
          <span>{requestNo}</span>
        </div>
        <p style={{ margin: 0, fontSize: 22, letterSpacing: '-.02em', color: 'var(--ink-strong)' }}>{line}</p>
        <p style={{ margin: 0, color: 'var(--muted)', maxWidth: '52ch' }}>{next}</p>
        {children}
        <DefList
          className="facts"
          rows={[
            ['Broker', config.brokerName],
            ['Support', config.supportPhone],
          ]}
        />
      </div>
    </Layout>
  );
}
