import { existsSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  /** origin ของ api — `/api/...` ส่งต่อไป `${apiUrl}/api/...` (คง `/api` ไว้) */
  apiUrl: string;
  /** โฟลเดอร์ build ของหน้าบ้าน (`dist/frontend-an22/browser`) — absolute */
  distDir: string;
  logLevel: string;
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

  return { port, apiUrl, distDir, logLevel };
}
