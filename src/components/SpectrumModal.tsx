import React, { useCallback, useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { MediaItem, SimilarItem, SpectrumResult, TagPairItem, Zone, ZoneKey } from '../types';
import { X, Loader2, Info, ChevronRight, Dices, Radar, Tag } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { TooltipHelp } from './TooltipHelp';

interface SpectrumModalProps {
  /** 探索の起点。null で閉じる */
  base: MediaItem | null;
  onClose: () => void;
  onOpenSettings: () => void;
  /** タグ不足で対象外のメディアを一覧したいときに呼ぶ */
  onShowExcluded?: () => void;
  /**
   * メディアの詳細を開く。
   *
   * カードのクリックは**この操作に割り当てる**。アプリの他の画面では
   * メディアのクリックが常に「詳細を開く」なので、ここだけ再検索にすると
   * 同じ見た目のものが違う動きをすることになる。
   * 「これを基準に探索」は別のボタンに分ける。
   */
  onOpenDetail?: (item: MediaItem) => void;
}

const fileNameOf = (p: string) => p.split(/[/\\]/).pop() || '';

/** 重心に入っている基本語タグだけを、表示用の名前で返す */
const basicTagNames = (tags: TagPairItem[]) =>
  tags.filter((t) => t.kind === 'basic').map((t) => t.name_ja || t.name);

/** タグのチップ列。「タグの類似度」と表示するなら、そのタグが見えなければ検証できない */
const TagChips: React.FC<{ tags: TagPairItem[]; max?: number }> = ({ tags, max = 4 }) => {
  const names = basicTagNames(tags);
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {names.slice(0, max).map((n) => (
        <span
          key={n}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-slate-800 text-slate-300 rounded text-[10px] max-w-full truncate"
        >
          <Tag className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
          <span className="truncate">{n}</span>
        </span>
      ))}
      {names.length > max && (
        <span className="text-[10px] text-slate-500 self-center">+{names.length - max}</span>
      )}
    </div>
  );
};

/**
 * 実測レンジの線分の色。中立色にしてゾーンの識別色と競合させない。
 * slate-400 はトラック #1e293b に対し 5.71:1。
 */
const RANGE_MARK = 'bg-[#94a3b8]';

/**
 * ゾーンの識別色。
 *
 * **これは「類似度の大小」を色にマップしたものではない。** 値の大小を色相に載せるのは
 * 二重符号化（カードに数値が出ている）であり、暗い面ではランプの暗い側が後退して
 * 「最も似ていない」枠が格下に見えてしまう。それは採らない。
 *
 * ここでの色の役割は**識別**で、凡例上の帯とゾーン見出しを結びつけるためだけに使う。
 * 見出しのテキストが常に名前を担うので、色だけに意味を載せてはいない。
 *
 * この3色は検証器で全ペア判定を通したもの（dark / surface #121a2b / --pairs all）。
 * Tailwind 由来の候補（indigo/sky/fuchsia 等）はいずれも落ちた。
 * 特に fuchsia↔sky は 2型色覚で ΔE 0.3、つまり実質同色で、目視では気付けない。
 *
 * コントラスト実測: 青 4.02 / 橙 3.77 / 青緑 4.30（対トラック、基準 3:1）。
 *
 * 橙はアプリの警告色（amber）と近いが、ゾーンは状態ではなく、
 * 見出しテキストが常に添うため状態表示と誤読される余地はない。
 */
const ZONE_COLOR: Record<ZoneKey, string> = {
  similar: '#3987e5',
  middle: '#d95926',
  distant: '#199e70',
};

/**
 * 類似度レンジ凡例。
 *
 * 軸は固定で、その中に実測レンジを線分として描く。min..max で正規化しないのは、
 * それをやると線分が常に全幅に伸びてしまい、**ライブラリの均質さが見えなくなる**ため。
 *
 * 軸の範囲は -1〜1 とする（計画書の 0〜1 から変更）。
 * centering を有効にすると重心から全体平均を引くため、コサイン類似度は負値を取り得る
 * （実測 min -0.49）。-1〜1 はコサイン類似度の本来の定義域であり、
 * centering の ON/OFF やモデルを跨いでも同じ軸で比較できる。
 */
const RangeLegend: React.FC<{ min: number; mean: number; max: number; zones: Zone[] }> = ({
  min,
  mean,
  max,
  zones,
}) => {
  const { t } = useTranslation();
  const pos = (v: number) => ((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100;
  const left = pos(min);
  const width = Math.max(pos(max) - left, 0.4);

  // 各ゾーンが分布のどこから採られたかを、同じ軸の上に帯として置く。
  // ゾーン見出しと同じ色を使い、どの帯がどの見出しに対応するかを一目で分かるようにする。
  const markers = zones
    .filter((z) => z.items.length > 0)
    .map((z) => {
      const sims = z.items.map((i) => i.similarity);
      return { key: z.key, lo: Math.min(...sims), hi: Math.max(...sims) };
    });

  return (
    <div className="px-1">
      <div className="flex items-center gap-3 text-[11px] text-slate-400 mb-1.5">
        <span>{t('spectrum.label_legend_low', '似ていない')}</span>
        <span className="flex-1" />
        <span>{t('spectrum.label_legend_high', '似ている')}</span>
      </div>

      <div className="relative h-2 rounded-full bg-slate-800 border border-white/5">
        {/* 0 の位置。centering 有効時は負値側に伸びるため基準線が要る */}
        <div className="absolute top-[-3px] bottom-[-3px] w-px bg-slate-500" style={{ left: '50%' }} />
        {/* 実測レンジ */}
        <div
          className={`absolute inset-y-0 rounded-full ${RANGE_MARK}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        {/* 平均。下の凡例に同じ丸を置いて意味が分かるようにしている */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-slate-100 ring-2 ring-slate-900"
          style={{ left: `${pos(mean)}%` }}
          title={`${t('spectrum.label_legend_mean', '平均')} ${mean.toFixed(3)}`}
        />
      </div>

      {/* 各ゾーンが採られた範囲 */}
      {markers.length > 1 && (
        <div className="relative h-2.5 mt-1">
          {markers.map((m) => (
            <div
              key={m.key}
              className="absolute top-0 h-2 rounded-sm"
              style={{
                left: `${pos(m.lo)}%`,
                width: `${Math.max(pos(m.hi) - pos(m.lo), 0.8)}%`,
                backgroundColor: ZONE_COLOR[m.key],
              }}
              title={`${m.lo.toFixed(3)} 〜 ${m.hi.toFixed(3)}`}
            />
          ))}
        </div>
      )}

      {/* 数値の読み。丸の意味が分かるよう、軸上と同じ丸をここにも置く */}
      <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-400 tabular-nums">
        <span>min {min.toFixed(3)}</span>
        <span className="inline-flex items-center gap-1 text-slate-200">
          <span className="w-2.5 h-2.5 rounded-full bg-slate-100 ring-2 ring-slate-900 inline-block shrink-0" />
          {t('spectrum.label_legend_mean', '平均')} {mean.toFixed(3)}
        </span>
        <span>max {max.toFixed(3)}</span>
        <span className="ml-auto text-slate-500">−1 … 0 … +1</span>
      </div>
    </div>
  );
};

const SimilarCard: React.FC<{
  item: SimilarItem;
  onOpenDetail: () => void;
  onExplore: () => void;
}> = ({ item, onOpenDetail, onExplore }) => {
  const { t } = useTranslation();
  const name = fileNameOf(item.media.file_path);
  return (
    <div className="group shrink-0 w-40 rounded-lg overflow-hidden border border-white/10 bg-slate-900/60 hover:border-indigo-400/60 transition">
      {/* クリックは詳細を開く。他画面と同じ操作にする。
          サムネイル本体には手を加えない。淡くすると「格下」と読めてしまい、
          最も似ていない枠＝セレンディピティ枠の意味が逆立ちする */}
      <button
        type="button"
        onClick={onOpenDetail}
        title={`${name}\n${t('spectrum.label_open_detail', '詳細を開く')}`}
        className="relative block w-full aspect-square bg-slate-950/80 cursor-pointer"
      >
        <img
          src={convertFileSrc(item.media.thumbnail_path || item.media.file_path)}
          alt={name}
          loading="lazy"
          className="w-full h-full object-cover"
          onError={(e) => {
            (e.target as HTMLElement).style.display = 'none';
          }}
        />
        {/* 探索の続行は別ボタンに分ける。ホバーでのみ出るので普段は邪魔にならない */}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onExplore();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              onExplore();
            }
          }}
          title={t('spectrum.label_explore_from', 'このメディアを基準に探索')}
          className="absolute top-1.5 right-1.5 p-1.5 rounded-full bg-black/60 hover:bg-indigo-500/80 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
        >
          <Radar className="w-3.5 h-3.5" />
        </span>
      </button>
      <div className="p-2 space-y-1">
        <div className="text-[11px] text-slate-300 truncate" title={name}>
          {name}
        </div>
        <div className="text-[11px] text-slate-400 tabular-nums">{item.similarity.toFixed(3)}</div>
        <TagChips tags={item.media.tags} />
      </div>
    </div>
  );
};

/** 基準メディアのプレビュー。何と比べているのかが見えないと似ているか判断できない */
const BaseMediaPreview: React.FC<{ media: MediaItem; onOpenDetail?: () => void }> = ({
  media,
  onOpenDetail,
}) => {
  const { t } = useTranslation();
  const name = fileNameOf(media.file_path);
  return (
    <div className="flex gap-3 p-2.5 rounded-xl bg-slate-900/60 border border-white/10">
      <button
        type="button"
        onClick={onOpenDetail}
        disabled={!onOpenDetail}
        title={onOpenDetail ? t('spectrum.label_open_detail', '詳細を開く') : name}
        className="relative w-24 h-24 shrink-0 rounded-lg overflow-hidden bg-slate-950/80 border border-white/10 disabled:cursor-default"
      >
        <img
          src={convertFileSrc(media.thumbnail_path || media.file_path)}
          alt={name}
          className="w-full h-full object-cover"
          onError={(e) => {
            (e.target as HTMLElement).style.display = 'none';
          }}
        />
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-[10px] font-bold text-indigo-300 uppercase tracking-wide">
          {t('spectrum.label_base', '基準')}
        </div>
        <div className="text-xs text-slate-100 truncate" title={name}>
          {name}
        </div>
        {media.categories.length > 0 && (
          <div className="text-[10px] text-slate-400 truncate">{media.categories.join(' / ')}</div>
        )}
        {/* このタグ集合が類似度の根拠そのもの。並べて初めて結果を検証できる */}
        <TagChips tags={media.tags} max={8} />
      </div>
    </div>
  );
};

const ZONE_LABEL: Record<ZoneKey, [string, string]> = {
  // 「まったく違う」「真逆」とは書かない。最低コサイン類似度は意味的な反対ではなく
  // 単なる無関係であり、ラベルが実態以上を約束することになる。
  // 基準とタグを共有する候補は除外済みなので、「タグの類似度が高い」は実態と合わない
  // （同じタグのメディアはここには絶対に出ない）。何が出る枠なのかをラベルで言い切る
  similar: ['spectrum.label_zone_similar', 'タグは違うが意味が近い'],
  middle: ['spectrum.label_zone_middle', '意味の近さが中くらい'],
  distant: ['spectrum.label_zone_distant', '意味が最も遠い'],
};

export const SpectrumModal: React.FC<SpectrumModalProps> = ({
  base,
  onClose,
  onOpenSettings,
  onShowExcluded,
  onOpenDetail,
}) => {
  const { t } = useTranslation();
  useEscapeToClose({ open: base !== null, onClose });
  const [result, setResult] = useState<SpectrumResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** パンくず: 探索の起点を辿れるようにする */
  const [trail, setTrail] = useState<{ id: number; label: string }[]>([]);

  const run = useCallback(async (mediaId: number) => {
    setLoading(true);
    setError(null);
    try {
      // シードは毎回こちらで作る。バックエンドを決定的にしておくと、
      // 同じ結果を再現でき、引き直しが「新しいシードで引く」と定義できる。
      const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      setResult(await invoke<SpectrumResult>('find_similar_media', { baseMediaId: mediaId, seed }));
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!base) {
      setResult(null);
      setTrail([]);
      return;
    }
    setTrail([{ id: base.id, label: fileNameOf(base.file_path) }]);
    run(base.id);
  }, [base, run]);

  if (!base) return null;

  const current = trail[trail.length - 1];

  // 結果カードのクリックでそのメディアを新しい基準にする（連鎖探索）
  const explore = (item: SimilarItem) => {
    setTrail((prev) => [...prev, { id: item.media_id, label: fileNameOf(item.media.file_path) }]);
    run(item.media_id);
  };

  const jumpTo = (index: number) => {
    const target = trail[index];
    setTrail((prev) => prev.slice(0, index + 1));
    run(target.id);
  };

  // 帯が表示件数と同じなら引き直しても同じ顔ぶれしか出ない
  const canReroll = !!result?.zones.some((z) => z.band_size > z.items.length);

  const notice = (() => {
    if (!result) return null;
    switch (result.status) {
      case 'no_embeddings':
        return {
          text: t('spectrum.notice_no_embeddings', 'タグのベクトルがまだ生成されていません。設定画面から生成してください。'),
          action: true,
        };
      case 'base_not_eligible':
        return {
          text: t(
            'spectrum.notice_base_not_eligible',
            'このメディアはタグが少ないため対象外です。タグを手動で追加するか、再解析してください。'
          ),
          action: false,
        };
      case 'not_enough_candidates':
        return {
          text: t('spectrum.notice_not_enough', '比較できるメディアがまだ足りません。解析済みのメディアを増やしてください。'),
          action: false,
        };
      case 'degraded':
        return {
          text: t('spectrum.notice_degraded', '候補が少ないため、類似上位のみを表示しています。'),
          action: false,
        };
      default:
        return null;
    }
  })();

  return (
    // z-40 にしているのは、カードから開くメディア詳細（z-50）をこの上に重ねるため。
    // 同じ z だと DOM 順でこちらが前面に来て、詳細が見えなくなる
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="glass-panel w-full max-w-5xl max-h-[88vh] flex flex-col rounded-2xl border border-white/10 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-white/10 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-100">
              {t('spectrum.label_title', '似ているメディア')}
            </h2>
            {/* パンくず履歴 */}
            <div className="flex items-center gap-1 mt-0.5 text-[11px] text-slate-400 overflow-x-auto">
              {trail.map((node, i) => (
                <React.Fragment key={`${node.id}-${i}`}>
                  {i > 0 && <ChevronRight className="w-3 h-3 shrink-0 text-slate-500" />}
                  <button
                    type="button"
                    onClick={() => jumpTo(i)}
                    className={`truncate max-w-[160px] hover:text-indigo-300 transition ${
                      i === trail.length - 1 ? 'text-slate-200' : ''
                    }`}
                  >
                    {node.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>

          {canReroll && (
            <button
              type="button"
              onClick={() => current && run(current.id)}
              disabled={loading}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-white/10 text-[11px] font-semibold text-slate-200 transition disabled:opacity-40 shrink-0"
              title={t('spectrum.reroll_help', '各ゾーンの帯から別のメディアを選び直します')}
            >
              <Dices className="w-3.5 h-3.5 text-indigo-300" />
              {t('spectrum.label_reroll', '引き直す')}
            </button>
          )}

          {result && (
            <span
              className="text-[11px] text-slate-400 shrink-0"
              title={t('spectrum.label_model_hint', '類似度の算出に使ったモデル')}
            >
              {result.model}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-300 hover:text-slate-100 hover:bg-white/10 transition shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5 min-h-0">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-slate-300 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('spectrum.label_loading', '類似度を計算しています...')}
            </div>
          )}

          {!loading && error && (
            <div className="px-4 py-3 rounded-lg bg-red-950/40 border border-red-500/30 text-sm text-red-200">
              {error}
            </div>
          )}

          {!loading && notice && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-950/30 border border-amber-500/25 text-[13px] text-amber-100">
              <Info className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="flex-1">
                {notice.text}
                {notice.action && (
                  <button type="button" onClick={onOpenSettings} className="ml-2 underline hover:text-white">
                    {t('spectrum.label_open_settings', '設定を開く')}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 基準メディアは結果が空でも見せる。対象外の理由を説明する場面でも
              「どのメディアの話か」が分からないと意味がない */}
          {!loading && result?.base_media && (
            <BaseMediaPreview
              media={result.base_media}
              onOpenDetail={onOpenDetail ? () => onOpenDetail(result.base_media!) : undefined}
            />
          )}

          {!loading && result && result.zones.length > 0 && (
            <>
              <RangeLegend
                min={result.range_min}
                mean={result.range_mean}
                max={result.range_max}
                zones={result.zones}
              />

              {result.zones.map((zone) => {
                const [key, fallback] = ZONE_LABEL[zone.key];
                return (
                  <div key={zone.key}>
                    {/* ゾーンの識別は見出しテキストと位置が担う。色には載せない */}
                    <div className="flex items-baseline gap-2 mb-2">
                      {/* 凡例上の帯と同じ色の下線で対応づける。
                          名前はテキストが担うので、色だけに意味を載せてはいない */}
                      <h3
                        className="text-xs font-semibold text-slate-200 pb-0.5"
                        style={{ borderBottom: `2px solid ${ZONE_COLOR[zone.key]}` }}
                      >
                        {t(key, fallback)}
                      </h3>
                      {zone.band_size > zone.items.length && (
                        <span className="text-[11px] text-slate-400">
                          {t('spectrum.label_band_of', '候補')} {zone.band_size} {t('spectrum.label_band_pick', '件から抽出')}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-3 overflow-x-auto pb-2">
                      {zone.items.map((item) => (
                        <SimilarCard
                          key={item.media_id}
                          item={item}
                          onOpenDetail={() => onOpenDetail?.(item.media)}
                          onExplore={() => explore(item)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* 除外されているメディアを黙って隠さない */}
              <div className="text-[11px] text-slate-400 border-t border-white/5 pt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>
                  {t('spectrum.label_candidates', '比較対象')}: {result.candidate_count}
                </span>
                {result.excluded_media > 0 && (
                  <button
                    type="button"
                    onClick={onShowExcluded}
                    disabled={!onShowExcluded}
                    className={onShowExcluded ? 'underline hover:text-indigo-300 transition' : 'cursor-default'}
                  >
                    {t('spectrum.label_excluded', 'タグ不足で対象外')}: {result.excluded_media}
                  </button>
                )}
                {/* 除外は結果の中身を決めている規則なので、件数と理由を必ず出す */}
                {result.shared_tag_excluded > 0 && (
                  <span className="inline-flex items-center gap-1">
                    {t('spectrum.label_shared_excluded', 'タグ共有で除外')}: {result.shared_tag_excluded}
                    <TooltipHelp
                      text={t(
                        'spectrum.shared_excluded_help',
                        '基準とタグを1つでも共有するメディアは候補から外しています。それらはタグ検索で見つけられるため、ここでは「タグが違うのに意味が近い」ものだけを出します。',
                      )}
                      width="w-80"
                    />
                  </span>
                )}
                <span>centering: {result.centering ? 'ON' : 'OFF'}</span>
                <span>descriptive: {result.include_descriptive ? 'ON' : 'OFF'}</span>
                <span className="ml-auto">{result.elapsed_ms} ms</span>
              </div>
            </>
          )}
        </div>

        {/* 基準は本文先頭のプレビューが示すので、フッターでの重複表示はやめた */}
      </div>
    </div>
  );
};
