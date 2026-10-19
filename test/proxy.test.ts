import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { INDEX_HTML, makeDist, startWeb } from './fixtures.ts';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** api ปลอม: จำ request ล่าสุด แล้วตอบตาม path */
async function startFakeApi(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === '/api/me' && !req.headers.authorization) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'กรุณาเข้าสู่ระบบ' }));
      } else if (req.url!.startsWith('/api/nope')) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'ไม่พบข้อมูล' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Api': 'fake' }).end(JSON.stringify({ ok: true, echo: body }));
      }
    });
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

describe('proxy /api → api', () => {
  const dist = makeDist();
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  let web: Awaited<ReturnType<typeof startWeb>>;
  before(async () => {
    api = await startFakeApi();
    web = await startWeb({ distDir: dist.distDir, apiUrl: api.url });
  });
  beforeEach(() => (api.seen.length = 0));
  after(async () => {
    await web.close();
    await api.close();
    dist.cleanup();
  });

  it('GET: คง path /api + query และส่ง header ของหน้าบ้านครบ', async () => {
    const res = await fetch(web.url + '/api/products?q=%E0%B8%81&page=2', {
      headers: { Authorization: 'Bearer t1', 'X-Branch-Id': 'HQ', 'X-Terminal-Id': '2' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-api'), 'fake');
    assert.deepEqual(await res.json(), { ok: true, echo: '' });
    const [r] = api.seen;
    assert.equal(r.method, 'GET');
    assert.equal(r.url, '/api/products?q=%E0%B8%81&page=2');
    assert.equal(r.headers.authorization, 'Bearer t1');
    assert.equal(r.headers['x-branch-id'], 'HQ');
    assert.equal(r.headers['x-terminal-id'], '2');
    assert.ok(r.headers['x-forwarded-for']);
  });

  it('POST JSON: body ถึง api ครบ', async () => {
    const body = JSON.stringify({ companyCode: 'DEMO', username: 'admin', password: 'admin' });
    const res = await fetch(web.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).echo, body);
    assert.equal(api.seen[0].method, 'POST');
    assert.equal(api.seen[0].headers['content-type'], 'application/json');
  });

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    it(`${method} ผ่าน proxy`, async () => {
      const res = await fetch(web.url + '/api/products/1', { method, body: method === 'DELETE' ? undefined : '{}' });
      assert.equal(res.status, 200);
      assert.equal(api.seen[0].method, method);
    });
  }

  it('status + body ของ api (401 / 404) ส่งกลับตรง ๆ ไม่ตกไป index.html', async () => {
    const r401 = await fetch(web.url + '/api/me');
    assert.equal(r401.status, 401);
    assert.deepEqual(await r401.json(), { message: 'กรุณาเข้าสู่ระบบ' });
    const r404 = await fetch(web.url + '/api/nope');
    assert.equal(r404.status, 404);
    assert.deepEqual(await r404.json(), { message: 'ไม่พบข้อมูล' });
  });

  it('/api เปล่า ๆ ก็ไปที่ api', async () => {
    await fetch(web.url + '/api');
    assert.equal(api.seen[0]?.url, '/api');
  });

  it('/apix ไม่ใช่ /api → ไม่ proxy', async () => {
    const res = await fetch(web.url + '/apix/products');
    assert.equal(api.seen.length, 0);
    assert.equal(await res.text(), INDEX_HTML);
  });
});

describe('proxy เมื่อ api ล่ม', () => {
  const dist = makeDist();
  let web: Awaited<ReturnType<typeof startWeb>>;
  before(async () => {
    // port ที่ไม่มีใครฟัง: เปิดแล้วปิดทันที
    const s = createServer().listen(0);
    await new Promise((r) => s.once('listening', r));
    const { port } = s.address() as AddressInfo;
    await new Promise((r) => s.close(r));
    web = await startWeb({ distDir: dist.distDir, apiUrl: `http://127.0.0.1:${port}` });
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

  it('หน้าเว็บยังโหลดได้', async () => {
    const res = await fetch(web.url + '/users');
    assert.equal(res.status, 200);
  });
});
