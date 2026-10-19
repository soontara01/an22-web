#!/bin/sh
# สร้าง image an22-web พร้อมไฟล์ build ของหน้าบ้าน
#   FRONTEND_DIR  repo หน้าบ้าน (default ../FrontEnd-An22) — build ไว้ก่อนแล้ว: cd ../FrontEnd-An22 && npm run build
#   IMAGE         ชื่อ image (default an22-web)
# tag = <git short sha ของหน้าบ้าน>[-dirty] และ latest
set -eu
cd "$(dirname "$0")/.."

FRONTEND_DIR=${FRONTEND_DIR:-../FrontEnd-An22}
IMAGE=${IMAGE:-an22-web}
DIST="$FRONTEND_DIR/dist/frontend-an22/browser"

if [ ! -f "$DIST/index.html" ]; then
  echo "ไม่พบ $DIST/index.html — build หน้าบ้านก่อน: (cd $FRONTEND_DIR && npm run build)" >&2
  exit 1
fi

TAG=$(git -C "$FRONTEND_DIR" rev-parse --short HEAD 2>/dev/null || echo local)
if [ -n "$(git -C "$FRONTEND_DIR" status --porcelain 2>/dev/null)" ]; then TAG="$TAG-dirty"; fi

rm -rf public
cp -R "$DIST" public

docker build -t "$IMAGE:$TAG" -t "$IMAGE:latest" .
echo "built $IMAGE:$TAG (+ latest) — run: docker run --rm -p 4000:4000 -e API_URL=http://<api>:8080 $IMAGE:$TAG"
