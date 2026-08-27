/**
 * Rust 側で `try_acquire_task_lock` を取る Tauri コマンド。
 *
 * このどれか1つが走っている間、**残りは必ず失敗する**
 * （`"別の解析または書き込み処理が実行中です。完了するまでお待ちください。"` が返る）。
 * 押せてしまうボタンを作らないための一覧で、UI のブロック範囲はこれで決める。
 *
 * Rust の実体とズレていないかは `npm run check:exclusive` が検査する。
 * **一覧を手で足すだけでは意味がない** —— 検査を通してから使うこと。
 */
export const EXCLUSIVE_COMMANDS = [
  'add_tag_to_media',
  'apply_tag_merges',
  'cleanup_unused_embeddings',
  'custom_analyze_video',
  'discard_embeddings',
  'generate_tag_embeddings',
  'merge_tags',
  'reanalyze_all_media',
  'reanalyze_folder',
  'reanalyze_single_media',
  'remove_tag_from_media',
  'rename_tag',
  'rescan_all_folders',
  'retry_media',
  'start_scan',
  'suggest_hypernyms',
  'suggest_related_tags',
  'suggest_tag_merges',
  'sync_folders',
] as const;

export type ExclusiveCommand = (typeof EXCLUSIVE_COMMANDS)[number];

/**
 * このうち「開始を要求するだけで、完了は待たない」もの。
 * 呼び出しが返ったあともバックグラウンドで走り続けるので、
 * 全画面ブロックではなく `batch_progress` の進捗表示に引き継ぐ。
 */
export const BACKGROUND_COMMANDS: readonly ExclusiveCommand[] = [
  'custom_analyze_video',
  'reanalyze_all_media',
  'reanalyze_folder',
  'retry_media',
  'rescan_all_folders',
  'start_scan',
];
