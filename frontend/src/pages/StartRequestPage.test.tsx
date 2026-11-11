import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK } from '../api/mockApi';
import { renderAt, signIn } from '../test/utils';
import { StartRequestPage } from './StartRequestPage';

const start = () => renderAt('/start', '/start', <StartRequestPage />);

describe('Start Request (Screen 1)', () => {
  it('asks for a valid email before sending a code', async () => {
    const { user } = start();
    await user.click(screen.getByRole('button', { name: /send code/i }));
    expect(screen.getByText('Enter your registered email')).toBeInTheDocument();
  });

  it('rejects a wrong sign-in code and counts attempts', async () => {
    const { user } = start();
    await signIn(user, MOCK.financeEmail, '000000');
    expect(await screen.findByText(/that code is not correct/i)).toBeInTheDocument();
    expect(screen.getByText(/attempts remaining: 2 of 3/i)).toBeInTheDocument();
  });

  it('shows an error summary when Continue is pressed with empty fields', async () => {
    const { user } = start();
    await signIn(user, MOCK.financeEmail);
    await screen.findByRole('heading', { name: /start a cover request/i });
    await user.click(screen.getByRole('button', { name: /continue to vehicle/i }));
    const summary = await screen.findByRole('alert');
    expect(within(summary).getByText(/fix 4 fields to continue/i)).toBeInTheDocument();
    expect(within(summary).getByText(/customer mobile/i)).toBeInTheDocument();
  });

  it('switches the ID label for company customers', async () => {
    const { user } = start();
    await signIn(user, MOCK.financeEmail);
    await screen.findByRole('heading', { name: /start a cover request/i });
    await user.click(screen.getByRole('radio', { name: 'Company' }));
    expect(screen.getByLabelText(/business reg\. no/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/company name/i)).toBeInTheDocument();
  });

  it('blocks a duplicate chassis number', async () => {
    const { user } = start();
    await signIn(user, MOCK.financeEmail);
    await fillCustomer(user);
    await fillVehicle(user, MOCK.existingChassis);
    await user.click(screen.getByRole('button', { name: /continue to finance/i }));
    expect(await screen.findAllByText(/a request already exists for this chassis number/i)).not.toHaveLength(0);
  });

  it('submits a full request and shows the request number', async () => {
    const { user } = start();
    await signIn(user, MOCK.financeEmail);
    await fillCustomer(user);
    await fillVehicle(user, 'NHP10-6789012');
    await user.click(screen.getByRole('button', { name: /continue to finance/i }));

    await screen.findByRole('heading', { level: 2, name: /^finance/i });
    await user.type(screen.getByLabelText(/facility reference no/i), 'LF/KDY/2026/00418');
    await user.type(screen.getByLabelText(/facility amount/i), '6000000');
    await user.type(screen.getByLabelText(/^tenure/i), '60');
    await user.click(screen.getByRole('button', { name: /continue to cover/i }));

    await screen.findByRole('heading', { level: 2, name: /^cover/i });
    expect(screen.getByLabelText(/sum insured/i)).toHaveValue('8,500,000.00');
    await user.type(screen.getByLabelText(/policy start date/i), '2999-01-01');
    await user.click(screen.getByRole('button', { name: 'SRCC' }));
    await user.click(screen.getByRole('button', { name: /continue to declaration/i }));

    await screen.findByRole('heading', { level: 2, name: /^declaration/i });
    await user.click(screen.getByRole('button', { name: /review request/i }));
    expect(await screen.findByText(/tick the declaration to continue/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/customer has consented/i));
    await user.click(screen.getByRole('button', { name: /review request/i }));

    await screen.findByRole('heading', { name: /review and submit/i });
    const submit = screen.getByRole('button', { name: /submit request/i });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText(/i confirm these details/i));
    await user.click(submit);

    expect(await screen.findByRole('heading', { name: /request sent/i })).toBeInTheDocument();
    expect(screen.getByTestId('request-no')).toHaveTextContent(/^MIG-2026-\d{4}$/);
  }, 15_000);
});

async function fillCustomer(user: Awaited<ReturnType<typeof start>>['user']) {
  await screen.findByRole('heading', { name: /start a cover request/i });
  await user.type(screen.getByLabelText(/customer name/i), 'Kasun Perera');
  await user.type(screen.getByLabelText(/^nic/i), '199012345678');
  await user.type(screen.getByLabelText(/customer mobile/i), '0774567123');
  await user.type(screen.getByLabelText(/customer address/i), '42/1 Peradeniya Road, Kandy 20000');
  await user.click(screen.getByRole('button', { name: /continue to vehicle/i }));
  await screen.findByRole('heading', { level: 2, name: /^vehicle/i });
}

async function fillVehicle(user: Awaited<ReturnType<typeof start>>['user'], chassis: string) {
  await user.type(screen.getByLabelText(/year of manufacture/i), '2019');
  await user.type(screen.getByLabelText(/^make/i), 'Toyota');
  await user.type(screen.getByLabelText(/^model/i), 'Aqua');
  await user.type(screen.getByLabelText(/registration no/i), 'cab-4521');
  await user.type(screen.getByLabelText(/chassis no/i), chassis);
  await user.type(screen.getByLabelText(/engine no/i), '1NZ-X123456');
  await user.type(screen.getByLabelText(/vehicle value/i), '8500000');
  await user.tab();
}
