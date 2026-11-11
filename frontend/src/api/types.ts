/* Shared types for the webform <-> backend contract. See docs/API_CONTRACT.md. */

export type Purpose = 'finance_signin' | 'insurer_signin';

/** Linked screen a sign-in is for; the backend checks that screen's WorkHub24 task is open before sending a code. */
export type SignInScreen = 'response' | 'compare' | 'binding' | 'payment';

export interface SessionUser {
  name: string;
  email: string;
  role: 'finance' | 'insurer';
  /** Finance partner name (finance users) */
  partner?: string;
  /** Insurer name (insurer users) */
  insurer?: string;
  /** Department label shown in the header, e.g. "Underwriting" */
  department?: string;
}

export interface Session {
  token: string;
  user: SessionUser;
  /** ISO date-time when the session ends (30 minutes after verification) */
  expiresAt: string;
}

export type CustomerType = 'Individual' | 'Company';
export type VehicleCondition = 'Brand new' | 'Registered';
export type VehicleUsage = 'Private' | 'Hiring' | 'Commercial';
export type FacilityType = 'Lease' | 'Loan';
export type CoverType = 'Comprehensive' | 'Third Party';

/** Screen 1 submission. Maps to WF-01 sections B to E. */
export interface RequestPayload {
  customer: {
    type: CustomerType;
    name: string;
    idNumber: string;
    mobile: string;
    email?: string;
    address: string;
  };
  vehicle: {
    category: string;
    make: string;
    model: string;
    year: number;
    condition: VehicleCondition;
    registrationNo?: string;
    chassisNo: string;
    engineNo: string;
    value: number;
    usage: VehicleUsage;
  };
  finance: {
    facilityType: FacilityType;
    referenceNo: string;
    amount: number;
    tenureMonths: number;
  };
  cover: {
    coverType: CoverType;
    sumInsured: number;
    optionalCovers: string[];
    policyStartDate: string;
    remarks?: string;
  };
  consent: true;
}

/** What insurers and finance users see about a request (no customer or finance data). */
export interface RequestSummary {
  requestNo: string;
  vehicle: string;
  category: string;
  usage: string;
  coverType: CoverType;
  sumInsured: number;
  policyStartDate: string;
  optionalCovers: string[];
}

export interface StoredPackage {
  packageRef: string;
  name: string;
  premiumRate: number;
  premium: number;
  taxes: number;
  total: number;
  excess: number;
  validUntil: string;
  standardCovers: string;
  optionalCovers: string[];
}

export interface NewPackageInput {
  name: string;
  coverType: CoverType;
  vehicleCategory: string;
  sumMin: number;
  sumMax: number;
  premiumRate: number;
  taxes: number;
  excess: number;
  standardCovers: string;
  optionalCovers: string[];
  validUntil: string;
}

export interface InsurerResponseView {
  request: RequestSummary;
  insurerName: string;
  recommended: StoredPackage[];
  vehicleCategories: string[];
  submission?: { submittedBy: string; submittedAt?: string; package: StoredPackage };
}

export type InsurerResponseInput =
  | { mode: 'stored'; packageRef: string; remarks?: string }
  | { mode: 'new'; package: NewPackageInput; remarks?: string };

export interface Offer {
  insurer: string;
  source: 'webform' | 'api';
  packageRef: string;
  packageName: string;
  premium: number;
  taxes: number;
  total: number;
  sumInsured: number;
  excess: number;
  standardCovers: string;
  optionalCovers: string[];
  validUntil: string;
  remarks?: string;
}

export type CompareStatus = 'awaiting_selection' | 'awaiting_customer_otp' | 'confirmed' | 'otp_locked';

export interface CompareView {
  request: RequestSummary;
  customer: { name: string; mobileLast3: string };
  offers: Offer[];
  status: CompareStatus;
  selected?: { insurer: string; packageRef: string; total: number; acceptedAt?: string };
}

export interface VerifyCustomerOtpResult {
  result: 'verified' | 'incorrect' | 'new_code_sent';
  attemptsLeft: number;
}

export interface BindingView {
  request: RequestSummary;
  insurerName: string;
  accepted: { packageName: string; packageRef: string; total: number; acceptedAt: string };
  customer: { name: string; idNumber: string; mobile: string; address: string };
  vehicle: { description: string; registrationNo?: string; chassisNo: string; engineNo: string };
  interestedParty: string;
  policyStartDate: string;
  submitted?: { policyNumber: string; submittedAt: string; expiryDate: string; documents: number };
}

export interface BindingInput {
  quotationRef: string;
  quotationFile: File;
  policyNumber: string;
  policyStartDate: string;
  policyExpiryDate: string;
  policyFiles: File[];
  remarks?: string;
}

export type PaymentStatus = 'Outstanding' | 'Overdue' | 'Paid';

export interface PaymentView {
  requestNo: string;
  policyNumber: string;
  insurerName: string;
  customerName: string;
  premiumDue: number;
  dueDate: string;
  status: PaymentStatus;
  paid?: { paidDate: string; reference: string; amount: number };
}

export interface PaymentInput {
  paidDate: string;
  reference: string;
  amount: number;
  remarks?: string;
}

export type ApiErrorCode =
  | 'LINK_INVALID'
  | 'NOT_AUTHORISED'
  | 'ALREADY_SUBMITTED'
  | 'REQUEST_CLOSED'
  | 'OTP_INCORRECT'
  | 'OTP_EXPIRED'
  | 'OTP_LOCKED'
  | 'DUPLICATE_CHASSIS'
  | 'VALIDATION'
  | 'SESSION_EXPIRED'
  | 'NETWORK'
  | 'UNKNOWN';

export class ApiError extends Error {
  code: ApiErrorCode;
  fields?: Record<string, string>;
  attemptsLeft?: number;

  constructor(code: ApiErrorCode, message?: string, extra?: { fields?: Record<string, string>; attemptsLeft?: number }) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.fields = extra?.fields;
    this.attemptsLeft = extra?.attemptsLeft;
  }
}

/** Everything the screens need from the backend. Implemented by HttpApi and MockApi. */
export interface GatewayApi {
  requestOtp(p: { email: string; purpose: Purpose; requestNo?: string; screen?: SignInScreen }): Promise<{ resendAfterSeconds: number }>;
  verifyOtp(p: { email: string; code: string; purpose: Purpose; requestNo?: string; screen?: SignInScreen }): Promise<Session>;

  checkChassis(token: string, chassisNo: string): Promise<{ exists: boolean }>;
  submitRequest(token: string, payload: RequestPayload): Promise<{ requestNo: string }>;

  getInsurerResponse(token: string, requestNo: string): Promise<InsurerResponseView>;
  submitInsurerResponse(token: string, requestNo: string, input: InsurerResponseInput): Promise<void>;

  getCompare(token: string, requestNo: string): Promise<CompareView>;
  selectPackage(token: string, requestNo: string, p: { insurer: string; packageRef: string }): Promise<{ mobileLast3: string }>;
  verifyCustomerOtp(token: string, requestNo: string, code: string): Promise<VerifyCustomerOtpResult>;

  getBinding(token: string, requestNo: string): Promise<BindingView>;
  submitBinding(token: string, requestNo: string, input: BindingInput): Promise<void>;

  getPayment(token: string, requestNo: string): Promise<PaymentView>;
  submitPayment(token: string, requestNo: string, input: PaymentInput): Promise<void>;
}
