use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

pub struct DbState {
    pub pool: Pool<Sqlite>,
}

pub async fn init_db(app_handle: &AppHandle) -> Result<Pool<Sqlite>, Box<dyn std::error::Error>> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"));

    if !app_dir.exists() {
        fs::create_dir_all(&app_dir)?;
    }

    let db_path = app_dir.join("loma.db");

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);

    // 同時に開ける接続の数。
    //
    // **5 のときに実際に足りなくなったことがある。** 解析の進捗イベントごとに
    // get_media + タグ一覧 + 親フォルダ + スキャンフォルダ + 設定 の5本が同時に飛び、
    // 上限ちょうどを使い切って get_media が
    // "pool timed out while waiting for an open connection" で失敗していた。
    // データベースが遅かったのではなく、上限が同時に投げる本数と同じだったのが原因。
    //
    // SQLite は WAL モードなので読み取りは同時に何本でも走れる。書き込みは
    // どのみち1本ずつになるが、待たされても busy_timeout の中で順番が回る。
    // 画面からの取得（最大5本）＋ 解析のバックグラウンド処理が重なっても
    // 足りるだけの余裕を取る。
    const MAX_CONNECTIONS: u32 = 16;

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(options)
        .await?;

    // PRAGMA 設定
    sqlx::query("PRAGMA journal_mode = WAL;")
        .execute(&pool)
        .await?;
    sqlx::query("PRAGMA synchronous = NORMAL;")
        .execute(&pool)
        .await?;
    sqlx::query("PRAGMA foreign_keys = ON;")
        .execute(&pool)
        .await?;

    // マイグレーション / テーブル作成
    create_tables(&pool).await?;

    // シードデータ挿入
    seed_initial_data(&pool).await?;

    Ok(pool)
}

/// スキーマを現在の形に揃える。**既存DBに対しても安全に呼べる**
/// （すべて `IF NOT EXISTS` / 失敗を無視する `ALTER`）。
/// 実データで検証するテストからも呼ぶ。
pub async fn create_tables(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scan_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL UNIQUE,
            parent_folder TEXT NOT NULL,
            thumbnail_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_hash TEXT,
            file_modified_at INTEGER NOT NULL,
            analysis_status TEXT NOT NULL DEFAULT 'pending',
            analysis_error TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            name_ja TEXT,
            is_category INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS media_tags (
            media_id INTEGER,
            tag_id INTEGER,
            PRIMARY KEY (media_id, tag_id),
            FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_tags_tag_id ON media_tags(tag_id);

        -- 概念スペクトラム検索用のタグ埋め込みベクトル。
        -- model を主キーに含めることで複数モデルのベクトルが共存でき、
        -- モデルを切り替えて戻しても再生成が不要になる。
        -- vector は f32 リトルエンディアンの連続列（追加クレート不要）。
        -- PRAGMA foreign_keys = ON のため、タグ削除でベクトルも自動的に消える。
        CREATE TABLE IF NOT EXISTS tag_embeddings (
            tag_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            dim INTEGER NOT NULL,
            vector BLOB NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            PRIMARY KEY (tag_id, model),
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tag_embeddings_model ON tag_embeddings(model);

        -- タグ整理の提案。**提案そのものではなく判定の記録を持つ。**
        --
        -- 提案を保存すると、タグが1つ統合されただけで他の提案が意味を失い、
        -- 全部作り直しになる。生のペアで持てば、
        -- 消えたタグは外部キーで自然に落ち、残りはそのまま使える。
        -- 提案への組み立ては読み出し時に行う。
        --
        -- method: 'rules'（規則）/ 'hypernym'（包括関係）/ 'related'（関連タグ）。
        -- 方式ごとに独立した枠を持つ（1つを回しても他が消えない）。
        CREATE TABLE IF NOT EXISTS tag_suggestion_runs (
            method TEXT PRIMARY KEY,
            started_at INTEGER NOT NULL,
            -- NULL は「途中」。②はここを見て続きから走る
            finished_at INTEGER,
            -- 途中結果を引き継いでよいかの判定に使う。
            -- モデルやパラメータが変わったものを混ぜると結果が解釈不能になる
            model TEXT,
            params TEXT
        );

        -- ②の段1で決めた包括語。**段2の結果はこの集合に対する相対値**なので、
        -- 続きから走らせるにはこれを一緒に持つ必要がある。
        CREATE TABLE IF NOT EXISTS tag_suggestion_categories (
            method TEXT NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY (method, tag_id),
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        -- 生の判定結果。dismissed は却下の記録。
        -- **却下で行を消さない。** 消すと再実行で同じ提案が戻る。
        -- 後から新しいメンバーが加わった場合は、そのメンバーだけが提案に出る。
        CREATE TABLE IF NOT EXISTS tag_suggestion_pairs (
            method TEXT NOT NULL,
            target_id INTEGER NOT NULL,
            member_id INTEGER NOT NULL,
            -- ①: 一致した規則（JSON配列）。②③では NULL
            rules TEXT,
            -- ③: コサイン類似度。①②では NULL
            score REAL,
            dismissed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            PRIMARY KEY (method, target_id, member_id),
            FOREIGN KEY (target_id) REFERENCES tags(id) ON DELETE CASCADE,
            FOREIGN KEY (member_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tag_suggestion_pairs_method
            ON tag_suggestion_pairs(method, dismissed);

        -- 判定済みの対象。**「見たが該当なし」と「まだ見ていない」を区別するために要る。**
        -- 未判定 = 母集団 - これ。中断で残ったぶんと、後から増えたタグが同じ形で出る。
        CREATE TABLE IF NOT EXISTS tag_suggestion_judged (
            method TEXT NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY (method, tag_id),
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    // name_ja カラムのマイグレーション（既存DBへの安全追加）
    let _ = sqlx::query("ALTER TABLE tags ADD COLUMN name_ja TEXT;")
        .execute(pool)
        .await;

    // tag_kind カラムのマイグレーション（既存DBへの安全追加）
    // 既存タグは複合タグを禁止するプロンプトで生成されたものなので 'basic' として扱う
    let _ = sqlx::query("ALTER TABLE tags ADD COLUMN tag_kind TEXT NOT NULL DEFAULT 'basic';")
        .execute(pool)
        .await;

    // 失敗の種別コード（`llm::error_kind`）。失敗一覧のグループ化に使う。
    // 既存の失敗レコードは NULL のままで、次に解析を試みたときに埋まる
    let _ = sqlx::query("ALTER TABLE media ADD COLUMN analysis_error_kind TEXT;")
        .execute(pool)
        .await;

    // 同じ種別で連続して失敗した回数。未知のエラーを「要確認」に降格させる判定に使う
    let _ = sqlx::query(
        "ALTER TABLE media ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;",
    )
    .execute(pool)
    .await;

    // 解析対象から外したファイル。
    //
    // `media` の列にしない理由: 「ライブラリから削除」で media 行ごと消えると
    // 除外情報も一緒に消え、次のスキャンで同じファイルが再登録されてしまう。
    // media から独立してパスを覚えておく必要がある。
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS excluded_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            reason TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// マイグレーションの ALTER TABLE は `let _ =` で失敗を捨てている
    /// （既存DBでは「列が既にある」で必ず失敗するため）。
    /// 綴りを間違えても気付けないので、結果として列が在ることを直接確かめる。
    #[tokio::test]
    async fn the_schema_has_the_failure_triage_columns_and_table() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        create_tables(&pool).await.unwrap();

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('media')")
            .fetch_all(&pool)
            .await
            .unwrap();
        for expected in ["analysis_error_kind", "consecutive_failures"] {
            assert!(
                columns.iter().any(|c| c == expected),
                "media に {expected} が無い: {columns:?}"
            );
        }

        // 除外は media から独立して残す必要がある（削除しても覚えておくため）
        sqlx::query("INSERT INTO excluded_paths (path, reason) VALUES ('D:/a.png', 'broken')")
            .execute(&pool)
            .await
            .expect("excluded_paths が作られていない");

        let paths = crate::batch::load_excluded_paths(&pool).await;
        assert!(paths.contains("D:/a.png"));

        // 同じパスを二重に登録しない
        let dup = sqlx::query("INSERT OR IGNORE INTO excluded_paths (path) VALUES ('D:/a.png')")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(dup.rows_affected(), 0, "同じパスが重複して入る");
    }

    /// 連続失敗の数え方。種別が変われば1に戻ること。
    #[tokio::test]
    async fn consecutive_failures_reset_when_the_kind_changes() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        create_tables(&pool).await.unwrap();

        sqlx::query(
            "INSERT INTO media (id, file_path, parent_folder, thumbnail_path, file_size, file_modified_at)
             VALUES (1, 'D:/a.png', 'x', '', 1, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let fail = |kind: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query(
                    "UPDATE media SET analysis_status = 'failed', analysis_error = 'e',
                     consecutive_failures = CASE WHEN analysis_error_kind = ?1 THEN consecutive_failures + 1 ELSE 1 END,
                     analysis_error_kind = ?1
                     WHERE id = 1",
                )
                .bind(kind)
                .execute(&pool)
                .await
                .unwrap();
                sqlx::query_scalar::<_, i64>("SELECT consecutive_failures FROM media WHERE id = 1")
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };

        assert_eq!(fail("unknown").await, 1);
        assert_eq!(fail("unknown").await, 2, "同じ種別で増えていない");
        assert_eq!(fail("server_unavailable").await, 1, "種別が変わっても1に戻っていない");
    }
}

async fn seed_initial_data(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    // デフォルト設定
    let default_settings = [
        ("ollama_url", "http://localhost:11434"),
        ("ollama_model", "qwen3-vl:30b"),
        // **`RECOMMENDED_TEXT_MODELS` の標準と揃えること。**
        // 実測で選んだ推奨と初期値が食い違っていると、新規インストールは
        // 測っていない構成で動く（2026-08-12 まで `qwen3:14b` のままだった）。
        ("ollama_text_model", "gemma4:12b"),
        ("llm_provider", "ollama"),
        ("gemini_model", "gemini-2.0-flash"),
        ("gemini_text_model", "gemini-3.5-flash-lite"),
        ("openai_base_url", "https://api.openai.com/v1"),
        ("openai_model", "gpt-4o-mini"),
        ("openai_text_model", "gpt-4o-mini"),
        ("claude_model", "claude-3-5-sonnet-20241022"),
        ("claude_text_model", "claude-3-5-haiku-20241022"),
        ("ext_llm_max_batch_items", "50"),
        ("ext_llm_retry_enabled", "true"),
        ("ext_llm_retry_max_attempts", "3"),
        ("ext_llm_retry_delay_sec", "2"),
        ("ui_language", "ja"),
        ("ffmpeg_notice_enabled", "true"),
        ("tag_granularity", "atomic"),
        ("force_detailed_prompt", "false"),
        // 0 = プロンプト種別・タグ粒度から自動決定（thinking対応モデルの推論トークンを考慮）
        ("ollama_num_ctx", "0"),
        // 送信前に画像の長辺をこのピクセル数まで縮小する（0 で無効）
        ("ollama_max_image_edge", "1536"),
        // LLMリクエストの詳細診断ログ（開発・障害調査用）
        ("llm_debug_logging", "false"),
        // --- 概念スペクトラム検索 ---
        // タグのベクトル化に使う埋め込みモデル。未導入なら設定画面から取得できる。
        ("spectrum_embedding_model", "bge-m3"),
        // 重心に descriptive タグを含めるか。既定OFF。
        // descriptive は複合語で df が小さく IDF 重みが大きいため、
        // 「意味が似ている」ではなく「同じ設定で解析された」でクラスタリングされる恐れがある。
        ("spectrum_include_descriptive", "false"),
        // 全重心の平均を引くか（anisotropy 対策）。既定ON。
        // これが無いとタグ本数の多いメディアが誰とでも似ている「ハブ」になる。
        ("spectrum_centering", "true"),
    ];

    for (key, val) in default_settings {
        sqlx::query("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2);")
            .bind(key)
            .bind(val)
            .execute(pool)
            .await?;
    }

    // 固定カテゴリ初期データ (英語名, 日本語表示名)
    let categories = [
        ("screenshot", "スクリーンショット"),
        ("document", "書類・文書"),
        ("landscape", "風景・自然"),
        ("food", "料理・食べ物"),
        ("character", "キャラクター"),
        ("animal", "動物・ペット"),
        ("person", "人物・顔写真"),
        ("item_product", "商品・雑貨"),
        ("art_illustration", "イラスト・アート"),
        ("text_heavy", "文字主体"),
        ("tech", "IT・技術"),
        ("other", "その他"),
    ];

    for (cat_en, cat_ja) in categories {
        sqlx::query(
            "INSERT INTO tags (name, name_ja, is_category) VALUES (?1, ?2, 1)
             ON CONFLICT(name) DO UPDATE SET name_ja = ?2, is_category = 1;",
        )
        .bind(cat_en)
        .bind(cat_ja)
        .execute(pool)
        .await?;
    }

    Ok(())
}

#[allow(dead_code)]
pub async fn auto_vacuum_if_needed(pool: &Pool<Sqlite>) {
    // 必要に応じてVACUUMを呼び出す
    let _ = sqlx::query("PRAGMA incremental_vacuum;")
        .execute(pool)
        .await;
}
