// スキャン進捗のモックドライバ (`vite --mode mock` 時のみ有効)。
//
// モックモードはバックエンドが存在しないため batch_progress イベントが一切発火せず、
// 進捗パネル（解析速度・残り時間の表示）を画面で確認できなかった。
// URL パラメータで進捗イベント列を再現し、UIを実際に描画できるようにする。
//
//   ?debugScan=full          登録フェーズ → 解析フェーズ（current が 1 に巻き戻る）
//   ?debugScan=mid           スキャン実行中にアプリを起動した状況（起動時 progress が無い）
//   ?debugScanIntervalMs=800 1件あたりの疑似所要時間（既定 1500ms）
//
// 注意: 残り時間は実時間から算出されるため、表示される値はここで指定した
// 疑似所要時間に基づく。数値そのものの正しさではなく、描画・状態遷移の確認用。

export type MockProgressPayload = {
  total: number;
  current: number;
  current_file: string;
  status: string;
  error_count: number;
  is_paused?: boolean;
};

type Emit = (event: string, payload: MockProgressPayload) => void;

const TOTAL_ITEMS = 838;

let running = false;

/**
 * 一時停止中か。**進捗を止めるだけで購読は切らない。**
 * 実バックエンドも pause 中は is_paused を立てた進捗を送り続けるので、
 * 画面は「止まっているが生きている」を出せる。
 */
let paused = false;

export function setMockScanPaused(next: boolean): void {
  paused = next;
}

export function isMockScanRunning(): boolean {
  return running;
}

function fileName(i: number): string {
  return `IMG_2025092${i % 10}_1${(100000 + i * 137) % 90000}.jpg`;
}

export function startScanSimulatorIfRequested(emit: Emit): void {
  if (typeof window === 'undefined') return;

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('debugScan');
  if (mode !== 'full' && mode !== 'mid') return;

  const intervalMs = Number(params.get('debugScanIntervalMs')) || 1500;
  running = true;

  const emitProgress = (p: MockProgressPayload) => emit('batch_progress', p);

  if (mode === 'mid') {
    // 解析の途中から進捗イベントが届き始める（起動時点では progress が null）
    let current = 300;
    const timer = setInterval(() => {
      emitProgress({
        total: TOTAL_ITEMS,
        current,
        current_file: fileName(current),
        status: 'Analyzing with Ollama (qwen3-vl:8b-instruct)',
        error_count: 0,
        is_paused: paused,
      });
      if (paused) return;
      current += 1;
      if (current > TOTAL_ITEMS) clearInterval(timer);
    }, intervalMs);
    return;
  }

  // full: 登録フェーズ（高速）→ 解析フェーズ（低速・current が 1 に巻き戻る）
  let registered = 0;
  const regTimer = setInterval(() => {
    registered += 40;
    emitProgress({
      total: TOTAL_ITEMS,
      current: Math.min(registered, TOTAL_ITEMS),
      current_file: fileName(registered),
      status: 'Registering media & Thumbnails (Multi-threaded)',
      error_count: 0,
    });
    if (registered >= TOTAL_ITEMS) {
      clearInterval(regTimer);
      let analyzed = 1;
      const anaTimer = setInterval(() => {
        emitProgress({
          total: TOTAL_ITEMS,
          current: analyzed,
          current_file: fileName(analyzed),
          status: 'Analyzing with Ollama (qwen3-vl:8b-instruct)',
          error_count: 0,
          is_paused: paused,
        });
        if (paused) return;
        analyzed += 1;
        if (analyzed > TOTAL_ITEMS) clearInterval(anaTimer);
      }, intervalMs);
    }
  }, 60);
}
