import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { FakeWorkHub24Client } from '../src/wh24/fakeClient.js';
import { FIELD_MAP, REQUEST_STATUS } from '../src/wh24/fields.js';
import { CURRENT_PACKAGE_INSURER_CODE } from '../src/routes/insurer.js';
import { buildRequestCardFields, formatWh24DateTime } from '../src/routes/requests.js';
import { JsonOffersRepository, MemoryOffersRepository, MemoryOtpAttemptsRepository, type OffersRepository } from '../src/services/offersStore.js';

const uploadDirectories: string[] = [];

afterAll(() => {
  for (const directory of uploadDirectories) rmSync(directory, { recursive: true, force: true });
});

function createTestApp(client: FakeWorkHub24Client, offersRepository: OffersRepository = new MemoryOffersRepository()) {
  const uploadDirectory = mkdtempSync(join(tmpdir(), 'insurance-brokers-uploads-'));
  uploadDirectories.push(uploadDirectory);
  return createApp({
    wh24Client: client,
    offersRepository,
    otpAttemptsRepository: new MemoryOtpAttemptsRepository(),
    uploadDirectory
  });
}

async function loginAsFinance(app: any, client: FakeWorkHub24Client, email = 'nadeesha.fernando@northgate.lk', requestNo = 'MIG-2026-0148') {
  if (requestNo === 'MIG-2026-0148') client.setOpenTask('wf-01-0148', 'Awaiting Package Selection');
  await request(app).post('/api/auth/otp/request').send({ email, purpose: 'finance_signin', requestNo });
  const otp = getLastOtp(client);
  const res = await request(app).post('/api/auth/otp/verify').send({ email, code: otp, purpose: 'finance_signin', requestNo });
  return res.body.token as string;
}

async function loginAsInsurer(app: any, client: FakeWorkHub24Client, email = 'dilani.w@insurer-a.lk', requestNo = 'MIG-2026-0148') {
  if (requestNo === 'MIG-2026-0148') client.setOpenTask('wf-01-0148', 'Awaiting Insurer Responses');
  await request(app).post('/api/auth/otp/request').send({ email, purpose: 'insurer_signin', requestNo });
  const otp = getLastOtp(client);
  const res = await request(app).post('/api/auth/otp/verify').send({ email, code: otp, purpose: 'insurer_signin', requestNo });
  return res.body.token as string;
}

function getLastOtp(client: FakeWorkHub24Client) {
  const items = Array.from((client as any).items.values()).filter((item: any) => item.workflow === 'WF-02');
  const last = items[items.length - 1] as any;
  return String(last?.fields?.oTPCode ?? '');
}

describe('Motor Insurance Gateway backend', () => {
  it('persists response references and premiums in the offers file, one row per package', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'insurance-offers-'));
    uploadDirectories.push(directory);
    const path = join(directory, 'offers.json');
    const repository = new JsonOffersRepository(path);
    const offer = {
      requestNo: 'MIG-2026-0148',
      insurer: 'Insurer A',
      packageRef: 'A-COMP-STD',
      premium: 238000,
      taxes: 49980,
      total: 287980,
      respondedBy: 'dilani.w@insurer-a.lk',
      respondedAt: '2026-11-11T00:00:00.000Z'
    };
    const plus = { ...offer, packageRef: 'A-COMP-PLUS' };

    await repository.replace(offer.requestNo, [plus]);
    await repository.replace(offer.requestNo, [offer, plus]);
    await repository.replace('MIG-2026-0149', [{ ...offer, requestNo: 'MIG-2026-0149' }]);

    // A resubmit replaces the request's offers; other requests are untouched.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([offer, plus, { ...offer, requestNo: 'MIG-2026-0149' }]);
    // A new repository on the same file (a backend restart) sees the same offers.
    expect(await new JsonOffersRepository(path).get(offer.requestNo)).toEqual([offer, plus]);
    await expect(repository.replace(offer.requestNo, [{ ...offer, requestNo: 'OTHER' }])).rejects.toThrow(/must belong/);
  });

  it('stores the Screen 2 offer only after WH24 succeeds, and allows a retry after a failure', async () => {
    class FailingOnceClient extends FakeWorkHub24Client {
      failNext = true;
      override async updateAndCompleteTask(
        cardId: string | number,
        taskName: string,
        prepareFields: () => Promise<Record<string, unknown>> | Record<string, unknown>
      ) {
        if (this.failNext) {
          this.failNext = false;
          await prepareFields();
          throw new Error('WH24 PUT failed');
        }
        return super.updateAndCompleteTask(cardId, taskName, prepareFields);
      }
    }
    const client = new FailingOnceClient();
    const offers = new MemoryOffersRepository();
    const app = createTestApp(client, offers);
    const insurerToken = await loginAsInsurer(app, client);
    const submit = (packageRef: string) => request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: [packageRef] });

    const failed = await submit('A-COMP-STD');
    expect(failed.status).toBe(500);
    expect(await offers.get('MIG-2026-0148')).toEqual([]);

    const retried = await submit('A-COMP-PLUS');
    expect(retried.status).toBe(204);
    expect((await offers.get('MIG-2026-0148')).map((offer) => offer.packageRef)).toEqual(['A-COMP-PLUS']);
  });

  it('overwrites a half-finished offer while the Screen 2 task is still open', async () => {
    const client = new FakeWorkHub24Client();
    const offers = new MemoryOffersRepository();
    await offers.replace('MIG-2026-0148', [{
      requestNo: 'MIG-2026-0148', insurer: 'Insurer A', packageRef: 'A-COMP-PLUS',
      respondedBy: 'dilani.w@insurer-a.lk', respondedAt: '2026-11-10T00:00:00.000Z'
    }]);
    const app = createTestApp(client, offers);
    const insurerToken = await loginAsInsurer(app, client);

    const view = await request(app)
      .get('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`);
    expect(view.status).toBe(200);
    expect(view.body.submission).toBeUndefined();

    const resubmitted = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: ['A-COMP-STD'] });
    expect(resubmitted.status).toBe(204);
    expect((await offers.get('MIG-2026-0148')).map((offer) => offer.packageRef)).toEqual(['A-COMP-STD']);
  });

  it('looks up WF-01 tasks once with no wait; only WF-02 result updates wait', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    await loginAsInsurer(app, client);
    await vi.waitFor(() => expect(client.completedTasks.some((task) => task.taskName === 'Awaiting Verification')).toBe(true));
    // WF-01 sign-in gate: one lookup, no wait. WF-02 Verified update: capped 8s wait.
    expect(client.taskLookupWaits).toEqual([0, 0, 8000]);
  });

  it('allows Screen 1 when WorkHub24 chassis lookup fails', async () => {
    class FailingChassisLookupClient extends FakeWorkHub24Client {
      override async findRequestByChassis(): Promise<never> {
        throw new Error('chassis search returned HTML');
      }
    }

    const client = new FailingChassisLookupClient();
    const app = createTestApp(client);
    const token = await loginAsFinance(app, client);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const payload = {
      customer: {
        type: 'Individual',
        name: 'Saman Silva',
        idNumber: '199012345V',
        mobile: '+94770000007',
        address: 'Colombo 7'
      },
      vehicle: {
        category: 'Motor car',
        make: 'Toyota',
        model: 'Aqua',
        year: 2019,
        condition: 'Registered',
        chassisNo: 'CH-LOOKUP-FAIL',
        engineNo: 'ENG-LOOKUP-FAIL',
        value: 8500000,
        usage: 'Private'
      },
      finance: {
        facilityType: 'Lease',
        referenceNo: 'FAC-LOOKUP-FAIL',
        amount: 1500000,
        tenureMonths: 36
      },
      cover: {
        coverType: 'Comprehensive',
        sumInsured: 8500000,
        optionalCovers: [],
        policyStartDate: '2026-11-10'
      },
      consent: true
    };

    try {
      const check = await request(app)
        .get('/api/requests/chassis/CH-LOOKUP-FAIL')
        .set('Authorization', `Bearer ${token}`);
      expect(check.status).toBe(200);
      expect(check.body.exists).toBe(false);

      const created = await request(app)
        .post('/api/requests')
        .set('Authorization', `Bearer ${token}`)
        .send(payload);
      expect(created.status).toBe(201);
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }

    // A client with no chassis search (the live tenant) skips the check and logs it once.
    class NoChassisSearchClient extends FakeWorkHub24Client {}
    Object.defineProperty(NoChassisSearchClient.prototype, 'findRequestByChassis', { value: undefined });
    const plainClient = new NoChassisSearchClient();
    const plainApp = createTestApp(plainClient);
    const plainToken = await loginAsFinance(plainApp, plainClient);
    const skipWarning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const chassisNo of ['CH-SKIP-1', 'CH-SKIP-2']) {
        const created = await request(plainApp).post('/api/requests').set('Authorization', `Bearer ${plainToken}`)
          .send({ ...payload, vehicle: { ...payload.vehicle, chassisNo } });
        expect(created.status).toBe(201);
      }
      const skipped = skipWarning.mock.calls.filter(([message]) => String(message).startsWith('Duplicate-chassis check skipped'));
      expect(skipped).toHaveLength(1);
    } finally {
      skipWarning.mockRestore();
    }
  });

  it('uses finance user view keys for OTP and session data', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const email = 'nadeesha.fernando@northgate.lk';

    await request(app).post('/api/auth/otp/request').send({ email, purpose: 'finance_signin' });
    const otp = getLastOtp(client);
    const otpCard = Array.from((client as any).items.values()).find((item: any) => item.workflow === 'WF-02') as any;
    expect(otpCard.fields.title).toBe('OTP · Finance User Sign-in · ●●● ●●● 0001');
    expect(otpCard.fields).toMatchObject({
      receipentEmail: email,
      mobile: '●●● ●●● 0001',
      oTPMobile: '94770000001',
      sentAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      purpose: 'Finance User Sign-in',
      requestRef: ''
    });
    expect(Object.keys(otpCard.fields).sort()).toEqual([
      'mobile', 'oTPCode', 'oTPMobile', 'purpose', 'receipentEmail', 'requestRef', 'sentAt', 'title'
    ]);
    expect(otpCard.fields.title).not.toContain(otp);
    const verified = await request(app)
      .post('/api/auth/otp/verify')
      .send({ email, code: otp, purpose: 'finance_signin' });

    expect(verified.status).toBe(200);
    // WF-01 financePartner is a dropdown of partner names, so the session carries the name.
    expect(verified.body.user.partner).toBe('Northgate Finance PLC');
    await vi.waitFor(() => {
      expect(otpCard.fields.oTPResult).toBe('Verified');
      expect(client.completedTasks).toContainEqual({ cardId: otpCard.itemId, taskName: 'Awaiting Verification' });
    });
  });

  it('matches active finance users case-insensitively and uses the first duplicate', async () => {
    class DuplicateFinanceUsersClient extends FakeWorkHub24Client {
      override async queryDatastore(table: string, filter: Record<string, string | number | boolean>) {
        if (table === 'ds_finance_user') {
          return [
            { active: 'No', email: 'Renu@Process361.com', mobile: '+94770000000', name: 'Inactive', partnerCode: 'FP-X' },
            { active: 'Yes', email: 'Renu@Process361.com', mobile: '+94770000001', name: 'First User', partnerCode: 'FP-01' },
            { active: 'Yes', email: 'renu@process361.com', mobile: '+94770000002', name: 'Second User', partnerCode: 'FP-02' }
          ];
        }
        return super.queryDatastore(table, filter);
      }
    }

    const client = new DuplicateFinanceUsersClient();
    const app = createTestApp(client);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: 'RENU@PROCESS361.COM', purpose: 'finance_signin' });
      const otpCard = Array.from((client as any).items.values()).find((item: any) => item.workflow === 'WF-02') as any;
      expect(otpCard.fields).toMatchObject({
        receipentEmail: 'Renu@Process361.com',
        oTPMobile: '94770000001',
        mobile: '●●● ●●● 0001'
      });
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it('verifies OTP codes and locks after repeated failures', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    client.setOpenTask('wf-01-0148', 'Awaiting Package Selection');

    const otpRequest = await request(app).post('/api/auth/otp/request').send({ email: 'nadeesha.fernando@northgate.lk', purpose: 'finance_signin', requestNo: 'MIG-2026-0148' });
    expect(otpRequest.status).toBe(200);
    expect(otpRequest.body.resendAfterSeconds).toBe(60);

    const wrongCode = '000000';
    const firstWrong = await request(app).post('/api/auth/otp/verify').send({ email: 'nadeesha.fernando@northgate.lk', code: wrongCode, purpose: 'finance_signin', requestNo: 'MIG-2026-0148' });
    expect(firstWrong.status).toBe(400);
    expect(firstWrong.body.error.code).toBe('OTP_INCORRECT');
    expect(firstWrong.body.error.attemptsLeft).toBe(2);

    const otp = getLastOtp(client);
    const secondWrong = await request(app).post('/api/auth/otp/verify').send({ email: 'nadeesha.fernando@northgate.lk', code: '111111', purpose: 'finance_signin', requestNo: 'MIG-2026-0148' });
    expect(secondWrong.status).toBe(400);
    expect(secondWrong.body.error.attemptsLeft).toBe(1);

    const thirdWrong = await request(app).post('/api/auth/otp/verify').send({ email: 'nadeesha.fernando@northgate.lk', code: '222222', purpose: 'finance_signin', requestNo: 'MIG-2026-0148' });
    expect(thirdWrong.status).toBe(429);
    expect(thirdWrong.body.error.code).toBe('OTP_LOCKED');
    const otpCard = Array.from((client as any).items.values()).find((item: any) => item.workflow === 'WF-02') as any;
    await vi.waitFor(() => {
      expect(otpCard.fields.oTPResult).toBe('Failed');
      expect(client.completedTasks).toContainEqual({ cardId: otpCard.itemId, taskName: 'Awaiting Verification' });
    });

    const valid = await request(app).post('/api/auth/otp/verify').send({ email: 'nadeesha.fernando@northgate.lk', code: otp, purpose: 'finance_signin', requestNo: 'MIG-2026-0148' });
    expect(valid.status).toBe(429);
  });

  it('expires the prior WF-02 task before creating a replacement code', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const email = 'nadeesha.fernando@northgate.lk';

    await request(app).post('/api/auth/otp/request').send({ email, purpose: 'finance_signin' });
    const firstCard = Array.from((client as any).items.values()).find((item: any) => item.workflow === 'WF-02') as any;

    const replacement = await request(app).post('/api/auth/otp/request').send({ email, purpose: 'finance_signin' });
    expect(replacement.status).toBe(200);
    expect(firstCard.fields.oTPResult).toBe('Expired');
    expect(client.completedTasks).toContainEqual({ cardId: firstCard.itemId, taskName: 'Awaiting Verification' });
    expect(Array.from((client as any).items.values()).filter((item: any) => item.workflow === 'WF-02')).toHaveLength(2);
  });

  it('continues successful sign-in when the WF-02 result update fails', async () => {
    class FailingOtpTaskClient extends FakeWorkHub24Client {
      override async updateAndCompleteTaskForWorkflow(
        _workflow: 'WF-01' | 'WF-02',
        _cardId: string | number,
        _taskName: string,
        _fields: Record<string, unknown>
      ): Promise<void> {
        throw new Error('test task update failure');
      }
    }

    const client = new FailingOtpTaskClient();
    const app = createTestApp(client);
    const email = 'nadeesha.fernando@northgate.lk';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await request(app).post('/api/auth/otp/request').send({ email, purpose: 'finance_signin' });
      const code = getLastOtp(client);
      const verified = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email, code, purpose: 'finance_signin' });

      expect(verified.status).toBe(200);
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
        'WorkHub24 WF-02 OTP result update failed; continuing sign-in.',
        expect.objectContaining({ result: 'Verified' })
      ));
    } finally {
      warning.mockRestore();
    }
  });

  it('does not send a linked sign-in code when the screen task is not open', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    client.setOpenTask('wf-01-0148', 'Awaiting Insurer Responses');

    const response = await request(app)
      .post('/api/auth/otp/request')
      .send({
        email: 'nadeesha.fernando@northgate.lk',
        purpose: 'finance_signin',
        requestNo: 'MIG-2026-0148'
      });

    expect(response.status).toBe(409);
    // Status is still Awaiting Quotes: Screen 3 is not open yet, which is not "already submitted".
    expect(response.body.error.code).toBe('NOT_READY');
    expect(Array.from((client as any).items.values()).filter((item: any) => item.workflow === 'WF-02')).toHaveLength(0);
  });

  it('links an insurer to a request by currentInsurer, else currentInsurerEmail via the insurers view', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    client.setOpenTask('wf-01-0148', 'Awaiting Insurer Responses');
    const send = () => request(app).post('/api/auth/otp/request').send({
      email: 'dilani.w@insurer-a.lk', purpose: 'insurer_signin', requestNo: 'MIG-2026-0148', screen: 'response'
    });

    // currentInsurer filled: it decides, even when the email would match.
    await client.updateFields('wf-01-0148', { G4: 'Insurer B', G5: 'quotes@insurer-a.lk' });
    expect((await send()).body.error?.code).toBe('NOT_AUTHORISED');
    await client.updateFields('wf-01-0148', { G4: 'Insurer A' });
    expect((await send()).status).toBe(200);

    // currentInsurer empty: currentInsurerEmail is matched to contactEmail in the insurers view.
    await client.updateFields('wf-01-0148', { G4: '', G5: 'QUOTES@insurer-a.lk' });
    expect((await send()).status).toBe(200);
    await client.updateFields('wf-01-0148', { G5: 'quotes@insurer-b.lk' });
    expect((await send()).body.error?.code).toBe('NOT_AUTHORISED');
    await client.updateFields('wf-01-0148', { G5: '' });
    expect((await send()).body.error?.code).toBe('NOT_AUTHORISED');

    // selectedInsurers rows are never read.
    await client.updateFields('wf-01-0148', { F1: [{ insurer: 'Insurer A' }], I2: 'Insurer A' });
    expect((await send()).body.error?.code).toBe('NOT_AUTHORISED');
  });

  it('gates insurer sign-in by the screen task: Screen 4 needs Awaiting Policy Upload', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const wf02Count = () => Array.from((client as any).items.values()).filter((item: any) => item.workflow === 'WF-02').length;
    // Safety net: with the current-insurer fields empty, the selected insurer (I2) can still sign in on Screen 4.
    await client.updateFields('wf-01-0148', { G4: '', G5: '', I2: 'Insurer A' });
    client.setOpenTask('wf-01-0148', 'Awaiting Policy Upload');
    const send = (screen?: string) => request(app).post('/api/auth/otp/request').send({
      email: 'dilani.w@insurer-a.lk', purpose: 'insurer_signin', requestNo: 'MIG-2026-0148', ...(screen ? { screen } : {})
    });

    // Screen 2: with the current-insurer fields empty (and I2 only counting on Screen 4), not linked.
    const closedScreen2 = await send('response');
    expect(closedScreen2.status).toBe(403);
    expect(closedScreen2.body.error.code).toBe('NOT_AUTHORISED');
    expect(wf02Count()).toBe(0);

    const binding = await send('binding');
    expect(binding.status).toBe(200);
    expect(wf02Count()).toBe(1);

    const payment = await send('payment');
    expect(payment.status).toBe(410);
    expect(wf02Count()).toBe(1);

    await client.updateFields('wf-01-0148', { A3: REQUEST_STATUS.completed });
    client.setOpenTask('wf-01-0148', 'None');
    const completed = await send('binding');
    expect(completed.status).toBe(410);
    expect(completed.body.error.code).toBe('REQUEST_CLOSED');
    expect(wf02Count()).toBe(1);
  });

  it('gates the Screen 2 submit by the open task, not by Status', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const insurerToken = await loginAsInsurer(app, client);
    await client.updateFields('wf-01-0148', { A3: 'Some Other Status' });

    const submitted = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: ['A-COMP-STD'] });
    expect(submitted.status).toBe(204);
    expect((await client.getItem('wf-01-0148')).fields.G19).toBe('No');

    const client2 = new FakeWorkHub24Client();
    const app2 = createTestApp(client2);
    const token2 = await loginAsInsurer(app2, client2);
    client2.setOpenTask('wf-01-0148', 'Awaiting Package Selection');
    // As after a real Screen 2 submit: the status is past Screen 2's step.
    await client2.updateFields('wf-01-0148', { A3: REQUEST_STATUS.awaitingSelection });
    const closed = await request(app2)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${token2}`)
      .send({ packageRefs: ['A-COMP-STD'] });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('ALREADY_SUBMITTED');
  });

  it('creates a request and blocks duplicate chassis numbers', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const token = await loginAsFinance(app, client);

    const payload = {
      customer: {
        type: 'Individual',
        name: 'Saman Silva',
        idNumber: '199012345V',
        mobile: '+94770000007',
        email: 'saman@example.com',
        address: 'Colombo 7'
      },
      vehicle: {
        category: 'Motor car',
        make: 'Toyota',
        model: 'Aqua',
        year: 2019,
        condition: 'Registered',
        registrationNo: 'ABC-4567',
        chassisNo: 'CH-NEW-001',
        engineNo: 'ENG-NEW-001',
        value: 8500000,
        usage: 'Private'
      },
      finance: {
        facilityType: 'Lease',
        referenceNo: 'FAC-NEW-01',
        amount: 1500000,
        tenureMonths: 36
      },
      cover: {
        coverType: 'Comprehensive',
        sumInsured: 8500000,
        optionalCovers: ['SRCC'],
        policyStartDate: '2026-11-10',
        remarks: 'Fresh request'
      },
      consent: true
    };

    const create = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send(payload);
    expect(create.status).toBe(201);
    expect(create.body.requestNo).toMatch(/^MIG-\d{4}-\d{4}$/);
    const createdRecord = (await client.getRequestCard(create.body.requestNo))!;
    expect(createdRecord).not.toBeNull();
    expect(createdRecord.fields.title).toBe('Saman Silva · CH-NEW-001');
    expect(createdRecord.fields.A3).toBe(REQUEST_STATUS.awaitingQuotes);
    expect(createdRecord.fields.B4).toBe('94770000007');

    const duplicate = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send({ ...payload, vehicle: { ...payload.vehicle, chassisNo: 'CH-NEW-001' } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_CHASSIS');
  });

  it('returns offers, completes workflow tasks, and allows finance selection', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const financeToken = await loginAsFinance(app, client);
    const insurerToken = await loginAsInsurer(app, client);

    const insurerResponse = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: ['A-COMP-STD'], remarks: 'Looks good' });
    expect(insurerResponse.status).toBe(204);
    expect(client.completedTasks.at(-1)?.taskName).toBe('Awaiting Insurer Responses');
    expect((await client.getItem('wf-01-0148')).fields.A3).toBe(REQUEST_STATUS.awaitingSelection);
    expect(client.taskEvents.slice(-3).map((event) => event.operation)).toEqual(['GET_TASK', 'PUT', 'POST_TASK']);

    const offers = await request(app).get('/api/finance/requests/MIG-2026-0148/offers').set('Authorization', `Bearer ${financeToken}`);
    expect(offers.status).toBe(200);
    expect(offers.body.offers.length).toBeGreaterThan(0);
    expect(offers.body.offers.find((offer: any) => offer.packageRef === 'A-COMP-STD')).toMatchObject({
      premium: 238000,
      taxes: 49980,
      total: 287980
    });
    expect(offers.body.offers.some((offer: any) => offer.packageRef === 'C-API-PRIME' && offer.source === 'api')).toBe(true);

    const selected = await request(app).post('/api/finance/requests/MIG-2026-0148/select').set('Authorization', `Bearer ${financeToken}`).send({ insurer: 'Insurer A', packageRef: 'A-COMP-STD' });
    expect(selected.status).toBe(200);
    expect(client.completedTasks.at(-1)?.taskName).toBe('Awaiting Package Selection');
    const selectedCard = await client.getItem('wf-01-0148');
    // Email and connection type come from the insurers view, not from F1.
    expect(selectedCard.fields.I4).toBe('quotes@insurer-a.lk');
    expect(selectedCard.fields.I3).toBe('Webform');
    expect(selectedCard.fields.I5a).toBe(287980);
    expect(selectedCard.fields.A3).toBe(REQUEST_STATUS.awaitingConsent);
    const otp = String((client as any).items.values().next().value?.fields?.I6 ?? '');

    const verifyOtp = await request(app).post('/api/finance/requests/MIG-2026-0148/customer-otp').set('Authorization', `Bearer ${financeToken}`).send({ code: otp || '654321' });
    expect(verifyOtp.status).toBe(200);
    expect(verifyOtp.body.result).toBe('verified');
    expect(client.completedTasks.at(-1)?.taskName).toBe('Awaiting OTP Verification');
    expect((await client.getItem('wf-01-0148')).fields.I12).toBe(287980);
    expect((await client.getItem('wf-01-0148')).fields.A3).toBe(REQUEST_STATUS.awaitingPolicy);
    const closedCompare = await request(app)
      .get('/api/finance/requests/MIG-2026-0148/offers')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(closedCompare.status).toBe(409);
    expect(closedCompare.body.error.code).toBe('ALREADY_SUBMITTED');
  });

  it('reports PENDING in the gap before WorkHub24 opens the next task, then lets each screen continue', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const financeToken = await loginAsFinance(app, client);
    const insurerToken = await loginAsInsurer(app, client);
    // WorkHub24 runs automated steps (e.g. the customer SMS) before the next task exists.
    client.nextTaskDelayMs = 150;
    const offers = () => request(app).get('/api/finance/requests/MIG-2026-0148/offers').set('Authorization', `Bearer ${financeToken}`);
    const binding = () => request(app).get('/api/insurer/requests/MIG-2026-0148/binding').set('Authorization', `Bearer ${insurerToken}`);
    const waitFor200 = (load: () => Promise<request.Response>) =>
      vi.waitFor(async () => expect((await load()).status).toBe(200), { timeout: 2_000, interval: 50 });

    // Screen 2 -> Screen 3
    const response = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: ['A-COMP-STD'] });
    expect(response.status).toBe(204);
    const gap1 = await offers();
    expect(gap1.status).toBe(409);
    expect(gap1.body.error.code).toBe('PENDING');
    await waitFor200(offers);

    // Screen 3 select -> customer code entry
    const select = await request(app).post('/api/finance/requests/MIG-2026-0148/select')
      .set('Authorization', `Bearer ${financeToken}`).send({ insurer: 'Insurer A', packageRef: 'A-COMP-STD' });
    expect(select.status).toBe(200);
    const gap2 = await offers();
    expect(gap2.body.error).toMatchObject({ code: 'PENDING', message: expect.stringMatching(/sending the code/i) });
    await waitFor200(offers);
    expect((await offers()).body.status).toBe('awaiting_customer_otp');

    // Code verified -> Screen 4
    const code = String((await client.getItem('wf-01-0148')).fields.I6);
    const verify = await request(app).post('/api/finance/requests/MIG-2026-0148/customer-otp')
      .set('Authorization', `Bearer ${financeToken}`).send({ code });
    expect(verify.body.result).toBe('verified');
    const gap3 = await binding();
    expect(gap3.status).toBe(409);
    expect(gap3.body.error.code).toBe('PENDING');
    await waitFor200(binding);

    // Status is past Screen 3's step: really already done, not pending.
    const done = await offers();
    expect(done.body.error.code).toBe('ALREADY_SUBMITTED');
  });

  it('only reports ALREADY_SUBMITTED once the status is past the screen\'s step', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const insurerToken = await loginAsInsurer(app, client);
    const binding = () => request(app).get('/api/insurer/requests/MIG-2026-0148/binding').set('Authorization', `Bearer ${insurerToken}`);
    await client.updateFields('wf-01-0148', { I2: 'Insurer A' });
    client.setOpenTask('wf-01-0148', 'Awaiting OTP Verification');

    // Customer has not confirmed yet: Screen 4 is not open yet, not "already submitted".
    await client.updateFields('wf-01-0148', { A3: REQUEST_STATUS.awaitingConsent });
    expect((await binding()).body.error.code).toBe('NOT_READY');
    // Verified but the task is not there: the handover gap.
    client.setOpenTask('wf-01-0148', 'None');
    await client.updateFields('wf-01-0148', { A3: REQUEST_STATUS.awaitingPolicy, I7: 'Verified' });
    expect((await binding()).body.error.code).toBe('PENDING');
    // Completed: closed.
    await client.updateFields('wf-01-0148', { A3: REQUEST_STATUS.completed });
    expect((await binding()).body.error.code).toBe('REQUEST_CLOSED');
  });

  it('stores one offer per insurer and moves status to Awaiting Selection', async () => {
    const client = new FakeWorkHub24Client();
    const offers = new MemoryOffersRepository();
    const app = createTestApp(client, offers);
    const insurerToken = await loginAsInsurer(app, client);
    const initialView = await request(app)
      .get('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`);
    expect(initialView.status).toBe(200);
    const submitted = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: ['A-COMP-STD'] });
    expect(submitted.status).toBe(204);
    expect((await client.getItem('wf-01-0148')).fields.A3).toBe(REQUEST_STATUS.awaitingSelection);
    expect(client.completedTasks.at(-1)?.taskName).toBe('Awaiting Insurer Responses');

    const responseView = await request(app)
      .get('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`);
    expect(responseView.status).toBe(409);
    expect(responseView.body.error.code).toBe('ALREADY_SUBMITTED');

    const duplicate = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: ['A-COMP-PLUS'] });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ALREADY_SUBMITTED');
    const [storedOffer] = await offers.get('MIG-2026-0148');
    expect(storedOffer).toMatchObject({
      requestNo: 'MIG-2026-0148',
      insurer: 'Insurer A',
      packageRef: 'A-COMP-STD',
      premium: 238000,
      taxes: 49980,
      total: 287980,
      respondedBy: 'dilani.w@insurer-a.lk'
    });
    expect(Object.keys(storedOffer).sort()).toEqual(['insurer', 'packageRef', 'premium', 'requestNo', 'respondedAt', 'respondedBy', 'taxes', 'total']);
  });

  it('lists the insurer\'s matching packages and stores each chosen package as its own offer', async () => {
    const client = new FakeWorkHub24Client();
    const offers = new MemoryOffersRepository();
    const app = createTestApp(client, offers);
    const insurerToken = await loginAsInsurer(app, client);

    const view = await request(app)
      .get('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`);
    // Only Insurer A's (INSA) packages; Insurer B's B-COMP-01 is not listed.
    expect(view.body.recommended.map((pkg: any) => pkg.packageRef).sort()).toEqual(['A-COMP-PLUS', 'A-COMP-STD']);

    const none = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: [] });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('VALIDATION');
    const foreign = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ packageRefs: ['A-COMP-STD', 'B-COMP-01'] });
    expect(foreign.status).toBe(422);
    expect(client.completedTasks.some((task) => task.taskName === 'Awaiting Insurer Responses')).toBe(false);

    const submitted = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({
        packageRefs: ['A-COMP-STD', 'A-COMP-PLUS', 'A-COMP-STD'],
        newPackage: {
          name: 'Custom Comprehensive', coverType: 'Comprehensive', vehicleCategory: 'Motor car',
          sumMin: 8000000, sumMax: 9000000, premiumRate: 2.8, taxes: 24990, excess: 30000,
          standardCovers: 'Own damage, theft', optionalCovers: [], validUntil: '2026-12-31'
        }
      });
    expect(submitted.status).toBe(204);
    expect((await client.getItem('wf-01-0148')).fields.G19).toBe('Yes');
    const stored = await offers.get('MIG-2026-0148');
    expect(stored.map((offer) => offer.packageRef)).toEqual(['A-COMP-STD', 'A-COMP-PLUS', 'INSA-NEW-MIG-2026-0148']);
    expect(stored[2]).toMatchObject({ premium: 238000, taxes: 24990, total: 262990 });
    expect(new Set(stored.map((offer) => offer.respondedAt)).size).toBe(1);

    // Screen 3 lists the stored packages (the new one appears once WH24 adds it to the packages view).
    const financeToken = await loginAsFinance(app, client);
    const compare = await request(app)
      .get('/api/finance/requests/MIG-2026-0148/offers')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(compare.status).toBe(200);
    const webform = compare.body.offers.filter((offer: any) => offer.source === 'webform');
    expect(webform.map((offer: any) => offer.packageRef).sort()).toEqual(['A-COMP-PLUS', 'A-COMP-STD']);
    expect(webform.find((offer: any) => offer.packageRef === 'A-COMP-STD')).toMatchObject({ total: 287980, insurer: 'Insurer A' });
  });

  it('writes new-package details before completing the insurer response task', async () => {
    const client = new FakeWorkHub24Client();
    const offers = new MemoryOffersRepository();
    const app = createTestApp(client, offers);
    const insurerToken = await loginAsInsurer(app, client);
    const submitted = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({
        packageRefs: [],
        newPackage: {
          name: 'Custom Comprehensive',
          coverType: 'Comprehensive',
          vehicleCategory: 'Motor car',
          sumMin: 8000000,
          sumMax: 9000000,
          premiumRate: 2.8,
          taxes: 24990,
          excess: 30000,
          standardCovers: 'Own damage, theft',
          optionalCovers: ['SRCC'],
          validUntil: '2026-12-31'
        }
      });

    expect(submitted.status).toBe(204);
    const card = await client.getItem('wf-01-0148');
    expect(card.fields.G7).toBe('Insurer A');
    expect(card.fields.G8).toBe('INSA-NEW-MIG-2026-0148');
    expect(card.fields.G9).toBe('Custom Comprehensive');
    expect(card.fields.G10).toBe('Motor car');
    expect(card.fields.G11).toBe('Comprehensive');
    expect(card.fields.G12).toBe(8000000);
    expect(card.fields.G13).toBe(9000000);
    expect(card.fields.G14).toBe(2.8);
    expect(card.fields.G15).toBeCloseTo(10.5);
    expect(card.fields.G16).toBe(30000);
    expect(card.fields.G17).toBe('Own damage, theft');
    expect(card.fields.G18).toBe('2026-12-31');
    expect(card.fields.G19).toBe('Yes');
    expect(card.fields.G21).toEqual(['SRCC']);
    // Key not confirmed yet, so the insurer code is not sent.
    expect(card.fields[CURRENT_PACKAGE_INSURER_CODE]).toBeUndefined();
    expect(card.fields.A3).toBe(REQUEST_STATUS.awaitingSelection);
    expect((await offers.get('MIG-2026-0148'))[0]?.packageRef).toBe('INSA-NEW-MIG-2026-0148');
  });

  it('builds the WF-01 create body with a WH24 datetime, text covers and the partner name', () => {
    const fields = buildRequestCardFields({
      customer: { type: 'Individual', name: 'C', idNumber: '200012345678', mobile: '+94771234567', address: 'X' },
      vehicle: { category: 'Motor car', make: 'M', model: 'N', year: 2024, condition: 'Registered', chassisNo: 'CH', engineNo: 'EN', value: 1, usage: 'Private' },
      finance: { facilityType: 'Lease', referenceNo: 'R', amount: 1, tenureMonths: 12 },
      cover: { coverType: 'Comprehensive', sumInsured: 1, optionalCovers: ['SRCC', 'Flood'], policyStartDate: '2026-12-01' },
      consent: true
    }, { partner: 'Northgate Finance PLC', name: 'F', email: 'f@example.com' });

    expect(fields.A2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(formatWh24DateTime(new Date('2026-11-11T11:33:33Z'))).toBe('2026-11-11T11:33:33.000000');
    expect(formatWh24DateTime(new Date('2026-11-11T11:33:33Z'), 'isoZ')).toBe('2026-11-11T11:33:33.000Z');
    expect(fields.E3).toBe('SRCC, Flood');
    expect(fields.A4).toBe('Northgate Finance PLC');
  });

  it('writes the signed-in insurer code with a new package once its key is mapped', async () => {
    FIELD_MAP[CURRENT_PACKAGE_INSURER_CODE] = 'currentPackageInsurerCode';
    try {
      const client = new FakeWorkHub24Client();
      const app = createTestApp(client);
      const insurerToken = await loginAsInsurer(app, client);
      const submitted = await request(app)
        .post('/api/insurer/requests/MIG-2026-0148/response')
        .set('Authorization', `Bearer ${insurerToken}`)
        .send({
          newPackage: {
            name: 'Custom Comprehensive', coverType: 'Comprehensive', vehicleCategory: 'Motor car',
            sumMin: 8000000, sumMax: 9000000, premiumRate: 2.8, taxes: 24990, excess: 30000,
            standardCovers: 'Own damage, theft', optionalCovers: [], validUntil: '2026-12-31'
          }
        });

      expect(submitted.status).toBe(204);
      const card = await client.getItem('wf-01-0148');
      expect(card.fields[CURRENT_PACKAGE_INSURER_CODE]).toBe('INSA');
      expect(card.fields.G19).toBe('Yes');
    } finally {
      delete FIELD_MAP[CURRENT_PACKAGE_INSURER_CODE];
    }
  });

  it('does not write the insurer code for a stored package', async () => {
    FIELD_MAP[CURRENT_PACKAGE_INSURER_CODE] = 'currentPackageInsurerCode';
    try {
      const client = new FakeWorkHub24Client();
      const app = createTestApp(client);
      const insurerToken = await loginAsInsurer(app, client);
      const submitted = await request(app)
        .post('/api/insurer/requests/MIG-2026-0148/response')
        .set('Authorization', `Bearer ${insurerToken}`)
        .send({ packageRefs: ['A-COMP-STD'] });

      expect(submitted.status).toBe(204);
      expect((await client.getItem('wf-01-0148')).fields[CURRENT_PACKAGE_INSURER_CODE]).toBeUndefined();
    } finally {
      delete FIELD_MAP[CURRENT_PACKAGE_INSURER_CODE];
    }
  });

  it('retries the package view once for a newly submitted package reference', async () => {
    class DelayedPackageViewClient extends FakeWorkHub24Client {
      packageViewCalls = 0;

      override async queryDatastore(table: string, filter: Record<string, string | number | boolean>) {
        const rows = await super.queryDatastore(table, filter);
        if (table !== 'ds_package') return rows;
        this.packageViewCalls += 1;
        if (this.packageViewCalls === 1) return rows;
        return [
          ...rows,
          {
            iD: 99,
            packageRef: 'INSA-NEW-MIG-2026-0148',
            insurerCode: 'INSA',
            insurerName: 'Insurer A',
            name: 'Delayed Package',
            premiumRate: '2.8',
            taxRate: '10.5',
            excess: '30000',
            standardCovers: 'Own damage, theft',
            optionalCovers: 'SRCC',
            validTo: '2026-12-31',
            status: 'Active',
            sourceRequestNo: 'MIG-2026-0148'
          }
        ];
      }
    }

    const client = new DelayedPackageViewClient();
    const offers = new MemoryOffersRepository();
    const app = createTestApp(client, offers);
    const insurerToken = await loginAsInsurer(app, client);
    const submitted = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({
        newPackage: {
          name: 'Delayed Package',
          coverType: 'Comprehensive',
          vehicleCategory: 'Motor car',
          sumMin: 8000000,
          sumMax: 9000000,
          premiumRate: 2.8,
          taxes: 24990,
          excess: 30000,
          standardCovers: 'Own damage, theft',
          optionalCovers: ['SRCC'],
          validUntil: '2026-12-31'
        }
      });
    expect(submitted.status).toBe(204);

    const financeToken = await loginAsFinance(app, client);
    const compare = await request(app)
      .get('/api/finance/requests/MIG-2026-0148/offers')
      .set('Authorization', `Bearer ${financeToken}`);

    expect(compare.status).toBe(200);
    expect(client.packageViewCalls).toBe(2);
    expect(compare.body.offers.find((offer: any) => offer.packageRef === 'INSA-NEW-MIG-2026-0148')).toMatchObject({
      premium: 238000,
      taxes: 24990,
      total: 262990
    });
    expect(insurerToken).toBeTruthy();
    expect(financeToken).toBeTruthy();
  });

  it('keeps the status update but returns an error when completing the task fails, without retrying', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const financeToken = await loginAsFinance(app, client);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const puts = () => client.taskEvents.filter((event) => event.operation === 'PUT' && event.taskName === 'Awaiting Package Selection').length;
      client.failNextTaskCompletion = true;
      const selected = await request(app)
        .post('/api/finance/requests/MIG-2026-0148/select')
        .set('Authorization', `Bearer ${financeToken}`)
        .send({ insurer: 'Insurer C', packageRef: 'C-API-PRIME' });

      expect(selected.status).toBe(500);
      expect(selected.body.error.message).toMatch(/could not complete this step/i);
      expect(puts()).toBe(1);
      expect(client.completedTasks.some((task) => task.taskName === 'Awaiting Package Selection')).toBe(false);
      expect((await client.getItem('wf-01-0148')).fields.A3).toBe(REQUEST_STATUS.awaitingConsent);
      expect(errors).toHaveBeenCalledWith(
        expect.stringMatching(/updated but completing the task failed/),
        expect.objectContaining({ taskName: 'Awaiting Package Selection' })
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('resends customer OTP after three wrong entries and resets attempts', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const financeToken = await loginAsFinance(app, client);

    const selected = await request(app)
      .post('/api/finance/requests/MIG-2026-0148/select')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ insurer: 'Insurer C', packageRef: 'C-API-PRIME' });
    expect(selected.status).toBe(200);
    expect((await client.getItem('wf-01-0148')).fields.A3).toBe(REQUEST_STATUS.awaitingConsent);
    const originalOtp = String((await client.getItem('wf-01-0148')).fields.I6);

    const first = await request(app)
      .post('/api/finance/requests/MIG-2026-0148/customer-otp')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ code: '000000' });
    const second = await request(app)
      .post('/api/finance/requests/MIG-2026-0148/customer-otp')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ code: '000000' });
    const third = await request(app)
      .post('/api/finance/requests/MIG-2026-0148/customer-otp')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ code: '000000' });

    expect(first.body).toMatchObject({ result: 'incorrect', attemptsLeft: 2 });
    expect(second.body).toMatchObject({ result: 'incorrect', attemptsLeft: 1 });
    expect(third.body).toMatchObject({ result: 'new_code_sent', attemptsLeft: 3 });
    const updatedCard = await client.getItem('wf-01-0148');
    expect(updatedCard.fields.I6).not.toBe(originalOtp);
    expect(updatedCard.fields.I7).toBe('Failed');
    // Wrong codes never move status.
    expect(updatedCard.fields.A3).toBe(REQUEST_STATUS.awaitingConsent);
    expect(client.completedTasks.at(-1)?.taskName).toBe('Awaiting OTP Verification');

    const compare = await request(app)
      .get('/api/finance/requests/MIG-2026-0148/offers')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(compare.body.status).toBe('awaiting_customer_otp');
    expect(compare.body.offers.length).toBeGreaterThan(0);
    expect(financeToken).toBeTruthy();
  });

  it('accepts binding uploads and records payment completion', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const insurerToken = await loginAsInsurer(app, client);
    await client.updateFields('wf-01-0148', { A3: REQUEST_STATUS.awaitingPolicy, I2: 'Insurer A' });
    client.setOpenTask('wf-01-0148', 'Awaiting Policy Upload');

    const getBinding = await request(app).get('/api/insurer/requests/MIG-2026-0148/binding').set('Authorization', `Bearer ${insurerToken}`);
    expect(getBinding.status).toBe(200);

    const binding = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/binding')
      .set('Authorization', `Bearer ${insurerToken}`)
      .field('quotationRef', 'Q-12345')
      .field('policyNumber', 'MIG-2026-01')
      .field('policyStartDate', '2026-11-10')
      .field('policyExpiryDate', '2027-11-09')
      .field('remarks', 'Submitted')
      .attach('quotationFile', Buffer.from('%PDF-1.4\n', 'utf8'), { filename: 'quote.pdf', contentType: 'application/pdf' })
      .attach('policyFiles', Buffer.from('image', 'utf8'), { filename: 'policy.png', contentType: 'image/png' });

    expect(binding.status).toBe(204);
    const savedCard = await client.getItem('wf-01-0148');
    expect(savedCard.fields.A3).toBe(REQUEST_STATUS.completed);
    expect(savedCard.fields.J7).toContain('/uploads/');
    const quotationUrl = String(savedCard.fields.J7).match(/http:\/\/localhost:4000\/uploads\/\S+/)?.[0];
    expect(quotationUrl).toBeTruthy();
    const uploaded = await request(app).get(new URL(quotationUrl!).pathname);
    expect(uploaded.status).toBe(200);

    const payment = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/payment')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ paidDate: '2026-11-05', reference: 'BOC-TRF-55120931', amount: 287980, remarks: 'Paid' });
    expect(payment.status).toBe(410);
    expect(payment.body.error.code).toBe('REQUEST_CLOSED');
  });
});
