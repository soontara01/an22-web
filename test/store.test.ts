import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MongoClient } from 'mongodb';
import type { Config } from '../src/config.ts';
import { createSessionStore } from '../src/session.ts';
import { Browser, type FakeApi, SESSION_SECRET, makeDist, startFakeApi, startWeb } from './fixtures.ts';

const MONGO = process.env.TEST_MONGODB_URI;
const LOGIN = { companyCode: 'DEMO', username: 'admin', password: 'admin' };

/**
 * ที่เก็บ session (E48): login แล้ว "restart" web (app + store ใหม่) —
 * memory หลุด (ตามคาด), MongoDB ยัง login อยู่ และเก็บ session แบบเข้ารหัส
 */
describe('session store', () => {
  const dist = makeDist();
  let api: FakeApi;
  before(async () => (api = await startFakeApi()));
  after(async () => {
    await api.close();
    dist.cleanup();
  });

  const restartTest = async (store: Partial<Config>) => {
    const config = { distDir: dist.distDir, apiUrl: api.url, ...store };
    const web1 = await startWeb(config);
    const browser = await new Browser(web1.url).open();
    await browser.post('/api/auth/login', LOGIN);
    assert.equal((await browser.get('/api/me')).status, 200);
    await web1.close();

    const web2 = await startWeb(config);
    try {
      const again = new Browser(web2.url);
      for (const [k, v] of browser.cookies) again.cookies.set(k, v);
      return (await again.get('/api/me')).status;
    } finally {
      await web2.close();
    }
  };

  it('memory: restart แล้วหลุด', async () => {
    assert.equal(await restartTest({ sessionStore: 'memory' }), 401);
  });

  it('mongodb: restart แล้วยัง login อยู่ และไม่มี token แบบอ่านออกใน DB', { skip: MONGO ? false : 'ตั้ง TEST_MONGODB_URI (docker compose up -d mongo)' }, async () => {
    const client = new MongoClient(MONGO!);
    await client.connect();
    const sessions = client.db().collection('sessions');
    await sessions.deleteMany({});
    try {
      assert.equal(await restartTest({ sessionStore: 'mongodb', mongodbUri: MONGO! }), 200);
      const docs = await sessions.find().toArray();
      assert.equal(docs.length, 1);
      assert.ok(docs[0].expires instanceof Date, 'มีวันหมดอายุ (TTL index ลบเอง)');
      assert.doesNotMatch(JSON.stringify(docs[0]), /shop-admin/, 'session ถูกเข้ารหัส');
      const indexes = await sessions.indexes();
      assert.ok(indexes.some((i) => i.key.expires === 1 && i.expireAfterSeconds === 0), 'TTL index');
    } finally {
      await sessions.deleteMany({});
      await client.close();
    }
  });

  it('mongodb: secret อื่นอ่าน session เดิมไม่ได้ (= login ใหม่)', { skip: MONGO ? false : 'ตั้ง TEST_MONGODB_URI' }, async () => {
    const config = { distDir: dist.distDir, apiUrl: api.url, sessionStore: 'mongodb' as const, mongodbUri: MONGO! };
    const web1 = await startWeb(config);
    const browser = await new Browser(web1.url).open();
    await browser.post('/api/auth/login', LOGIN);
    assert.equal((await browser.get('/api/me')).status, 200);
    await web1.close();
    const other = createSessionStore({ ...web1.config, sessionSecret: SESSION_SECRET.replace('test', 'evil') });
    const web2 = await startWeb({ ...config, sessionSecret: SESSION_SECRET.replace('test', 'evil') }, other.store);
    try {
      const again = new Browser(web2.url);
      for (const [k, v] of browser.cookies) again.cookies.set(k, v);
      assert.equal((await again.get('/api/me')).status, 401);
    } finally {
      await web2.close();
      await other.close();
    }
  });
});
