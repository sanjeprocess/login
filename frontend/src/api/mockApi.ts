import {
  ApiError,
  type BindingInput,
  type BindingView,
  type CompareView,
  type GatewayApi,
  type InsurerResponseInput,
  type InsurerResponseView,
  type Offer,
  type PaymentInput,
  type PaymentView,
  type Purpose,
  type RequestPayload,
  type RequestSummary,
  type Session,
  type StoredPackage,
  type VerifyCustomerOtpResult,
} from './types';

/**
 * In-memory stand-in for the webform backend, so the screens run and can be tested
 * without WorkHub24. Codes below are shown in the yellow dev bar.
 */
export const MOCK = {
  signInCode: '123456',
  customerCode: '654321',
  financeEmail: 'nadeesha.fernando@northgate.lk',
  insurerEmail: 'dilani.w@insurer-a.lk',
  requestNo: 'MIG-2026-0148',
  notAuthorisedRequest: 'MIG-2026-0999',
  closedRequest: 'MIG-2026-0100',
  existingChassis: 'NHP10-0000001',
};

const SUMMARY: RequestSummary = {
  requestNo: MOCK.requestNo,
  vehicle: 'Toyota Aqua, 2019',
  category: 'Motor car',
  usage: 'Private',
  coverType: 'Comprehensive',
  sumInsured: 8500000,
  policyStartDate: '2026-11-10',
  optionalCovers: ['SRCC', 'Terrorism'],
};

const PACKAGES: StoredPackage[] = [
  { packageRef: 'A-COMP-STD', name: 'Comprehensive Standard', premiumRate: 2.8, premium: 238000, taxes: 49980, total: 287980, excess: 25000, validUntil: '2026-12-31', standardCovers: 'Own damage, theft, third party liability, windscreen', optionalCovers: ['SRCC', 'Terrorism'] },
  { packageRef: 'A-COMP-PLUS', name: 'Comprehensive Plus', premiumRate: 3.1, premium: 263500, taxes: 55335, total: 318835, excess: 15000, validUntil: '2026-12-31', standardCovers: 'Standard covers plus roadside assistance and a courtesy vehicle', optionalCovers: ['SRCC', 'Terrorism', 'Flood'] },
];

const OTHER_OFFERS: Offer[] = [
  { insurer: 'Insurer B', source: 'webform', packageRef: 'B-COMP-01', packageName: 'Motor Comprehensive', premium: 229500, taxes: 48195, total: 277695, sumInsured: 8500000, excess: 30000, standardCovers: 'Own damage, theft, third party liability', optionalCovers: ['SRCC'], validUntil: '2026-12-15', remarks: 'One free windscreen replacement a year.' },
  { insurer: 'Insurer C', source: 'api', packageRef: 'C-API-PRIME', packageName: 'Prime Motor', premium: 246500, taxes: 51765, total: 298265, sumInsured: 8500000, excess: 20000, standardCovers: 'Own damage, theft, third party liability, windscreen', optionalCovers: ['SRCC', 'Terrorism', 'Flood'], validUntil: '2026-11-30', remarks: 'Quoted automatically through the insurer API.' },
];

interface MockState {
  otpAttempts: Record<string, number>;
  insurerSubmission?: InsurerResponseView['submission'];
  compareStatus: CompareView['status'];
  selected?: CompareView['selected'];
  customerAttempts: number;
  binding?: BindingView['submitted'];
  payment?: PaymentView['paid'];
  requests: number;
}

function freshState(): MockState {
  return { otpAttempts: {}, compareStatus: 'awaiting_selection', customerAttempts: 3, requests: 148 };
}

export class MockApi implements GatewayApi {
  private s: MockState = freshState();
  constructor(private delayMs = 450) {}

  /** Test helper: start every test from the same data. */
  reset() {
    this.s = freshState();
  }

  private wait<T>(v: T): Promise<T> {
    return new Promise((r) => setTimeout(() => r(v), this.delayMs));
  }
  private async fail(e: ApiError): Promise<never> {
    await this.wait(null);
    throw e;
  }
  private checkToken(token: string) {
    if (!token) throw new ApiError('SESSION_EXPIRED', 'Your session has ended. Verify again to continue.');
  }
  private checkRequest(no: string) {
    if (no === MOCK.notAuthorisedRequest) throw new ApiError('NOT_AUTHORISED');
    if (no === MOCK.closedRequest) throw new ApiError('REQUEST_CLOSED');
    if (no !== MOCK.requestNo) throw new ApiError('LINK_INVALID');
  }

  async requestOtp(p: { email: string; purpose: Purpose; requestNo?: string }) {
    if (p.requestNo) {
      try {
        this.checkRequest(p.requestNo);
      } catch (e) {
        return this.fail(e as ApiError);
      }
    }
    this.s.otpAttempts[p.email.toLowerCase()] = 3;
    return this.wait({ resendAfterSeconds: 60 });
  }

  async verifyOtp(p: { email: string; code: string; purpose: Purpose; requestNo?: string }): Promise<Session> {
    const email = p.email.toLowerCase();
    const left = this.s.otpAttempts[email] ?? 3;
    if (left <= 0) return this.fail(new ApiError('OTP_LOCKED', 'Too many attempts. Request a new code.', { attemptsLeft: 0 }));
    const known = p.purpose === 'finance_signin' ? email === MOCK.financeEmail : email === MOCK.insurerEmail;
    if (!known || p.code !== MOCK.signInCode) {
      this.s.otpAttempts[email] = left - 1;
      return this.fail(new ApiError(left - 1 <= 0 ? 'OTP_LOCKED' : 'OTP_INCORRECT', 'That code is not correct.', { attemptsLeft: left - 1 }));
    }
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const user =
      p.purpose === 'finance_signin'
        ? { name: 'Nadeesha Fernando', email, role: 'finance' as const, partner: 'Northgate Finance PLC', branch: 'Kandy City' }
        : { name: 'Dilani Wickramasinghe', email, role: 'insurer' as const, insurer: 'Insurer A', department: 'Underwriting' };
    return this.wait({ token: `mock-${p.purpose}-${Date.now()}`, user, expiresAt });
  }

  async checkChassis(token: string, chassisNo: string) {
    this.checkToken(token);
    return this.wait({ exists: chassisNo.trim().toUpperCase() === MOCK.existingChassis });
  }

  async submitRequest(token: string, payload: RequestPayload) {
    this.checkToken(token);
    if (payload.vehicle.chassisNo.toUpperCase() === MOCK.existingChassis) {
      return this.fail(new ApiError('DUPLICATE_CHASSIS', 'A request already exists for this chassis number.', { fields: { 'v-chassis': 'A request already exists for this chassis number' } }));
    }
    this.s.requests += 1;
    return this.wait({ requestNo: `MIG-2026-${String(this.s.requests).padStart(4, '0')}` });
  }

  async getInsurerResponse(token: string, requestNo: string): Promise<InsurerResponseView> {
    try {
      this.checkToken(token);
      this.checkRequest(requestNo);
    } catch (e) {
      return this.fail(e as ApiError);
    }
    return this.wait({
      request: SUMMARY,
      insurerName: 'Insurer A',
      recommended: PACKAGES,
      vehicleCategories: ['Motor car', 'Dual purpose (van / cab)', 'SUV / Jeep', 'Motorcycle', 'Three-wheeler', 'Lorry', 'Bus'],
      submission: this.s.insurerSubmission,
    });
  }

  async submitInsurerResponse(token: string, requestNo: string, input: InsurerResponseInput) {
    this.checkToken(token);
    this.checkRequest(requestNo);
    if (this.s.insurerSubmission) return this.fail(new ApiError('ALREADY_SUBMITTED'));
    let pkg: StoredPackage;
    if (input.mode === 'stored') {
      const found = PACKAGES.find((p) => p.packageRef === input.packageRef);
      if (!found) return this.fail(new ApiError('VALIDATION', 'Choose a package.'));
      pkg = found;
    } else {
      const premium = Math.round((SUMMARY.sumInsured * input.package.premiumRate) / 100 * 100) / 100;
      pkg = {
        packageRef: 'A-NEW-' + Date.now().toString().slice(-4),
        name: input.package.name,
        premiumRate: input.package.premiumRate,
        premium,
        taxes: input.package.taxes,
        total: premium + input.package.taxes,
        excess: input.package.excess,
        validUntil: input.package.validUntil,
        standardCovers: input.package.standardCovers,
        optionalCovers: input.package.optionalCovers,
      };
    }
    this.s.insurerSubmission = { submittedBy: MOCK.insurerEmail, submittedAt: new Date().toISOString(), package: pkg };
    await this.wait(null);
  }

  private offers(): Offer[] {
    const a = this.s.insurerSubmission?.package ?? PACKAGES[0];
    const mine: Offer = {
      insurer: 'Insurer A', source: 'webform', packageRef: a.packageRef, packageName: a.name, premium: a.premium, taxes: a.taxes,
      total: a.total, sumInsured: SUMMARY.sumInsured, excess: a.excess, standardCovers: a.standardCovers, optionalCovers: a.optionalCovers,
      validUntil: a.validUntil, remarks: 'Inspection waived for vehicles under 8 years old.',
    };
    return [...OTHER_OFFERS, mine].sort((x, y) => x.total - y.total);
  }

  async getCompare(token: string, requestNo: string): Promise<CompareView> {
    try {
      this.checkToken(token);
      this.checkRequest(requestNo);
    } catch (e) {
      return this.fail(e as ApiError);
    }
    return this.wait({ request: SUMMARY, customer: { name: 'Kasun Perera', mobileLast3: '123' }, offers: this.offers(), status: this.s.compareStatus, selected: this.s.selected });
  }

  async selectPackage(token: string, requestNo: string, p: { insurer: string; packageRef: string }) {
    this.checkToken(token);
    this.checkRequest(requestNo);
    if (this.s.compareStatus === 'confirmed') return this.fail(new ApiError('ALREADY_SUBMITTED'));
    const offer = this.offers().find((o) => o.insurer === p.insurer && o.packageRef === p.packageRef);
    if (!offer) return this.fail(new ApiError('VALIDATION', 'Choose a package.'));
    this.s.selected = { insurer: offer.insurer, packageRef: offer.packageRef, total: offer.total };
    this.s.compareStatus = 'awaiting_customer_otp';
    this.s.customerAttempts = 3;
    return this.wait({ mobileLast3: '123' });
  }

  async verifyCustomerOtp(token: string, requestNo: string, code: string): Promise<VerifyCustomerOtpResult> {
    this.checkToken(token);
    this.checkRequest(requestNo);
    if (code === MOCK.customerCode) {
      this.s.compareStatus = 'confirmed';
      if (this.s.selected) this.s.selected.acceptedAt = new Date().toISOString();
      return this.wait({ result: 'verified', attemptsLeft: this.s.customerAttempts });
    }
    this.s.customerAttempts -= 1;
    if (this.s.customerAttempts <= 0) {
      this.s.customerAttempts = 3;
      return this.wait({ result: 'new_code_sent', attemptsLeft: 3 });
    }
    return this.wait({ result: 'incorrect', attemptsLeft: this.s.customerAttempts });
  }

  async getBinding(token: string, requestNo: string): Promise<BindingView> {
    try {
      this.checkToken(token);
      this.checkRequest(requestNo);
    } catch (e) {
      return this.fail(e as ApiError);
    }
    return this.wait({
      request: SUMMARY,
      insurerName: 'Insurer A',
      accepted: { packageName: 'Comprehensive Standard', packageRef: 'A-COMP-STD', total: 287980, acceptedAt: '2026-11-05T12:04:00+05:30' },
      customer: { name: 'Kasun Perera', idNumber: '199012345678', mobile: '+94 77 456 7123', address: '42/1 Peradeniya Road, Kandy 20000' },
      vehicle: { description: 'Toyota Aqua, 2019', registrationNo: 'CAB-4521', chassisNo: 'NHP10-6789012', engineNo: '1NZ-X123456' },
      interestedParty: 'Northgate Finance PLC (Lease)',
      policyStartDate: SUMMARY.policyStartDate,
      submitted: this.s.binding,
    });
  }

  async submitBinding(token: string, requestNo: string, input: BindingInput) {
    this.checkToken(token);
    this.checkRequest(requestNo);
    if (this.s.binding) return this.fail(new ApiError('ALREADY_SUBMITTED'));
    this.s.binding = { policyNumber: input.policyNumber, submittedAt: new Date().toISOString(), expiryDate: input.policyExpiryDate, documents: 1 + input.policyFiles.length };
    await this.wait(null);
  }

  async getPayment(token: string, requestNo: string): Promise<PaymentView> {
    try {
      this.checkToken(token);
      this.checkRequest(requestNo);
    } catch (e) {
      return this.fail(e as ApiError);
    }
    return this.wait({
      requestNo,
      policyNumber: 'A/MV/2026/004512',
      insurerName: 'Insurer A',
      customerName: 'Kasun Perera',
      premiumDue: 287980,
      dueDate: '2026-12-10',
      status: this.s.payment ? 'Paid' : 'Outstanding',
      paid: this.s.payment,
    });
  }

  async submitPayment(token: string, requestNo: string, input: PaymentInput) {
    this.checkToken(token);
    this.checkRequest(requestNo);
    if (this.s.payment) return this.fail(new ApiError('ALREADY_SUBMITTED'));
    this.s.payment = { paidDate: input.paidDate, reference: input.reference, amount: input.amount };
    await this.wait(null);
  }
}
