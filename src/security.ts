import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Config } from './config.ts';

/**
 * hash ของ `<script>` inline ใน index.html (Angular ใส่มา 1 ตัวตอน inline critical CSS) — CSP อนุญาตเฉพาะสคริปต์นี้
 * อ่านจากไฟล์ตอน start จึงตรงกับ build ที่ serve อยู่เสมอ
 */
export function inlineScriptHashes(distDir: string): string[] {
  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`,
  );
}

/**
 * Content-Security-Policy ของหน้าบ้าน — เปิดเฉพาะที่แอปใช้จริง:
 * สคริปต์จากเว็บเรา (+ inline ที่ hash ตรง), style inline (Angular / Material ใส่ `<style>` ตอนรัน) + Google Fonts,
 * รูป `data:` / `blob:` (รูปสินค้าเป็น data URL, ไฟล์ Excel ดาวน์โหลดผ่าน blob), เรียก `/api` ได้เฉพาะเว็บเรา, ห้ามถูกฝังใน frame
 */
export function contentSecurityPolicy(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * header ความปลอดภัยของทุกคำตอบ (หน้าเว็บ, ไฟล์, `/api`):
 * CSP + กันการฝัง frame (clickjacking), ไม่ส่ง Referer ออกนอกเว็บ (URL ตั้งรหัสผ่านมี token), แยก window จากเว็บอื่น,
 * ปิด API ของเบราว์เซอร์ที่ไม่ใช้, HSTS เฉพาะเมื่อมาทาง https
 */
export function securityHeaders(config: Config): RequestHandler {
  const csp = contentSecurityPolicy(inlineScriptHashes(config.distDir));
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()',
    );
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/** query ที่เป็นความลับ — ไม่ลง log (ลิงก์ตั้งรหัสผ่านใหม่ `/auth/reset-password?token=…`) */
const SECRET_PARAMS = ['token', 'code', 'password'];

/** URL สำหรับ log: ค่า query ที่เป็นความลับเปลี่ยนเป็น `***` */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url || !url.includes('?')) return url;
  const [pathname, query] = url.split('?', 2) as [string, string];
  const params = new URLSearchParams(query);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SECRET_PARAMS.includes(key.toLowerCase())) {
      params.set(key, '***');
      changed = true;
    }
  }
  return changed ? `${pathname}?${params.toString().replaceAll('%2A', '*')}` : url;
}

/** path ที่ตรวจรหัสผ่าน / ส่งอีเมล — เดารหัสได้ถ้าไม่จำกัด */
export const RATE_LIMITED_PATHS = [
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/verify',
  '/api/platform/auth/login',
];
const isUnlock = (p: string) => /^\/api\/shifts\/\d+\/unlock$/.test(p);
const isRateLimited = (p: string) => RATE_LIMITED_PATHS.includes(p) || isUnlock(p);

/**
 * path ที่แค่ตรวจรหัสผ่าน: ครั้งที่ผ่านไม่นับ (C3-7) — ร้านที่พนักงานหลายคนออก internet ทาง IP เดียว
 * (สลับคนขาย, ปลดล็อกหน้าจอ, เปลี่ยนกะ) ไม่ชนเพดานในวันปกติ. สมัคร / ลืม-ตั้งรหัสผ่านนับทุกครั้ง
 * (ครั้งที่ "สำเร็จ" สร้างบริษัท / ส่งอีเมล)
 */
const PASSWORD_CHECK_PATHS = ['/api/auth/login', '/api/auth/verify', '/api/platform/auth/login'];
const isPasswordCheck = (p: string) => PASSWORD_CHECK_PATHS.includes(p) || isUnlock(p);

export const TOO_MANY = { message: 'พยายามบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' };

/**
 * จำกัดจำนวนครั้งต่อ IP (`req.ip` ตาม `TRUST_PROXY`) ใน 15 นาที เฉพาะ POST ของ path ข้างบน — ด่านแรกกันเดารหัส;
 * api ต้องจำกัดต่อบัญชีอีกชั้น. path ที่ตรวจรหัสผ่านนับเฉพาะครั้งที่ไม่ผ่าน (ตอบ ≥ 400). นับในหน่วยความจำของแต่ละ instance (หลาย instance = เพดานรวมสูงขึ้นตามจำนวน)
 */
export function authRateLimiter(config: Config): RequestHandler {
  if (config.authRateLimit === 0) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.method !== 'POST' || !isRateLimited(req.path),
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode < 400 && isPasswordCheck(req.path),
    // IPv6 นับเป็นกลุ่ม /56 (คนเดียวเปลี่ยนเลขท้ายได้ทั้งช่วง)
    keyGenerator: (req) =>
      `${ipKeyGenerator(req.ip ?? '0.0.0.0')}:${req.path.startsWith('/api/shifts/') ? 'unlock' : req.path}`,
    handler: (_req, res) => {
      res.status(429).set('Cache-Control', 'no-store').json(TOO_MANY);
    },
  });
}
