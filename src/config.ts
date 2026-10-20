import { existsSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  /** origin ของ api — `/api/...` ส่งต่อไป `${apiUrl}/api/...` (คง `/api` ไว้) */
  apiUrl: string;
  /** โฟลเดอร์ build ของหน้าบ้าน (`dist/frontend-an22/browser`) — absolute */
  distDir: string;
  logLevel: string;
  /** ที่เก็บ session ของ login (E48): memory = เครื่องเดียว หลุดเมื่อ restart, mongodb = หลาย instance / อยู่รอด restart */
  sessionStore: 'memory' | 'mongodb';
  /** บังคับเมื่อ `sessionStore = mongodb` */
  mongodbUri: string | null;
  /** เซ็น cookie, XSRF-TOKEN และเข้ารหัส session ใน MongoDB — ≥ 32 ตัว */
  sessionSecret: string;
  /** ไม่ใช้งานนานเท่านี้ → หลุด (ใช้งานอยู่ต่ออายุเอง) */
  sessionIdleHours: number;
  /** นับจาก login เกินเท่านี้ → ต้อง login ใหม่ */
  sessionMaxDays: number;
  /** `auto` = Secure เมื่อ request เป็น https (ดู `X-Forwarded-Proto` ตาม `trustProxy`) */
  cookieSecure: 'auto' | boolean;
  /** ค่า `trust proxy` ของ Express — proxy หน้า web ที่เชื่อ `X-Forwarded-*` */
  trustProxy: boolean | number | string;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** อ่าน config จาก env var; ค่าผิด → throw พร้อมข้อความที่บอกว่าต้องแก้อะไร */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT ต้องเป็นเลข 1–65535 (ได้ "${env.PORT}")`);
  }

  const apiUrl = (env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(`API_URL ไม่ใช่ URL (ได้ "${env.API_URL}")`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/') {
    throw new Error(`API_URL ต้องเป็น origin แบบ http(s)://host:port ไม่มี path (ได้ "${env.API_URL}")`);
  }

  const distDir = path.resolve(env.DIST_DIR ?? '../FrontEnd-An22/dist/frontend-an22/browser');
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`DIST_DIR ไม่มี index.html: ${distDir} (build หน้าบ้านก่อน: cd ../FrontEnd-An22 && npm run build)`);
  }

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL ต้องเป็น ${LOG_LEVELS.join(' / ')} (ได้ "${logLevel}")`);
  }

  const sessionStore = env.SESSION_STORE ?? 'memory';
  if (sessionStore !== 'memory' && sessionStore !== 'mongodb') {
    throw new Error(`SESSION_STORE ต้องเป็น memory / mongodb (ได้ "${sessionStore}")`);
  }
  const mongodbUri = env.MONGODB_URI || null;
  if (sessionStore === 'mongodb' && !/^mongodb(\+srv)?:\/\//.test(mongodbUri ?? '')) {
    throw new Error(`SESSION_STORE=mongodb ต้องตั้ง MONGODB_URI เป็น mongodb://… (ได้ "${env.MONGODB_URI ?? ''}")`);
  }

  const sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET ต้องยาวอย่างน้อย 32 ตัว (สร้าง: openssl rand -base64 48)');
  }

  const sessionIdleHours = positive(env.SESSION_IDLE_HOURS, 12, 'SESSION_IDLE_HOURS');
  const sessionMaxDays = positive(env.SESSION_MAX_DAYS, 7, 'SESSION_MAX_DAYS');
  if (sessionIdleHours > sessionMaxDays * 24) {
    throw new Error('SESSION_IDLE_HOURS ต้องไม่เกิน SESSION_MAX_DAYS');
  }

  const secure = env.COOKIE_SECURE ?? 'auto';
  if (!['auto', 'true', 'false'].includes(secure)) {
    throw new Error(`COOKIE_SECURE ต้องเป็น auto / true / false (ได้ "${secure}")`);
  }
  const cookieSecure = secure === 'auto' ? 'auto' : secure === 'true';

  const trust = env.TRUST_PROXY ?? 'loopback';
  const trustProxy = trust === 'true' ? true : trust === 'false' ? false : /^\d+$/.test(trust) ? Number(trust) : trust;

  return {
    port,
    apiUrl,
    distDir,
    logLevel,
    sessionStore,
    mongodbUri,
    sessionSecret,
    sessionIdleHours,
    sessionMaxDays,
    cookieSecure,
    trustProxy,
  };
}

function positive(value: string | undefined, fallback: number, name: string): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} ต้องเป็นตัวเลขมากกว่า 0 (ได้ "${value}")`);
  return n;
}
