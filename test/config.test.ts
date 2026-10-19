import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { makeDist } from './fixtures.ts';

describe('loadConfig', () => {
  const dist = makeDist();
  after(dist.cleanup);

  it('ใช้ค่า default เมื่อไม่ตั้ง', () => {
    const c = loadConfig({ DIST_DIR: dist.distDir });
    assert.deepEqual(c, { port: 4000, apiUrl: 'http://localhost:8080', distDir: dist.distDir, logLevel: 'info' });
  });

  it('อ่านค่าจาก env และตัด / ท้าย API_URL', () => {
    const c = loadConfig({ DIST_DIR: dist.distDir, PORT: '8000', API_URL: 'http://api:8080/', LOG_LEVEL: 'debug' });
    assert.equal(c.port, 8000);
    assert.equal(c.apiUrl, 'http://api:8080');
    assert.equal(c.logLevel, 'debug');
  });

  it('PORT ผิด → error', () => {
    for (const PORT of ['abc', '0', '70000', '1.5']) {
      assert.throws(() => loadConfig({ DIST_DIR: dist.distDir, PORT }), /PORT/);
    }
  });

  it('API_URL ผิด / มี path → error', () => {
    for (const API_URL of ['not a url', 'ftp://api', 'http://api:8080/api']) {
      assert.throws(() => loadConfig({ DIST_DIR: dist.distDir, API_URL }), /API_URL/);
    }
  });

  it('DIST_DIR ไม่มี index.html → error', () => {
    assert.throws(() => loadConfig({ DIST_DIR: dist.root + '/nope' }), /DIST_DIR/);
  });

  it('LOG_LEVEL ผิด → error', () => {
    assert.throws(() => loadConfig({ DIST_DIR: dist.distDir, LOG_LEVEL: 'loud' }), /LOG_LEVEL/);
  });
});
