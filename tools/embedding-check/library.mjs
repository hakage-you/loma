/**
 * 計測スクリプトが共有する「重心ライブラリ」の構築。
 *
 * `src-tauri/src/embedding.rs` の `build_library` と同じ手順を JS で再現する。
 * IDF 重み（w = ln(N/df)）・basic タグ下限・centering まで含めて一致させてある。
 * **片方を変えたら両方直すこと。** 一致していない計測は嘘をつく。
 *
 * ここを共有にしているのは、帯幅の検討（band-width.mjs）と語彙重複の検討
 * （lexical-overlap.mjs）で同じ重心が必要になったため。個別に写すと必ずズレる。
 */

import { DatabaseSync } from 'node:sqlite';

/** embedding.rs の定数と揃えること */
export const MIN_BASIC_TAGS = 3;
export const ZONE_SIZE = 4;
export const ZONE_BAND_RATIO = 0.1;
export const ZONE_BAND_MAX = ZONE_SIZE * 2;

/** SplitMix64。embedding.rs の実装と同じ数列を出す */
export class SplitMix64 {
  static MASK = (1n << 64n) - 1n;
  constructor(seed) {
    this.state = BigInt(seed);
  }
  nextU64() {
    const M = SplitMix64.MASK;
    this.state = (this.state + 0x9e3779b97f4a7c15n) & M;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return z ^ (z >> 31n);
  }
  below(n) {
    return n === 0 ? 0 : Number(this.nextU64() % BigInt(n));
  }
}

function normalize(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return false;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return true;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 重心ライブラリを組み立てる。
 *
 * 返す `tagIds` は重心に寄与したタグ（カテゴリ + basic、`includeDescriptive` なら descriptive も）。
 * `basicIds` は語彙の重なりを見るための basic タグのみ（カテゴリは全メディアが持つので数えない）。
 */
export function buildLibrary({ dbPath, model = 'bge-m3', centering = true, includeDescriptive = false }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const vectors = new Map();
  let dim = 0;
  for (const row of db.prepare('SELECT tag_id, vector FROM tag_embeddings WHERE model = ?').all(model)) {
    const buf = Buffer.from(row.vector);
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
    if (!normalize(v)) continue;
    vectors.set(row.tag_id, v);
    dim = v.length;
  }
  if (!dim) throw new Error(`モデル ${model} のベクトルが無い（先に run.mjs を通すこと）`);

  const tagName = new Map();
  for (const r of db.prepare('SELECT id, name, name_ja FROM tags').all()) {
    tagName.set(r.id, r.name_ja?.trim() || r.name);
  }
  const filePath = new Map();
  for (const r of db.prepare("SELECT id, file_path FROM media WHERE analysis_status = 'completed'").all()) {
    filePath.set(r.id, r.file_path);
  }

  const perMedia = new Map();
  const rows = db
    .prepare(
      `SELECT mt.media_id, mt.tag_id, t.is_category, t.tag_kind
       FROM media_tags mt JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
       WHERE m.analysis_status = 'completed'`,
    )
    .all();
  for (const r of rows) {
    let e = perMedia.get(r.media_id);
    if (!e) perMedia.set(r.media_id, (e = { tagIds: [], basicIds: [], basic: 0 }));
    const isCategory = r.is_category !== 0;
    if (!isCategory && r.tag_kind === 'basic') {
      e.basic++;
      e.basicIds.push(r.tag_id);
    }
    if (isCategory || r.tag_kind === 'basic' || (includeDescriptive && r.tag_kind === 'descriptive')) {
      e.tagIds.push(r.tag_id);
    }
  }

  const eligible = [...perMedia.entries()]
    .filter(([, p]) => p.basic >= MIN_BASIC_TAGS)
    .sort((a, b) => a[0] - b[0]);
  const n = eligible.length;

  const df = new Map();
  for (const [, p] of eligible) {
    for (const id of new Set(p.tagIds)) df.set(id, (df.get(id) ?? 0) + 1);
  }
  const idf = (tagId) => Math.max(0, Math.log(n / Math.max(1, df.get(tagId) ?? 1)));

  /** タグ id 集合から重み付き重心を作る。centering 済みの空間に合わせる */
  const mean = new Float64Array(dim);
  function centroidOf(tagIds, { applyCentering = true } = {}) {
    const acc = new Float32Array(dim);
    let used = 0;
    let weightSum = 0;
    for (const tagId of tagIds) {
      const v = vectors.get(tagId);
      if (!v) continue;
      used++;
      const w = idf(tagId);
      weightSum += w;
      for (let i = 0; i < dim; i++) acc[i] += w * v[i];
    }
    if (!used || weightSum <= Number.EPSILON) return null;
    if (!normalize(acc)) return null;
    if (applyCentering && centering) {
      for (let i = 0; i < dim; i++) acc[i] -= mean[i];
      if (!normalize(acc)) return null;
    }
    return acc;
  }

  // centering 前の重心を全件作り、その平均を控えてから引く（embedding.rs と同じ順序）
  const ids = [];
  const centroids = [];
  const tagIds = [];
  const basicIds = [];
  for (const [mediaId, p] of eligible) {
    const c = centroidOf(p.tagIds, { applyCentering: false });
    if (!c) continue;
    ids.push(mediaId);
    centroids.push(c);
    tagIds.push(p.tagIds);
    basicIds.push(new Set(p.basicIds));
  }
  if (centering && centroids.length) {
    for (const c of centroids) for (let i = 0; i < dim; i++) mean[i] += c[i];
    for (let i = 0; i < dim; i++) mean[i] /= centroids.length;
    for (let k = centroids.length - 1; k >= 0; k--) {
      const c = centroids[k];
      for (let i = 0; i < dim; i++) c[i] -= mean[i];
      if (!normalize(c)) {
        // 中心と一致した重心は方向が定義できない。embedding.rs も落とす
        ids.splice(k, 1);
        centroids.splice(k, 1);
        tagIds.splice(k, 1);
        basicIds.splice(k, 1);
      }
    }
  }

  return {
    db,
    dim,
    model,
    centering,
    includeDescriptive,
    /** 候補メディアの id（重心の添字と対応） */
    ids,
    centroids,
    tagIds,
    basicIds,
    completedCount: perMedia.size,
    eligibleCount: n,
    N: centroids.length,
    idf,
    /** 任意のタグ集合から、centering 済み空間の重心を作る */
    centroidOf,
    tagVector: (tagId) => vectors.get(tagId),
    tagName: (tagId) => tagName.get(tagId) ?? `#${tagId}`,
    fileName: (mediaId) => (filePath.get(mediaId) ?? '').split(/[\\/]/).pop(),
  };
}

/** 基準メディアの添字を決定的に選ぶ */
export function sampleBases(N, count, seed) {
  const rng = new SplitMix64(seed);
  const picked = [];
  const seen = new Set();
  while (picked.length < Math.min(count, N)) {
    const i = rng.below(N);
    if (!seen.has(i)) {
      seen.add(i);
      picked.push(i);
    }
  }
  return picked;
}
