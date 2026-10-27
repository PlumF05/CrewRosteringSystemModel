#!/usr/bin/env bash
# WebView2 离线安装器 12 路并行分段下载（单线程被 CDN 限速 ~30KB/s）
set -e
URL="https://catalog.s.download.windowsupdate.com/d/msdownload/update/software/updt/2026/10/microsoftedgestandaloneinstallerx64_81d2e46792d27147d30ba1e4718d177b7af48b4e.exe"
TOTAL=219113848
PARTS=12
STEP=$(( (TOTAL + PARTS - 1) / PARTS ))
UA="Mozilla/5.0"
mkdir -p .wv2parts
pids=()
for i in $(seq 0 $((PARTS-1))); do
  START=$(( i * STEP ))
  END=$(( START + STEP - 1 ))
  [ $END -ge $TOTAL ] && END=$(( TOTAL - 1 ))
  [ $START -gt $END ] && continue
  ( for retry in 1 2 3 4 5; do
      curl -s -A "$UA" --max-time 560 -r "$START-$END" -o ".wv2parts/part_$i" "$URL" && break
      sleep 2
    done ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
# 校验分段大小并拼接
cat .wv2parts/part_* > /dev/null 2>&1 || true
: > src-tauri/MicrosoftEdgeWebView2RuntimeInstallerX64.exe
for i in $(seq 0 $((PARTS-1))); do
  START=$(( i * STEP )); END=$(( START + STEP - 1 )); [ $END -ge $TOTAL ] && END=$(( TOTAL - 1 )); [ $START -gt $END ] && continue
  EXPECT=$(( END - START + 1 ))
  ACTUAL=$(stat -c %s ".wv2parts/part_$i" 2>/dev/null || echo 0)
  if [ "$ACTUAL" != "$EXPECT" ]; then echo "SEG_FAIL part_$i expect=$EXPECT actual=$ACTUAL"; exit 1; fi
  cat ".wv2parts/part_$i" >> src-tauri/MicrosoftEdgeWebView2RuntimeInstallerX64.exe
done
FINAL=$(stat -c %s src-tauri/MicrosoftEdgeWebView2RuntimeInstallerX64.exe)
if [ "$FINAL" != "$TOTAL" ]; then echo "SIZE_MISMATCH $FINAL != $TOTAL"; exit 1; fi
rm -rf .wv2parts
echo "DOWNLOAD_OK $FINAL bytes"
