import {
  ApiError,
  type ApiErrorCode,
  type BindingInput,
  type BindingView,
  type CompareView,
  type GatewayApi,
  type InsurerResponseInput,
  type InsurerResponseView,
  type PaymentInput,
  type PaymentView,
  type Purpose,
  type RequestPayload,
  type Session,
  type SignInScreen,
  type VerifyCustomerOtpResult,
} from './types';

/**
 * Calls the webform backend. The backend talks to WorkHub24; the browser never does,
 * so no WorkHub24 credentials ever reach the client.
 */
export class HttpApi implements GatewayApi {
  constructor(private baseUrl: string) {}

  private async call<T>(method: string, path: string, opts: { token?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    } catch {
      throw new ApiError('NETWORK', 'Could not reach the server. Check your connection and try again.');
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = (data && data.error) || {};
      const code = (e.code as ApiErrorCode) || (res.status === 401 ? 'SESSION_EXPIRED' : 'UNKNOWN');
      throw new ApiError(code, e.message, { fields: e.fields, attemptsLeft: e.attemptsLeft });
    }
    return data as T;
  }

  private enc(no: string) {
    return encodeURIComponent(no);
  }

  requestOtp(p: { email: string; purpose: Purpose; requestNo?: string; screen?: SignInScreen }) {
    return this.call<{ resendAfterSeconds: number }>('POST', '/auth/otp/request', { body: p });
  }
  verifyOtp(p: { email: string; code: string; purpose: Purpose; requestNo?: string; screen?: SignInScreen }) {
    return this.call<Session>('POST', '/auth/otp/verify', { body: p });
  }

  checkChassis(token: string, chassisNo: string) {
    return this.call<{ exists: boolean }>('GET', `/requests/chassis/${encodeURIComponent(chassisNo)}`, { token });
  }
  submitRequest(token: string, payload: RequestPayload) {
    return this.call<{ requestNo: string }>('POST', '/requests', { token, body: payload });
  }

  getInsurerResponse(token: string, requestNo: string) {
    return this.call<InsurerResponseView>('GET', `/insurer/requests/${this.enc(requestNo)}/response`, { token });
  }
  submitInsurerResponse(token: string, requestNo: string, input: InsurerResponseInput) {
    return this.call<void>('POST', `/insurer/requests/${this.enc(requestNo)}/response`, { token, body: input });
  }

  getCompare(token: string, requestNo: string) {
    return this.call<CompareView>('GET', `/finance/requests/${this.enc(requestNo)}/offers`, { token });
  }
  selectPackage(token: string, requestNo: string, p: { insurer: string; packageRef: string }) {
    return this.call<{ mobileLast3: string }>('POST', `/finance/requests/${this.enc(requestNo)}/select`, { token, body: p });
  }
  verifyCustomerOtp(token: string, requestNo: string, code: string) {
    return this.call<VerifyCustomerOtpResult>('POST', `/finance/requests/${this.enc(requestNo)}/customer-otp`, { token, body: { code } });
  }

  getBinding(token: string, requestNo: string) {
    return this.call<BindingView>('GET', `/insurer/requests/${this.enc(requestNo)}/binding`, { token });
  }
  submitBinding(token: string, requestNo: string, input: BindingInput) {
    const form = new FormData();
    form.append('quotationRef', input.quotationRef);
    form.append('quotationFile', input.quotationFile);
    form.append('policyNumber', input.policyNumber);
    form.append('policyStartDate', input.policyStartDate);
    form.append('policyExpiryDate', input.policyExpiryDate);
    input.policyFiles.forEach((f) => form.append('policyFiles', f));
    if (input.remarks) form.append('remarks', input.remarks);
    return this.call<void>('POST', `/insurer/requests/${this.enc(requestNo)}/binding`, { token, form });
  }

  getPayment(token: string, requestNo: string) {
    return this.call<PaymentView>('GET', `/insurer/requests/${this.enc(requestNo)}/payment`, { token });
  }
  submitPayment(token: string, requestNo: string, input: PaymentInput) {
    return this.call<void>('POST', `/insurer/requests/${this.enc(requestNo)}/payment`, { token, body: input });
  }
}
