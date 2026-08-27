/**
 * 検証用画像の収集と生成。
 *
 * `test_assets/` の実画像に加え、**情報量の乏しい画像を生成して必ず混ぜる**。
 * タグ本数の下限はそこでしか観測できないため（実写だけを測ると下限を見誤る）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makePNG(width, height, rgbFn) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const SPARSE_SPECS = [
  ['sparse_solid_gray.png', () => [128, 128, 128]],
  ['sparse_white_dot.png', (x, y) =>
    x > 380 && x < 420 && y > 280 && y < 320 ? [20, 20, 20] : [255, 255, 255]],
  ['sparse_gradient.png', (x, y, W, H) => {
    const v = Math.round(((x / W) * 0.5 + (y / H) * 0.5) * 255);
    return [v, v, v];
  }],
  ['sparse_blank_ui.png', (x, y) => {
    if (y < 48) return [240, 240, 242];
    if (x < 200 && y > 60) return [248, 248, 250];
    if (x > 230 && x < 760 && y > 90 && y < 130) return [235, 235, 238];
    if (x > 230 && x < 620 && y > 160 && y < 190) return [238, 238, 240];
    return [255, 255, 255];
  }],
];

/** 低情報量画像を生成する（決定的なので毎回同じ内容になる） */
export function generateSparseImages(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const W = 800;
  const H = 600;
  return SPARSE_SPECS.map(([name, fn]) => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, makePNG(W, H, (x, y) => fn(x, y, W, H)));
    return p;
  });
}

/**
 * 検証対象の画像一覧を返す。
 * test_assets/ は .gitignore されており各自の環境で中身が違うため、存在するものだけを拾う。
 */
export function collectImages(repoRoot, generatedDir, sampleCount = 5, imagesDir = null) {
  const imgs = [];

  // ディレクトリを明示されたときは、そこだけを対象にする（test_assets も sparse も混ぜない）。
  // ファイル名の `__<ラベル>` を group にするので、同じ素材の条件違いを1回の実行で並べられる。
  // 例: `02_neine__keep.jpg` / `02_neine__checker.jpg` -> group は keep / checker
  if (imagesDir) {
    for (const f of fs.readdirSync(imagesDir).filter((f) => /\.(png|jpe?g|webp|bmp)$/i.test(f)).sort()) {
      // ラベルは英字だけ。素材名に `_` が入っていても最後の `__` だけを拾う
      const m = /__([a-z]+)\.[a-z]+$/i.exec(f);
      imgs.push({ path: path.join(imagesDir, f), name: f, group: m ? m[1] : 'dir' });
    }
    return imgs;
  }

  const push = (p, group) => {
    if (fs.existsSync(p)) imgs.push({ path: p, name: path.basename(p), group });
  };

  const d3 = path.join(repoRoot, 'test_assets/3files');
  if (fs.existsSync(d3)) {
    for (const f of fs.readdirSync(d3).filter((f) => /\.(png|jpe?g|webp|bmp)$/i.test(f))) {
      push(path.join(d3, f), 'real-sample');
    }
  }

  const d100 = path.join(repoRoot, 'test_assets/100files');
  if (fs.existsSync(d100)) {
    const files = fs.readdirSync(d100).filter((f) => /\.(png|jpe?g|webp|bmp)$/i.test(f)).sort();
    // 全件は時間がかかりすぎるため等間隔サンプリング（決定的に選ぶので実行間で比較できる）
    const step = Math.max(1, Math.floor(files.length / Math.max(1, sampleCount)));
    for (let i = 0; i < files.length && imgs.filter((x) => x.group === 'real-varied').length < sampleCount; i += step) {
      push(path.join(d100, files[i]), 'real-varied');
    }
  }

  for (const p of generateSparseImages(generatedDir)) {
    imgs.push({ path: p, name: path.basename(p), group: 'sparse' });
  }

  return imgs;
}
