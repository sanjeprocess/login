# Motor Insurance Gateway: Webform

The frontend for the B2B Motor Insurance Gateway pilot. Finance users and insurers use these five screens. WorkHub24 runs the workflow (WF-01 Motor Insurance Request, WF-02 Send OTP), and a separate webform backend sits between this app and WorkHub24.

Built with React 18, TypeScript, Vite and React Router. Tests use Vitest and Testing Library.

## Quick start (VS Code)

1. Install Node.js 18 or later.
2. Open this folder in VS Code, then open a terminal (**Terminal → New Terminal**).
3. Install packages:
   ```bash
   npm install
   ```
4. Run the app:
   ```bash
   npm run dev
   ```
5. Open http://localhost:5173.

It starts with the **built-in mock API**, so no backend is needed. A yellow bar at the top shows the test details:

| What | Value |
| --- | --- |
| Finance user email | nadeesha.fernando@northgate.lk |
| Insurer email | dilani.w@insurer-a.lk |
| Every sign-in code | 123456 |
| Customer OTP (Screen 3) | 654321 |
| Request number in links | MIG-2026-0148 |
| "Not authorised" link | MIG-2026-0999 |
| "Request closed" link | MIG-2026-0100 |
| Duplicate chassis | NHP10-0000001 |

Mock data lives in memory, so a page reload resets it.

## Screens and routes

| # | Screen | Route | Who | Opened from |
| --- | --- | --- | --- | --- |
| 1 | Start Request | `/start` | Finance user | Start page |
| 2 | Insurer Response | `/insurer/respond?req=<Request No>` | Insurer | Email T-01 |
| 3 | Comparison and Selection | `/finance/compare?req=<Request No>` | Finance user | Email T-02 |
| 4 | Binding Upload | `/insurer/binding?req=<Request No>` | Selected insurer | Email T-04 |
| 5 | Confirm Payment | `/insurer/payment?req=<Request No>` | Insurer | Email T-06 |

`/` lists all five for testing. Every screen sits behind the same email + SMS code sign-in.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the app with hot reload on port 5173 |
| `npm test` | Runs all tests once |
| `npm run test:watch` | Re-runs tests as you edit |
| `npm run typecheck` | TypeScript check only |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serves the production build |

## Switching to the real backend

Edit `.env`:

```
VITE_USE_MOCK_API=false
VITE_API_BASE_URL=/api
```

In development, Vite forwards `/api` to `http://localhost:4000` (see `vite.config.ts`). Change the target to wherever the backend runs. The backend must implement the endpoints in `docs/API_CONTRACT.md`. Restart `npm run dev` after changing `.env`.

## Project layout

```
src/
  api/
    types.ts         Data shapes and the GatewayApi interface
    httpApi.ts       Real backend client (fetch)
    mockApi.ts       In-memory mock with sample data
    client.tsx       Picks mock or real from .env; React context
  components/
    Layout.tsx       Header, session bar, hero, footer
    OtpGate.tsx      Email + 6-digit code sign-in
    OtpInput.tsx     The six code boxes
    FileDrop.tsx     File picker with list and remove
    Dialog.tsx       Confirmation dialog
    LinkError.tsx    Invalid / not authorised / closed link pages
    ui.tsx           Fields, steps, guide panel, error summary, buttons
  lib/
    validators.ts    NIC, mobile, email, amounts, dates, files
    format.ts        Money, mobile, dates, timers
    form.ts          Form state, touched fields, error summary
    session.ts       Session token per screen and request
    useLoad.ts       Load screen data
  pages/             One file per screen (+ a test file next to each)
  styles/global.css  Light theme
docs/API_CONTRACT.md Endpoints the backend must provide
```

## Tests

`npm test` runs 29 tests across 8 files, all against the mock API:

- **Validators and formatting:** NIC, mobile, email, amounts, tenure, rates, dates, file type and size.
- **OTP input:** paste and typing.
- **Screen 1:** email check, wrong code and attempts, error summary, company labels, duplicate chassis, full submit.
- **Screen 2:** missing link, not-authorised link, stored package submit, new package premium calculation and validation.
- **Screen 3:** sort order, confirm dialog, wrong and correct customer OTP, new code after 3 failures.
- **Screen 4:** required uploads and dates, full submit with files.
- **Screen 5:** amount warning, required reference, recorded payment.

Add new tests as `*.test.tsx` next to the file they cover. `src/test/utils.tsx` has `renderAt()` and `signIn()` helpers.

## Security notes

- The browser never calls WorkHub24 and never holds WorkHub24 credentials. Only the backend does.
- OTP codes are generated, hashed and checked by the backend. The browser only sends what the user typed.
- The session token is kept in `sessionStorage`, scoped to one screen and one request, and cleared when the tab closes or the 30-minute session ends.
- Insurers only receive the data their step needs. The backend must enforce this as well, never just the screens.
