import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK } from '../api/mockApi';
import { renderAt, signIn } from '../test/utils';
import { InsurerResponsePage } from './InsurerResponsePage';

const open = (req = MOCK.requestNo) => renderAt(`/insurer/respond?req=${req}`, '/insurer/respond', <InsurerResponsePage />);

describe('Insurer Response (Screen 2)', () => {
  it('shows a link error when the request number is missing', () => {
    renderAt('/insurer/respond', '/insurer/respond', <InsurerResponsePage />);
    expect(screen.getByText(/link invalid or expired/i)).toBeInTheDocument();
  });

  it('shows "not authorised" for a request the insurer was not selected for', async () => {
    const { user } = open(MOCK.notAuthorisedRequest);
    await user.type(screen.getByLabelText(/registered email/i), MOCK.insurerEmail);
    await user.click(screen.getByRole('button', { name: /send code/i }));
    expect(await screen.findByText(/this request is not assigned to you/i)).toBeInTheDocument();
  });

  it('requires at least one package', async () => {
    const { user } = open();
    await signIn(user, MOCK.insurerEmail);
    await screen.findByText(/recommended packages/i);
    await user.click(screen.getByRole('button', { name: /submit response/i }));
    expect(await screen.findByText(/choose at least one package/i)).toBeInTheDocument();
  });

  it('submits several recommended packages in one response', async () => {
    const { user } = open();
    await signIn(user, MOCK.insurerEmail);
    await screen.findByText(/recommended packages/i);
    const boxes = screen.getAllByRole('checkbox').filter((box) => (box as HTMLInputElement).name === 'pkg');
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    await user.click(boxes[0]);
    await user.click(boxes[1]);
    expect(screen.getByText(/2 packages selected/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /submit response/i }));
    expect(await screen.findByRole('heading', { name: /response received/i })).toBeInTheDocument();
    const refs = boxes.slice(0, 2).map((box) => (box as HTMLInputElement).value);
    for (const ref of refs) expect(screen.getByText(ref)).toBeInTheDocument();
  });

  it('calculates the premium for a new package and validates it', async () => {
    const { user } = open();
    await signIn(user, MOCK.insurerEmail);
    await screen.findByText(/recommended packages/i);
    await user.click(screen.getByRole('checkbox', { name: /enter a new package/i }));
    await user.type(screen.getByLabelText(/premium rate/i), '3');
    expect(screen.getByTestId('calc-premium')).toHaveTextContent('LKR 255,000.00');
    await user.click(screen.getByRole('button', { name: /submit response/i }));
    expect(await screen.findByText(/fix \d+ fields to continue/i)).toBeInTheDocument();
  });
});
