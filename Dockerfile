# image = server + ไฟล์ build ของหน้าบ้าน 1 เวอร์ชัน — สร้างด้วย `npm run docker:build` (คัดลอก dist มาไว้ ./public ก่อน)
FROM node:24-alpine
ENV NODE_ENV=production PORT=4000 DIST_DIR=/app/public
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.ts"]
