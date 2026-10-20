import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { SESSION_SECRET, makeDist } from './fixtures.ts';

describe('loadConfig', () => {
  const dist = makeDist();
  after(dist.cleanup);
  /** env ขั้นต่ำที่ต้องมี */
  const base = () => ({ DIST_DIR: dist.distDir, SESSION_SECRET });

  it('ใช้ค่า default เมื่อไม่ตั้ง', () => {
    const c = loadConfig({ ...base() });
    assert.deepEqual(c, {
      port: 4000,
      apiUrl: 'http://localhost:8080',
      distDir: dist.distDir,
      logLevel: 'info',
      sessionStore: 'memory',
      mongodbUri: null,
      sessionSecret: SESSION_SECRET,
      sessionIdleHours: 12,
      sessionMaxDays: 7,
      cookieSecure: 'auto',
      trustProxy: 'loopback',
      authRateLimit: 20,
    });
  });

  it('อ่านค่าจาก env และตัด / ท้าย API_URL', () => {
    const c = loadConfig({ ...base(), PORT: '8000', API_URL: 'http://api:8080/', LOG_LEVEL: 'debug' });
    assert.equal(c.port, 8000);
    assert.equal(c.apiUrl, 'http://api:8080');
    assert.equal(c.logLevel, 'debug');
  });

  it('PORT ผิด → error', () => {
    for (const PORT of ['abc', '0', '70000', '1.5']) {
      assert.throws(() => loadConfig({ ...base(), PORT }), /PORT/);
    }
  });

  it('API_URL ผิด / มี path → error', () => {
    for (const API_URL of ['not a url', 'ftp://api', 'http://api:8080/api']) {
      assert.throws(() => loadConfig({ ...base(), API_URL }), /API_URL/);
    }
  });

  it('DIST_DIR ไม่มี index.html → error', () => {
    assert.throws(() => loadConfig({ ...base(), DIST_DIR: dist.root + '/nope' }), /DIST_DIR/);
  });

  it('LOG_LEVEL ผิด → error', () => {
    assert.throws(() => loadConfig({ ...base(), LOG_LEVEL: 'loud' }), /LOG_LEVEL/);
  });

  it('session: store / MongoDB / secret / อายุ / cookie / trust proxy', () => {
    const c = loadConfig({
      ...base(),
      SESSION_STORE: 'mongodb',
      MONGODB_URI: 'mongodb://mongo:27017/an22',
      SESSION_IDLE_HOURS: '8',
      SESSION_MAX_DAYS: '1',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: '1',
    });
    assert.equal(c.sessionStore, 'mongodb');
    assert.equal(c.mongodbUri, 'mongodb://mongo:27017/an22');
    assert.equal(c.sessionIdleHours, 8);
    assert.equal(c.sessionMaxDays, 1);
    assert.equal(c.cookieSecure, true);
    assert.equal(c.trustProxy, 1);
    assert.equal(loadConfig({ ...base(), COOKIE_SECURE: 'false', TRUST_PROXY: 'false' }).trustProxy, false);
  });

  it('session ผิด → error', () => {
    assert.throws(() => loadConfig({ DIST_DIR: dist.distDir }), /SESSION_SECRET/);
    assert.throws(() => loadConfig({ ...base(), SESSION_SECRET: 'short' }), /SESSION_SECRET/);
    assert.throws(() => loadConfig({ ...base(), SESSION_STORE: 'redis' }), /SESSION_STORE/);
    assert.throws(() => loadConfig({ ...base(), SESSION_STORE: 'mongodb' }), /MONGODB_URI/);
    assert.throws(() => loadConfig({ ...base(), SESSION_IDLE_HOURS: '0' }), /SESSION_IDLE_HOURS/);
    assert.throws(() => loadConfig({ ...base(), SESSION_MAX_DAYS: 'x' }), /SESSION_MAX_DAYS/);
    assert.throws(() => loadConfig({ ...base(), SESSION_IDLE_HOURS: '48', SESSION_MAX_DAYS: '1' }), /SESSION_IDLE_HOURS/);
    assert.throws(() => loadConfig({ ...base(), COOKIE_SECURE: 'yes' }), /COOKIE_SECURE/);
    assert.throws(() => loadConfig({ ...base(), AUTH_RATE_LIMIT: '-1' }), /AUTH_RATE_LIMIT/);
    assert.equal(loadConfig({ ...base(), AUTH_RATE_LIMIT: '0' }).authRateLimit, 0);
  });

  it('ข้อความ error ไม่มีค่าที่ตั้งไว้ (ไปลง log — อาจมีรหัสผ่าน)', () => {
    const secret = 's3cret-Pa55';
    const cases: Record<string, string>[] = [
      { SESSION_STORE: 'mongodb', MONGODB_URI: `mongo://user:${secret}@db:27017/an22` },
      { API_URL: `ftp://user:${secret}@api` },
      { API_URL: `http://user:${secret}@api:8080/x` },
      { API_URL: `not a url ${secret}` },
      { PORT: secret },
      { LOG_LEVEL: secret },
      { COOKIE_SECURE: secret },
      { SESSION_SECRET: secret },
    ];
    for (const extra of cases) {
      let message = '';
      try {
        loadConfig({ ...base(), ...extra });
      } catch (err) {
        message = (err as Error).message;
      }
      assert.ok(message, `ต้อง error: ${JSON.stringify(Object.keys(extra))}`);
      assert.ok(!message.includes(secret), `ข้อความมีค่าลับ: ${message}`);
    }
  });

  it('API_URL ห้ามมี user:password (api อยู่ใน network ภายใน)', () => {
    assert.throws(() => loadConfig({ ...base(), API_URL: 'http://user:pass@api:8080' }), /ห้ามมี user:password/);
  });
});
