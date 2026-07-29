import React, { useCallback, useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { MediaItem, SimilarItem, SpectrumResult, Zone, ZoneKey } from '../types';
import { X, Loader2, Info, ChevronRight, Dices } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';

interface SpectrumModalProps {
  /** 探索の起点。null で閉じる */
  base: MediaItem | null;
  onClose: () => void;
  onOpenSettings: () => void;
  /** タグ不足で対象外のメディアを一覧したいときに呼ぶ */
  onShowExcluded?: () => void;
}

const fileNameOf = (p: string) => p.split(/[/\\]/).pop() || '';

/**
 * データマークの色。
 *
 * indigo-400 のベタ1色のみを使う。**類似度の大小を色相にマップしない。**
 * カードには数値が出ており、ゾーンは見出しと位置で識別できるので、色に載せると
 * 「既に出ている情報を色で二重化する」ことになる（データ可視化の典型的な誤り）。
 * さらに暗い面の上でランプを引くと、低類似度＝暗い＝後退して見え、
 * 本機能の売りである「最も似ていない」枠が格下扱いになってしまう。
 *
 * コントラスト実測（データ可視化の基準 3:1 / 2026-07-30）:
 *   indigo-400 #818cf8 -- カード面 #121a2b で 5.83:1 / トラック #1e293b で 4.90:1
 *   indigo-600 #4f46e5 は 2.76:1 で不可。半透明も不可（indigo-500/70 は合成後 2.30:1）。
 */
const MARK = 'bg-[#818cf8]';

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

  // 各ゾーンが分布のどこから採られたかを、同じ軸の上に印として置く。
  // 色でなく位置で示すので、ゾーン間に優劣の含みが出ない。
  const markers = zones
    .filter((z) => z.items.length > 0)
    .map((z) => {
      const sims = z.items.map((i) => i.similarity);
      return { key: z.key, lo: Math.min(...sims), hi: Math.max(...sims) };
    });

  return (
    <div className="px-1">
      <div className="flex items-center gap-3 text-[11px] text-slate-400 mb-1.5">
        <span>{t('spectrum.legend_low', '似ていない')}</span>
        <span className="flex-1" />
        <span>{t('spectrum.legend_high', '似ている')}</span>
      </div>

      <div className="relative h-2 rounded-full bg-slate-800 border border-white/5">
        {/* 0 の位置。centering 有効時は負値側に伸びるため基準線が要る */}
        <div className="absolute top-[-3px] bottom-[-3px] w-px bg-slate-500" style={{ left: '50%' }} />
        {/* 実測レンジ */}
        <div
          className={`absolute inset-y-0 rounded-full ${MARK}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        {/* 平均 */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-slate-100 ring-2 ring-slate-900"
          style={{ left: `${pos(mean)}%` }}
        />
      </div>

      {/* ゾーンが採られた位置 */}
      {markers.length > 1 && (
        <div className="relative h-3 mt-0.5">
          {markers.map((m) => (
            <div
              key={m.key}
              className="absolute top-0 h-2 border-x border-b border-slate-500"
              style={{ left: `${pos(m.lo)}%`, width: `${Math.max(pos(m.hi) - pos(m.lo), 0.6)}%` }}
              title={`${m.lo.toFixed(3)} 〜 ${m.hi.toFixed(3)}`}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400 tabular-nums">
        <span>min {min.toFixed(3)}</span>
        <span className="text-slate-200">mean {mean.toFixed(3)}</span>
        <span>max {max.toFixed(3)}</span>
        <span className="ml-auto text-slate-500">−1 … 0 … +1</span>
      </div>
    </div>
  );
};

const SimilarCard: React.FC<{ item: SimilarItem; onClick: () => void }> = ({ item, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="group shrink-0 w-36 text-left rounded-lg overflow-hidden border border-white/10 bg-slate-900/60 hover:border-indigo-400/60 transition"
    title={fileNameOf(item.file_path)}
  >
    {/* サムネイル本体には手を加えない。淡くすると「格下」と読めてしまい、
        最も似ていない枠＝セレンディピティ枠の意味が逆立ちする */}
    <div className="relative aspect-square bg-slate-950/80">
      <img
        src={convertFileSrc(item.thumbnail_path || item.file_path)}
        alt={fileNameOf(item.file_path)}
        loading="lazy"
        className="w-full h-full object-cover"
        onError={(e) => {
          (e.target as HTMLElement).style.display = 'none';
        }}
      />
    </div>
    <div className="p-2">
      <div className="text-[11px] text-slate-300 truncate">{fileNameOf(item.file_path)}</div>
      <div className="mt-0.5 text-[11px] text-slate-400 tabular-nums">{item.similarity.toFixed(3)}</div>
    </div>
  </button>
);

const ZONE_LABEL: Record<ZoneKey, [string, string]> = {
  // 「まったく違う」「真逆」とは書かない。最低コサイン類似度は意味的な反対ではなく
  // 単なる無関係であり、ラベルが実態以上を約束することになる。
  similar: ['spectrum.zone_similar', 'タグの類似度が高い'],
  middle: ['spectrum.zone_middle', '類似度が中くらい'],
  distant: ['spectrum.zone_distant', 'タグの類似度が最も低い'],
};

export const SpectrumModal: React.FC<SpectrumModalProps> = ({
  base,
  onClose,
  onOpenSettings,
  onShowExcluded,
}) => {
  const { t } = useTranslation();
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
    setTrail((prev) => [...prev, { id: item.media_id, label: fileNameOf(item.file_path) }]);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="glass-panel w-full max-w-5xl max-h-[88vh] flex flex-col rounded-2xl border border-white/10 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-white/10 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-100">
              {t('spectrum.title', '似ているメディア')}
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
              {t('spectrum.reroll', '引き直す')}
            </button>
          )}

          {result && (
            <span
              className="text-[11px] text-slate-400 shrink-0"
              title={t('spectrum.model_hint', '類似度の算出に使ったモデル')}
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
              {t('spectrum.loading', '類似度を計算しています...')}
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
                    {t('spectrum.open_settings', '設定を開く')}
                  </button>
                )}
              </div>
            </div>
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
                      <h3 className="text-xs font-semibold text-slate-200">{t(key, fallback)}</h3>
                      {zone.band_size > zone.items.length && (
                        <span className="text-[11px] text-slate-400">
                          {t('spectrum.band_of', '候補')} {zone.band_size} {t('spectrum.band_pick', '件から抽出')}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-3 overflow-x-auto pb-2">
                      {zone.items.map((item) => (
                        <SimilarCard key={item.media_id} item={item} onClick={() => explore(item)} />
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* 除外されているメディアを黙って隠さない */}
              <div className="text-[11px] text-slate-400 border-t border-white/5 pt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>
                  {t('spectrum.candidates', '比較対象')}: {result.candidate_count}
                </span>
                {result.excluded_media > 0 && (
                  <button
                    type="button"
                    onClick={onShowExcluded}
                    disabled={!onShowExcluded}
                    className={onShowExcluded ? 'underline hover:text-indigo-300 transition' : 'cursor-default'}
                  >
                    {t('spectrum.excluded', 'タグ不足で対象外')}: {result.excluded_media}
                  </button>
                )}
                <span>centering: {result.centering ? 'ON' : 'OFF'}</span>
                <span>descriptive: {result.include_descriptive ? 'ON' : 'OFF'}</span>
                <span className="ml-auto">{result.elapsed_ms} ms</span>
              </div>
            </>
          )}
        </div>

        {/* Footer: 現在の基準 */}
        <div className="px-5 py-2.5 border-t border-white/10 text-[11px] text-slate-400 shrink-0 truncate">
          {t('spectrum.base', '基準')}: {current?.label}
        </div>
      </div>
    </div>
  );
};
