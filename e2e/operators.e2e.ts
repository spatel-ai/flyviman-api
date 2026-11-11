import { APIRequestContext, expect, test } from '@playwright/test';
import {
  outbox,
  PASSWORD,
  PDF_BYTES,
  registerCustomer,
  registerOperator,
  uniqueEmail,
  uploadPdf,
} from './support/data.js';
import { csrfHeaders, signIn } from './support/session.js';

const COMPANY = {
  registrationNumber: 'U62200MH2015PTC123456',
  taxNumber: '27AAACS1234A1Z5',
  businessAddress: {
    line1: 'Hangar 4, Juhu Aerodrome',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400049',
    country: 'IN',
  },
  serviceCategories: ['PRIVATE_CHARTER', 'HELICOPTER'],
  operatingRegions: ['Maharashtra', 'Goa'],
};

async function addDocument(request: APIRequestContext, type: string) {
  const headers = await csrfHeaders(request);
  const fileId = await uploadPdf(request, headers, `${type.toLowerCase()}.pdf`);
  const response = await request.post('operator/documents', {
    headers,
    data: { type, fileId, expiresAt: '2030-12-31' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data as { id: string; fileId: string };
}

/** A registered operator with a complete application, not yet submitted. */
async function completeApplication(request: APIRequestContext) {
  const operator = await registerOperator(request);
  const patch = await request.patch('operator/profile', {
    headers: await csrfHeaders(request),
    data: COMPANY,
  });
  expect(patch.status()).toBe(200);
  const aoc = await addDocument(request, 'AOC');
  const insurance = await addDocument(request, 'INSURANCE');
  return {
    ...operator,
    id: (await patch.json()).data.id as string,
    aoc,
    insurance,
  };
}

async function submit(request: APIRequestContext) {
  const response = await request.post('operator/profile/submit', {
    headers: await csrfHeaders(request),
  });
  expect(response.status()).toBe(200);
}

async function asReviewer(
  playwright: {
    request: { newContext(options: object): Promise<APIRequestContext> };
  },
  baseURL: string | undefined,
  account: 'ops' | 'superAdmin' = 'ops',
) {
  const reviewer = await playwright.request.newContext({ baseURL });
  await signIn(reviewer, account);
  return { reviewer, headers: await csrfHeaders(reviewer) };
}

test.describe('operator registration', () => {
  test('creates a draft organisation whose administrator verifies by email', async ({
    request,
  }) => {
    const { email, legalName } = await registerOperator(request);

    const me = (await (await request.get('me')).json()).data;
    expect(me).toMatchObject({
      email,
      role: 'OPERATOR_ADMIN',
      status: 'ACTIVE',
      profile: null,
    });

    const profile = (await (await request.get('operator/profile')).json()).data;
    expect(profile).toMatchObject({
      legalName,
      status: 'DRAFT',
      contactEmail: email,
    });
    expect(profile.missing).toEqual([
      'registrationNumber',
      'businessAddress',
      'serviceCategories',
      'document:AOC',
      'document:INSURANCE',
    ]);
  });

  test('answers the same for an email that is already registered', async ({
    request,
  }) => {
    const { email } = await registerCustomer(request);
    const before = (await outbox(request, email)).length;
    const response = await request.post('operator/register', {
      headers: await csrfHeaders(request),
      data: {
        legalName: 'Copycat Air',
        contactName: 'Someone',
        email,
        password: PASSWORD,
        acceptTerms: true,
      },
    });
    expect(response.status()).toBe(202);
    expect((await outbox(request, email)).length).toBe(before);
    // Still a customer.
    expect((await (await request.get('me')).json()).data.role).toBe('CUSTOMER');
  });

  test('rejects a weak password and unaccepted terms', async ({ request }) => {
    const response = await request.post('operator/register', {
      data: {
        legalName: 'Air',
        contactName: 'Me',
        email: uniqueEmail(),
        password: 'short',
        acceptTerms: false,
      },
    });
    expect(response.status()).toBe(400);
    const fields = (await response.json()).error.details.map(
      (d: { field: string }) => d.field,
    );
    expect(fields).toEqual(expect.arrayContaining(['password', 'acceptTerms']));
  });
});

test.describe('operator profile', () => {
  test('is closed to callers who are not signed in and to customers', async ({
    request,
  }) => {
    expect((await request.get('operator/profile')).status()).toBe(401);
    await registerCustomer(request);
    const response = await request.get('operator/profile');
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('FORBIDDEN');
  });

  test('cannot be submitted until it is complete', async ({ request }) => {
    await registerOperator(request);
    const response = await request.post('operator/profile/submit', {
      headers: await csrfHeaders(request),
    });
    expect(response.status()).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe('OPERATOR_PROFILE_INCOMPLETE');
    expect(body.error.details.map((d: { field: string }) => d.field)).toContain(
      'document:AOC',
    );
  });

  test('a required field cannot be set to null, and an address can be cleared', async ({
    request,
  }) => {
    await registerOperator(request);
    const headers = await csrfHeaders(request);
    const nulled = await request.patch('operator/profile', {
      headers,
      data: { legalName: null },
    });
    expect(nulled.status()).toBe(400);

    await request.patch('operator/profile', { headers, data: COMPANY });
    const cleared = await request.patch('operator/profile', {
      headers,
      data: { businessAddress: null },
    });
    expect(cleared.status()).toBe(200);
    expect((await cleared.json()).data.businessAddress).toBeNull();
    expect((await cleared.json()).data.missing).toContain('businessAddress');
  });

  test('rejects an invalid address and a category operators cannot offer', async ({
    request,
  }) => {
    await registerOperator(request);
    const response = await request.patch('operator/profile', {
      headers: await csrfHeaders(request),
      data: {
        businessAddress: {
          line1: 'x',
          city: 'Mumbai',
          state: 'MH',
          postalCode: '!',
          country: 'India',
        },
        serviceCategories: ['SCHEDULED_AIRLINE'],
      },
    });
    expect(response.status()).toBe(400);
    const fields = (await response.json()).error.details.map(
      (d: { field: string }) => d.field,
    );
    expect(fields).toEqual(
      expect.arrayContaining([
        'businessAddress.postalCode',
        'businessAddress.country',
        'serviceCategories',
      ]),
    );
  });

  test('is locked while under review', async ({ request }) => {
    await completeApplication(request);
    await submit(request);
    const headers = await csrfHeaders(request);

    const patch = await request.patch('operator/profile', {
      headers,
      data: { tradingName: 'New name' },
    });
    expect(patch.status()).toBe(409);
    expect((await patch.json()).error.code).toBe('OPERATOR_UNDER_REVIEW');

    const again = await request.post('operator/profile/submit', { headers });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('OPERATOR_INVALID_TRANSITION');
  });
});

test.describe('compliance documents', () => {
  test('an operator uploads, lists, downloads and removes a document', async ({
    request,
  }) => {
    await registerOperator(request);
    const document = await addDocument(request, 'AOC');

    const list = (await (await request.get('operator/documents')).json()).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      type: 'AOC',
      fileName: 'aoc.pdf',
      verificationStatus: 'PENDING',
      expiresAt: '2030-12-31',
    });

    const link = await request.get(`documents/${document.fileId}/download`);
    expect(link.status()).toBe(200);
    const file = await request.get((await link.json()).data.url);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('application/pdf');
    expect(file.headers()['content-disposition']).toContain('attachment');
    expect(await file.body()).toEqual(PDF_BYTES);

    const removed = await request.delete(`operator/documents/${document.id}`, {
      headers: await csrfHeaders(request),
    });
    expect(removed.status()).toBe(204);
    expect(
      (await request.get(`documents/${document.fileId}/download`)).status(),
    ).toBe(404);
  });

  test('another operator and a customer cannot download or remove it', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await registerOperator(request);
    const document = await addDocument(request, 'AOC');

    const rival = await playwright.request.newContext({ baseURL });
    await registerOperator(rival);
    expect(
      (await rival.get(`documents/${document.fileId}/download`)).status(),
    ).toBe(404);
    const remove = await rival.delete(`operator/documents/${document.id}`, {
      headers: await csrfHeaders(rival),
    });
    expect(remove.status()).toBe(404);
    expect((await (await rival.get('operator/documents')).json()).data).toEqual(
      [],
    );
    await rival.dispose();

    const customer = await playwright.request.newContext({ baseURL });
    await registerCustomer(customer);
    expect(
      (await customer.get(`documents/${document.fileId}/download`)).status(),
    ).toBe(404);
    await customer.dispose();

    const anonymous = await playwright.request.newContext({ baseURL });
    expect(
      (await anonymous.get(`documents/${document.fileId}/download`)).status(),
    ).toBe(401);
    await anonymous.dispose();
  });

  test('a file reserved by someone else cannot be attached', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await registerOperator(request);
    const fileId = await uploadPdf(request, await csrfHeaders(request));

    const rival = await playwright.request.newContext({ baseURL });
    await registerOperator(rival);
    const response = await rival.post('operator/documents', {
      headers: await csrfHeaders(rival),
      data: { type: 'AOC', fileId },
    });
    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('UPLOAD_NOT_FOUND');
    await rival.dispose();
  });

  test('a reserved file that was never uploaded cannot be attached', async ({
    request,
  }) => {
    await registerOperator(request);
    const headers = await csrfHeaders(request);
    const presign = await request.post('uploads/presign', {
      headers,
      data: {
        purpose: 'OPERATOR_DOCUMENT',
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      },
    });
    const { fileId } = (await presign.json()).data;
    const response = await request.post('operator/documents', {
      headers,
      data: { type: 'AOC', fileId },
    });
    expect(response.status()).toBe(422);
  });

  test('uploads are limited by type, size and content', async ({ request }) => {
    await registerOperator(request);
    const headers = await csrfHeaders(request);
    const base = {
      purpose: 'OPERATOR_DOCUMENT',
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
    };

    for (const data of [
      { ...base, contentType: 'text/html' },
      { ...base, sizeBytes: 11 * 1024 * 1024 },
      { ...base, fileName: '../../etc/passwd' },
    ]) {
      const response = await request.post('uploads/presign', { headers, data });
      expect(response.status(), JSON.stringify(data)).toBe(400);
    }

    // Content that is not what it claims to be is refused at upload.
    const presign = await request.post('uploads/presign', {
      headers,
      data: base,
    });
    const { upload } = (await presign.json()).data;
    const put = await request.fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      data: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    expect(put.status()).toBe(400);
    expect((await put.json()).error.code).toBe('UPLOAD_TYPE_MISMATCH');

    // A tampered upload link is refused.
    const forged = await request.fetch(`${upload.url}x`, {
      method: 'PUT',
      headers: upload.headers,
      data: PDF_BYTES,
    });
    expect(forged.status()).toBe(403);
  });

  test('presigning needs a session', async ({ request }) => {
    const response = await request.post('uploads/presign', { data: {} });
    expect(response.status()).toBe(401);
  });
});

test.describe('admin review', () => {
  test('operations verify the documents, then approve; every step is audited and notified', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const operator = await completeApplication(request);
    await submit(request);
    const { reviewer, headers } = await asReviewer(playwright, baseURL);

    // It is in the review queue.
    const queue = await reviewer.get('admin/operators', {
      params: { status: 'PENDING_REVIEW', q: operator.legalName },
    });
    expect((await queue.json()).data).toEqual([
      expect.objectContaining({ id: operator.id, status: 'PENDING_REVIEW' }),
    ]);

    // Approval is refused until the required documents are verified.
    const early = await reviewer.post(
      `admin/operators/${operator.id}/approve`,
      { headers },
    );
    expect(early.status()).toBe(422);
    expect((await early.json()).error.code).toBe(
      'OPERATOR_DOCUMENTS_UNVERIFIED',
    );

    const detail = (
      await (await reviewer.get(`admin/operators/${operator.id}`)).json()
    ).data;
    expect(detail.documents).toHaveLength(2);
    // A reviewer can open the document.
    expect(
      (
        await reviewer.get(`documents/${operator.aoc.fileId}/download`)
      ).status(),
    ).toBe(200);

    for (const document of detail.documents) {
      const verify = await reviewer.post(
        `admin/documents/${document.id}/verify`,
        {
          headers,
          data: { decision: 'VERIFIED' },
        },
      );
      expect(verify.status()).toBe(200);
      expect((await verify.json()).data.verificationStatus).toBe('VERIFIED');
    }

    const approve = await reviewer.post(
      `admin/operators/${operator.id}/approve`,
      { headers },
    );
    expect(approve.status()).toBe(200);
    expect((await approve.json()).data).toMatchObject({ status: 'APPROVED' });

    // The operator sees the new status and is told about it.
    expect(
      (await (await request.get('operator/profile')).json()).data.status,
    ).toBe('APPROVED');
    const inbox = (await (await request.get('me/notifications')).json()).data;
    expect(inbox.map((n: { templateKey: string }) => n.templateKey)).toEqual([
      'operator.approved',
      'operator.submitted',
    ]);
    const emails = (await outbox(request, operator.email)).map(
      (m) => m.subject,
    );
    expect(emails).toContain('Your Flyviman operator account is approved');

    // Each change left an audit record with before and after.
    const audit = await reviewer.get('admin/audit-logs', {
      params: { entityType: 'Operator', entityId: operator.id },
    });
    const records = (await audit.json()).data;
    expect(records.map((r: { action: string }) => r.action)).toEqual([
      'operator.approve',
      'operator.submit',
      'operator.profile_update',
      'operator.register',
    ]);
    // Profile changes record which fields changed, never their values.
    expect(records[2].after).toEqual({
      fields: [
        'businessAddress',
        'operatingRegions',
        'registrationNumber',
        'serviceCategories',
        'taxNumber',
      ],
    });
    expect(records[0]).toMatchObject({
      actorRole: 'OPS',
      before: { status: 'PENDING_REVIEW' },
      after: { status: 'APPROVED' },
    });
    await reviewer.dispose();
  });

  test('a rejection needs a reason, which the operator sees, and can be resubmitted', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const operator = await completeApplication(request);
    await submit(request);
    const { reviewer, headers } = await asReviewer(playwright, baseURL);

    const noReason = await reviewer.post(
      `admin/operators/${operator.id}/reject`,
      { headers, data: {} },
    );
    expect(noReason.status()).toBe(400);
    expect((await noReason.json()).error.code).toBe('VALIDATION_ERROR');

    const reject = await reviewer.post(
      `admin/operators/${operator.id}/reject`,
      {
        headers,
        data: { reason: 'The insurance certificate has expired.' },
      },
    );
    expect(reject.status()).toBe(200);

    const profile = (await (await request.get('operator/profile')).json()).data;
    expect(profile).toMatchObject({
      status: 'REJECTED',
      reviewNote: 'The insurance certificate has expired.',
    });

    // The operator can fix it and send it back.
    await submit(request);
    expect(
      (await (await request.get('operator/profile')).json()).data.status,
    ).toBe('PENDING_REVIEW');
    await reviewer.dispose();
  });

  test('suspend and reinstate, and identity details stay locked after approval', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const operator = await completeApplication(request);
    await submit(request);
    const { reviewer, headers } = await asReviewer(
      playwright,
      baseURL,
      'superAdmin',
    );
    for (const document of [operator.aoc, operator.insurance]) {
      await reviewer.post(`admin/documents/${document.id}/verify`, {
        headers,
        data: { decision: 'VERIFIED' },
      });
    }
    await reviewer.post(`admin/operators/${operator.id}/approve`, { headers });

    // What was reviewed cannot be changed afterwards: not the company's
    // identity, and not the services it offers.
    for (const data of [
      { legalName: 'A Different Company' },
      { tradingName: 'A Better-Known Brand' },
      { serviceCategories: ['AIR_AMBULANCE'] },
    ]) {
      const locked = await request.patch('operator/profile', {
        headers: await csrfHeaders(request),
        data,
      });
      expect(locked.status(), JSON.stringify(data)).toBe(409);
      expect((await locked.json()).error.code).toBe('OPERATOR_FIELD_LOCKED');
    }
    const allowed = await request.patch('operator/profile', {
      headers: await csrfHeaders(request),
      data: { contactName: 'New Contact' },
    });
    expect(allowed.status()).toBe(200);

    const suspend = await reviewer.post(
      `admin/operators/${operator.id}/suspend`,
      {
        headers,
        data: { reason: 'Insurance lapsed.' },
      },
    );
    expect((await suspend.json()).data.status).toBe('SUSPENDED');

    // A suspended operator cannot be approved again, only reinstated.
    const wrong = await reviewer.post(
      `admin/operators/${operator.id}/approve`,
      { headers },
    );
    expect(wrong.status()).toBe(409);
    expect((await wrong.json()).error.code).toBe('OPERATOR_INVALID_TRANSITION');

    const reinstate = await reviewer.post(
      `admin/operators/${operator.id}/reinstate`,
      { headers },
    );
    expect((await reinstate.json()).data.status).toBe('APPROVED');
    await reviewer.dispose();
  });

  test('a rejected document needs a reason and blocks approval', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const operator = await completeApplication(request);
    await submit(request);
    const { reviewer, headers } = await asReviewer(playwright, baseURL);

    const noReason = await reviewer.post(
      `admin/documents/${operator.aoc.id}/verify`,
      {
        headers,
        data: { decision: 'REJECTED' },
      },
    );
    expect(noReason.status()).toBe(400);

    const rejected = await reviewer.post(
      `admin/documents/${operator.aoc.id}/verify`,
      {
        headers,
        data: { decision: 'REJECTED', reason: 'Illegible scan.' },
      },
    );
    expect((await rejected.json()).data).toMatchObject({
      verificationStatus: 'REJECTED',
      verificationNote: 'Illegible scan.',
    });

    const approve = await reviewer.post(
      `admin/operators/${operator.id}/approve`,
      { headers },
    );
    expect(approve.status()).toBe(422);
    await reviewer.dispose();
  });

  test('is closed to everyone but the permitted roles', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const operator = await completeApplication(request);
    await submit(request);
    const path = `admin/operators/${operator.id}`;

    // The operator itself, on the admin routes.
    expect((await request.get('admin/operators')).status()).toBe(403);
    expect((await request.get(path)).status()).toBe(403);
    const self = await request.post(`${path}/approve`, {
      headers: await csrfHeaders(request),
    });
    expect(self.status()).toBe(403);

    const anonymous = await playwright.request.newContext({ baseURL });
    expect((await anonymous.get('admin/operators')).status()).toBe(401);
    expect((await anonymous.post(`${path}/approve`)).status()).toBe(401);
    await anonymous.dispose();

    const customer = await playwright.request.newContext({ baseURL });
    await registerCustomer(customer);
    expect((await customer.get(path)).status()).toBe(403);
    await customer.dispose();

    // Still waiting for review.
    expect(
      (await (await request.get('operator/profile')).json()).data.status,
    ).toBe('PENDING_REVIEW');
  });

  test('answers 404 for an operator or document that does not exist', async ({
    playwright,
    baseURL,
  }) => {
    const { reviewer, headers } = await asReviewer(playwright, baseURL);
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await reviewer.get(`admin/operators/${id}`)).status()).toBe(404);
    expect(
      (
        await reviewer.post(`admin/operators/${id}/approve`, { headers })
      ).status(),
    ).toBe(404);
    const document = await reviewer.post(`admin/documents/${id}/verify`, {
      headers,
      data: { decision: 'VERIFIED' },
    });
    expect(document.status()).toBe(404);
    expect((await reviewer.get('admin/operators/not-a-uuid')).status()).toBe(
      400,
    );
    await reviewer.dispose();
  });
});
