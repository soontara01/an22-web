import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSetCookie } from 'cookie';
import type session from 'express-session';
import { type Logger, pino } from 'pino';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { createSessionStore } from '../src/session.ts';

/** มี `<script>` inline 1 ตัวเหมือน build จริง (Angular ใส่ตอน inline critical CSS) — CSP ต้องอนุญาตด้วย hash */
export const INLINE_SCRIPT = "document.title='an22'";
export const INDEX_HTML = `<!doctype html><html><head><script>${INLINE_SCRIPT}</script></head><body><app-root></app-root></body></html>`;
export const SECRET = 'SECRET-OUTSIDE-DIST';
export const SESSION_SECRET = 'test-secret-test-secret-test-secret-0123';

/** dist ปลอมหน้าตาแบบ build ของ Angular + ไฟล์ลับข้าง ๆ (ต้องเข้าไม่ถึง) */
export function makeDist(): { root: string; distDir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'an22-web-'));
  const distDir = path.join(root, 'browser');
  mkdirSync(distDir);
  writeFileSync(path.join(distDir, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(distDir, 'main-EXTO3ZN5.js'), 'console.log("main");');
  writeFileSync(path.join(distDir, 'chunk-0vy21Nd2.js'), 'export const a = 1;');
  writeFileSync(path.join(distDir, 'styles-KW4BQYMB.css'), 'body{margin:0}');
  writeFileSync(path.join(distDir, 'favicon.ico'), 'ico');
  writeFileSync(path.join(distDir, '.env'), SECRET);
  writeFileSync(path.join(root, 'secret.txt'), SECRET);
  return { root, distDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface Web {
  url: string;
  config: Config;
  store: session.Store;
  /** ปิด server (และ store ถ้า startWeb สร้างเอง) */
  close: () => Promise<void>;
}

/**
 * เปิด web จริงบน port สุ่ม (ทดสอบผ่าน fetch / http เหมือน browser); ส่ง `store` มาเพื่อจำลอง restart ด้วย store เดิม
 */
export async function startWeb(
  config: Partial<Config> & { distDir: string },
  store?: session.Store,
  logger: Logger = pino({ level: 'silent' }),
): Promise<Web> {
  const full: Config = {
    port: 0,
    apiUrl: 'http://127.0.0.1:9',
    logLevel: 'silent',
    sessionStore: 'memory',
    mongodbUri: null,
    sessionSecret: SESSION_SECRET,
    sessionIdleHours: 12,
    sessionMaxDays: 7,
    cookieSecure: 'auto',
    trustProxy: 'loopback',
    authRateLimit: 0,
    ...config,
  };
  const own = store ? null : createSessionStore(full);
  const sessions = store ?? own!.store;
  const server: Server = createApp(full, logger, sessions).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    config: full,
    store: sessions,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await own?.close();
    },
  };
}

/**
 * browser จำลอง: จำ cookie (รวม httpOnly), ส่ง `X-XSRF-TOKEN` จาก cookie `XSRF-TOKEN` ให้ทุก request ที่เปลี่ยนข้อมูล
 * เหมือน Angular `HttpClient`
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  /** Set-Cookie ล่าสุดตามชื่อ (ตรวจ HttpOnly / SameSite / Secure) */
  readonly setCookies = new Map<string, string>();
  /** false = ไม่ส่ง header XSRF (จำลองเว็บอื่น / client ที่ลืม) */
  xsrf = true;

  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async request(method: string, url: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (this.cookies.size) headers['cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const xsrf = this.cookies.get('XSRF-TOKEN');
    if (this.xsrf && xsrf && !['GET', 'HEAD'].includes(method)) headers['x-xsrf-token'] ??= xsrf;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(this.base + url, { method, headers, body });
    for (const raw of res.headers.getSetCookie()) {
      const c = parseSetCookie(raw);
      this.setCookies.set(c.name, raw);
      const expired = c.maxAge !== undefined ? c.maxAge <= 0 : c.expires ? c.expires.getTime() <= Date.now() : false;
      if (expired || !c.value) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request('GET', url, { headers });
  }

  post(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request('POST', url, { body, headers });
  }

  /** เปิดหน้าแรก (ได้ XSRF-TOKEN มาเหมือนเปิดเว็บจริง) */
  async open() {
    await this.get('/');
    return this;
  }
}

export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeApi {
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
}

/**
 * api ปลอม: จำทุก request แล้วตอบตาม path —
 * login: `{ token: 'shop-<username>', user }` (password `bad` → 401, username `notoken` → ไม่มี token),
 * platform login: `{ token: 'platform-1', admin }`, `/api/me` / `/api/platform/me`: 401 ถ้าไม่มี token หรือ token = `shop-expired`,
 * `/api/nope*` → 404, อื่น ๆ → 200 echo
 */
export async function startFakeApi(): Promise<FakeApi> {
  const seen: Seen[] = [];
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) =>
    res.writeHead(status, { 'Content-Type': 'application/json', ...extra }).end(JSON.stringify(body));
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const auth = req.headers.authorization;
      const url = req.url!;
      if (url === '/api/auth/login' || url === '/api/auth/signup') {
        const { username, password } = JSON.parse(body || '{}');
        if (password === 'bad') return json(res, 401, { message: 'รหัสบริษัท ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง' });
        if (username === 'notoken') return json(res, 200, { user: { username } });
        return json(res, 200, { token: `shop-${username}`, user: { username } }, { 'Set-Cookie': 'api=1' });
      }
      if (url === '/api/platform/auth/login') return json(res, 200, { token: 'platform-1', admin: { id: 1 } });
      if (url === '/api/me' || url === '/api/platform/me') {
        if (!auth || auth === 'Bearer shop-expired') return json(res, 401, { message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
        return json(res, 200, { auth });
      }
      if (url.startsWith('/api/nope')) return json(res, 404, { message: 'ไม่พบข้อมูล' });
      if (url === '/api/cached') return json(res, 200, { ok: true }, { 'Cache-Control': 'private, max-age=60' });
      return json(res, 200, { ok: true, echo: body }, { 'X-Api': 'fake', 'Set-Cookie': 'api=1' });
    });
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** port ที่ไม่มีใครฟัง: เปิดแล้วปิดทันที */
export async function deadPort(): Promise<number> {
  const s = createServer().listen(0);
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}
