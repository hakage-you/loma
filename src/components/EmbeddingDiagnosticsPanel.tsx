import React from 'react';
import { EmbeddingDiagnostics } from '../types';
import { CheckCircle, AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';

/**
 * 類似度分布の計測結果を「読める」形で出すパネル。
 *
 * 生の数値だけを並べると、計測した本人以外は評価できない。
 * ここでは指標ごとに **判定・意味・次の一手** を添える。
 *
 * データマークは indigo-400 のベタ1色（コントラスト実測済み: パネル面で 5.8:1）。
 * 判定は色だけに載せず、必ずアイコンとテキストラベルを伴わせる。
 */

/**
 * 判定の基準値。**実測に基づくが、測定回数は多くない**（同一ライブラリ 1,007件、
 * モデル2種 + centering ON/OFF の4条件、2026-07-30）。
 * 目安として使い、境界付近の値を厳密に扱わないこと。
 * 計測手順: tools/embedding-check/README.md
 */
const REFERENCE = {
  /** centering ON での実測 sd。この2つが実質的な下限と上限の目安になる */
  sd: { bgeM3: 0.132, qwen8b: 0.198, centeringOff: 0.044 },
  /** ハブ相関。centering OFF では +0.32〜+0.53 が出た */
  hub: { noise: 0.15, centeringOffMin: 0.32 },
};

type Verdict = 'good' | 'ok' | 'warn';

const VerdictBadge: React.FC<{ verdict: Verdict; label: string }> = ({ verdict, label }) => {
  // 色だけに意味を載せない。必ずアイコン + テキストを伴わせる
  const Icon = verdict === 'warn' ? AlertTriangle : verdict === 'good' ? CheckCircle : Info;
  const tone =
    verdict === 'warn' ? 'text-amber-300' : verdict === 'good' ? 'text-emerald-300' : 'text-slate-300';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold shrink-0 ${tone}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
};

const Metric: React.FC<{
  title: string;
  value: string;
  verdict: Verdict;
  verdictLabel: string;
  reading: string;
  reference?: string;
}> = ({ title, value, verdict, verdictLabel, reading, reference }) => (
  <div className="space-y-0.5">
    <div className="flex items-baseline gap-2">
      <span className="text-slate-200 font-semibold w-24 shrink-0">{title}</span>
      <span className="tabular-nums text-slate-100">{value}</span>
      <span className="flex-1" />
      <VerdictBadge verdict={verdict} label={verdictLabel} />
    </div>
    <p className="text-[10px] text-slate-400 leading-relaxed pl-0.5">{reading}</p>
    {reference && <p className="text-[10px] text-slate-500 pl-0.5">{reference}</p>}
  </div>
);

/** 分布のヒストグラム。固定軸 -1〜+1 を 0.1 刻みで 20 分割したもの */
const Histogram: React.FC<{ d: EmbeddingDiagnostics }> = ({ d }) => {
  const total = d.histogram.reduce((a, b) => a + b.count, 0) || 1;
  const peak = Math.max(...d.histogram.map((b) => b.count), 1);
  return (
    <div>
      <div className="relative flex items-end gap-px h-16">
        {/* 0 の基準線。centering が効いていれば分布はここを中心に集まる。
            分布がどちらかに偏っていること自体が読み取れるよう、目盛ではなく線で置く */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-slate-600 pointer-events-none" />
        {d.histogram.map((b) => (
          <div
            key={b.lower}
            className="flex-1 bg-[#818cf8] rounded-t-sm min-h-px"
            style={{ height: `${(b.count / peak) * 100}%` }}
            title={`${b.lower.toFixed(1)} 〜 ${b.upper.toFixed(1)}: ${((b.count / total) * 100).toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="relative mt-1 text-[10px] text-slate-500 tabular-nums">
        <span>−1</span>
        <span className="absolute left-1/2 -translate-x-1/2">0</span>
        <span className="absolute right-0">+1</span>
      </div>
    </div>
  );
};

export const EmbeddingDiagnosticsPanel: React.FC<{ d: EmbeddingDiagnostics }> = ({ d }) => {
  const { t } = useTranslation();

  const width = d.sim_max - d.sim_min;

  // 分離能力: sd が小さいと「どれも似ている」としか言えなくなる
  const sepVerdict: Verdict =
    d.sim_stddev >= REFERENCE.sd.qwen8b * 0.9
      ? 'good'
      : d.sim_stddev >= REFERENCE.sd.centeringOff * 2
        ? 'ok'
        : 'warn';

  // ハブ化: 0 から離れていると、類似度が意味ではなくタグ本数を測っている
  const hub = Math.abs(d.tagcount_similarity_corr);
  const hubVerdict: Verdict = hub <= REFERENCE.hub.noise ? 'good' : hub < REFERENCE.hub.centeringOffMin ? 'ok' : 'warn';

  // 群分離: 両群が存在しないと計算できない
  const groupsMeasurable =
    d.desc_intra_mean !== null && d.nondesc_intra_mean !== null && d.inter_group_mean !== null;
  const groupGap = groupsMeasurable
    ? (d.desc_intra_mean! + d.nondesc_intra_mean!) / 2 - d.inter_group_mean!
    : null;
  // 系統的なずれが sd の 1/4 を超えたら、類似度が意味ではなく「解析設定」を測っている
  const groupVerdict: Verdict =
    groupGap === null ? 'ok' : groupGap > d.sim_stddev * 0.25 ? 'warn' : 'good';

  return (
    <div className="mt-2.5 p-3 rounded-xl bg-slate-950/60 border border-white/5 text-[11px] space-y-3">
      <div className="text-slate-400">
        {d.model} / {d.dim}次元 / centering {d.centering ? 'ON' : 'OFF'} / descriptive{' '}
        {d.include_descriptive ? 'ON' : 'OFF'}
      </div>

      <Histogram d={d} />

      <div className="space-y-2.5 pt-1">
        <Metric
          title={t('settings.diag_separation', '概念の分離')}
          value={`sd ${d.sim_stddev.toFixed(3)} / ${t('settings.diag_width', '幅')} ${width.toFixed(3)}`}
          verdict={sepVerdict}
          verdictLabel={
            sepVerdict === 'good'
              ? t('settings.diag_good', '良好')
              : sepVerdict === 'ok'
                ? t('settings.diag_ok', '実用域')
                : t('settings.diag_warn', '要改善')
          }
          reading={
            sepVerdict === 'warn'
              ? t(
                  'settings.diag_separation_warn',
                  '分布が狭く、どのメディアも「そこそこ似ている」としか判定できていません。centering が OFF になっていないか確認し、より高精度な埋め込みモデルを試してください。',
                )
              : t(
                  'settings.diag_separation_ok',
                  '大きいほど、似ている／似ていないをはっきり分けられています。小さいと「どれも似ている」しか言えなくなります。',
                )
          }
          reference={`${t('settings.diag_ref', '参考')}: bge-m3 ${REFERENCE.sd.bgeM3} / qwen3-embedding:8b ${REFERENCE.sd.qwen8b} / centering OFF ${REFERENCE.sd.centeringOff}`}
        />

        <Metric
          title={t('settings.diag_hub', 'ハブ化')}
          value={`r ${d.tagcount_similarity_corr >= 0 ? '+' : ''}${d.tagcount_similarity_corr.toFixed(3)}`}
          verdict={hubVerdict}
          verdictLabel={
            hubVerdict === 'good'
              ? t('settings.diag_none', '問題なし')
              : hubVerdict === 'ok'
                ? t('settings.diag_slight', 'わずかにあり')
                : t('settings.diag_warn', '要改善')
          }
          reading={
            hubVerdict === 'warn'
              ? t(
                  'settings.diag_hub_warn',
                  'タグ本数の多いメディアが何とでも似ていると判定されています。類似度が意味ではなくタグ本数を測っている状態です。centering を有効にしてください。',
                )
              : t(
                  'settings.diag_hub_ok',
                  '0 に近いほど良い指標です。タグ本数の多いメディアが何とでも似てしまう現象は出ていません。',
                )
          }
          reference={t(
            'settings.diag_hub_ref',
            '参考: |r| が 0.15 以下は計測のばらつきの範囲。centering OFF での実測は +0.32〜+0.53',
          )}
        />

        {groupsMeasurable ? (
          <Metric
            title={t('settings.diag_group', '解析設定の混在')}
            value={`${t('settings.diag_gap', '群間の差')} ${groupGap!.toFixed(3)}`}
            verdict={groupVerdict}
            verdictLabel={
              groupVerdict === 'warn' ? t('settings.diag_warn', '要改善') : t('settings.diag_none', '問題なし')
            }
            reading={
              groupVerdict === 'warn'
                ? t(
                    'settings.diag_group_warn',
                    '記述的タグを持つメディア同士が、意味とは無関係に近いと判定されています。「記述的タグも類似度計算に含める」を OFF にしてください。',
                  )
                : t(
                    'settings.diag_group_ok',
                    '記述的タグの有無による偏りは出ていません。似ていると判定される理由が「同じ設定で解析されたから」になっていない状態です。',
                  )
            }
          />
        ) : (
          <div className="text-[10px] text-slate-500 leading-relaxed">
            {t(
              'settings.diag_group_unmeasurable',
              '解析設定の混在は測定できません（記述的タグを持つメディアと持たないメディアの両方が必要です）。',
            )}
          </div>
        )}
      </div>

      <div className="text-[10px] text-slate-500 pt-1 border-t border-white/5">
        {t('settings.spectrum_sample', '標本')} {d.sample_size} / {d.eligible_media} ·{' '}
        {d.load_ms + d.centroid_ms}ms + {d.pairwise_ms}ms
        <span className="block mt-0.5">
          {t(
            'settings.diag_basis',
            '判定の目安は少数の実測に基づくため、境界付近の値は厳密に扱わないでください。',
          )}
        </span>
      </div>
    </div>
  );
};
