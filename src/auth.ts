import express, { type Request, Router } from 'express';
import type { Logger } from 'pino';
import type { Config } from './config.ts';
import { API_DOWN, API_TIMEOUT_MS, clientHeaders, tokenSlot } from './http.ts';
import { sessionCookieName } from './session.ts';

/** path ที่ api ตอบพร้อม `token` — web เก็บ token ไว้ใน session แล้วตัดออกจากคำตอบ (E48) */
const LOGIN_PATHS = [
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/mfa/verify',
  '/api/platform/auth/login',
  '/api/platform/auth/mfa/verify',
];
/** ขั้นรหัส Microsoft Authenticator (ร้าน E55 / platform admin E56): ส่งต่อพร้อม challenge ที่เก็บไว้ใน session แทน token */
const MFA_VERIFY_PATHS = ['/api/auth/mfa/verify', '/api/platform/auth/mfa/verify'];
/** ช่อง challenge ของฝั่งนั้น — ร้าน / platform แยกกันเหมือน token */
const mfaSlot = (slot: 'shopToken' | 'platformToken') => (slot === 'shopToken' ? 'mfaToken' : 'platformMfaToken');
/** ไม่มี login ที่รอรหัสอยู่ (ข้อความเดียวกับ api) — 400 ไม่ใช่ 401: หน้าบ้าน logout เมื่อได้ 401 */
export const MFA_EXPIRED = { message: 'หมดเวลายืนยันรหัส กรุณาเข้าสู่ระบบใหม่' };
const LOGOUT_PATHS = ['/api/auth/logout', '/api/platform/auth/logout'];

/**
 * BFF ของ login (E48): browser ได้แค่ cookie `an22.sid` (httpOnly) — token ของ api อยู่ใน session ฝั่ง web
 * - login / signup / platform login: ส่งต่อไป api → 2xx ที่มี `token` = เริ่ม session ใหม่ (id ใหม่ กัน session fixation)
 *   เก็บ token ในช่องของมัน (ร้าน / platform) คงอีกช่องไว้ แล้วตอบโดยไม่มี `token`; ไม่สำเร็จ = ส่งคำตอบของ api ต่อตามเดิม
 * - ขั้นรหัส Authenticator (ร้าน E55 / platform admin E56 — platform ทุกครั้ง): login ที่ตอบ 2xx พร้อม `challenge` (ไม่มี `token`)
 *   = รหัสผ่านถูก รอรหัส 6 หลัก — เก็บ challenge ในช่อง `mfaToken` / `platformMfaToken` (session id ใหม่) แล้วตอบโดยไม่มี `challenge`;
 *   `POST /api/auth/mfa/verify` / `/api/platform/auth/mfa/verify` ส่งต่อด้วย `Bearer <challenge ของฝั่งนั้น>` (ไม่มี → 400 เอง)
 *   ได้ token = login สำเร็จเหมือนข้างบน (challenge หายไปกับ session เดิม)
 * - logout: web ตอบเอง — ลบช่องนั้นและ challenge ของฝั่งนั้น, ไม่เหลือทั้งสองช่อง = ทำลาย session + ลบ cookie
 */
export function authRoutes(config: Config, logger: Logger): Router {
  const router = Router();

  router.post(LOGIN_PATHS, express.json({ limit: '1mb' }), async (req, res) => {
    const slot = tokenSlot(req.path);
    const pending = mfaSlot(slot);
    const isVerify = MFA_VERIFY_PATHS.includes(req.path);
    const headers = forwardHeaders(req);
    if (isVerify) {
      const challenge = req.session[pending];
      if (!challenge) return res.status(400).set('Cache-Control', 'no-store').json(MFA_EXPIRED);
      headers['authorization'] = `Bearer ${challenge}`;
    }
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(config.apiUrl + req.originalUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(req.body ?? null),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (err) {
      logger.error({ err, reqId: req.id }, 'api login error');
      return res.status(502).set('Cache-Control', 'no-store').json(API_DOWN);
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .set('Cache-Control', 'no-store')
        .send(text);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    const token = body['token'];
    const challenge = body['challenge'];
    if (!isVerify && (typeof token !== 'string' || !token) && typeof challenge === 'string' && challenge) {
      // รหัสผ่านถูก รอรหัส Authenticator — ยังไม่มี session ของร้าน
      delete body['challenge'];
      const { shopToken, platformToken, mfaToken, platformMfaToken } = req.session;
      return req.session.regenerate((err) => {
        if (err) return res.status(500).json({ message: 'เริ่ม session ไม่ได้ กรุณาลองใหม่' });
        Object.assign(req.session, { shopToken, platformToken, mfaToken, platformMfaToken });
        req.session[pending] = challenge;
        req.session.createdAt = Date.now();
        req.session.save((saveErr) => {
          if (saveErr) return res.status(500).json({ message: 'เริ่ม session ไม่ได้ กรุณาลองใหม่' });
          res.status(upstream.status).set('Cache-Control', 'no-store').json(body);
        });
      });
    }
    if (typeof token !== 'string' || !token) {
      logger.error({ reqId: req.id, status: upstream.status }, 'api login answered without a token');
      return res.status(502).set('Cache-Control', 'no-store').json(API_DOWN);
    }
    delete body['token'];

    // อีกฝั่งคงไว้ทั้ง token และ challenge ที่รอรหัส; challenge ของฝั่งนี้หมดหน้าที่แล้ว
    const other = slot === 'shopToken' ? 'platformToken' : 'shopToken';
    const kept = req.session[other];
    const keptChallenge = req.session[mfaSlot(other)];
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ message: 'เริ่ม session ไม่ได้ กรุณาลองใหม่' });
      req.session[slot] = token;
      if (kept) req.session[other] = kept;
      if (keptChallenge) req.session[mfaSlot(other)] = keptChallenge;
      req.session.createdAt = Date.now();
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ message: 'เริ่ม session ไม่ได้ กรุณาลองใหม่' });
        res.status(upstream.status).set('Cache-Control', 'no-store').json(body);
      });
    });
  });

  router.post(LOGOUT_PATHS, (req, res) => {
    const slot = tokenSlot(req.path);
    delete req.session[slot];
    delete req.session[mfaSlot(slot)];
    const done = () => res.set('Cache-Control', 'no-store').json(null);
    if (req.session.shopToken || req.session.platformToken) return req.session.save(() => done());
    req.session.destroy(() => {
      res.clearCookie(sessionCookieName(config), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure === 'auto' ? req.secure : config.cookieSecure,
      });
      done();
    });
  });

  return router;
}

/** header ที่ api ควรรู้: ชนิด body, request id + ผู้เรียกจริงตามที่ web เชื่อ (`clientHeaders()`) — ไม่ส่ง cookie / Authorization ของ browser */
function forwardHeaders(req: Request): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-request-id': String(req.id),
    ...clientHeaders(req),
  };
}
