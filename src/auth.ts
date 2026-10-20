import express, { type Request, Router } from 'express';
import type { Logger } from 'pino';
import type { Config } from './config.ts';
import { API_DOWN, API_TIMEOUT_MS, clientHeaders, tokenSlot } from './http.ts';
import { sessionCookieName } from './session.ts';

/** path ที่ api ตอบพร้อม `token` — web เก็บ token ไว้ใน session แล้วตัดออกจากคำตอบ (E48) */
const LOGIN_PATHS = ['/api/auth/login', '/api/auth/signup', '/api/platform/auth/login'];
const LOGOUT_PATHS = ['/api/auth/logout', '/api/platform/auth/logout'];

/**
 * BFF ของ login (E48): browser ได้แค่ cookie `an22.sid` (httpOnly) — token ของ api อยู่ใน session ฝั่ง web
 * - login / signup / platform login: ส่งต่อไป api → 2xx ที่มี `token` = เริ่ม session ใหม่ (id ใหม่ กัน session fixation)
 *   เก็บ token ในช่องของมัน (ร้าน / platform) คงอีกช่องไว้ แล้วตอบโดยไม่มี `token`; ไม่สำเร็จ = ส่งคำตอบของ api ต่อตามเดิม
 * - logout: web ตอบเอง — ลบช่องนั้น, ไม่เหลือทั้งสองช่อง = ทำลาย session + ลบ cookie
 */
export function authRoutes(config: Config, logger: Logger): Router {
  const router = Router();

  router.post(LOGIN_PATHS, express.json({ limit: '1mb' }), async (req, res) => {
    const slot = tokenSlot(req.path);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(config.apiUrl + req.originalUrl, {
        method: 'POST',
        headers: forwardHeaders(req),
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
    if (typeof token !== 'string' || !token) {
      logger.error({ reqId: req.id, status: upstream.status }, 'api login answered without a token');
      return res.status(502).set('Cache-Control', 'no-store').json(API_DOWN);
    }
    delete body['token'];

    const other = slot === 'shopToken' ? 'platformToken' : 'shopToken';
    const kept = req.session[other];
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ message: 'เริ่ม session ไม่ได้ กรุณาลองใหม่' });
      req.session[slot] = token;
      if (kept) req.session[other] = kept;
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
