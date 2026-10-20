import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { redactUrl } from '../src/security.ts';
import { Browser, type FakeApi, INLINE_SCRIPT, type Web, makeDist, startFakeApi, startWeb } from './fixtures.ts';

const LOGIN = { companyCode: 'DEMO', username: 'admin', password: 'bad' };

describe('security headers', () => {
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

  for (const url of ['/', '/users/new', '/main-EXTO3ZN5.js', '/api/products', '/healthz', '/nope.js']) {
    it(`มีครบบน ${url}`, async () => {
      const res = await fetch(web.url + url);
      const h = (n: string) => res.headers.get(n);
      assert.match(h('content-security-policy')!, /default-src 'self'/);
      assert.equal(h('x-frame-options'), 'DENY');
      assert.equal(h('x-content-type-options'), 'nosniff');
      assert.equal(h('referrer-policy'), 'same-origin');
      assert.equal(h('cross-origin-opener-policy'), 'same-origin');
      assert.match(h('permissions-policy')!, /camera=\(\)/);
      assert.equal(h('strict-transport-security'), null, 'HSTS เฉพาะ https');
    });
  }

  it('CSP อนุญาตเฉพาะสคริปต์ของเว็บเรา + inline ที่ hash ตรงกับ index.html, ห้ามฝัง frame', async () => {
    const csp = (await fetch(web.url + '/')).headers.get('content-security-policy')!;
    const hash = createHash('sha256').update(INLINE_SCRIPT).digest('base64');
    assert.match(csp, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, '\\$&')}'`));
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(csp, /'unsafe-eval'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
  });

  it('HSTS เมื่อมาทาง https ผ่าน proxy ที่เชื่อ', async () => {
    const res = await fetch(web.url + '/', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  });

  it('คำตอบ /api ไม่ลง cache ถ้า api ไม่ได้กำหนด; ถ้ากำหนดมาใช้ของ api', async () => {
    assert.equal((await fetch(web.url + '/api/products')).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(web.url + '/api/cached')).headers.get('cache-control'), 'private, max-age=60');
  });
});

describe('log ไม่มีความลับใน URL', () => {
  it('redactUrl ซ่อนค่า token / code / password ใน query', () => {
    assert.equal(redactUrl('/auth/reset-password?token=abc-123'), '/auth/reset-password?token=***');
    assert.equal(redactUrl('/x?a=1&TOKEN=s&code=9'), '/x?a=1&TOKEN=***&code=***');
    assert.equal(redactUrl('/sales?from=2026-10-01'), '/sales?from=2026-10-01');
    assert.equal(redactUrl('/users'), '/users');
  });

  it('access log ของลิงก์ตั้งรหัสผ่านไม่มี token', async () => {
    const dist = makeDist();
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const web = await startWeb({ distDir: dist.distDir }, undefined, pino({ level: 'info' }, sink));
    try {
      await fetch(web.url + '/auth/reset-password?token=SECRET-RESET-TOKEN');
      await new Promise((r) => setTimeout(r, 50));
      const log = lines.join('');
      assert.match(log, /reset-password\?token=\*\*\*/);
      assert.doesNotMatch(log, /SECRET-RESET-TOKEN/);
    } finally {
      await web.close();
      dist.cleanup();
    }
  });
});

describe('จำกัดจำนวนครั้งเดารหัส (AUTH_RATE_LIMIT)', () => {
  const dist = makeDist();
  let api: FakeApi;
  let web: Web;
  before(async () => {
    api = await startFakeApi();
    web = await startWeb({ distDir: dist.distDir, apiUrl: api.url, authRateLimit: 3 });
  });
  after(async () => {
    await web.close();
    await api.close();
    dist.cleanup();
  });

  it('เกินเพดานต่อ IP → 429 ข้อความไทย ไม่ถึง api; path / method อื่นไม่ถูกนับ', async () => {
    const browser = await new Browser(web.url).open();
    for (let i = 0; i < 3; i++) assert.equal((await browser.post('/api/auth/login', LOGIN)).status, 401);
    api.seen.length = 0;
    const blocked = await browser.post('/api/auth/login', LOGIN);
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { message: 'พยายามบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' });
    assert.ok(blocked.headers.get('ratelimit'), 'บอกเวลาที่ลองใหม่ได้');
    assert.equal(api.seen.length, 0);

    assert.equal((await browser.post('/api/products', {})).status, 200); // ไม่ใช่ path ตรวจรหัส
    assert.equal((await browser.get('/api/me')).status, 401); // GET ไม่ถูกนับ
    assert.equal((await browser.post('/api/auth/verify', {})).status, 200); // นับแยกต่อ path
  });

  it('ปลดล็อก POS (/api/shifts/:id/unlock) ก็ถูกจำกัด', async () => {
    const browser = await new Browser(web.url).open();
    for (let i = 0; i < 3; i++) await browser.post('/api/shifts/7/unlock', {});
    assert.equal((await browser.post('/api/shifts/8/unlock', {})).status, 429);
  });
});

describe('IP ของผู้ใช้ที่ส่งให้ api (X-Real-IP)', () => {
  const dist = makeDist();
  let api: FakeApi;
  before(async () => (api = await startFakeApi()));
  beforeEach(() => (api.seen.length = 0));
  after(async () => {
    await api.close();
    dist.cleanup();
  });

  it('ไม่เชื่อ proxy (TRUST_PROXY=false): X-Forwarded-For ที่ browser ปลอมมาถูกแทนด้วย IP จริง', async () => {
    const web = await startWeb({ distDir: dist.distDir, apiUrl: api.url, trustProxy: false });
    try {
      const browser = await new Browser(web.url).open();
      await browser.get('/api/products', { 'X-Forwarded-For': '6.6.6.6' });
      await browser.post('/api/auth/login', { ...LOGIN, password: 'admin' }, { 'X-Forwarded-For': '6.6.6.6' });
      for (const s of api.seen) {
        assert.match(String(s.headers['x-real-ip']), /127\.0\.0\.1/, s.url);
        assert.doesNotMatch(String(s.headers['x-forwarded-for']), /6\.6\.6\.6/, s.url);
      }
      assert.equal(api.seen.length, 2);
    } finally {
      await web.close();
    }
  });

  it('เชื่อ proxy หน้า web (loopback): ใช้ IP ที่ proxy บอก', async () => {
    const web = await startWeb({ distDir: dist.distDir, apiUrl: api.url, trustProxy: 'loopback' });
    try {
      await new Browser(web.url).get('/api/products', { 'X-Forwarded-For': '203.0.113.9' });
      assert.equal(api.seen[0]?.headers['x-real-ip'], '203.0.113.9');
      assert.equal(api.seen[0]?.headers['x-forwarded-for'], '203.0.113.9');
    } finally {
      await web.close();
    }
  });
});

describe('cookie session บน https (COOKIE_SECURE=true)', () => {
  it('ชื่อ __Host-an22.sid: Secure, Path=/, ไม่มี Domain — และใช้งานได้ตามปกติ', async () => {
    const dist = makeDist();
    const api = await startFakeApi();
    const web = await startWeb({ distDir: dist.distDir, apiUrl: api.url, cookieSecure: true });
    try {
      // express-session ตั้ง cookie Secure เฉพาะ request ที่เป็น https — มาทาง proxy ที่เชื่อ (loopback)
      const https = { 'X-Forwarded-Proto': 'https' };
      const browser = new Browser(web.url);
      await browser.get('/', https);
      await browser.post('/api/auth/login', { ...LOGIN, password: 'admin' }, https);
      const cookie = browser.setCookies.get('__Host-an22.sid')!;
      assert.ok(cookie, 'ได้ cookie ชื่อ __Host-');
      assert.match(cookie, /Secure/);
      assert.match(cookie, /Path=\//);
      assert.doesNotMatch(cookie, /Domain=/i);
      assert.ok(!browser.cookies.has('an22.sid'));
      await browser.get('/api/me', https);
      assert.equal(api.seen.at(-1)?.headers.authorization, 'Bearer shop-admin');
      await browser.post('/api/auth/logout', undefined, https);
      assert.ok(!browser.cookies.has('__Host-an22.sid'), 'logout ลบ cookie ได้');
    } finally {
      await web.close();
      await api.close();
      dist.cleanup();
    }
  });
});
