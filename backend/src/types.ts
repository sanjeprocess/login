export type Purpose = 'finance_signin' | 'insurer_signin';

export interface SessionUser {
  name: string;
  email: string;
  role: 'finance' | 'insurer';
  partner?: string;
  insurer?: string;
  insurerCode?: string;
  department?: string;
}

export interface Session {
  token: string;
  user: SessionUser;
  expiresAt: string;
}

export type CustomerType = 'Individual' | 'Company';
export type VehicleCondition = 'Brand new' | 'Registered';
export type VehicleUsage = 'Private' | 'Hiring' | 'Commercial';
export type FacilityType = 'Lease' | 'Loan';
export type CoverType = 'Comprehensive' | 'Third Party';

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
  submission?: { submittedBy: string; submittedAt: string; packages: StoredPackage[] };
}

/** Screen 2: one or more stored packages and/or one new package; at least one in total. */
export interface InsurerResponseInput {
  packageRefs: string[];
  newPackage?: NewPackageInput;
  remarks?: string;
}

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

export type CompareStatus = 'awaiting_selection' | 'awaiting_customer_otp' | 'confirmed';

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
  | 'PENDING'
  | 'NOT_READY'
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

export interface GatewayApi {
  requestOtp(p: { email: string; purpose: Purpose; requestNo?: string }): Promise<{ resendAfterSeconds: number }>;
  verifyOtp(p: { email: string; code: string; purpose: Purpose; requestNo?: string }): Promise<Session>;

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
