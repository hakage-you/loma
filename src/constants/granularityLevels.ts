import { TagGranularity } from '../types';

export type GranularityLevel = {
  value: TagGranularity;
  labelKey: string;
  labelDefault: string;
  descriptiveRange: string;
};

/**
 * タグ付与粒度レベルの定義。
 *
 * **基本語タグは常に5〜10個で固定で、レベルで変わるのは記述的タグの本数だけ。**
 * 設定画面の選択欄と、粒度の比較モーダルの両方が同じ並びを使う。
 */
export const GRANULARITY_LEVELS: GranularityLevel[] = [
  {
    value: 'atomic',
    labelKey: 'settings.label_granularity_atomic',
    labelDefault: 'Lv1: 分解重視（現行）',
    descriptiveRange: '基本語タグ 5〜10個 / 記述的タグなし',
  },
  {
    value: 'balanced',
    labelKey: 'settings.label_granularity_balanced',
    labelDefault: 'Lv2: バランス',
    descriptiveRange: '基本語タグ 5〜10個 + 記述的タグ 1〜3個',
  },
  {
    value: 'descriptive',
    labelKey: 'settings.label_granularity_descriptive',
    labelDefault: 'Lv3: 記述重視',
    descriptiveRange: '基本語タグ 5〜10個 + 記述的タグ 3〜6個',
  },
];
