/**
 * Ollama 呼び出しの共通部分。`run.mjs`（本番再現）と `ladder.mjs`（候補条件の実験）で共有する。
 *
 * **`options` の扱いに注意。** 本番の同義語検出（`commands.rs`）は
 * `{model, prompt, stream}` しか送っておらず `options` が無い。つまり num_ctx も
 * temperature も Ollama 既定のまま。大きなプロンプトは**黙って切り捨てられる**ので、
 * 本番を再現するときは `options` を渡さず、候補条件を試すときだけ明示的に渡すこと。
 */

import http from 'node:http';
import https from 'node:https';

/**
 * `options` を渡さなければ本番と同じ（＝Ollama既定）になる。
 *
 * **`fetch` を使ってはいけない。** Node の fetch（undici）は
 * `headersTimeout` の既定が **300秒**で、`stream:false` の Ollama は
 * 生成が終わるまでヘッダを返さない。つまり**5分を超える生成は必ず失敗扱いになる**。
 * しかも出るのは `TypeError: fetch failed` で、**モデルが壊れたのか遅いだけなのかを
 * 区別できない**（実際に qwen3:14b / 300件が 300.7 秒で "request_error" になった）。
 * タイムアウトの無い `node:http` を直に使う。
 */
export function callGenerate(url, model, prompt, { formatJson = false, options = null, think = null, timeoutMs = 0 } = {}) {
  const body = { model, prompt, stream: false };
  // format:"json" は thinking 対応モデルの応答を {} に縮退させる既知の欠陥がある。
  // 本番も送っていない。条件として切り替えられるようにだけしておく。
  if (formatJson) body.format = 'json';
  if (options && Object.keys(options).length) body.options = options;
  // thinking の停止。**生成時間を支配する要因なので独立した軸として持つ。**
  // 実測: qwen3:14b は n=100 を 98秒（eval 4,142）で終えたのに、n=300 は
  // 76分走った末に Ollama ごと落ちた。thinking の生成長がクラッシュ窓を広げている疑い。
  // 本番も未指定（＝モデル既定）なので、`null` のときは何も送らない。
  if (think !== null) body.think = think;

  const payload = Buffer.from(JSON.stringify(body));
  const u = new URL(`${url}/api/generate`);
  const mod = u.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama API Error (${res.statusCode}): ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`応答が JSON ではない: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    // 既定のソケットタイムアウトは切る。長時間の生成そのものは「失敗」ではない
    req.setTimeout(0);
    req.on('error', reject);

    // **生成長を止める手段が Ollama 側に無いので、時間の上限はここで持つ。**
    // num_ctx は文脈シフトで素通りし（eval が num_ctx の10倍まで伸びた実測あり）、
    // num_predict は thinking を壊す。よって呼び出し側の打ち切りが唯一の歯止め。
    // **打ち切りは「モデルの失敗」ではなく「この規模では終わらない」という測定値**なので、
    // 専用のエラーにして呼び出し側が区別できるようにする。
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        const e = new Error(`generation_timeout: ${timeoutMs}ms を超えても応答しない`);
        e.code = 'GENERATION_TIMEOUT';
        req.destroy(e);
      }, timeoutMs);
      req.on('close', () => clearTimeout(timer));
    }
    req.end(payload);
  });
}

/**
 * **モデルの失敗ではなく環境の障害**かを判定する。
 *
 * Ollama の `llama-server` は最新版で落ちることがある（既知 issue）。
 * これが起きると全モデル・全サイズが一様に失敗し、**「モデルが処理できなかった」
 * ように見える**。実際 2026-08-04 に、ラダー4段すべてが 2 秒前後で
 * `0xc0000005`（アクセス違反）で落ち、切り分け表では「パースできない 4回」に
 * 分類された。長時間の連続実行では起きうるので、計測結果と混ぜない。
 *
 * 復旧は Ollama の再起動。**この分類が出たらその回は破棄して測り直すこと。**
 */
export function isEnvironmentFailure(message) {
  const m = String(message ?? '');
  return /llama-server process has terminated|0xc0000005|ECONNREFUSED|socket hang up|EPIPE/i.test(m);
}

/** 次のモデルの計測を汚さないよう VRAM から降ろす */
export async function unloadModel(url, model) {
  try {
    await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch {
    // 降ろせなくても計測は続行できる。VRAM の値が混ざる可能性があるだけ
  }
}

/** いま常駐しているモデルの VRAM。`others` が空でないと VRAM も速度も影響を受ける */
export async function residentSize(url, model) {
  const ps = await fetch(`${url}/api/ps`).then((r) => r.json()).catch(() => null);
  const list = ps?.models ?? [];
  const hit = list.find((m) => m.name === model || m.model === model);
  return {
    sizeVram: hit?.size_vram ?? null,
    sizeTotal: hit?.size ?? null,
    others: list.filter((m) => m !== hit).map((m) => m.name),
  };
}

/**
 * `/api/show` からモデルの素性を取る。
 * `context_length` は**どの num_ctx まで指定できるか**の上限判定に使う
 * （これを超える num_ctx を要求しても伸びない）。
 */
export async function modelProfile(url, model) {
  const r = await fetch(`${url}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  }).then((x) => x.json()).catch(() => null);
  const caps = Array.isArray(r?.capabilities) ? r.capabilities : [];
  // context_length はモデルによって置き場所が違う
  const info = r?.model_info ?? {};
  const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
  return {
    capabilities: caps,
    thinking: caps.includes('thinking'),
    parameterSize: r?.details?.parameter_size ?? null,
    quantization: r?.details?.quantization_level ?? null,
    contextLength: ctxKey ? info[ctxKey] : (r?.details?.context_length ?? null),
  };
}

export async function listModels(url) {
  const r = await fetch(`${url}/api/tags`).then((x) => x.json()).catch(() => null);
  return r?.models ?? null;
}

export const ns2ms = (n) => (n == null ? null : n / 1e6);
export const gib = (b) => (b == null ? '-' : `${(b / 1024 ** 3).toFixed(1)}GB`);
