import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK } from '../api/mockApi';
import { enterCode, renderAt, signIn } from '../test/utils';
import { ComparePage } from './ComparePage';

describe('Comparison and Selection (Screen 3)', () => {
  it('sorts packages by total premium, confirms, and verifies the customer OTP', async () => {
    const { user } = renderAt(`/finance/compare?req=${MOCK.requestNo}`, '/finance/compare', <ComparePage />);
    await signIn(user, MOCK.financeEmail);
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers[1]).toMatch(/Insurer B/);
    expect(headers[3]).toMatch(/Insurer C/);

    const send = screen.getByRole('button', { name: /select and send otp/i });
    expect(send).toBeDisabled();
    await user.click(screen.getByLabelText(/choose insurer a/i));
    await user.click(send);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be changed/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /send otp/i }));

    await screen.findByRole('heading', { name: /confirm with the customer/i });
    await enterCode(user, '111111');
    await user.click(screen.getByRole('button', { name: /verify code/i }));
    expect(await screen.findByText(/that code is not correct/i)).toBeInTheDocument();
    expect(screen.getByText(/attempts remaining: 2 of 3/i)).toBeInTheDocument();

    await enterCode(user, MOCK.customerCode);
    await user.click(screen.getByRole('button', { name: /verify code/i }));
    expect(await screen.findByRole('heading', { name: /package confirmed/i })).toBeInTheDocument();
  });

  it('accepts a new customer code after 3 wrong attempts', async () => {
    const { user } = renderAt(`/finance/compare?req=${MOCK.requestNo}`, '/finance/compare', <ComparePage />);
    await signIn(user, MOCK.financeEmail);
    await screen.findByRole('table');
    await user.click(screen.getByLabelText(/choose insurer b/i));
    await user.click(screen.getByRole('button', { name: /select and send otp/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /send otp/i }));
    await screen.findByRole('heading', { name: /confirm with the customer/i });
    for (let i = 0; i < 3; i++) {
      await enterCode(user, '111111');
      await user.click(screen.getByRole('button', { name: /verify code/i }));
      if (i < 2) await screen.findByText(/attempts remaining/i);
    }
    expect(await screen.findByText(/a new code has been sent/i)).toBeInTheDocument();
    expect(screen.getByText(/attempts remaining: 3 of 3/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify code/i })).toBeInTheDocument();
  }, 15_000);
});
