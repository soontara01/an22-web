import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import compression from 'compression';
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.ts';

/** ไฟล์ที่ Angular ใส่ hash ในชื่อ (`main-EXTO3ZN5.js`, `chunk-0vy21Nd2.js`, `styles-KW4BQYMB.css`) — เนื้อหาไม่มีวันเปลี่ยน */
const HASHED_FILE = /-[A-Za-z0-9_-]{8}\.(?:js|css)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** ทุกอย่างที่ไม่มี hash: browser ต้องถาม server ทุกครั้ง (ได้ 304 ถ้าไม่เปลี่ยน) — deploy ใหม่เห็นผลทันที */
const NO_CACHE = 'no-cache';
const REQUEST_ID = /^[\w.-]{1,64}$/;

export function createApp(config: Config, logger: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false); // static / sendFile ทำ ETag ของไฟล์เอง

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const given = req.headers['x-request-id'];
        const id = typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (req.url === '/healthz') return 'debug';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // liveness — ไม่เรียก api (web ยังทำงานได้แม้ api ล่ม: หน้าเว็บโหลดได้, /api ตอบ 502)
  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  app.use(compression());

  // send (ใต้ express.static) จำกัดไฟล์ไว้ใน distDir: path ที่มี `..` → 403, decode ไม่ได้ / null byte → 400, dotfile → ไม่เจอ
  app.use(
    express.static(config.distDir, {
      index: false,
      redirect: false,
      dotfiles: 'ignore',
      cacheControl: false,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', HASHED_FILE.test(path.basename(filePath)) ? IMMUTABLE : NO_CACHE);
      },
    }),
  );

  // SPA fallback: route ของ Angular (ไม่มีจุดใน segment สุดท้าย) → index.html; ทุกเมนูเป็น full reload จึงผ่านตรงนี้บ่อย
  // path ที่ดูเป็นไฟล์แต่ไม่มีจริง (เช่น chunk ของ build เก่า) → 404 ไม่ใช่ HTML — ไม่งั้น browser จะได้ HTML แทน JS
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      return res.status(400).type('text').send('Bad Request');
    }
    if (decoded.includes('\0') || path.posix.basename(decoded).includes('.')) return next();
    res.setHeader('Cache-Control', NO_CACHE);
    res.sendFile('index.html', { root: config.distDir, cacheControl: false }, (err) => err && next(err));
  });

  app.use((_req, res) => {
    res.status(404).type('text').send('Not Found');
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err?.status ?? err?.statusCode) || 500;
    if (status >= 500) res.err = err; // pino-http log ที่ระดับ error
    res.status(status).type('text').send(status === 500 ? 'Internal Server Error' : String(err?.message ?? 'Error'));
  };
  app.use(onError);

  return app;
}
