import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK } from '../api/mockApi';
import { config } from '../config';
import { renderAt, signIn } from '../test/utils';
import { BindingPage } from './BindingPage';

const pdf = (name: string) => new File(['%PDF-1.4'], name, { type: 'application/pdf' });

describe('Binding Upload (Screen 4)', () => {
  it('requires the documents and a valid expiry date', async () => {
    const { user } = renderAt(`/insurer/binding?req=${MOCK.requestNo}`, '/insurer/binding', <BindingPage />);
    await signIn(user, MOCK.insurerEmail);
    await screen.findByText(/policyholder/i);
    await user.type(screen.getByLabelText(/policy expiry date/i), '2026-11-01');
    await user.click(screen.getByRole('button', { name: /submit policy/i }));
    expect(await screen.findByText(/fix 5 fields to continue/i)).toBeInTheDocument();
    expect(screen.getAllByText(/expiry date must be after the start date/i).length).toBeGreaterThan(0);
  });

  it('submits the policy with uploads', async () => {
    const { user } = renderAt(`/insurer/binding?req=${MOCK.requestNo}`, '/insurer/binding', <BindingPage />);
    await signIn(user, MOCK.insurerEmail);
    await screen.findByText(/policyholder/i);
    await user.type(screen.getByLabelText(/quotation ref no/i), 'QA-2026-0912');
    await user.upload(screen.getByLabelText(/quotation document/i), pdf('Quotation.pdf'));
    await user.type(screen.getByLabelText(/policy number/i), 'A/MV/2026/004512');
    await user.type(screen.getByLabelText(/policy expiry date/i), '2027-11-09');
    await user.upload(screen.getByLabelText(/policy documents/i), [pdf('Schedule.pdf'), pdf('Cover_Note.pdf')]);
    expect(screen.getByText('Schedule.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /submit policy/i }));
    expect(await screen.findByRole('heading', { name: /policy submitted/i })).toBeInTheDocument();
    expect(screen.getByText(/3 documents uploaded/i)).toBeInTheDocument();
    // The policy number typed above, not the request number.
    expect(screen.getByTestId('policy-number')).toHaveTextContent('A/MV/2026/004512');
    expect(screen.getByTestId('policy-number')).not.toHaveTextContent(MOCK.requestNo);
    expect(screen.getByText('The customer and the finance partner have been notified.')).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(steps).toEqual([
      expect.stringContaining('The customer gets an SMS that the policy is issued'),
      expect.stringContaining('The finance partner gets the policy by email'),
    ]);
    expect(screen.queryByText(/premium payment/i)).not.toBeInTheDocument();
  });

  it('shows the payment step again when paymentEnabled is on', async () => {
    config.paymentEnabled = true;
    try {
      const { user } = renderAt(`/insurer/binding?req=${MOCK.requestNo}`, '/insurer/binding', <BindingPage />);
      await signIn(user, MOCK.insurerEmail);
      await screen.findByText(/policyholder/i);
      await user.type(screen.getByLabelText(/quotation ref no/i), 'QA-2026-0912');
      await user.upload(screen.getByLabelText(/quotation document/i), pdf('Quotation.pdf'));
      await user.type(screen.getByLabelText(/policy number/i), 'A/MV/2026/004512');
      await user.type(screen.getByLabelText(/policy expiry date/i), '2027-11-09');
      await user.upload(screen.getByLabelText(/policy documents/i), [pdf('Schedule.pdf')]);
      await user.click(screen.getByRole('button', { name: /submit policy/i }));
      expect(await screen.findByText(/you confirm the premium payment/i)).toBeInTheDocument();
    } finally {
      config.paymentEnabled = false;
    }
  });
});
