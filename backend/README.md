# Motor Insurance Gateway Backend

This project provides the backend for the Motor Insurance Gateway webform.

## Run locally

1. Copy `.env.example` to `.env.local` if it does not already exist. Keep local secrets in the backend `.env.local`; it is excluded from Git.
2. Install dependencies:
   npm install
3. Start the API in watch mode:
   npm run dev
4. The API listens on port 4000 by default.

To connect to WorkHub24, set `WH24_MODE=http` in `.env.local`, then fill in `WH24_BASE_URL`, `WH24_API_KEY`, and `WH24_TENANT` using your WorkHub24 values. `WH24_CLIENT_ID` and `WH24_CLIENT_SECRET` are also reserved there, but the HTTP client currently sends only the API key; confirm the authentication scheme before relying on client credentials. Keep all credentials in the backend only; do not put them in the frontend `.env`, since frontend variables can be exposed to browsers. The real WorkHub24 endpoint paths and authentication details still need confirmation in `src/wh24/httpClient.ts`.

`SMS_MOBILE_FORMAT` (`e164` | `intl` | `local`, default `intl`, e.g. `94751136543`) sets the mobile format written to WF-02 `oTPMobile` and WF-01 `customerMobile` for WorkHub24 SMS.

## Probing WorkHub24 (read-only modes)

- `npm run probe -- views`: prints the row keys and value types (no values) of the insurer users, packages and insurers views, plus distinct values of enum-like keys such as `active` and `status`.
- `npm run probe -- wf02fieldkeys <cardId>`: prints a WF-02 card's field keys (no values). Without an id it uses the highest WF-02 card id that returns JSON (GET per id; `cards/list` does not work on this tenant).
- `npm run probe -- createbisect`: **creates WF-01 test cards.** Builds the exact create body `POST /api/requests` sends for the e2e sample request, prints each key's type (values only for dropdown/date/boolean fields), then POSTs `{ customerName }`, adds one section at a time (title, A–E), and for the first failing section adds fields one by one to find the key that makes WH24 return HTML. Prints the created card ids for deletion.
- `npm run probe -- wf01keys [cardId]`: prints a WF-01 card's keys that are not in `config/wf01-field-map.json` (no values). Without an id it uses the highest card id that returns JSON. Use it to find the key of a newly added WF-01 field, such as Current Package Insurer Code (`G7a`), which is only written once mapped.

## Point the frontend at this backend

The webform already proxies `/api` to port 4000. To use this local backend, set the following in the frontend `.env`:

VITE_USE_MOCK_API=false

## WorkHub24 HTTP client TODOs

- Confirm the exact base path and auth scheme for the WorkHub24 REST API.
- Confirm all datastore names and row schemas for finance users, insurer users, package catalogues, and request items.
- Confirm the field mapping for every WF-01/WF-02 field ID and the exact API payload structure for update/create calls.
- Confirm the upload endpoint and file metadata expected by WorkHub24.
- Confirm the task completion endpoint semantics and the step IDs for API Client tasks.
- Confirm retry and rate-limit requirements, and any tenant-specific headers.

## Notes

- All routes are mounted under `/api`.
- The mock insurer routes are available at `/mock-insurer/quote` and `/mock-insurer/bind`.
- In development, the app uses `WH24_MODE=fake` by default.
