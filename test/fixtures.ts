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
