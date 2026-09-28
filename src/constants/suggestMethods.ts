/**
 * 提案の生成方式。**混ぜない。** リストには選んだ方式の結果だけを出す。
 * ルール検出の誤爆が LLM の結果に混ざると質を下げるため（計画 §1）。
 */
export type SuggestMethod = 'rules' | 'hypernym' | 'related';

/**
 * 表示文字列はここに持たず、キーと既定値の組で持つ。
 * モジュール定数なので `t()` を呼べない —— 描画時に解決する。
 */
export const METHODS: {
  id: SuggestMethod;
  command: string;
  labelKey: string;
  labelDefault: string;
  hintKey: string;
  hintDefault: string;
}[] = [
  {
    id: 'rules',
    command: 'suggest_tag_merges',
    labelKey: 'tag_modal.label_method_rules',
    labelDefault: 'Spelling variants',
    hintKey: 'tag_modal.label_method_rules_hint',
    hintDefault: 'Detected from spelling, singular/plural and Japanese notation rules',
  },
  {
    id: 'hypernym',
    command: 'suggest_hypernyms',
    labelKey: 'tag_modal.label_method_hypernym',
    labelDefault: 'Hypernyms',
    hintKey: 'tag_modal.label_method_hypernym_hint',
    hintDefault: 'AI decides "is a kind of" and groups them',
  },
  {
    id: 'related',
    command: 'suggest_related_tags',
    labelKey: 'tag_modal.label_method_related',
    labelDefault: 'Close in meaning',
    hintKey: 'tag_modal.label_method_related_hint',
    hintDefault: 'Pairs by vector similarity. Includes words an LLM merely judged to be close',
  },
];

/**
 * 規則の識別子 → 表示名のキー。
 * バックエンドは識別子で返す（表示文字列に依存した判定をしないため）。
 * 未知の識別子はそのまま出せるよう、呼ぶ側が既定値に識別子を渡す。
 */
export const ruleLabelKey = (rule: string) => `tag_modal.label_rule_${rule}`;
