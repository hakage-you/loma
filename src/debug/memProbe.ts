// 【一時】OOM 調査用の計測。**原因が分かったら消すこと。**
//
// 「起動後に無操作で放置するだけで WebView が Out of Memory で落ちる」の調査用。
// 実測で数時間かかるため、落ちた瞬間に devtools のコンソールごと消えてしまう。
// Rust 側の `append_mem_probe` でファイルへ追記し、落ちた後から増え方を読めるようにする。
//
// 記録先: `%APPDATA%\com.hakageyou.loma\loma-memprobe.log`
//
// 読み方:
//   - `heap_used_mb` が単調に増える            → JS 側のリーク（配列・クロージャ・リスナ）
//   - `dom_nodes` が単調に増える               → DOM が積み上がっている
//   - どちらも横ばいなのに落ちる               → JS ヒープ外（画像デコード・GPU）が犯人。
//                                                tools/oom-probe の CSV 側で判断する
//   - `loma_log_bytes` が増える                 → 1.5秒ポーリングの読み込み量が増え続けている

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** 30秒ごと。数時間放置して 360 行程度に収まる粒度 */
const PROBE_INTERVAL_MS = 30_000;

/** `performance.memory` は Chromium 独自で、標準の型定義には無い */
type ChromePerformance = Performance & {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
};

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

export function useMemProbe(counts: { media: number; tags: number }) {
  // 件数は毎レンダー変わり得るが、interval を張り直したくないので ref で渡す
  const countsRef = useRef(counts);
  countsRef.current = counts;

  useEffect(() => {
    // モックモードにはバックエンドが無い。e2e のログを汚さない
    if (import.meta.env.MODE === 'mock') return;

    const startedAt = Date.now();

    const sample = () => {
      const memory = (performance as ChromePerformance).memory;
      const line = [
        `uptime_min=${Math.round((Date.now() - startedAt) / 60000)}`,
        `heap_used_mb=${memory ? mb(memory.usedJSHeapSize) : 'n/a'}`,
        `heap_total_mb=${memory ? mb(memory.totalJSHeapSize) : 'n/a'}`,
        `heap_limit_mb=${memory ? mb(memory.jsHeapSizeLimit) : 'n/a'}`,
        `dom_nodes=${document.getElementsByTagName('*').length}`,
        `img_nodes=${document.getElementsByTagName('img').length}`,
        `media_items=${countsRef.current.media}`,
        `tags=${countsRef.current.tags}`,
      ].join(' ');

      // 失敗しても放置してもらう計測なので握り潰す
      invoke('append_mem_probe', { line }).catch(() => {});
    };

    sample();
    const id = setInterval(sample, PROBE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}
