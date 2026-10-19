import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { INDEX_HTML, SECRET, makeDist, startWeb } from './fixtures.ts';

/** ส่ง path ดิบ (fetch / URL จะ normalize `..` ทิ้งก่อนส่ง) */
function rawGet(base: string, rawPath: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    request({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    })
      .on('error', reject)
      .end();
  });
}

describe('static + SPA fallback', () => {
  const dist = makeDist();
  let web: Awaited<ReturnType<typeof startWeb>>;
  before(async () => (web = await startWeb({ distDir: dist.distDir })));
  after(async () => {
    await web.close();
    dist.cleanup();
  });

  for (const route of ['/', '/users/new', '/inventory/stock-card/123?all=1', '/auth/login']) {
    it(`route ${route} → index.html, no-cache`, async () => {
      const res = await fetch(web.url + route);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type')!, /text\/html/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal(await res.text(), INDEX_HTML);
    });
  }

  it('HEAD route → 200 ไม่มี body', async () => {
    const res = await fetch(web.url + '/users', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  it('/index.html ตรง ๆ → no-cache', async () => {
    const res = await fetch(web.url + '/index.html');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  for (const [file, type] of [
    ['/main-EXTO3ZN5.js', /javascript/],
    ['/chunk-0vy21Nd2.js', /javascript/],
    ['/styles-KW4BQYMB.css', /text\/css/],
  ] as const) {
    it(`ไฟล์มี hash ${file} → immutable 1 ปี`, async () => {
      const res = await fetch(web.url + file);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type')!, type);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    });
  }

  it('favicon.ico (ไม่มี hash) → no-cache', async () => {
    const res = await fetch(web.url + '/favicon.ico');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  it('ไฟล์ที่ไม่มีจริง (chunk ของ build เก่า) → 404 ไม่ใช่ HTML', async () => {
    const res = await fetch(web.url + '/chunk-OLD12345.js');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /html/);
  });

  it('method อื่นที่ไม่ใช่ /api → 404', async () => {
    const res = await fetch(web.url + '/users', { method: 'POST', body: '{}' });
    assert.equal(res.status, 404);
  });

  for (const raw of [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/%2e%2e%5csecret.txt',
    '/foo/../../secret.txt',
    '/.env',
    '/%2eenv',
    '/main-EXTO3ZN5.js%00.html',
    '/%E0%A4%A',
  ]) {
    it(`ไม่หลุดออกนอก dist: ${raw}`, async () => {
      const res = await rawGet(web.url, raw);
      assert.notEqual(res.status, 200, `status ${res.status}`);
      assert.ok(!res.body.includes(SECRET));
    });
  }

  it('/healthz → 200 JSON', async () => {
    const res = await fetch(web.url + '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('ส่ง X-Request-Id กลับ (ใช้ของ client ถ้ารูปแบบถูก)', async () => {
    const mine = await fetch(web.url + '/healthz', { headers: { 'X-Request-Id': 'abc-123' } });
    assert.equal(mine.headers.get('x-request-id'), 'abc-123');
    const bad = await fetch(web.url + '/healthz', { headers: { 'X-Request-Id': 'x'.repeat(100) } });
    assert.match(bad.headers.get('x-request-id')!, /^[0-9a-f-]{36}$/);
  });

  it('gzip ไฟล์ static เมื่อ browser รับได้', async () => {
    const res = await rawHeaders(web.url, '/main-EXTO3ZN5.js', { 'Accept-Encoding': 'gzip' });
    // ไฟล์เล็กกว่า threshold ของ compression (1kb) จึงไม่ถูกบีบ — ตรวจแค่ว่าไม่พังและมี Vary
    assert.equal(res.status, 200);
    assert.match(res.headers.vary ?? '', /Accept-Encoding/i);
  });
});

function rawHeaders(base: string, p: string, headers: Record<string, string>) {
  const { hostname, port } = new URL(base);
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    request({ hostname, port, path: p, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers }));
    })
      .on('error', reject)
      .end();
  });
}
