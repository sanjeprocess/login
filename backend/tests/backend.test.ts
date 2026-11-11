import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { FakeWorkHub24Client } from '../src/wh24/fakeClient.js';
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
  return String(last?.fields?.O5 ?? '');
}

describe('Motor Insurance Gateway backend', () => {
  it('persists only response references in the offers store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'insurance-offers-'));
    uploadDirectories.push(directory);
    const repository = new JsonOffersRepository(join(directory, 'offers.json'));
    const offer = {
      requestNo: 'MIG-2026-0148',
      insurer: 'Insurer A',
      packageRef: 'A-COMP-STD',
      respondedBy: 'dilani.w@insurer-a.lk',
      respondedAt: '2026-11-11T00:00:00.000Z'
    };

    await repository.add(offer);
    const secondInsurer = await repository.add({ ...offer, insurer: 'Insurer B', packageRef: 'B-COMP-01' });

    expect(JSON.parse(readFileSync(join(directory, 'offers.json'), 'utf8'))).toEqual([offer]);
    expect(await repository.get(offer.requestNo)).toEqual([offer]);
    expect(secondInsurer.added).toBe(false);
  });

  it('allows Screen 1 when WorkHub24 chassis lookup fails', async () => {
    class FailingChassisLookupClient extends FakeWorkHub24Client {
      override async findItemByField(workflow: 'WF-01', fieldId: string, value: string) {
        if (fieldId === 'C7') throw new Error('cards/list returned HTML');
        return super.findItemByField(workflow, fieldId, value);
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
  });

  it('uses the finance user branch name in the session', async () => {
    const client = new FakeWorkHub24Client();
    const app = createTestApp(client);
    const email = 'nadeesha.fernando@northgate.lk';

    await request(app).post('/api/auth/otp/request').send({ email, purpose: 'finance_signin' });
    const otp = getLastOtp(client);
    const otpCard = Array.from((client as any).items.values()).find((item: any) => item.workflow === 'WF-02') as any;
    expect(otpCard.fields.title).toBe('OTP · finance_signin · ●●● ●●● 0001');
    expect(otpCard.fields.title).not.toContain(otp);
    const verified = await request(app)
      .post('/api/auth/otp/verify')
      .send({ email, code: otp, purpose: 'finance_signin' });

    expect(verified.status).toBe(200);
    expect(verified.body.user.branch).toBe('Kandy City');
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

    const valid = await request(app).post('/api/auth/otp/verify').send({ email: 'nadeesha.fernando@northgate.lk', code: otp, purpose: 'finance_signin', requestNo: 'MIG-2026-0148' });
    expect(valid.status).toBe(429);
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
    expect(response.body.error.code).toBe('ALREADY_SUBMITTED');
    expect(Array.from((client as any).items.values()).filter((item: any) => item.workflow === 'WF-02')).toHaveLength(0);
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
    const createdItem = await client.findItemByField('WF-01', 'A1', create.body.requestNo);
    expect(createdItem).not.toBeNull();
    const createdRecord = await client.getItem(createdItem!.itemId);
    expect(createdRecord.fields.A5).toBe('Kandy City');
    expect(createdRecord.fields.title).toBe('Saman Silva · CH-NEW-001');

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
      .send({ mode: 'stored', packageRef: 'A-COMP-STD', remarks: 'Looks good' });
    expect(insurerResponse.status).toBe(204);
    expect(client.completedTasks.at(-1)?.taskName).toBe('Awaiting Insurer Responses');
    expect((await client.getItem('wf-01-0148')).fields.A3).toBe('Awaiting Quotes');
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
    const otp = String((client as any).items.values().next().value?.fields?.I6 ?? '');

    const verifyOtp = await request(app).post('/api/finance/requests/MIG-2026-0148/customer-otp').set('Authorization', `Bearer ${financeToken}`).send({ code: otp || '654321' });
    expect(verifyOtp.status).toBe(200);
    expect(verifyOtp.body.result).toBe('verified');
    expect(client.completedTasks.at(-1)?.taskName).toBe('Awaiting OTP Verification');
    const closedCompare = await request(app)
      .get('/api/finance/requests/MIG-2026-0148/offers')
      .set('Authorization', `Bearer ${financeToken}`);
    expect(closedCompare.status).toBe(409);
    expect(closedCompare.body.error.code).toBe('ALREADY_SUBMITTED');
  });

  it('stores one offer per insurer without changing flow-owned status', async () => {
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
      .send({ mode: 'stored', packageRef: 'A-COMP-STD' });
    expect(submitted.status).toBe(204);
    expect((await client.getItem('wf-01-0148')).fields.A3).toBe('Awaiting Quotes');
    expect(client.completedTasks.at(-1)?.taskName).toBe('Awaiting Insurer Responses');

    const responseView = await request(app)
      .get('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`);
    expect(responseView.status).toBe(409);
    expect(responseView.body.error.code).toBe('ALREADY_SUBMITTED');

    const duplicate = await request(app)
      .post('/api/insurer/requests/MIG-2026-0148/response')
      .set('Authorization', `Bearer ${insurerToken}`)
      .send({ mode: 'stored', packageRef: 'A-COMP-PLUS' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ALREADY_SUBMITTED');
    const [storedOffer] = await offers.get('MIG-2026-0148');
    expect(storedOffer).toMatchObject({
      requestNo: 'MIG-2026-0148',
      insurer: 'Insurer A',
      packageRef: 'A-COMP-STD',
      respondedBy: 'dilani.w@insurer-a.lk'
    });
    expect(Object.keys(storedOffer).sort()).toEqual(['insurer', 'packageRef', 'requestNo', 'respondedAt', 'respondedBy']);
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
        mode: 'new',
        package: {
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
    expect(card.fields.G8).toBe('INSURERA-NEW-MIG-2026-0148');
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
    expect(card.fields.A3).toBe('Awaiting Quotes');
    expect((await offers.get('MIG-2026-0148'))[0]?.packageRef).toBe('INSURERA-NEW-MIG-2026-0148');
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
            package_ref: 'INSURERA-NEW-MIG-2026-0148',
            insurer: 'Insurer A',
            name: 'Delayed Package',
            premium_rate: 2.8,
            tax_rate: 10.5,
            excess: 30000,
            standard_covers: 'Own damage, theft',
            optional_covers: 'SRCC',
            valid_to: '2026-12-31'
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
        mode: 'new',
        package: {
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
    expect(compare.body.offers.find((offer: any) => offer.packageRef === 'INSURERA-NEW-MIG-2026-0148')).toMatchObject({
      premium: 238000,
      taxes: 24990,
      total: 262990
    });
    expect(insurerToken).toBeTruthy();
    expect(financeToken).toBeTruthy();
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
    await client.updateFields('wf-01-0148', { A3: 'Awaiting Quotes', I2: 'Insurer A' });
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
