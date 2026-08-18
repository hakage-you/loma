/**
 * 評価用のシード（正例・負例・階層）の**唯一の出所**。
 *
 * **必ずここから import すること。** 各ツールに書き写すと、片方だけ直したときに
 * 「どのシードで測ったのか」が分からなくなる。この project は既に一度、
 * 評価シードをプロンプトの例文に書いてしまい「見つけた」のか「例をコピーした」のかを
 * 区別できなくする事故を起こしている。**シードは1か所に置き、参照だけする。**
 *
 * シードをプロンプトの例文に使ってはならない。例文にはルールが既に拾える組を使う。
 */

/**
 * 語彙的に無関係な階層（包括関係）のシード。**手で実在を確認したもののみ。**
 * 機械的に列挙できない＝LLM の本命。`hierarchy-scan.mjs` が毎回
 * 「ルール到達不可であること」を検証するので、ルール側が変わればそこで気付ける。
 */
export const HIERARCHY_SEEDS = [
  ['container', 'bowl'], ['container', 'cup'], ['container', 'plate'], ['container', 'glass'],
  ['bowl', 'soup_bowl'], ['bowl', 'rice_bowl'], ['bowl', 'sauce_bowl'],
  ['footwear', 'shoe'], ['footwear', 'boot'], ['footwear', 'sneaker'],
  ['vehicle', 'car'], ['vehicle', 'bicycle'], ['vehicle', 'bus'],
  ['structure', 'greenhouse'], ['structure', 'parking_lot'],
  ['furniture', 'chair'], ['furniture', 'desk'], ['furniture', 'cabinet'],
];

/** 統合してほしい組（ユーザーが良いと評価した実例） */
export const WANT_TOGETHER = [
  ['onigiri', 'rice_ball', '別語彙・同概念'],
  ['greenhouse', 'structure', '包括概念への丸め'],
  ['parking_structure', 'structure', '包括概念への丸め'],
  ['bright_light', 'bright_natural_light', '粒度の丸め'],
  ['bright_light', 'bright_daytime_scene', '粒度の丸め'],
];

/** 統合してほしくない組（ユーザーが悪いと評価した実例。すべてルールベース由来） */
export const WANT_APART = [
  ['bear', 'bean', '編集距離1の誤爆'],
  ['bear', 'beer', '編集距離1の誤爆'],
  ['soup_bowl', 'brick_wall', '編集距離3の誤爆'],
  ['swimming_fish', 'black_and_white_penguin', '共通語による連鎖'],
  ['green_sauce', 'green_hoodie', '日本語プレフィックスの誤爆'],
  ['bright_light', 'bright_screen', '対象が違う'],
];
