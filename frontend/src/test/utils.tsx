import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiProvider } from '../api/client';
import { MOCK, MockApi } from '../api/mockApi';
import { screen } from '@testing-library/react';

/** Render a page at a route with an instant mock API. */
export function renderAt(path: string, routePath: string, page: ReactElement) {
  const api = new MockApi(0);
  const user = userEvent.setup();
  const utils = render(
    <ApiProvider api={api}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={page} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return { api, user, ...utils };
}

/** Go through the email + OTP gate. */
export async function signIn(user: ReturnType<typeof userEvent.setup>, email: string, code = MOCK.signInCode) {
  await user.type(screen.getByLabelText(/registered email/i), email);
  await user.click(screen.getByRole('button', { name: /send code/i }));
  await screen.findByRole('heading', { name: /enter your code/i });
  await enterCode(user, code);
  await user.click(screen.getByRole('button', { name: /^verify/i }));
}

export async function enterCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const first = screen.getByLabelText('Digit 1');
  await user.click(first);
  await user.paste(code);
}
