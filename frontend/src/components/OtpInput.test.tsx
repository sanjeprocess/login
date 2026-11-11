import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { OtpInput } from './OtpInput';

function Harness() {
  const [v, setV] = useState('');
  return (
    <>
      <span id="l">Code</span>
      <OtpInput value={v} onChange={setV} labelledBy="l" />
      <output data-testid="v">{v}</output>
    </>
  );
}

describe('OtpInput', () => {
  it('accepts a pasted code and ignores non-digits', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText('Digit 1'));
    await user.paste('12a3456');
    expect(screen.getByTestId('v')).toHaveTextContent('123456');
  });

  it('moves to the next box while typing', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText('Digit 1'));
    await user.keyboard('42');
    expect(screen.getByTestId('v')).toHaveTextContent('42');
    expect(screen.getByLabelText('Digit 3')).toHaveFocus();
  });
});
