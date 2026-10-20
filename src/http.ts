/** รูปแบบ error ตาม api-contract.md — หน้าบ้านแสดง `message` ตรง ๆ */
export const API_DOWN = { message: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่' };
/** api ไม่ตอบภายในเวลานี้ → ตัด แล้วตอบ 502 */
export const API_TIMEOUT_MS = 60_000;

export const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');

/** ช่อง token ใน session ที่ใช้กับ path นี้: `/api/platform/**` = platform admin, ที่เหลือ = ผู้ใช้ร้าน (E36 / E48) */
export const tokenSlot = (p: string): 'platformToken' | 'shopToken' =>
  p === '/api/platform' || p.startsWith('/api/platform/') ? 'platformToken' : 'shopToken';
