import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK } from '../api/mockApi';
import { renderAt, signIn } from '../test/utils';
import { PaymentPage } from './PaymentPage';

describe('Confirm Payment (Screen 5)', () => {
  it('warns when the amount differs, then records the payment', async () => {
    const { user } = renderAt(`/insurer/payment?req=${MOCK.requestNo}`, '/insurer/payment', <PaymentPage />);
    await signIn(user, MOCK.insurerEmail);
    const amount = await screen.findByLabelText(/amount received/i);
    expect(amount).toHaveValue('287,980.00');
    await user.clear(amount);
    await user.type(amount, '280000');
    await user.tab();
    expect(screen.getByText(/is different from the premium due/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/payment reference/i), 'BOC-TRF-55120931');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect(await screen.findByRole('heading', { name: /payment recorded/i })).toBeInTheDocument();
  });

  it('requires a payment reference', async () => {
    const { user } = renderAt(`/insurer/payment?req=${MOCK.requestNo}`, '/insurer/payment', <PaymentPage />);
    await signIn(user, MOCK.insurerEmail);
    await screen.findByLabelText(/amount received/i);
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect((await screen.findAllByText(/enter payment reference/i)).length).toBeGreaterThan(0);
  });
});
