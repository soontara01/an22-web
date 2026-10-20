import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Browser, type FakeApi, type Web, makeDist, startFakeApi, startWeb } from './fixtures.ts';

const LOGIN = { companyCode: 'DEMO', username: 'admin', password: 'admin' };

describe('session ของ login (BFF, E48)', () => {
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
  const authSeen = (url: string) => api.seen.filter((s) => s.url === url).at(-1)?.headers.authorization;

  it('login: ส่งต่อ api, เก็บ token ใน session, ตอบโดยไม่มี token + cookie httpOnly', async () => {
    const res = await browser.post('/api/auth/login', LOGIN);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { user: { username: 'admin' } });
    assert.deepEqual(JSON.parse(api.seen.at(-1)!.body), LOGIN);
    const cookie = browser.setCookies.get('an22.sid')!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, /Secure/i); // http ธรรมดา (COOKIE_SECURE=auto)
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('api=')));

    const me = await browser.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(authSeen('/api/me'), 'Bearer shop-admin');
    assert.equal(api.seen.at(-1)!.headers.cookie, undefined); // cookie ของเราไม่ไปถึง api
  });

  it('Authorization ที่ browser ส่งมาเองถูกทิ้ง', async () => {
    await browser.get('/api/me', { Authorization: 'Bearer forged' });
    assert.equal(authSeen('/api/me'), undefined);
    await browser.post('/api/auth/login', LOGIN);
    await browser.get('/api/me', { Authorization: 'Bearer forged' });
    assert.equal(authSeen('/api/me'), 'Bearer shop-admin');
  });

  it('ร้าน / platform แยกช่อง; logout ลบเฉพาะช่องตัวเอง แล้วทำลาย session เมื่อไม่เหลือ', async () => {
    await browser.post('/api/auth/login', LOGIN);
    const platform = await browser.post('/api/platform/auth/login', { username: 'platform', password: 'platform' });
    assert.deepEqual(await platform.json(), { admin: { id: 1 } });
    await browser.get('/api/platform/me');
    assert.equal(authSeen('/api/platform/me'), 'Bearer platform-1');
    await browser.get('/api/me');
    assert.equal(authSeen('/api/me'), 'Bearer shop-admin');

    const out = await browser.post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.equal(await out.json(), null);
    assert.ok(!api.seen.some((s) => s.url.endsWith('/logout'))); // web ตอบเอง
    assert.equal((await browser.get('/api/me')).status, 401);
    assert.equal((await browser.get('/api/platform/me')).status, 200);

    await browser.post('/api/platform/auth/logout');
    assert.ok(!browser.cookies.has('an22.sid'), 'cookie ถูกลบ');
    assert.equal((await browser.get('/api/platform/me')).status, 401);
  });

  it('เปลี่ยน session id ทุกครั้งที่ login (กัน session fixation)', async () => {
    await browser.post('/api/platform/auth/login', { username: 'platform', password: 'platform' });
    const before = browser.cookies.get('an22.sid');
    await browser.post('/api/auth/login', LOGIN);
    assert.notEqual(browser.cookies.get('an22.sid'), before);
    await browser.get('/api/platform/me');
    assert.equal(authSeen('/api/platform/me'), 'Bearer platform-1'); // ช่อง platform ยังอยู่
  });

  it('api ตอบ 401 → ลืม token ช่องนั้น', async () => {
    await browser.post('/api/auth/login', { ...LOGIN, username: 'expired' });
    assert.equal((await browser.get('/api/me')).status, 401);
    assert.equal(authSeen('/api/me'), 'Bearer shop-expired');
    await browser.get('/api/products');
    assert.equal(authSeen('/api/products'), undefined);
  });

  it('login ไม่ผ่าน → คำตอบของ api ตามเดิม ไม่แตะ session เดิม', async () => {
    await browser.post('/api/auth/login', LOGIN);
    const sid = browser.cookies.get('an22.sid');
    const res = await browser.post('/api/auth/login', { ...LOGIN, password: 'bad' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { message: 'รหัสบริษัท ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง' });
    assert.equal(browser.cookies.get('an22.sid'), sid);
    await browser.get('/api/me');
    assert.equal(authSeen('/api/me'), 'Bearer shop-admin');
  });

  it('api ตอบ login สำเร็จแต่ไม่มี token → 502 ไม่มี session', async () => {
    const res = await browser.post('/api/auth/login', { ...LOGIN, username: 'notoken' });
    assert.equal(res.status, 502);
    assert.ok(!browser.cookies.has('an22.sid'));
  });

  it('signup ก็ login ผ่าน session เหมือนกัน', async () => {
    const res = await browser.post('/api/auth/signup', { companyCode: 'ACME', username: 'boss', password: 'x' });
    assert.deepEqual(await res.json(), { user: { username: 'boss' } });
    await browser.get('/api/me');
    assert.equal(authSeen('/api/me'), 'Bearer shop-boss');
  });

  it('request ที่ไม่ได้ login ไม่สร้าง session / cookie', async () => {
    await browser.get('/api/products');
    assert.ok(!browser.cookies.has('an22.sid'));
  });

  it('Secure cookie เมื่อมาทาง https ผ่าน proxy ที่เชื่อ (X-Forwarded-Proto)', async () => {
    await browser.post('/api/auth/login', LOGIN, { 'X-Forwarded-Proto': 'https' });
    assert.match(browser.setCookies.get('an22.sid')!, /Secure/);
  });
});

describe('อายุ session', () => {
  const dist = makeDist();
  let api: FakeApi;
  before(async () => (api = await startFakeApi()));
  after(async () => {
    await api.close();
    dist.cleanup();
  });

  it('ไม่ใช้งานเกิน SESSION_IDLE_HOURS → หลุด; ใช้งานอยู่ = ต่ออายุ', async () => {
    const web = await startWeb({ distDir: dist.distDir, apiUrl: api.url, sessionIdleHours: 1.5 / 3600 });
    try {
      const browser = await new Browser(web.url).open();
      await browser.post('/api/auth/login', LOGIN);
      for (let i = 0; i < 3; i++) {
        await sleep(700);
        assert.equal((await browser.get('/api/me')).status, 200, `ยังใช้งานอยู่ รอบ ${i}`);
      }
      await sleep(1700);
      assert.equal((await browser.get('/api/me')).status, 401);
    } finally {
      await web.close();
    }
  });

  it('เกิน SESSION_MAX_DAYS นับจาก login → หลุด แม้ใช้งานอยู่', async () => {
    const web = await startWeb({
      distDir: dist.distDir,
      apiUrl: api.url,
      sessionIdleHours: 1 / 3600,
      sessionMaxDays: 2 / 86400,
    });
    try {
      const browser = await new Browser(web.url).open();
      await browser.post('/api/auth/login', LOGIN);
      await sleep(800);
      assert.equal((await browser.get('/api/me')).status, 200);
      await sleep(800);
      assert.equal((await browser.get('/api/me')).status, 200);
      await sleep(700);
      assert.equal((await browser.get('/api/me')).status, 401);
    } finally {
      await web.close();
    }
  });
});

describe('CSRF (XSRF-TOKEN / X-XSRF-TOKEN)', () => {
  const dist = makeDist();
  let api: FakeApi;
  let web: Web;
  before(async () => {
    api = await startFakeApi();
    web = await startWeb({ distDir: dist.distDir, apiUrl: api.url });
  });
  after(async () => {
    await web.close();
    await api.close();
    dist.cleanup();
  });
  const CSRF = { message: 'คำขอไม่ถูกต้อง กรุณาโหลดหน้าใหม่' };

  it('หน้าแรกและ /api ตั้ง cookie XSRF-TOKEN ที่ JS อ่านได้', async () => {
    const browser = await new Browser(web.url).open();
    const cookie = browser.setCookies.get('XSRF-TOKEN')!;
    assert.ok(cookie);
    assert.doesNotMatch(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const again = await browser.get('/api/products');
    assert.ok(!again.headers.getSetCookie().some((c) => c.startsWith('XSRF-TOKEN')), 'ไม่ออกใหม่ถ้ามีแล้ว');
  });

  it('POST ไม่มี header → 403 (รวม login / logout) และไม่ถึง api', async () => {
    const browser = await new Browser(web.url).open();
    browser.xsrf = false;
    api.seen.length = 0;
    for (const url of ['/api/products', '/api/auth/login', '/api/auth/logout']) {
      const res = await browser.post(url, LOGIN);
      assert.equal(res.status, 403, url);
      assert.deepEqual(await res.json(), CSRF);
    }
    assert.equal(api.seen.length, 0);
  });

  it('header ไม่ตรง cookie / cookie ปลอม (ไม่มี HMAC ของเรา) → 403', async () => {
    const browser = await new Browser(web.url).open();
    const wrong = await browser.post('/api/products', {}, { 'x-xsrf-token': 'other' });
    assert.equal(wrong.status, 403);

    const forged = new Browser(web.url);
    forged.cookies.set('XSRF-TOKEN', 'abc.def');
    const res = await forged.post('/api/products', {});
    assert.equal(res.status, 403);
  });

  it('GET ไม่ต้องมี header; POST ที่ถูกต้องผ่าน', async () => {
    const browser = await new Browser(web.url).open();
    assert.equal((await fetch(web.url + '/api/products')).status, 200);
    assert.equal((await browser.post('/api/products', {})).status, 200);
  });
});
