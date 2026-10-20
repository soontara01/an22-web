import type { Request } from 'express';

/** รูปแบบ error ตาม api-contract.md — หน้าบ้านแสดง `message` ตรง ๆ */
export const API_DOWN = { message: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่' };
/** api ไม่ตอบภายในเวลานี้ → ตัด แล้วตอบ 502 */
export const API_TIMEOUT_MS = 60_000;

export const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');

/** ช่อง token ใน session ที่ใช้กับ path นี้: `/api/platform/**` = platform admin, ที่เหลือ = ผู้ใช้ร้าน (E36 / E48) */
export const tokenSlot = (p: string): 'platformToken' | 'shopToken' =>
  p === '/api/platform' || p.startsWith('/api/platform/') ? 'platformToken' : 'shopToken';

/**
 * ผู้เรียกจริงที่ส่งให้ api: IP ตาม `TRUST_PROXY` (`req.ip`) — **แทนที่** `X-Forwarded-*` ที่ browser ส่งมา (ปลอมได้)
 * api ใช้ `X-Real-IP` จำกัดจำนวนครั้งต่อ IP / log ได้ เพราะเข้าถึงได้จาก web เท่านั้น
 */
export function clientHeaders(req: Request): Record<string, string> {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  return {
    'x-real-ip': ip,
    'x-forwarded-for': ip,
    'x-forwarded-proto': req.protocol,
    'x-forwarded-host': req.get('host') ?? '',
  };
}
