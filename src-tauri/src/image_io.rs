use std::path::Path;

use anyhow::{anyhow, Result};
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader, RgbImage};

use crate::llm::NOT_AN_IMAGE_ERROR;

/// 画像を1枚デコードする。画像を開くときは必ずこれを通すこと。
///
/// `image::open()` を直接使ってはいけない。あれは `ImageReader::open` が
/// `Format::Extension` を設定するだけで中身を見ないため、拡張子が `.png` で
/// 中身が JPEG のファイルを "Invalid PNG signature" で弾く。
/// 実測ではライブラリ 4,944 件のうち 13 件が拡張子と中身の食い違いだった。
///
/// `with_guessed_format()` は先頭16バイトの署名で format を差し替える。
/// 署名が一致しなければ差し替えは起きないので、本当に壊れたファイル
/// （PNG署名から 0x0D が欠けている等）はこれまで通り失敗する。
pub fn decode_image(path: &Path) -> Result<DynamicImage> {
    let reader = ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| anyhow!("{}: {} ({})", NOT_AN_IMAGE_ERROR, path.display(), e))?;

    log_extension_mismatch(path, reader.format());

    reader
        .decode()
        .map_err(|e| anyhow!("{}: {} ({})", NOT_AN_IMAGE_ERROR, path.display(), e))
}

/// 拡張子と実際の中身が食い違っていたらログに残す。
///
/// デコード自体は中身に従って成功するので失敗ではない。ただしファイル名を
/// 直すかどうかはユーザーの判断材料になるので、黙って通さず記録する。
fn log_extension_mismatch(path: &Path, actual: Option<ImageFormat>) {
    let Some(actual) = actual else {
        return;
    };
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return;
    };
    // .jpg と .jpeg のような別名は ImageFormat に落とせば同じものになる
    let Some(from_ext) = ImageFormat::from_extension(ext) else {
        return;
    };
    if from_ext == actual {
        return;
    }

    crate::logger::log_info(&format!(
        "[Image] Extension does not match content: '{}' (extension says {:?}, content is {:?})",
        path.display(),
        from_ext,
        actual
    ));
}

/// VLM へ送る前に、透過部分を何で埋めるか。
///
/// **JPEG はアルファを持てない。** 埋め方を決めないと、透明画素の下に入っている RGB が
/// そのまま出る。多くのエクスポータがそこに (0,0,0) を書くため、透過画像は真っ黒な背景の
/// 絵として VLM に渡り、「黒背景」に相当するタグが付く。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Background {
    /// 合成しない。アルファを捨てるだけ（**現行の挙動**）
    Keep,
    /// 白一色で塗る。
    /// **計測用に残してある。** 2026-08-27 の実測では黒背景タグを消す効果は市松と同じだが、
    /// `white_background`（画像について嘘をつくタグ）が 25% で出たため採用しなかった。
    /// 塗り方を再検討するときに比較対象として要る
    #[allow(dead_code)]
    White,
    /// 白と薄灰の市松模様で塗る。画像編集ソフトが透過を表すのに使う慣習に合わせる
    Checker,
}

/// 市松模様のマス目（px）。
///
/// **固定 px にしない。** 送信前に長辺を `ollama_max_image_edge` まで縮小するので、
/// 元画像が大きいほどマス目が細かくなり、縮小でモアレになる。長辺に対する比率で決めれば
/// 縮小後も同じ見た目になる。
fn checker_square_px(w: u32, h: u32) -> u32 {
    (w.max(h) / 14).max(8)
}

/// 市松の座標に対応する明度を返す。白 255 / 薄灰 204。
///
/// コントラストを付けすぎない。JPEG は高周波に弱く、強い市松はブロックノイズになる。
fn checker_value(x: u32, y: u32, square: u32) -> u8 {
    if ((x / square) + (y / square)) % 2 == 0 {
        255
    } else {
        204
    }
}

/// 透明な画素が「見える量」あるか。
///
/// **アルファチャンネルの有無では判定にならない。** 実測ではライブラリの
/// アルファ付き PNG 1,758件のうち 1,029件（59%）が実質不透明（透明1%未満）で、
/// それらは合成しても1画素も変わらない。
///
/// 全画素を持ち上げると 8192x8192 で数百MBになるため、`pixels()` で走査し、
/// 閾値に達した時点で打ち切る。
pub fn has_visible_transparency(img: &DynamicImage) -> bool {
    if !img.color().has_alpha() {
        return false;
    }
    let total = img.width() as u64 * img.height() as u64;
    if total == 0 {
        return false;
    }
    let threshold = (total / 100).max(1); // 1%
    let mut clear = 0u64;
    for (_, _, px) in img.pixels() {
        if px.0[3] < 240 {
            clear += 1;
            if clear >= threshold {
                return true;
            }
        }
    }
    false
}

/// ファイルを開いて `has_visible_transparency` を見る。開けなければ false。
///
/// タグを保存する側が「この画像は合成されたか」を知るために使う。デコードが1回増えるが、
/// VLM の推論（実測 1.8秒）に対して実測 11ms/件なので無視できる。
pub fn file_has_visible_transparency(path: &Path) -> bool {
    decode_image(path).map(|img| has_visible_transparency(&img)).unwrap_or(false)
}

/// アルファを合成して RGB にする。
///
/// 合成は straight alpha の src-over（`out = src * a + bg * (1 - a)`）。
/// アルファを持たない画像はそのまま RGB に落とす。
pub fn composite_over(img: &DynamicImage, bg: Background) -> RgbImage {
    if bg == Background::Keep || !has_visible_transparency(img) {
        return img.to_rgb8();
    }

    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let square = checker_square_px(w, h);
    let mut out = RgbImage::new(w, h);

    for (x, y, px) in rgba.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        let bg_rgb: [u8; 3] = match bg {
            Background::White => [255, 255, 255],
            Background::Checker => {
                let v = checker_value(x, y, square);
                [v, v, v]
            }
            Background::Keep => unreachable!("Keep は上で返している"),
        };
        let a = a as u32;
        let mix = |src: u8, dst: u8| -> u8 {
            (((src as u32) * a + (dst as u32) * (255 - a) + 127) / 255) as u8
        };
        out.put_pixel(
            x,
            y,
            image::Rgb([mix(r, bg_rgb[0]), mix(g, bg_rgb[1]), mix(b, bg_rgb[2])]),
        );
    }
    out
}

/// VLM へ送る JPEG バイト列を作る。縮小と RGB 化の順序をここに集約する。
///
/// `Background::Keep` は**現行の挙動そのまま**（縮小してからアルファを捨てる）。
/// 合成する場合は**合成してから縮小する**。透過のまま縮小すると、境界の半透明画素が
/// 周囲の RGB と混ざってから合成されることになり、縁に元の RGB（多くは黒）が残る。
pub fn encode_jpeg_for_vlm(
    img: &DynamicImage,
    max_edge: u32,
    bg: Background,
) -> Result<Vec<u8>> {
    let rgb = if bg == Background::Keep {
        let resized = downscale(img, max_edge);
        resized.to_rgb8()
    } else {
        let composited = DynamicImage::ImageRgb8(composite_over(img, bg));
        downscale(&composited, max_edge).to_rgb8()
    };

    let mut buffer = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut buffer, ImageFormat::Jpeg)?;
    Ok(buffer.into_inner())
}

/// 長辺を `max_edge` まで縮小する。`max_edge` が 0 なら縮小しない。
pub fn downscale(img: &DynamicImage, max_edge: u32) -> DynamicImage {
    if max_edge == 0 {
        return img.clone();
    }
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= max_edge {
        return img.clone();
    }
    img.resize(max_edge, max_edge, image::imageops::FilterType::Triangle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;
    use std::io::Cursor;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("loma_image_io_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn encode(format: ImageFormat) -> Vec<u8> {
        let img = RgbImage::from_pixel(8, 8, image::Rgb([10, 20, 30]));
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, format).unwrap();
        buf.into_inner()
    }

    /// 拡張子が嘘でも中身で開けること。実物では中身JPEGの `.png` が7件、
    /// 中身PNGの `.jpg` が3件あり、拡張子で判定すると全滅する。
    #[test]
    fn decodes_by_content_when_the_extension_lies() {
        let dir = temp_dir();

        let jpeg_named_png = dir.join("jpeg_content.png");
        std::fs::write(&jpeg_named_png, encode(ImageFormat::Jpeg)).unwrap();
        assert!(
            decode_image(&jpeg_named_png).is_ok(),
            "中身JPEGの .png が開けていない"
        );

        let png_named_jpg = dir.join("png_content.jpg");
        std::fs::write(&png_named_jpg, encode(ImageFormat::Png)).unwrap();
        assert!(
            decode_image(&png_named_jpg).is_ok(),
            "中身PNGの .jpg が開けていない"
        );

        // 拡張子と中身が合っているものは当然開ける
        let honest = dir.join("honest.png");
        std::fs::write(&honest, encode(ImageFormat::Png)).unwrap();
        assert!(decode_image(&honest).is_ok());
    }

    /// 完全透過の画素は、合成しないと下に入っている RGB がそのまま出る。
    /// 実物の透過 PNG はそこに (0,0,0) が入っていることが多く、それが「黒背景」の正体。
    #[test]
    fn keep_leaves_the_rgb_under_a_transparent_pixel() {
        let mut rgba = image::RgbaImage::new(4, 4);
        for px in rgba.pixels_mut() {
            *px = image::Rgba([0, 0, 0, 0]);
        }
        let img = DynamicImage::ImageRgba8(rgba);

        let kept = composite_over(&img, Background::Keep);
        assert_eq!(kept.get_pixel(0, 0).0, [0, 0, 0], "Keep は現行どおり黒のまま");

        let white = composite_over(&img, Background::White);
        assert_eq!(white.get_pixel(0, 0).0, [255, 255, 255], "White で白く塗られていない");
    }

    /// 半透明の画素は下地と混ざること。境界のアンチエイリアスがここに乗る。
    #[test]
    fn a_half_transparent_pixel_is_mixed_with_the_background() {
        let mut rgba = image::RgbaImage::new(1, 1);
        rgba.put_pixel(0, 0, image::Rgba([0, 0, 0, 128]));
        let out = composite_over(&DynamicImage::ImageRgba8(rgba), Background::White);
        // 0 * (128/255) + 255 * (127/255) = 127
        assert_eq!(out.get_pixel(0, 0).0, [127, 127, 127]);
    }

    /// 市松は白と薄灰の2値だけで、両方が必ず現れること。
    /// 片方しか出ないと「単色で塗った」のと同じになり、明暗どちらの素材も救えなくなる。
    #[test]
    fn checker_uses_both_shades() {
        let mut rgba = image::RgbaImage::new(64, 64);
        for px in rgba.pixels_mut() {
            *px = image::Rgba([0, 0, 0, 0]);
        }
        let out = composite_over(&DynamicImage::ImageRgba8(rgba), Background::Checker);
        let mut shades: Vec<u8> = out.pixels().map(|p| p.0[0]).collect();
        shades.sort_unstable();
        shades.dedup();
        assert_eq!(shades, vec![204, 255], "市松の2値が揃っていない");
    }

    /// マス目は長辺に対する比率で決まること。縮小してもマス目の見た目が変わらない前提。
    #[test]
    fn checker_squares_scale_with_the_image() {
        assert_eq!(checker_square_px(1400, 700), 100);
        assert_eq!(checker_square_px(140, 70), 10);
        // 極端に小さい画像でも 8px は確保する（1px 市松は縮小で必ず潰れる）
        assert_eq!(checker_square_px(16, 16), 8);
    }

    /// アルファを持たない画像は、どの Background でも素通しであること。
    #[test]
    fn an_opaque_image_is_untouched_by_any_background() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 4, image::Rgb([10, 20, 30])));
        for bg in [Background::Keep, Background::White, Background::Checker] {
            assert_eq!(composite_over(&img, bg).get_pixel(0, 0).0, [10, 20, 30], "{bg:?}");
        }
    }

    /// **一度きりの移行。** 合成の仕様を変える前に解析された透過画像を、
    /// タグを消して `pending` に落とし、サムネイルを作り直す。
    ///
    /// **GUI は作らない。** 修正後は透過画像が黒く解析されること自体が起きないので、
    /// この操作が再び要る場面が無い（新しく追加された透過画像は最初から正しく解析される）。
    /// 恒久的なボタンを置くと、後から見て何のための操作か分からなくなる。
    ///
    /// 解析そのものは走らせない。実行後にアプリの
    /// 「フォルダ管理 → Process Pending Only」を押せば、既存の経路がそのまま処理する。
    ///
    /// ```bash
    /// # 何件が対象になるかを見るだけ（既定）
    /// LOMA_MIGRATE_DB=<loma.db> cargo test --release migrate_transparent_media -- --ignored --nocapture
    /// # 実際に書き換える
    /// LOMA_MIGRATE_DB=<loma.db> LOMA_MIGRATE_APPLY=1     ///   LOMA_THUMB_DIR=<thumbnails> cargo test --release migrate_transparent_media -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn migrate_transparent_media() {
        use sqlx::sqlite::SqlitePoolOptions;

        let db = std::env::var("LOMA_MIGRATE_DB").expect("LOMA_MIGRATE_DB に loma.db のパスを指定してください");
        let apply = std::env::var("LOMA_MIGRATE_APPLY").is_ok();
        let thumb_dir = std::env::var("LOMA_THUMB_DIR").ok().map(std::path::PathBuf::from);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&format!("sqlite:{}", db.replace('\\', "/")))
            .await
            .expect("DB を開けません");

        // 除外は `excluded_paths` テーブルで持つ（`media` に列は無い）
        let excluded: Vec<String> = sqlx::query_scalar("SELECT path FROM excluded_paths")
            .fetch_all(&pool)
            .await
            .unwrap_or_default();
        let excluded: std::collections::HashSet<String> = excluded.into_iter().collect();

        let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, file_path FROM media")
            .fetch_all(&pool)
            .await
            .expect("media を読めません");

        let mut targets: Vec<i64> = Vec::new();
        let mut rebuilt = 0usize;
        let mut missing = 0usize;
        // 拡張子ごとの内訳。**PNG ヘッダのカラータイプで数えると取りこぼす**
        // （パレット PNG の tRNS、拡張子と中身が食い違うファイル）ので、
        // デコードして数えた結果がどこから来ているかを出す
        let mut by_ext: std::collections::BTreeMap<String, usize> = Default::default();
        for (id, path_str) in &rows {
            if excluded.contains(path_str) {
                continue;
            }
            let path = std::path::Path::new(path_str);
            if !path.exists() {
                missing += 1;
                continue;
            }
            let Ok(img) = decode_image(path) else { continue };
            if !has_visible_transparency(&img) {
                continue;
            }
            drop(img);
            targets.push(*id);
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("(なし)")
                .to_lowercase();
            *by_ext.entry(ext).or_default() += 1;
            if apply {
                if let Some(dir) = &thumb_dir {
                    if crate::batch::regenerate_thumbnail(path, dir).is_ok() {
                        rebuilt += 1;
                    }
                }
            }
        }

        println!(
            "メディア {} 件 / 見つからない {missing} 件 / 透過を持つ {} 件",
            rows.len(),
            targets.len()
        );

        for (ext, n) in &by_ext {
            println!("  .{ext}  {n} 件");
        }

        if !apply {
            println!("
**下見だけで終了した。** 実際に書き換えるには LOMA_MIGRATE_APPLY=1 を付ける。");
            return;
        }

        for chunk in targets.chunks(500) {
            let ph = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            // **タグを消してから pending に落とす。** 消さずに再解析すると
            // 通常の解析経路（`INSERT OR IGNORE`）で古いタグの上に足されるだけになる
            let sql = format!("DELETE FROM media_tags WHERE media_id IN ({ph})");
            let mut q = sqlx::query(&sql);
            for id in chunk {
                q = q.bind(id);
            }
            q.execute(&pool).await.expect("タグの削除に失敗");

            let sql = format!(
                "UPDATE media SET analysis_status = 'pending', analysis_error = NULL WHERE id IN ({ph})"
            );
            let mut q = sqlx::query(&sql);
            for id in chunk {
                q = q.bind(id);
            }
            q.execute(&pool).await.expect("pending への更新に失敗");
        }

        println!(
            "
{} 件のタグを消して pending にした / サムネイル {rebuilt} 件を作り直した。
             アプリの「フォルダ管理 → Process Pending Only」で解析が走る。",
            targets.len()
        );
    }

    /// 実際に透明な画素を持つ画像が何件あるかを数える（計測用）。
    ///
    /// **アルファチャンネルの有無では足りない。** チャンネルはあるが全面不透明な
    /// ファイルが多く、それらは合成しても何も変わらないので再解析の対象外になる。
    ///
    /// ```bash
    /// LOMA_ALPHA_SOURCES=<パス一覧> cargo test --release count_visible_transparency -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn count_visible_transparency() {
        let list_path = std::env::var("LOMA_ALPHA_SOURCES")
            .expect("LOMA_ALPHA_SOURCES にパス一覧のファイルを指定してください");
        let list = std::fs::read_to_string(&list_path).unwrap();

        let (mut total, mut decoded, mut with_alpha, mut visible) = (0, 0, 0, 0);
        let mut buckets = [0usize; 5]; // <1% / 1-10% / 10-30% / 30-60% / 60%+
        for line in list.lines().map(str::trim).filter(|l| !l.is_empty()) {
            total += 1;
            let Ok(img) = decode_image(std::path::Path::new(line)) else { continue };
            decoded += 1;
            if !img.color().has_alpha() {
                continue;
            }
            with_alpha += 1;
            let rgba = img.to_rgba8();
            let n = (rgba.width() * rgba.height()) as f64;
            let clear = rgba.pixels().filter(|p| p.0[3] < 240).count() as f64 / n;
            if clear >= 0.01 {
                visible += 1;
            }
            let b = if clear < 0.01 {
                0
            } else if clear < 0.10 {
                1
            } else if clear < 0.30 {
                2
            } else if clear < 0.60 {
                3
            } else {
                4
            };
            buckets[b] += 1;
        }
        println!("一覧 {total} 件 / デコード成功 {decoded} / アルファあり {with_alpha} / 実際に透明 {visible}");
        let names = ["<1%（実質不透明）", "1-10%", "10-30%", "30-60%", "60%以上"];
        for (i, n) in buckets.iter().enumerate() {
            println!("  透明率 {:16} {n} 件", names[i]);
        }
    }

    /// 透過画像を Background 3種で書き出す（計測用。通常のテスト実行では走らない）。
    ///
    /// **本番と同じ `encode_jpeg_for_vlm` を通す。** ここで別実装を書くと、
    /// 「ツールでは効いたが本番では違うものを送っていた」という失敗をする。
    ///
    /// ```bash
    /// LOMA_ALPHA_SOURCES=<パス一覧のファイル> LOMA_ALPHA_OUT=<出力先>     ///   cargo test --release export_transparent_variants -- --ignored --nocapture
    /// ```
    ///
    /// `LOMA_ALPHA_COUNT`（既定 8）/ `LOMA_MAX_EDGE`（既定 1536）で調整する。
    #[test]
    #[ignore]
    fn export_transparent_variants() {
        let list_path = std::env::var("LOMA_ALPHA_SOURCES")
            .expect("LOMA_ALPHA_SOURCES にパス一覧のファイルを指定してください");
        let out_dir = std::path::PathBuf::from(
            std::env::var("LOMA_ALPHA_OUT").expect("LOMA_ALPHA_OUT に出力先を指定してください"),
        );
        let want: usize = std::env::var("LOMA_ALPHA_COUNT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8);
        let max_edge: u32 = std::env::var("LOMA_MAX_EDGE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1536);

        std::fs::create_dir_all(&out_dir).unwrap();
        let list = std::fs::read_to_string(&list_path).unwrap();

        let mut exported = 0usize;
        let mut scanned = 0usize;
        for line in list.lines().map(str::trim).filter(|l| !l.is_empty()) {
            if exported >= want {
                break;
            }
            let path = std::path::Path::new(line);
            let Ok(img) = decode_image(path) else { continue };
            scanned += 1;
            if !img.color().has_alpha() {
                continue;
            }

            // アルファチャンネルを持っていても全面不透明なファイルが多い。
            // 実際に透明な画素がどれだけあるかで選ぶ。
            let rgba = img.to_rgba8();
            let total = (rgba.width() * rgba.height()) as f64;
            let clear = rgba.pixels().filter(|p| p.0[3] < 16).count() as f64;
            let semi = rgba
                .pixels()
                .filter(|p| p.0[3] >= 16 && p.0[3] < 240)
                .count() as f64;
            let clear_ratio = clear / total;
            if clear_ratio < 0.10 {
                continue;
            }

            // 日本語のファイル名は全部 `_` になるので、連続する `_` は畳む。
            // 先頭の連番だけでも識別できるが、レポートで元ファイルを見分けたい
            let mut stem = String::new();
            for c in path.file_stem().and_then(|s| s.to_str()).unwrap_or("image").chars() {
                if c.is_ascii_alphanumeric() {
                    stem.push(c.to_ascii_lowercase());
                } else if !stem.ends_with('_') {
                    stem.push('_');
                }
            }
            let stem = format!("{:02}_{}", exported, stem.trim_matches('_').chars().take(20).collect::<String>());

            for (bg, label) in [
                (Background::Keep, "keep"),
                (Background::White, "white"),
                (Background::Checker, "checker"),
            ] {
                let bytes = encode_jpeg_for_vlm(&img, max_edge, bg).unwrap();
                let out = out_dir.join(format!("{stem}__{label}.jpg"));
                std::fs::write(&out, bytes).unwrap();
            }

            println!(
                "exported {stem}  {}x{}  透明 {:.1}%  半透明 {:.1}%  <- {}",
                img.width(),
                img.height(),
                clear_ratio * 100.0,
                semi / total * 100.0,
                path.display()
            );
            exported += 1;
        }

        // 対照。**透過でない画像を混ぜないと、プロンプトに1行足したせいで
        // 通常の解析まで壊れたことに気付けない。** LIGHT は極小であること自体が
        // 設計意図なので、1行の追加が全体に効く可能性を常に疑う。
        let mut opaque = 0usize;
        if let Ok(list_path) = std::env::var("LOMA_OPAQUE_SOURCES") {
            let want_opaque: usize = std::env::var("LOMA_OPAQUE_COUNT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(4);
            let list = std::fs::read_to_string(&list_path).unwrap_or_default();
            for line in list.lines().map(str::trim).filter(|l| !l.is_empty()) {
                if opaque >= want_opaque {
                    break;
                }
                let path = std::path::Path::new(line);
                let Ok(img) = decode_image(path) else { continue };
                if img.color().has_alpha() {
                    let rgba = img.to_rgba8();
                    if rgba.pixels().any(|p| p.0[3] < 240) {
                        continue; // 透過を含むものは対照にならない
                    }
                }
                let bytes = encode_jpeg_for_vlm(&img, max_edge, Background::Keep).unwrap();
                let out = out_dir.join(format!("c{opaque:02}__opaque.jpg"));
                std::fs::write(&out, bytes).unwrap();
                println!("control c{opaque:02}  {}x{}  <- {}", img.width(), img.height(), path.display());
                opaque += 1;
            }
        }

        println!(
            "
走査 {scanned} 件 / 透過 {exported} 件 x 3 + 対照 {opaque} 件 -> {}",
            out_dir.display()
        );
        assert!(exported > 0, "透明画素を持つ画像が1枚も見つからなかった");
    }

    /// アルファチャンネルがあっても全面不透明なら合成対象にしない。
    /// 実測でライブラリの 1,758件中 1,029件がこれに当たる
    #[test]
    fn a_fully_opaque_alpha_image_is_not_treated_as_transparent() {
        let mut rgba = image::RgbaImage::new(20, 20);
        for px in rgba.pixels_mut() {
            *px = image::Rgba([10, 20, 30, 255]);
        }
        let img = DynamicImage::ImageRgba8(rgba);
        assert!(!has_visible_transparency(&img));
        // 市松を指定しても塗られない
        assert_eq!(composite_over(&img, Background::Checker).get_pixel(0, 0).0, [10, 20, 30]);
    }

    /// 1% に満たない透明は合成対象にしない。境界を跨ぐと対象になること。
    #[test]
    fn transparency_below_one_percent_is_ignored() {
        let make = |clear: u32| {
            let mut rgba = image::RgbaImage::new(100, 10); // 1000 画素 -> 1% = 10 画素
            for px in rgba.pixels_mut() {
                *px = image::Rgba([10, 20, 30, 255]);
            }
            for i in 0..clear {
                rgba.put_pixel(i, 0, image::Rgba([0, 0, 0, 0]));
            }
            DynamicImage::ImageRgba8(rgba)
        };
        assert!(!has_visible_transparency(&make(9)), "9/1000 は対象外のはず");
        assert!(has_visible_transparency(&make(10)), "10/1000 は対象のはず");
    }

    /// 本当に壊れているファイルは、中身で判定しても失敗のままであること。
    /// 実物は PNG署名 89504e47 0d0a1a0a から 0d が欠けていた（CRLF→LF 変換の巻き添え）。
    #[test]
    fn a_corrupted_signature_still_fails() {
        let dir = temp_dir();
        let mut bytes = encode(ImageFormat::Png);
        assert_eq!(bytes[4], 0x0d, "PNG署名の前提が変わっている");
        bytes.remove(4);

        let broken = dir.join("broken_signature.png");
        std::fs::write(&broken, bytes).unwrap();

        let err = decode_image(&broken).unwrap_err().to_string();
        assert!(
            err.contains(NOT_AN_IMAGE_ERROR),
            "壊れたファイルが恒久失敗として分類されない: {err}"
        );
    }
}
