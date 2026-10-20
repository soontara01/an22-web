import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, RequestHandler } from 'express';
import type { Config } from './config.ts';

/** ชื่อเดียวกับค่า default ของ Angular `HttpClient` (withXsrfConfiguration) — หน้าบ้านไม่ต้องตั้งอะไร */
export const XSRF_COOKIE = 'XSRF-TOKEN';
export const XSRF_HEADER = 'x-xsrf-token';
export const CSRF_FAILED = { message: 'คำขอไม่ถูกต้อง กรุณาโหลดหน้าใหม่' };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * กัน CSRF แบบ double-submit (E48): cookie `XSRF-TOKEN` (อ่านได้ด้วย JS ของเว็บเราเท่านั้น) = nonce + HMAC ของ secret;
 * request ที่เปลี่ยนข้อมูลต้องส่ง header `X-XSRF-TOKEN` ค่าเดียวกัน — เว็บอื่นอ่าน cookie ไม่ได้จึงปลอม header ไม่ได้,
 * HMAC กันการฝัง cookie ที่สร้างเอง (เช่นจาก subdomain); ร่วมกับ SameSite=Lax ของ cookie session
 */
export function createCsrf(config: Config): { issue: RequestHandler; verify: RequestHandler } {
  const sign = (nonce: string) =>
    `${nonce}.${createHmac('sha256', config.sessionSecret).update(`xsrf:${nonce}`).digest('base64url')}`;
  const valid = (token: string | undefined): token is string => {
    if (!token) return false;
    const [nonce] = token.split('.');
    const expected = Buffer.from(sign(nonce ?? ''));
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const cookieOf = (req: Request) => parseCookie(req.headers.cookie ?? '')[XSRF_COOKIE];

  /** ตั้ง cookie ให้ ถ้ายังไม่มี / ไม่ถูกต้อง (ทุก response ของ /api และ index.html) */
  const issue: RequestHandler = (req, res, next) => {
    if (!valid(cookieOf(req))) {
      res.append(
        'Set-Cookie',
        stringifySetCookie({
          name: XSRF_COOKIE,
          value: sign(randomBytes(18).toString('base64url')),
          path: '/',
          sameSite: 'lax',
          secure: config.cookieSecure === 'auto' ? req.secure : config.cookieSecure,
        }),
      );
    }
    next();
  };

  /** POST / PUT / PATCH / DELETE: header ต้องตรงกับ cookie และ cookie ต้องเป็นของเรา ไม่งั้น 403 */
  const verify: RequestHandler = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const cookie = cookieOf(req);
    if (valid(cookie) && req.get(XSRF_HEADER) === cookie) return next();
    res.status(403).set('Cache-Control', 'no-store').json(CSRF_FAILED);
  };

  return { issue, verify };
}
