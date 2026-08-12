//! タグ整理の提案を **判定の記録として** 保存する。
//!
//! ## なぜ提案そのものを保存しないのか
//!
//! 提案を保存すると、タグを1つ統合しただけで他の提案が意味を失う。
//! `dish ⊃ bowl, plate, pot` の提案があるとき `bowl` を `container` に統合すると、
//! 保存済みの提案は存在しないタグを指す。作り直せば済む話に見えるが、
//! ②（包括関係）は段1からの作り直しになり、1回の統合で払える代償ではない。
//!
//! 生のペア `(target, member)` で持てば、消えたタグは外部キーの
//! `ON DELETE CASCADE` で自然に落ち、残りはそのまま使える。
//! 提案への組み立ては読み出し時に行う。
//!
//! ## 未判定という概念
//!
//! ②の段2は「該当なし」のとき何も出力しない。**そのため結果だけを見ても
//! 「見たが該当しなかった」と「まだ見ていない」が区別できない。**
//! 判定した対象を別に記録することで、
//!
//! - 中断で残ったぶん
//! - 実行後に増えたタグ
//!
//! が同じ形（母集団 − 判定済み）で出る。これが中断再開の土台でもある。
//!
//! ## 却下
//!
//! 却下でペアを削除しない。削除すると再実行で同じ提案が戻る。
//! `dismissed` を立てるだけにすると、後から新しいメンバーが加わったときに
//! **そのメンバーだけが提案に出る**。

use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite};
use std::collections::{HashMap, HashSet};

/// 提案の生成方式。**方式ごとに独立した枠を持つ。**
/// 1つを回し直しても他の結果が消えない（別操作として提供するため）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// ① 規則ベース。LLM 不要・即時
    Rules,
    /// ② 包括関係。LLM を使う・長い
    Hypernym,
    /// ③ 関連タグ。埋め込みのみ・即時
    Related,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rules => "rules",
            Self::Hypernym => "hypernym",
            Self::Related => "related",
        }
    }
}

/// 実行の仕方。
///
/// **既定は増分。** タグが数十件増えるたびに全件を測り直す理由がない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    /// 前回の判定を引き継ぎ、**未判定のぶんだけ**処理する。
    /// 中断からの再開も、完了後に増えたタグの処理も、これ1つで足りる
    /// （どちらも「母集団 − 判定済み」という同じ形になる）。
    ///
    /// 段1は走らせない。**新しく増えたタグの中に良い包括語があっても拾わない。**
    /// それが要るときは `Full`。
    Incremental,
    /// 最初からやり直す。段1も引き直す。**却下の記録だけは残す。**
    Full,
}

/// 1件の判定。方式によって埋まる欄が違う。
#[derive(Debug, Clone)]
pub struct PairRecord {
    pub target_id: i64,
    pub member_id: i64,
    /// ①: 一致した規則の識別子
    pub rules: Vec<String>,
    /// ③: コサイン類似度
    pub score: Option<f32>,
}

/// 中断された実行の続き。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeState {
    /// 段1で決まった包括語のタグID。**段2の結果はこれに対する相対値**
    pub categories: Vec<i64>,
    /// 判定済みの対象タグID
    pub judged: Vec<i64>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 実行を開始する。**引き継げる結果があればそれを返す。**
///
/// `signature` にはモデル名や結果を左右するパラメータを入れる。
/// 前回と違えば引き継がない —— **条件の違うものを混ぜた結果は解釈できない**。
/// これは「llama-server の障害を計測結果と混ぜない」のと同じ理由。
///
/// **完了済みでも引き継ぐ**（`Incremental` のとき）。中断からの再開と、
/// 完了後に増えたタグの処理は、どちらも「未判定を処理する」という同じ操作。
pub async fn begin_run(
    pool: &Pool<Sqlite>,
    method: Method,
    signature: &str,
    mode: RunMode,
) -> Result<Option<ResumeState>, String> {
    let m = method.as_str();
    let prev: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT finished_at, params FROM tag_suggestion_runs WHERE method = ?1")
            .bind(m)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

    let can_resume = mode == RunMode::Incremental
        && match &prev {
            Some((_, params)) => params.as_deref() == Some(signature),
            None => false,
        };

    if can_resume {
        let categories: Vec<i64> = sqlx::query_scalar(
            "SELECT tag_id FROM tag_suggestion_categories WHERE method = ?1",
        )
        .bind(m)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        let judged: Vec<i64> =
            sqlx::query_scalar("SELECT tag_id FROM tag_suggestion_judged WHERE method = ?1")
                .bind(m)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
        crate::logger::log_info(&format!(
            "[suggestion-store] {} の結果を引き継ぎます: カテゴリ{}件 判定済み{}件",
            m,
            categories.len(),
            judged.len()
        ));
        // 再開したので未完了に戻す。**途中で落ちても次回また続きから走れる**
        sqlx::query(
            "UPDATE tag_suggestion_runs SET started_at = ?2, finished_at = NULL WHERE method = ?1",
        )
        .bind(m)
        .bind(now())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(Some(ResumeState { categories, judged }));
    }

    if let Some((_, params)) = &prev {
        if mode == RunMode::Incremental && params.as_deref() != Some(signature) {
            crate::logger::log_info(&format!(
                "[suggestion-store] {} の結果は条件が違うため捨てます（前回: {:?}）",
                m, params
            ));
        }
    }

    // やり直し。**却下の記録は残す**（ユーザーの判断であって計算結果ではない）
    let dismissed: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT target_id, member_id FROM tag_suggestion_pairs WHERE method = ?1 AND dismissed = 1",
    )
    .bind(m)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for table in [
        "tag_suggestion_pairs",
        "tag_suggestion_judged",
        "tag_suggestion_categories",
    ] {
        sqlx::query(&format!("DELETE FROM {} WHERE method = ?1", table))
            .bind(m)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    for (t, mem) in &dismissed {
        sqlx::query(
            "INSERT INTO tag_suggestion_pairs (method, target_id, member_id, dismissed)
             VALUES (?1, ?2, ?3, 1)",
        )
        .bind(m)
        .bind(t)
        .bind(mem)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    sqlx::query(
        "INSERT INTO tag_suggestion_runs (method, started_at, finished_at, params)
         VALUES (?1, ?2, NULL, ?3)
         ON CONFLICT(method) DO UPDATE SET started_at = ?2, finished_at = NULL, params = ?3",
    )
    .bind(m)
    .bind(now())
    .bind(signature)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(None)
}

/// 段1の結果を保存する。段2の途中結果と一緒に引き継ぐために要る。
pub async fn save_categories(
    pool: &Pool<Sqlite>,
    method: Method,
    tag_ids: &[i64],
) -> Result<(), String> {
    let m = method.as_str();
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM tag_suggestion_categories WHERE method = ?1")
        .bind(m)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    for id in tag_ids {
        sqlx::query(
            "INSERT OR IGNORE INTO tag_suggestion_categories (method, tag_id) VALUES (?1, ?2)",
        )
        .bind(m)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 1チャンク分の結果を確定する。**判定済みの記録と同じトランザクションで書く。**
///
/// 別々に書くと、間で落ちたときに「判定済みなのに結果が無い」あるいは
/// 「結果はあるのに未判定」が生まれ、再開が壊れる。
pub async fn commit_chunk(
    pool: &Pool<Sqlite>,
    method: Method,
    pairs: &[PairRecord],
    judged_tag_ids: &[i64],
) -> Result<(), String> {
    let m = method.as_str();
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for p in pairs {
        // 却下済みのペアを復活させない。ユーザーの判断を計算結果で上書きしない
        let rules_json = if p.rules.is_empty() {
            None
        } else {
            serde_json::to_string(&p.rules).ok()
        };
        sqlx::query(
            "INSERT INTO tag_suggestion_pairs (method, target_id, member_id, rules, score)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(method, target_id, member_id)
             DO UPDATE SET rules = ?4, score = ?5",
        )
        .bind(m)
        .bind(p.target_id)
        .bind(p.member_id)
        .bind(rules_json)
        .bind(p.score)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    for id in judged_tag_ids {
        sqlx::query("INSERT OR IGNORE INTO tag_suggestion_judged (method, tag_id) VALUES (?1, ?2)")
            .bind(m)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 完了を記録する。以後 `begin_run` は引き継がず最初から走る。
pub async fn finish_run(pool: &Pool<Sqlite>, method: Method) -> Result<(), String> {
    sqlx::query("UPDATE tag_suggestion_runs SET finished_at = ?2 WHERE method = ?1")
        .bind(method.as_str())
        .bind(now())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 却下を記録する。**行は消さない**（消すと再実行で戻る）。
pub async fn dismiss(
    pool: &Pool<Sqlite>,
    method: Method,
    target_id: i64,
    member_ids: &[i64],
) -> Result<(), String> {
    let m = method.as_str();
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for id in member_ids {
        sqlx::query(
            "UPDATE tag_suggestion_pairs SET dismissed = 1
             WHERE method = ?1 AND target_id = ?2 AND member_id = ?3",
        )
        .bind(m)
        .bind(target_id)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存されているペアを読む。**却下済みと、タグが消えたものは出ない。**
///
/// タグの消滅は外部キーが処理するので、ここで存在確認は要らない。
pub async fn load_pairs(
    pool: &Pool<Sqlite>,
    method: Method,
) -> Result<Vec<PairRecord>, String> {
    let rows: Vec<(i64, i64, Option<String>, Option<f32>)> = sqlx::query_as(
        "SELECT target_id, member_id, rules, score FROM tag_suggestion_pairs
         WHERE method = ?1 AND dismissed = 0",
    )
    .bind(method.as_str())
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(target_id, member_id, rules, score)| PairRecord {
            target_id,
            member_id,
            rules: rules
                .and_then(|r| serde_json::from_str::<Vec<String>>(&r).ok())
                .unwrap_or_default(),
            score,
        })
        .collect())
}

/// ペアを target ごとにまとめる。**提案の組み立てはこれを通す。**
///
/// ①だけはペア単位のまま出す（連結成分にすると推移閉包が爆発する。
/// 上限15を外したとき 2,792件の塊ができた実測がある）。
pub fn group_by_target(pairs: &[PairRecord]) -> Vec<(i64, Vec<i64>, Vec<String>)> {
    let mut by_target: HashMap<i64, (HashSet<i64>, HashSet<String>)> = HashMap::new();
    for p in pairs {
        let e = by_target.entry(p.target_id).or_default();
        e.0.insert(p.member_id);
        for r in &p.rules {
            e.1.insert(r.clone());
        }
    }
    let mut out: Vec<(i64, Vec<i64>, Vec<String>)> = by_target
        .into_iter()
        .map(|(t, (members, rules))| {
            let mut m: Vec<i64> = members.into_iter().collect();
            m.sort_unstable();
            let mut r: Vec<String> = rules.into_iter().collect();
            r.sort();
            (t, m, r)
        })
        .collect();
    // 決定的な順に並べる（同じ入力で同じ並びになること自体が検証の前提）
    out.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
    out
}

/// まだ判定していない対象。
///
/// **中断で残ったぶんと、実行後に増えたタグが同じ形で出る。**
/// どちらも「この提案はこのタグを見ていない」という同じ事実なので、
/// 区別して持つ意味がない。
pub async fn unjudged(
    pool: &Pool<Sqlite>,
    method: Method,
    population: &[i64],
) -> Result<Vec<i64>, String> {
    let judged: HashSet<i64> =
        sqlx::query_scalar::<_, i64>("SELECT tag_id FROM tag_suggestion_judged WHERE method = ?1")
            .bind(method.as_str())
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
    Ok(population
        .iter()
        .copied()
        .filter(|id| !judged.contains(id))
        .collect())
}

/// 最後に走らせた方式。
///
/// UI にまだ方式の切り替えが無いため、「直前に出した結果」を復元するのに要る。
/// 切り替えが入ったら呼び出し側が方式を指定するので、これは既定値としてのみ使う。
pub async fn latest_method(pool: &Pool<Sqlite>) -> Option<Method> {
    let m: Option<String> = sqlx::query_scalar(
        "SELECT method FROM tag_suggestion_runs ORDER BY started_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match m.as_deref() {
        Some("rules") => Some(Method::Rules),
        Some("hypernym") => Some(Method::Hypernym),
        Some("related") => Some(Method::Related),
        _ => None,
    }
}

/// 実行の状態。UI が「途中で止まっている」「未判定が残っている」を出せるようにする。
#[derive(Debug, Clone, Serialize)]
pub struct RunStatus {
    pub method: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub pair_count: i64,
    pub judged_count: i64,
    /// まだ見ていない対象の数。
    ///
    /// **中断で残ったぶんと、実行後に増えたタグと、失敗したチャンクが同じ数に入る。**
    /// どれも「この提案はこのタグを見ていない」という同じ事実なので区別しない。
    pub unjudged_count: i64,
}

/// 方式ごとの判定対象。**未判定を数えるにはこれが要る。**
///
/// ②は単語1語 basic に限り、かつ段1が選んだカテゴリを外す
/// （カテゴリは割り当てる先であって割り当てられる側ではない）。
fn population_sql(method: Method) -> &'static str {
    match method {
        Method::Hypernym => {
            r#"SELECT COUNT(*) FROM tags t
               WHERE t.is_category = 0 AND t.tag_kind = 'basic'
                 AND t.name NOT LIKE '%\_%' ESCAPE '\'
                 AND t.id NOT IN (
                   SELECT tag_id FROM tag_suggestion_categories WHERE method = 'hypernym')
                 AND t.id NOT IN (
                   SELECT tag_id FROM tag_suggestion_judged WHERE method = ?1)"#
        }
        _ => {
            r#"SELECT COUNT(*) FROM tags t
               WHERE t.is_category = 0
                 AND t.id NOT IN (
                   SELECT tag_id FROM tag_suggestion_judged WHERE method = ?1)"#
        }
    }
}

pub async fn run_status(
    pool: &Pool<Sqlite>,
    method: Method,
) -> Result<Option<RunStatus>, String> {
    let m = method.as_str();
    let row: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT started_at, finished_at FROM tag_suggestion_runs WHERE method = ?1")
            .bind(m)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((started_at, finished_at)) = row else {
        return Ok(None);
    };
    let unjudged_count: i64 = sqlx::query_scalar(population_sql(method))
        .bind(m)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let pair_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tag_suggestion_pairs WHERE method = ?1 AND dismissed = 0",
    )
    .bind(m)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let judged_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tag_suggestion_judged WHERE method = ?1")
            .bind(m)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(Some(RunStatus {
        method: m.to_string(),
        started_at,
        finished_at,
        pair_count,
        judged_count,
        unjudged_count,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mem_pool() -> Pool<Sqlite> {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON;")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                is_category INTEGER NOT NULL DEFAULT 0,
                tag_kind TEXT NOT NULL DEFAULT 'basic');
            CREATE TABLE tag_suggestion_runs (
                method TEXT PRIMARY KEY, started_at INTEGER NOT NULL,
                finished_at INTEGER, model TEXT, params TEXT);
            CREATE TABLE tag_suggestion_categories (
                method TEXT NOT NULL, tag_id INTEGER NOT NULL,
                PRIMARY KEY (method, tag_id),
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE);
            CREATE TABLE tag_suggestion_pairs (
                method TEXT NOT NULL, target_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
                rules TEXT, score REAL, dismissed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER,
                PRIMARY KEY (method, target_id, member_id),
                FOREIGN KEY (target_id) REFERENCES tags(id) ON DELETE CASCADE,
                FOREIGN KEY (member_id) REFERENCES tags(id) ON DELETE CASCADE);
            CREATE TABLE tag_suggestion_judged (
                method TEXT NOT NULL, tag_id INTEGER NOT NULL,
                PRIMARY KEY (method, tag_id),
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE);
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        for i in 1..=10i64 {
            sqlx::query("INSERT INTO tags (id, name) VALUES (?1, ?2)")
                .bind(i)
                .bind(format!("t{}", i))
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    fn pair(t: i64, m: i64) -> PairRecord {
        PairRecord { target_id: t, member_id: m, rules: vec![], score: None }
    }

    #[tokio::test]
    async fn resume_picks_up_where_it_stopped() {
        let pool = mem_pool().await;
        assert!(begin_run(&pool, Method::Hypernym, "sig-a", RunMode::Incremental).await.unwrap().is_none());
        save_categories(&pool, Method::Hypernym, &[1, 2]).await.unwrap();
        commit_chunk(&pool, Method::Hypernym, &[pair(1, 3)], &[3, 4]).await.unwrap();

        // 中断された想定で再開
        let st = begin_run(&pool, Method::Hypernym, "sig-a", RunMode::Incremental).await.unwrap();
        let st = st.expect("途中結果が引き継がれる");
        assert_eq!(st.categories, vec![1, 2], "段1の結果が残る");
        assert_eq!(st.judged, vec![3, 4], "判定済みが残る");
        assert_eq!(load_pairs(&pool, Method::Hypernym).await.unwrap().len(), 1);

        let rest = unjudged(&pool, Method::Hypernym, &[3, 4, 5, 6]).await.unwrap();
        assert_eq!(rest, vec![5, 6], "残りだけが未判定として出る");
    }

    #[tokio::test]
    async fn different_conditions_are_not_mixed() {
        let pool = mem_pool().await;
        begin_run(&pool, Method::Hypernym, "model-a", RunMode::Incremental).await.unwrap();
        save_categories(&pool, Method::Hypernym, &[1]).await.unwrap();
        commit_chunk(&pool, Method::Hypernym, &[pair(1, 3)], &[3]).await.unwrap();

        // モデルを変えたら引き継がない
        let st = begin_run(&pool, Method::Hypernym, "model-b", RunMode::Incremental).await.unwrap();
        assert!(st.is_none(), "条件が違えば最初から");
        assert!(load_pairs(&pool, Method::Hypernym).await.unwrap().is_empty());
        assert!(unjudged(&pool, Method::Hypernym, &[3]).await.unwrap() == vec![3]);
    }

    /// **完走したあとタグが増えた場合、増えたぶんだけ判定する。**
    /// 全件やり直しは段1から引き直すので、既定にはしない。
    #[tokio::test]
    async fn a_finished_run_only_judges_what_is_new() {
        let pool = mem_pool().await;
        begin_run(&pool, Method::Hypernym, "sig", RunMode::Incremental).await.unwrap();
        save_categories(&pool, Method::Hypernym, &[1]).await.unwrap();
        commit_chunk(&pool, Method::Hypernym, &[pair(1, 3)], &[3, 4]).await.unwrap();
        finish_run(&pool, Method::Hypernym).await.unwrap();

        // タグが増えた
        sqlx::query("INSERT INTO tags (id, name) VALUES (99, 't99')")
            .execute(&pool)
            .await
            .unwrap();

        let st = begin_run(&pool, Method::Hypernym, "sig", RunMode::Incremental)
            .await
            .unwrap()
            .expect("完了済みでも引き継ぐ");
        assert_eq!(st.categories, vec![1], "段1は引き直さない");
        let todo = unjudged(&pool, Method::Hypernym, &[3, 4, 99]).await.unwrap();
        assert_eq!(todo, vec![99], "増えたタグだけが対象");
        assert_eq!(load_pairs(&pool, Method::Hypernym).await.unwrap().len(), 1, "前回の結果は残る");
    }

    /// 全件やり直しは明示したときだけ。段1も引き直す。
    #[tokio::test]
    async fn full_mode_starts_over() {
        let pool = mem_pool().await;
        begin_run(&pool, Method::Hypernym, "sig", RunMode::Incremental).await.unwrap();
        save_categories(&pool, Method::Hypernym, &[1]).await.unwrap();
        commit_chunk(&pool, Method::Hypernym, &[pair(1, 3)], &[3]).await.unwrap();
        finish_run(&pool, Method::Hypernym).await.unwrap();

        let st = begin_run(&pool, Method::Hypernym, "sig", RunMode::Full).await.unwrap();
        assert!(st.is_none(), "引き継がない");
        assert!(load_pairs(&pool, Method::Hypernym).await.unwrap().is_empty());
        assert_eq!(unjudged(&pool, Method::Hypernym, &[3]).await.unwrap(), vec![3]);
    }

    #[tokio::test]
    async fn dismissal_survives_a_rerun() {
        let pool = mem_pool().await;
        begin_run(&pool, Method::Rules, "sig", RunMode::Full).await.unwrap();
        commit_chunk(&pool, Method::Rules, &[pair(1, 3), pair(1, 4)], &[3, 4]).await.unwrap();
        dismiss(&pool, Method::Rules, 1, &[3]).await.unwrap();
        assert_eq!(load_pairs(&pool, Method::Rules).await.unwrap().len(), 1);

        // 回し直しても却下は残る。**ユーザーの判断は計算結果で上書きしない**
        begin_run(&pool, Method::Rules, "sig", RunMode::Full).await.unwrap();
        commit_chunk(&pool, Method::Rules, &[pair(1, 3), pair(1, 4)], &[3, 4]).await.unwrap();
        let left = load_pairs(&pool, Method::Rules).await.unwrap();
        assert_eq!(left.len(), 1, "却下したペアは戻らない");
        assert_eq!(left[0].member_id, 4);
    }

    #[tokio::test]
    async fn deleting_a_tag_removes_its_pairs() {
        let pool = mem_pool().await;
        begin_run(&pool, Method::Hypernym, "sig", RunMode::Incremental).await.unwrap();
        commit_chunk(
            &pool,
            Method::Hypernym,
            &[pair(1, 3), pair(1, 4), pair(2, 5)],
            &[3, 4, 5],
        )
        .await
        .unwrap();
        // 統合で 3 が消えた想定
        sqlx::query("DELETE FROM tags WHERE id = 3").execute(&pool).await.unwrap();

        let pairs = load_pairs(&pool, Method::Hypernym).await.unwrap();
        assert_eq!(pairs.len(), 2, "消えたタグのペアだけが落ちる");
        let groups = group_by_target(&pairs);
        // target 1 はメンバーが1件残るので提案として成立する
        assert_eq!(groups.iter().find(|g| g.0 == 1).unwrap().1, vec![4]);
        // target 2 も残る。**他の提案の再計算は要らない**
        assert_eq!(groups.iter().find(|g| g.0 == 2).unwrap().1, vec![5]);
    }

    #[tokio::test]
    async fn methods_do_not_interfere() {
        let pool = mem_pool().await;
        begin_run(&pool, Method::Rules, "a", RunMode::Full).await.unwrap();
        commit_chunk(&pool, Method::Rules, &[pair(1, 3)], &[3]).await.unwrap();
        begin_run(&pool, Method::Related, "b", RunMode::Full).await.unwrap();
        commit_chunk(&pool, Method::Related, &[pair(2, 5)], &[5]).await.unwrap();

        // ③を回し直しても①は消えない
        begin_run(&pool, Method::Related, "c", RunMode::Full).await.unwrap();
        assert_eq!(load_pairs(&pool, Method::Rules).await.unwrap().len(), 1);
        assert!(load_pairs(&pool, Method::Related).await.unwrap().is_empty());
    }

    /// 未判定は **母集団 − カテゴリ − 判定済み**。
    /// カテゴリを引かないと、完走しても常にカテゴリ数ぶん残って見える。
    #[tokio::test]
    async fn unjudged_count_excludes_categories_and_judged() {
        let pool = mem_pool().await;
        begin_run(&pool, Method::Hypernym, "sig", RunMode::Incremental).await.unwrap();
        // t1..t10 が母集団（全部 basic・単語1語）
        save_categories(&pool, Method::Hypernym, &[1, 2]).await.unwrap();
        commit_chunk(&pool, Method::Hypernym, &[], &[3, 4, 5]).await.unwrap();

        let st = run_status(&pool, Method::Hypernym).await.unwrap().unwrap();
        // 10件 − カテゴリ2件 − 判定済み3件 = 5件
        assert_eq!(st.unjudged_count, 5);
        assert_eq!(st.judged_count, 3);

        // タグが増えたら未判定も増える
        sqlx::query("INSERT INTO tags (id, name) VALUES (99, 't99')")
            .execute(&pool)
            .await
            .unwrap();
        let st = run_status(&pool, Method::Hypernym).await.unwrap().unwrap();
        assert_eq!(st.unjudged_count, 6, "増えたタグは未判定として出る");
    }

    #[tokio::test]
    async fn latest_method_follows_the_last_run() {
        let pool = mem_pool().await;
        assert!(latest_method(&pool).await.is_none(), "実行前は無い");
        begin_run(&pool, Method::Rules, "a", RunMode::Full).await.unwrap();
        assert_eq!(latest_method(&pool).await, Some(Method::Rules));
        // started_at は秒精度なので、後勝ちを確実にするため直接ずらす
        sqlx::query("UPDATE tag_suggestion_runs SET started_at = 1 WHERE method = 'rules'")
            .execute(&pool)
            .await
            .unwrap();
        begin_run(&pool, Method::Hypernym, "b", RunMode::Incremental).await.unwrap();
        assert_eq!(latest_method(&pool).await, Some(Method::Hypernym));
    }

    #[test]
    fn grouping_merges_rules_of_the_same_target() {
        let pairs = vec![
            PairRecord { target_id: 1, member_id: 2, rules: vec!["ja_exact".into()], score: None },
            PairRecord { target_id: 1, member_id: 3, rules: vec!["singular".into()], score: None },
            PairRecord { target_id: 9, member_id: 8, rules: vec![], score: None },
        ];
        let g = group_by_target(&pairs);
        assert_eq!(g[0].0, 1, "メンバーが多い順");
        assert_eq!(g[0].1, vec![2, 3]);
        assert_eq!(g[0].2, vec!["ja_exact", "singular"], "規則は和集合");
    }
}
