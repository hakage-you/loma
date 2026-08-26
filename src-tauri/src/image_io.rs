use std::path::Path;

use anyhow::{anyhow, Result};
use image::{DynamicImage, ImageFormat, ImageReader};

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
