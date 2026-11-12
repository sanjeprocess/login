# Webform API contract

The endpoints the webform calls. The webform backend implements them and translates each into WorkHub24 API calls (create item, update fields, add table rows, upload files, complete the API Client task, read datastores). Types are in `src/api/types.ts`.

- Base URL: `VITE_API_BASE_URL` (default `/api`).
- JSON in and out, except binding upload (`multipart/form-data`).
- After sign-in, send `Authorization: Bearer <token>` on every call.
- Dates are `YYYY-MM-DD`. Date-times are ISO 8601. Amounts are numbers in LKR.

## Errors

Any non-2xx response returns:

```json
{ "error": { "code": "OTP_INCORRECT", "message": "That code is not correct.", "attemptsLeft": 2, "fields": { "v-chassis": "..." } } }
```

| Code | HTTP | When | Screen behaviour |
| --- | --- | --- | --- |
| LINK_INVALID | 404 | Request No unknown or link expired | Link error page |
| NOT_AUTHORISED | 403 | User not linked to this request (e.g. insurer not selected) | Link error page |
| REQUEST_CLOSED | 410 | Request already closed | Link error page |
| ALREADY_SUBMITTED | 409 | Step already done: status (A3) is past this screen's step | Reloads and shows the submitted view |
| PENDING | 409 | The previous step was just completed by the backend, but WorkHub24 has not opened this step's task yet (e.g. while it sends the customer SMS). `message` says what is happening | Shows the message; re-checks every 3 s for up to 2 min, then "This is taking longer than usual…" |
| NOT_READY | 409 | Status (A3) has not reached this screen's step | Link error page |
| OTP_INCORRECT | 400 | Wrong code; include `attemptsLeft` | Error + attempts left |
| OTP_LOCKED | 429 | 3 wrong attempts | Must request a new code |
| OTP_EXPIRED | 400 | Code older than 5 minutes | Must request a new code |
| DUPLICATE_CHASSIS | 409 | Chassis already has an open request; include `fields` | Back to Vehicle step with the error |
| VALIDATION | 422 | Server-side validation failed; include `fields` | Error banner |
| SESSION_EXPIRED | 401 | Token missing or expired | Back to sign-in |

## Sign-in (all screens)

### POST /auth/otp/request

```json
{ "email": "nadeesha.fernando@northgate.lk", "purpose": "finance_signin", "requestNo": "MIG-2026-0148" }
```

- `purpose`: `finance_signin` or `insurer_signin`. `requestNo` is sent on every screen except Start Request.
- `screen` (optional, also on `/auth/otp/verify`): `response` (Screen 2), `compare` (Screen 3 and customer OTP), `binding` (Screen 4) or `payment`. When `requestNo` is sent, the backend checks that the screen's WF-01 task is open before sending a code: Screen 2 `Awaiting Insurer Responses`, Screen 3 `Awaiting Package Selection`, customer OTP `Awaiting OTP Verification`, Screen 4 `Awaiting Policy Upload`. No open task returns `ALREADY_SUBMITTED` (`REQUEST_CLOSED` if Status is `Completed`) and no code is sent. Without `screen`, the task is inferred from whether a package has been selected.
- Look up the email in ds_finance_user or ds_insurer_user. If found, generate a 6-digit code, store its hash with a 5-minute expiry, and start WF-02 Send OTP.
- Always return 200 whether or not the email exists, so nobody can test emails.
- If `requestNo` is given and invalid, return LINK_INVALID / NOT_AUTHORISED / REQUEST_CLOSED.

Response: `{ "resendAfterSeconds": 60 }`

### POST /auth/otp/verify

```json
{ "email": "...", "code": "123456", "purpose": "insurer_signin", "requestNo": "MIG-2026-0148" }
```

Response (`Session`):

```json
{
  "token": "opaque-token",
  "expiresAt": "2026-11-06T17:30:00+05:30",
  "user": { "name": "Dilani Wickramasinghe", "email": "dilani.w@insurer-a.lk", "role": "insurer", "insurer": "Insurer A", "department": "Underwriting" }
}
```

Finance users get `partner` instead of `insurer`. Sessions last 30 minutes. For insurers, the token only works for the `requestNo` it was issued for.

## Screen 1: Start Request (finance user)

### GET /requests/chassis/{chassisNo}

Response: `{ "exists": false }`. True when an open WF-01 request already has this chassis.

### POST /requests

Body: `RequestPayload` (customer, vehicle, finance, cover, consent). The backend creates the WF-01 item through the WorkHub24 API, filling sections A to E.

Response: `{ "requestNo": "MIG-2026-0149" }`

## Screen 2: Insurer Response (insurer)

### GET /insurer/requests/{requestNo}/response

Response (`InsurerResponseView`):

- `request`: summary only, with no customer or finance data
- `insurerName`
- `vehicleCategories`
- `recommended[]`: this insurer's ds_package rows matching vehicle category, cover type and sum insured within sum_min to sum_max, still valid, with premium = sum insured × rate
- `submission`: present if already responded

### POST /insurer/requests/{requestNo}/response

```json
{
  "packageRefs": ["A-COMP-STD", "A-COMP-PLUS"],
  "newPackage": { "name": "...", "coverType": "Comprehensive", "vehicleCategory": "Motor car", "sumMin": 5000000, "sumMax": 12000000, "premiumRate": 2.95, "taxes": 52000, "excess": 20000, "standardCovers": "...", "optionalCovers": ["SRCC"], "validUntil": "2026-12-31" },
  "remarks": "..."
}
```

`packageRefs` lists any of the insurer's recommended packages; `newPackage` is optional. At least one package is required in total (otherwise 422 `VALIDATION`).

The backend:

1. writes the new-package fields (G7 to G21, Is New Package = Yes) on the WF-01 item when `newPackage` is sent, otherwise Is New Package = No;
2. sets status (A3) to Awaiting Selection and completes the "Awaiting Insurer Responses" task;
3. stores every package as a separate offer (`backend/data/offers.json`), with its premium, taxes and total for the request's sum insured. Screen 3 lists them all.

Response: 204.

## Screen 3: Comparison and Selection (finance user)

### GET /finance/requests/{requestNo}/offers

Response (`CompareView`):

- `request`
- `customer`: `name` and `mobileLast3`
- `offers[]`: H2 rows plus the H1 API insurer package
- `status`: `awaiting_selection` / `awaiting_customer_otp` / `confirmed`
- `selected`

### POST /finance/requests/{requestNo}/select

```json
{ "insurer": "Insurer A", "packageRef": "A-COMP-STD" }
```

The backend:

1. writes I1 to I5a;
2. generates the customer OTP into I6;
3. completes the "Awaiting Package Selection" task (step 6.0). WF-01 then sends the SMS at step 6.2.

Response: `{ "mobileLast3": "123" }`

### POST /finance/requests/{requestNo}/customer-otp

```json
{ "code": "654321" }
```

The backend checks the code against I6.

- **Correct:** sets I7 = Verified and completes step 6.4. Response `{ "result": "verified", "attemptsLeft": n }`.
- **Wrong:** response `{ "result": "incorrect", "attemptsLeft": n }`.
- **Third wrong attempt:**
  1. set I7 = Failed and write a new code to I6;
  2. complete step 6.4, so WF-01 loops back to 6.1 and resends;
  3. respond `{ "result": "new_code_sent", "attemptsLeft": 3 }`.

## Screen 4: Binding Upload (selected insurer)

### GET /insurer/requests/{requestNo}/binding

Response (`BindingView`):

- `accepted`: package name, ref, total, accepted at
- `customer`: name, ID, mobile, address. Only the selected insurer gets these.
- `vehicle`
- `interestedParty`
- `policyStartDate`
- `submitted`: present if already done

Return NOT_AUTHORISED to any insurer that was not selected.

### POST /insurer/requests/{requestNo}/binding (multipart)

Fields:

- `quotationRef`
- `quotationFile`: 1 PDF
- `policyNumber`
- `policyStartDate`
- `policyExpiryDate`
- `policyFiles`: 1 or more PDF, JPG or PNG
- `remarks`

Each file is up to 10 MB. The backend writes section J, uploads the files into J2 and J6, and completes "Awaiting Policy Upload" (step 8.3). Response: 204.

## Screen 5: Confirm Payment (insurer)

### GET /insurer/requests/{requestNo}/payment

Response (`PaymentView`): `policyNumber`, `insurerName`, `customerName`, `premiumDue`, `dueDate`, `status` (Outstanding / Overdue / Paid), and `paid`.

### POST /insurer/requests/{requestNo}/payment

```json
{ "paidDate": "2026-11-05", "reference": "BOC-TRF-55120931", "amount": 287980, "remarks": "..." }
```

The backend writes K4 to K6 and completes "Awaiting Payment Confirmation" (step 10.1). Response: 204.
