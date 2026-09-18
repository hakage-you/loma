//! 実データに対する検証。
//!
//! **合成データでは出ない偏りがある。** 実ライブラリは media 4,941件 /
//! tags 10,123件 / tag_suggestion_pairs 30,146件 で、タグは長い裾を持ち、
//! 使用数が同点のタグが大量にある。決定性や件数の問題はここでしか出ない。
//!
//! 使うのは**コピー**。元のDBは読むだけで、コピーはテストの終わりに消す。
//!
//! DB が無い環境（CI・他人のマシン）では黙って通る。
//! 場所は環境変数 `LOMA_TEST_DB` で指定できる。既定は
//! `%APPDATA%\com.hakageyou.loma\loma.db`。
//!
//! **注意: ここで得られる数字は「あるユーザーのライブラリ」のもので、
//! 標準でも理想でもない。** 件数そのものを期待値に固定しないこと。

use std::path::{Path, PathBuf};

/// コピーしたDBの置き場。Drop で消すので、テストが失敗しても残らない。
pub struct DbCopy {
    dir: PathBuf,
    pub path: PathBuf,
}

impl Drop for DbCopy {
    fn drop(&mut self) {
        // **Windows は開いているファイルを消せない。**
        // `SqlitePool` が閉じ切るまで少し待つ。1回で諦めると 52MB のコピーが
        // テンポラリに残り続ける（実際に 74個・3.7GB 溜めた）
        for attempt in 0..10 {
            if std::fs::remove_dir_all(&self.dir).is_ok() || !self.dir.exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20 * (attempt + 1)));
        }
        eprintln!(
            "[real-db] コピーを消せなかった: {} （次の実行で掃除する）",
            self.dir.display()
        );
    }
}

impl DbCopy {
    /// `sqlx` に渡す接続文字列
    pub fn url(&self) -> String {
        format!("sqlite:{}", self.path.to_string_lossy().replace('\\', "/"))
    }
}

/// 実DBの場所。無ければ `None`
pub fn source_db_path() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("LOMA_TEST_DB") {
        let path = PathBuf::from(explicit);
        return path.exists().then_some(path);
    }
    let appdata = std::env::var("APPDATA").ok()?;
    let path = Path::new(&appdata).join("com.hakageyou.loma").join("loma.db");
    path.exists().then_some(path)
}

/// テンポラリに取り残されたコピーを掃除する。
///
/// **panic したテストでは `Drop` が最後まで走らないことがある。**
/// 1個 52MB あるので、溜まると効く。30分以上前のものだけを消す
/// （同時に走っている別のテストのものを消さないため）。
fn sweep_stale_copies() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("loma-real-db-") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age.as_secs() > 30 * 60);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// 実DBをテンポラリへ写す。
///
/// **WAL と SHM も一緒に写す。** アプリが動いている最中はコミット済みの内容が
/// WAL 側にしか無いことがあり、本体だけ写すと古い状態を読むことになる。
pub fn copy_real_db(label: &str) -> Option<DbCopy> {
    sweep_stale_copies();
    let source = source_db_path()?;
    let dir = std::env::temp_dir().join(format!(
        "loma-real-db-{}-{}-{}",
        label,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("loma.db");
    std::fs::copy(&source, &path).ok()?;
    for suffix in ["-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{}", source.to_string_lossy(), suffix));
        if from.exists() {
            let to = PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix));
            let _ = std::fs::copy(&from, &to);
        }
    }
    Some(DbCopy { dir, path })
}

/// 実DBが無いときに出す1行。**黙って通すと「通った」と読めてしまう**
pub fn skip_note(test: &str) {
    eprintln!(
        "[skip] {test}: 実DBが見つからないので飛ばした \
         (LOMA_TEST_DB で場所を指定できる)"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::TagItem;
    use crate::suggestion_store::Method;
    use sqlx::SqlitePool;
    use std::collections::HashMap;

    async fn open(copy: &DbCopy) -> SqlitePool {
        SqlitePool::connect(&copy.url())
            .await
            .expect("コピーしたDBを開けない")
    }

    /// **必ず閉じてから返る。** 開いたままだと Windows はコピーを消せず、
    /// 52MB がテンポラリに残る
    async fn close(pool: SqlitePool) {
        pool.close().await;
    }

    async fn tag_map(pool: &SqlitePool) -> HashMap<i64, TagItem> {
        let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, String, i64)>(
            "SELECT t.id, t.name, t.name_ja, t.is_category, t.tag_kind,
                    (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = t.id)
             FROM tags t",
        )
        .fetch_all(pool)
        .await
        .expect("タグを読めない");

        rows.into_iter()
            .map(|(id, name, name_ja, is_category, kind, count)| {
                (
                    id,
                    TagItem {
                        id,
                        name,
                        name_ja,
                        is_category: is_category != 0,
                        count,
                        kind,
                    },
                )
            })
            .collect()
    }

    /// 実データの規模を出す。**期待値は置かない。**
    /// 数字は「あるユーザーのライブラリ」のもので、標準でも理想でもない。
    #[tokio::test]
    async fn real_db_shape_is_printed() {
        let Some(copy) = copy_real_db("shape") else {
            skip_note("real_db_shape_is_printed");
            return;
        };
        let pool = open(&copy).await;

        for table in [
            "media",
            "tags",
            "media_tags",
            "tag_suggestion_pairs",
            "tag_embeddings",
            "excluded_paths",
        ] {
            let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap_or(-1);
            eprintln!("[real-db] {table}: {n}");
        }
        close(pool).await;
    }

    /// **関連タグの提案が、同じDB・同じバイナリで毎回同じ結果になること。**
    ///
    /// 以前は `connected_components` が HashMap を走査していたため、BFS の
    /// 開始点が実行ごとに変わり、使用数が同点のタグで代表が入れ替わっていた
    /// （実測 742件中14件）。合成データでは同点がほとんど作れないので、
    /// この検証は実データでしか成立しない。
    #[tokio::test]
    async fn related_suggestions_are_stable_across_runs() {
        let Some(copy) = copy_real_db("stable") else {
            skip_note("related_suggestions_are_stable_across_runs");
            return;
        };
        let pool = open(&copy).await;
        let tags = tag_map(&pool).await;

        let pairs = crate::suggestion_store::load_pairs(&pool, Method::Related)
            .await
            .expect("ペアを読めない");
        if pairs.is_empty() {
            eprintln!("[skip] 関連タグのペアが保存されていないので比較できない");
            close(pool).await;
            return;
        }

        let first = crate::commands::build_suggestions_from_store(&pool, Method::Related, &tags)
            .await
            .expect("1回目");
        let second = crate::commands::build_suggestions_from_store(&pool, Method::Related, &tags)
            .await
            .expect("2回目");

        eprintln!("[real-db] 関連タグの提案: {}件", first.len());
        // **判定の前に閉じる。** 落ちたときもコピーを消せるようにする
        close(pool).await;
        assert_eq!(first.len(), second.len(), "提案の件数が実行ごとに変わる");

        let targets = |v: &[crate::commands::MergeSuggestion]| -> Vec<(String, Vec<String>)> {
            v.iter()
                .map(|s| {
                    (
                        s.target_tag.name.clone(),
                        s.source_tags.iter().map(|t| t.name.clone()).collect(),
                    )
                })
                .collect()
        };
        let a = targets(&first);
        let b = targets(&second);
        let differing: Vec<_> = a
            .iter()
            .zip(b.iter())
            .filter(|(x, y)| x != y)
            .take(5)
            .collect();
        assert!(
            differing.is_empty(),
            "代表またはメンバーが実行ごとに入れ替わる: {:?}",
            differing
        );
    }

    /// ①（表記ゆれ）も同じく安定していること。
    /// こちらは `group_by_target` が明示的に並べ替えているので元から安定のはずで、
    /// **その前提が崩れていないこと**を実データで押さえる。
    #[tokio::test]
    async fn rule_suggestions_are_stable_across_runs() {
        let Some(copy) = copy_real_db("stable-rules") else {
            skip_note("rule_suggestions_are_stable_across_runs");
            return;
        };
        let pool = open(&copy).await;
        let tags = tag_map(&pool).await;

        let pairs = crate::suggestion_store::load_pairs(&pool, Method::Rules)
            .await
            .expect("ペアを読めない");
        if pairs.is_empty() {
            eprintln!("[skip] 表記ゆれのペアが保存されていない");
            close(pool).await;
            return;
        }

        let first = crate::commands::build_suggestions_from_store(&pool, Method::Rules, &tags)
            .await
            .expect("1回目");
        let second = crate::commands::build_suggestions_from_store(&pool, Method::Rules, &tags)
            .await
            .expect("2回目");

        eprintln!("[real-db] 表記ゆれの提案: {}件", first.len());
        close(pool).await;
        let names = |v: &[crate::commands::MergeSuggestion]| -> Vec<String> {
            v.iter().map(|s| s.target_tag.name.clone()).collect()
        };
        assert_eq!(names(&first), names(&second), "代表が実行ごとに入れ替わる");
    }

    /// コピーを触っても元のDBが変わらないこと。
    /// **この検証自体が、以降のテストが安全であることの根拠になる。**
    #[tokio::test]
    async fn the_original_database_is_never_touched() {
        let Some(source) = source_db_path() else {
            skip_note("the_original_database_is_never_touched");
            return;
        };
        let before = std::fs::metadata(&source).and_then(|m| m.modified()).ok();
        let size_before = std::fs::metadata(&source).map(|m| m.len()).ok();

        {
            let copy = copy_real_db("write").expect("コピーできない");
            let pool = open(&copy).await;
            sqlx::query("DELETE FROM media_tags")
                .execute(&pool)
                .await
                .expect("コピー側は書き換えられるはず");
            let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_tags")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(left, 0, "コピーへの書き込みが効いていない");
            pool.close().await;
        }

        let after = std::fs::metadata(&source).and_then(|m| m.modified()).ok();
        let size_after = std::fs::metadata(&source).map(|m| m.len()).ok();
        assert_eq!(before, after, "元のDBの更新時刻が変わった");
        assert_eq!(size_before, size_after, "元のDBのサイズが変わった");
    }
}
