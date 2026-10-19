import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const INDEX_HTML = '<!doctype html><html><body><app-root></app-root></body></html>';
export const SECRET = 'SECRET-OUTSIDE-DIST';

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

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { pino } from 'pino';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';

/** เปิด web จริงบน port สุ่ม (ทดสอบผ่าน fetch / http เหมือน browser) */
export async function startWeb(config: Partial<Config> & { distDir: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const full: Config = { port: 0, apiUrl: 'http://127.0.0.1:9', logLevel: 'silent', ...config };
  const server: Server = createApp(full, pino({ level: 'silent' })).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
