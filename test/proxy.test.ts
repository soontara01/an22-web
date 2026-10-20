import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Browser, type FakeApi, INDEX_HTML, type Web, deadPort, makeDist, startFakeApi, startWeb } from './fixtures.ts';

describe('proxy /api → api', () => {
  const dist = makeDist();
  let api: FakeApi;
  let web: Web;
  let browser: Browser;
  before(async () => {
    api = await startFakeApi();
    web = await startWeb({ distDir: dist.distDir, apiUrl: api.url });
  });
  beforeEach(async () => {
    api.seen.length = 0;
    browser = await new Browser(web.url).open();
  });
  after(async () => {
    await web.close();
    await api.close();
    dist.cleanup();
  });

  it('GET: คง path /api + query และส่ง header ของหน้าบ้านครบ', async () => {
    const res = await browser.get('/api/products?q=%E0%B8%81&page=2', { 'X-Branch-Id': 'HQ', 'X-Terminal-Id': '2' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-api'), 'fake');
    assert.deepEqual(await res.json(), { ok: true, echo: '' });
    const [r] = api.seen;
    assert.equal(r.method, 'GET');
    assert.equal(r.url, '/api/products?q=%E0%B8%81&page=2');
    assert.equal(r.headers['x-branch-id'], 'HQ');
    assert.equal(r.headers['x-terminal-id'], '2');
    assert.ok(r.headers['x-forwarded-for']);
  });

  it('POST JSON: body ถึง api ครบ', async () => {
    const body = { name: 'เมาส์', price: 531 };
    const res = await browser.post('/api/products', body);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).echo, JSON.stringify(body));
    assert.equal(api.seen[0].method, 'POST');
    assert.equal(api.seen[0].headers['content-type'], 'application/json');
  });

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    it(`${method} ผ่าน proxy`, async () => {
      const res = await browser.request(method, '/api/products/1', { body: method === 'DELETE' ? undefined : {} });
      assert.equal(res.status, 200);
      assert.equal(api.seen[0].method, method);
    });
  }

  it('status + body ของ api (401 / 404) ส่งกลับตรง ๆ ไม่ตกไป index.html', async () => {
    const r401 = await browser.get('/api/me');
    assert.equal(r401.status, 401);
    assert.deepEqual(await r401.json(), { message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    const r404 = await browser.get('/api/nope');
    assert.equal(r404.status, 404);
    assert.deepEqual(await r404.json(), { message: 'ไม่พบข้อมูล' });
  });

  it('cookie ของ api ไม่ถึง browser', async () => {
    const res = await browser.get('/api/products');
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('api=')));
  });

  it('/api เปล่า ๆ ก็ไปที่ api', async () => {
    await browser.get('/api');
    assert.equal(api.seen[0]?.url, '/api');
  });

  it('/apix ไม่ใช่ /api → ไม่ proxy', async () => {
    const res = await browser.get('/apix/products');
    assert.equal(api.seen.length, 0);
    assert.equal(await res.text(), INDEX_HTML);
  });
});

describe('proxy เมื่อ api ล่ม', () => {
  const dist = makeDist();
  let web: Web;
  before(async () => {
    web = await startWeb({ distDir: dist.distDir, apiUrl: `http://127.0.0.1:${await deadPort()}` });
  });
  after(async () => {
    await web.close();
    dist.cleanup();
  });

  it('→ 502 JSON ข้อความไทย (ไม่ใช่ index.html)', async () => {
    const res = await fetch(web.url + '/api/me');
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type')!, /application\/json/);
    assert.deepEqual(await res.json(), { message: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่' });
  });

  it('login ตอน api ล่ม → 502 JSON', async () => {
    const browser = await new Browser(web.url).open();
    const res = await browser.post('/api/auth/login', { companyCode: 'DEMO', username: 'admin', password: 'admin' });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { message: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่' });
    assert.ok(!browser.cookies.has('an22.sid'));
  });

  it('หน้าเว็บยังโหลดได้', async () => {
    const res = await fetch(web.url + '/users');
    assert.equal(res.status, 200);
  });
});
