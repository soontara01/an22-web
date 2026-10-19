# CLAUDE.md — an22-web

web server ของระบบ An22: serve ไฟล์ build ของหน้าบ้าน (Angular SPA) + proxy `/api` → api
ระบบมี 3 repo (E47): **FrontEnd-An22** (spec + หน้าบ้าน), **an22-web** (repo นี้), **an22-api** (Spring Boot + PostgreSQL)

**spec อยู่ที่ `../FrontEnd-An22/docs/backend/README.md` (หัวข้อ web) อ่านก่อนทำงาน** — repo หน้าบ้านเปิดได้ผ่าน `.claude/settings.json`
(`additionalDirectories`); spec ไม่ชัด / ต้องแก้ → บอกผู้ใช้ก่อน แล้วแก้ใน `../FrontEnd-An22`

## เครื่องมือ

- Node 24 + Express 5, **TypeScript รันตรงด้วย type stripping** — ไม่มีขั้น compile, `tsc` ใช้ตรวจ type อย่างเดียว
  - ใช้ได้แค่ syntax ที่ลบทิ้งได้ (`erasableSyntaxOnly`): ห้าม `enum`, `namespace`, parameter property; import ไฟล์ในโปรเจกต์ใส่ `.ts`, import type ใช้ `import type`
- proxy: `http-proxy-middleware` (v4), log: `pino` + `pino-http` (JSON), gzip: `compression`
- test: `node:test` + `fetch` (เปิด server จริงบน port สุ่ม) — ไม่มี jest / supertest

## คำสั่ง

```sh
npm start                 # node --env-file-if-exists=.env src/server.ts
npm run dev               # --watch + pino-pretty
npm test                  # test/**/*.test.ts
npm run typecheck         # tsc --noEmit
npm run docker:build      # คัดลอก dist หน้าบ้าน → ./public แล้ว docker build -t an22-web:<sha หน้าบ้าน> -t an22-web:latest
```

build หน้าบ้านก่อน: `cd ../FrontEnd-An22 && npm run build` → `dist/frontend-an22/browser`

## Config (env var; dev คัดลอก `.env.example` เป็น `.env`)

| ตัวแปร      | default                                       | หมายเหตุ                                                          |
| ----------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `PORT`      | `4000`                                        |                                                                   |
| `API_URL`   | `http://localhost:8080`                       | origin เท่านั้น (ไม่มี path) — `/api/x` → `${API_URL}/api/x`      |
| `DIST_DIR`  | `../FrontEnd-An22/dist/frontend-an22/browser` | ต้องมี `index.html` ไม่งั้นไม่ start; ใน Docker = `/app/public`   |
| `LOG_LEVEL` | `info`                                        | `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent` |

ค่าผิด → `src/config.ts` หยุดตอน start พร้อมข้อความภาษาไทย

## โครงไฟล์

- `src/config.ts` — `loadConfig(env)` อ่าน + ตรวจ env
- `src/app.ts` — `createApp(config, logger)` สร้าง express app (test ใช้ตัวนี้)
- `src/server.ts` — entry: listen + graceful shutdown (SIGTERM / SIGINT)
- `test/fixtures.ts` — dist ปลอม (+ ไฟล์ลับนอก dist), `startWeb()`; `test/*.test.ts` — config / static / proxy (api ปลอม)
- `Dockerfile`, `scripts/docker-build.sh` — image = server + dist 1 เวอร์ชัน (rollback ด้วย tag)

## กฎ (ลำดับ middleware ใน `createApp`)

1. `GET /healthz` → `200 {"status":"ok"}` — liveness, ไม่เรียก api (web ยังทำงานได้แม้ api ล่ม); log ระดับ debug
2. **proxy `/api`** (`/api` และ `/api/...` เท่านั้น — `/apix` ไม่ใช่): **คง `/api` ไว้** เหมือน `proxy.conf.json` ของหน้าบ้าน;
   ติดที่ root ด้วย `pathFilter` (อย่าเปลี่ยนเป็น `app.use('/api', …)` — Express จะตัด `/api` ทิ้ง); body / header (`Authorization`, `X-Branch-Id`, `X-Terminal-Id`) ส่งแบบ stream ไม่แตะ
   (อย่าใส่ body parser ก่อน proxy); api ล่ม / เกิน 60 วิ → `502 {"message":"ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่"}` (รูปแบบ error ตาม `api-contract.md`);
   `/api` ไม่ตกไป index.html เด็ดขาด
3. **static** จาก `DIST_DIR` (`express.static` / `send` กัน `..`, null byte, dotfile — ไม่มีอะไรนอก dist หลุดออกไป)
   - ชื่อมี hash 8 ตัว (`main-XXXXXXXX.js`, `chunk-XXXXXXXX.js`, `styles-XXXXXXXX.css`) → `Cache-Control: public, max-age=31536000, immutable`
   - ไฟล์อื่น (`index.html`, `favicon.ico`, …) → `no-cache` (browser ถามทุกครั้ง ได้ 304 ถ้าไม่เปลี่ยน → deploy ใหม่เห็นผลทันที)
4. **SPA fallback**: GET / HEAD ที่ segment สุดท้าย (decode แล้ว) ไม่มีจุด → `index.html` + `no-cache`
   — ทุกเมนูของหน้าบ้านเป็น full page reload ("SPA per menu" ใน `../FrontEnd-An22/CLAUDE.md`) จึงผ่านตรงนี้ทุกครั้งที่เปลี่ยนเมนู;
   path ที่ดูเป็นไฟล์แต่ไม่มี (chunk ของ build เก่า) → **404 ไม่ใช่ HTML**; decode ไม่ได้ → 400; method อื่น → 404
5. log ต่อ request 1 บรรทัด: `req.id` (รับ `X-Request-Id` ของ client ถ้ารูปแบบถูก ไม่งั้นสุ่ม, ส่งกลับใน header), method, url, ip, status, เวลา —
   **ไม่ log header** (มี token); 5xx = error, 4xx = warn

เปลี่ยนกฎข้อไหน → แก้ test ที่ตรงกันใน commit เดียวกัน; ถ้ากระทบหน้าบ้าน (path, header, cache) → แก้ `../FrontEnd-An22/docs/backend/README.md` / `deploy/` ด้วย (บอกผู้ใช้ก่อน)

## ทดสอบกับแอปจริง

build ปัจจุบันของหน้าบ้านใช้ mock ในเบราว์เซอร์ (`useMock: true`) — ใช้ได้ครบโดยไม่มี api:
`npm start` → `http://localhost:4000` → login บริษัท `DEMO` / `admin` / `admin` → เปลี่ยนเมนูจาก sidenav (full reload), reload บน URL ลึก,
console สะอาด, ไม่มี request `/api` ออกไป (ถ้ามีจะได้ 502 เพราะยังไม่มี api)

## Deploy

```sh
(cd ../FrontEnd-An22 && npm run build) && npm run docker:build
docker run -d -p 4000:4000 -e API_URL=http://<api>:8080 an22-web:<tag>
```

image: `node:24-alpine`, user `node`, `HEALTHCHECK` เรียก `/healthz`; compose รวม api + PostgreSQL ทำตอน C2

## Git

commit ทุกขั้นย่อย, ห้าม push โดยไม่ถาม
