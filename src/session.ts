import { MongoStore, createWebCryptoAdapter } from 'connect-mongo';
import type { RequestHandler } from 'express';
import session from 'express-session';
import createMemoryStore from 'memorystore';
import { MongoClient, MongoError } from 'mongodb';
import type { Config } from './config.ts';

declare module 'express-session' {
  interface SessionData {
    /** token ของผู้ใช้ร้านที่ api ออกตอน login — browser ไม่เคยเห็น (E48) */
    shopToken?: string;
    /** token ของ platform admin (`/api/platform/**`) — แยกช่องจากของร้าน */
    platformToken?: string;
    /** ms ตอน login — เกิน `sessionMaxDays` ต้อง login ใหม่ */
    createdAt?: number;
  }
}

/**
 * ชื่อ cookie session: บน https (`COOKIE_SECURE=true`) ใช้ prefix `__Host-` — browser รับเฉพาะ cookie ที่ Secure, path=/
 * ไม่มี Domain จึงไม่มี subdomain ไหนฝัง / ทับ cookie นี้ได้; `auto` / `false` ใช้ชื่อธรรมดา (prefix บังคับ Secure ทุกครั้ง)
 */
export const sessionCookieName = (config: Pick<Config, 'cookieSecure'>): string =>
  config.cookieSecure === true ? '__Host-an22.sid' : 'an22.sid';

/**
 * MongoDB หาไม่เจอ (ล่ม / ต่อไม่ได้) นานเท่านี้ → request ที่ใช้ session ได้ 500 ทันที แทนการค้างรอ
 * ค่า default ของ driver (30 วินาทีต่อครั้ง — หน้าจอขาวราว 1 นาที, V2-U-14); mongo กลับมาแล้วใช้ต่อได้เอง
 */
export const MONGO_SELECTION_TIMEOUT_MS = 5_000;

export interface SessionStore {
  store: session.Store;
  close: () => Promise<void>;
}

/** ที่เก็บ session ตาม config: memory (TTL + LRU, ไม่ใช่ MemoryStore ของ express-session ที่รั่ว) หรือ MongoDB (เข้ารหัส) */
export function createSessionStore(config: Config): SessionStore {
  const ttlMs = config.sessionIdleHours * 3_600_000;
  if (config.sessionStore === 'mongodb') {
    const client = new MongoClient(config.mongodbUri!, {
      serverSelectionTimeoutMS: MONGO_SELECTION_TIMEOUT_MS,
    });
    // TTL index ให้ MongoDB ลบ session ที่หมดอายุเอง — สร้างเองเพื่อรอให้เสร็จก่อนปิด client ได้
    const indexed = client
      .db()
      .collection('sessions')
      .createIndex({ expires: 1 }, { expireAfterSeconds: 0 })
      .catch(() => undefined); // ต่อไม่ได้ตอนนี้: store จะ error ตอนใช้งานเอง (log ตาม request)
    const store = MongoStore.create({
      client,
      collectionName: 'sessions',
      ttl: Math.ceil(ttlMs / 1000),
      autoRemove: 'disabled', // TTL index สร้างเองข้างบน (ผลเหมือน 'native')
      // session มี JWT ของ api — เก็บแบบเข้ารหัส (AES-GCM) คนอ่าน DB ได้ก็ใช้ token ไม่ได้
      cryptoAdapter: createWebCryptoAdapter({ secret: config.sessionSecret }),
    });
    // ถอดรหัสไม่ได้ (เปลี่ยน SESSION_SECRET / ข้อมูลเสีย) = ไม่มี session → login ใหม่ ไม่ใช่ 500;
    // error ของ MongoDB เอง (ต่อไม่ได้ ฯลฯ) ยังเป็น error ตามเดิม
    const get = store.get.bind(store);
    store.get = (sid, callback) =>
      get(sid, (err, data) => (err && !(err instanceof MongoError) ? callback(null, null) : callback(err, data)));
    const settled = trackPending(store);
    return {
      store,
      close: async () => {
        await settled();
        await indexed;
        await client.close();
      },
    };
  }
  const MemoryStore = createMemoryStore(session);
  const store = new MemoryStore({ checkPeriod: Math.min(ttlMs, 600_000), ttl: ttlMs });
  return {
    store,
    close: async () => store.stopInterval(),
  };
}

/**
 * cookie `an22.sid` (httpOnly, SameSite=Lax) — สร้างเมื่อ login เท่านั้น (`saveUninitialized: false`);
 * ใช้งานอยู่ต่ออายุทุก request (`rolling`) และเกิน `sessionMaxDays` นับจาก login → เริ่ม session ใหม่ (หลุด)
 */
export function sessionMiddleware(config: Config, store: session.Store): RequestHandler[] {
  const maxAgeMs = config.sessionMaxDays * 86_400_000;
  return [
    session({
      name: sessionCookieName(config),
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      unset: 'destroy',
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        path: '/',
        maxAge: config.sessionIdleHours * 3_600_000,
      },
    }),
    (req, _res, next) => {
      const created = req.session.createdAt;
      if (created === undefined || Date.now() - created <= maxAgeMs) return next();
      req.session.regenerate(next);
    },
  ];
}

/**
 * นับงานของ store ที่ยังไม่เสร็จ (express-session ต่ออายุ session หลังส่งคำตอบไปแล้ว) — ตอนปิดรอให้เสร็จก่อน
 * ไม่งั้นงานนั้นถูกตัดกลางคันเมื่อปิด MongoClient. คืนฟังก์ชันที่รอจนว่าง (สูงสุด 5 วิ)
 */
function trackPending(store: session.Store): () => Promise<void> {
  let pending = 0;
  const methods = ['get', 'set', 'touch', 'destroy'] as const;
  for (const name of methods) {
    const original = store[name]?.bind(store) as ((...args: unknown[]) => void) | undefined;
    if (!original) continue;
    (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const callback = args.at(-1);
      pending++;
      const done = (...result: unknown[]) => {
        pending--;
        if (typeof callback === 'function') callback(...result);
      };
      original(...(typeof callback === 'function' ? [...args.slice(0, -1), done] : [...args, done]));
    };
  }
  return async () => {
    const until = Date.now() + 5000;
    while (pending > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  };
}
