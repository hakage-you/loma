import React, { useState, useEffect, useTransition, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { runExclusive } from '../hooks/useBusy';
import { useLoadMoreOnScroll } from '../hooks/useLoadMoreOnScroll';
import { useExclusiveGuard } from '../hooks/useExclusiveGuard';
import { listen } from '@tauri-apps/api/event';
// **`window.confirm` / `window.alert` は使わない。** Tauri の webview では表示されず、
// confirm は false 相当になるため、確認を出したつもりで何も起きない状態になる。
import { ask, message as showMessage } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import { X, Edit2, Check, GitMerge, Search, Sparkles, ThumbsUp, ThumbsDown, RefreshCw, Eye, Image as ImageIcon, PlusCircle, CheckCircle2, Filter, Film, AlertCircle, Info } from 'lucide-react';
import { TagItem, MergeSuggestion, MediaItem } from '../types';
import { useTranslation } from '../contexts/I18nContext';
import { TooltipHelp } from './TooltipHelp';
import { placeFloating, FloatingPlacement } from '../utils/floatingPosition';

/**
 * 提案の生成方式。**混ぜない。** リストには選んだ方式の結果だけを出す。
 * ルール検出の誤爆が LLM の結果に混ざると質を下げるため（計画 §1）。
 */
type SuggestMethod = 'rules' | 'hypernym' | 'related';

/**
 * 表示文字列はここに持たず、キーと既定値の組で持つ。
 * モジュール定数なので `t()` を呼べない —— 描画時に解決する。
 */
const METHODS: {
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
const ruleLabelKey = (rule: string) => `tag_modal.label_rule_${rule}`;

/**
 * 一度に DOM へ出す件数。**上限ではない** —— 末尾まで来たら足していくので全件に到達できる
 * （提案の件数を絞らないこと自体は仕様 / 計画 §6）。
 *
 * 提案カードは1枚あたり約72要素（規則チップ・メンバー全員ぶんの `<option>`・
 * メンバーチップ2ボタン・サムネ最大5枚）で、一覧の行の約4倍重い。実測 2,460枚で
 * 177,512要素・描画10.0秒だったため、初期値を一覧より小さく取る。
 *
 * **提案だけ初回と追加で数を変える。** `sortedSuggestions` はグループの大きい順なので
 * 先頭ほど重く、実測で先頭50枚が 13,525要素（1枚270要素＝全体平均の約4倍）・1.7秒だった。
 * 初回だけ 20 に絞り、以降は 50 ずつ足す。
 */
const TAG_PAGE = 200;
const SUGGESTION_FIRST = 20;
const SUGGESTION_PAGE = 50;

/**
 * 提案カードのサンプルサムネと、ホバー時の拡大表示。
 *
 * **ホバーの状態をここに閉じ込めるためだけに切り出してある。**
 * モーダル直下に持つと、サムネの上をマウスが通るたびにモーダル全体が再描画される。
 *
 * 拡大表示は `document.body` へ portal する。モーダルの内側は
 * `backdrop-blur` と `zoom-in-95` が position:fixed の基準を作るため、
 * その場に置くとスクロール領域で切られる。
 */
/** 拡大表示の一辺。位置決めに実寸が要るので定数で持つ */
const THUMB_PREVIEW_SIZE = 128;

const SampleThumbStack: React.FC<{
  thumbnails: string[];
  totalImagesCount?: number;
}> = ({ thumbnails, totalImagesCount }) => {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<{ src: string; pos: FloatingPlacement } | null>(null);

  return (
    <div className="flex items-center gap-1 shrink-0 ml-1">
      <div
        className="flex items-center -space-x-2 p-0.5"
        title={t('tag_modal.label_title_sample_media', 'Group sample media')}
      >
        {thumbnails.slice(0, 5).map((thumbPath, idx) => (
          <img
            key={idx}
            src={convertFileSrc(thumbPath)}
            alt="sample"
            width={28}
            height={28}
            loading="lazy"
            decoding="async"
            className="w-7 h-7 rounded-md object-cover border-2 border-slate-900 shadow-md cursor-pointer transition-transform hover:scale-110 relative"
            onMouseEnter={(e) => {
              setHovered({
                src: convertFileSrc(thumbPath),
                // 端のサムネでも切れないよう、位置はツールチップと同じ関数で出す
                pos: placeFloating(
                  e.currentTarget.getBoundingClientRect(),
                  { width: THUMB_PREVIEW_SIZE, height: THUMB_PREVIEW_SIZE },
                  'center'
                ),
              });
            }}
            onMouseLeave={() => setHovered(null)}
            onError={(e) => {
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
        ))}
      </div>

      {/* 最大枚数以上の画像がある場合の「続きあり (+N / ...)」インジケーター */}
      {totalImagesCount !== undefined && totalImagesCount > thumbnails.length && (
        <span
          className="px-1.5 py-0.5 bg-slate-800/90 text-slate-300 border border-white/10 rounded-md text-[10px] font-mono font-bold tracking-tight shrink-0 shadow-sm"
          title={`${t('tag_modal.label_title_total_media', 'Media with this tag')}: ${totalImagesCount}${t(
            'tag_modal.label_tag_count_unit',
            ''
          )}`}
        >
          +{totalImagesCount - thumbnails.length}…
        </span>
      )}

      {hovered &&
        createPortal(
          <div
            style={{ left: `${hovered.pos.left}px`, top: `${hovered.pos.top}px` }}
            className="fixed w-32 h-32 rounded-2xl overflow-hidden border-2 border-indigo-500 bg-slate-950 shadow-2xl z-[120] pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex items-center justify-center select-none"
          >
            <img src={hovered.src} alt="floating preview" className="w-full h-full object-cover" />
          </div>,
          document.body
        )}
    </div>
  );
};

interface TagManagementModalProps {
  open: boolean;
  tags: TagItem[];
  isScanning?: boolean;
  onClose: () => void;
  onRenameTag: (tagId: number, newName: string, newNameJa?: string) => Promise<void>;
  onMergeTags: (targetTagId: number, sourceTagIds: number[]) => Promise<void>;
  /** 統合を適用した後の再読込。タグ一覧とメディアを取り直す */
  onDataChanged?: () => Promise<void>;
  onSelectTagFilter?: (tagName: string) => void;
}

const TagPreviewCard: React.FC<{
  media: MediaItem;
  onClick: () => void;
}> = ({ media, onClick }) => {
  const { t } = useTranslation();
  const isVideo = /\.(mp4|webm|mov|avi|mkv|flv|wmv)$/i.test(media.file_path);
  const primarySrc = media.thumbnail_path
    ? convertFileSrc(media.thumbnail_path)
    : isVideo
    ? ''
    : convertFileSrc(media.file_path);
  const fallbackSrc = isVideo ? '' : convertFileSrc(media.file_path);

  const [imgSrc, setImgSrc] = useState<string>(primarySrc);
  const [hasError, setHasError] = useState<boolean>(!primarySrc);

  const handleImgError = () => {
    if (imgSrc === primarySrc && fallbackSrc && fallbackSrc !== primarySrc) {
      setImgSrc(fallbackSrc);
    } else {
      setHasError(true);
    }
  };

  const fileName = media.file_path.split(/[/\\]/).pop() || '';

  return (
    <div
      onClick={onClick}
      className="group relative bg-slate-950 border border-white/10 rounded-xl overflow-hidden shadow aspect-square flex flex-col items-center justify-center cursor-pointer transition hover:border-indigo-500/50 select-none"
      title={fileName}
    >
      {!hasError && imgSrc ? (
        <img
          src={imgSrc}
          alt={fileName}
          onError={handleImgError}
          className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
          loading="lazy"
        />
      ) : (
        <div className="flex flex-col items-center justify-center p-2 text-center gap-1.5 w-full h-full bg-slate-900/90 text-slate-400">
          {isVideo ? (
            <Film className="w-7 h-7 text-indigo-400 opacity-80" />
          ) : (
            <AlertCircle className="w-6 h-6 text-amber-400/80" />
          )}
          <span className="text-[10px] font-mono text-slate-300 truncate max-w-full px-1">{fileName}</span>
          <span className="text-[9px] text-indigo-300 font-semibold">{isVideo ? t('tag_modal.label_video_file', 'Video') : t('tag_modal.label_image_file', 'Image')}</span>
        </div>
      )}

      {/* Video Badge */}
      {isVideo && !hasError && (
        <div className="absolute top-2 left-2 z-10 px-1.5 py-0.5 bg-slate-950/80 backdrop-blur-md border border-white/20 text-indigo-300 rounded-md text-[9px] font-bold flex items-center gap-1">
          <Film className="w-3 h-3 text-indigo-400" />
          <span>VIDEO</span>
        </div>
      )}

      {/* Hover Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition p-2 flex flex-col justify-end pointer-events-none">
        <p className="text-[10px] text-white font-medium truncate">{fileName}</p>
        <p className="text-[9px] text-indigo-300 font-semibold">{isVideo ? t('tag_modal.label_click_play', 'Click to play') : t('tag_modal.label_click_zoom', 'Click to enlarge')}</p>
      </div>
    </div>
  );
};

export const TagManagementModal: React.FC<TagManagementModalProps> = ({
  open,
  tags,
  isScanning = false,
  onClose,
  onRenameTag,
  onMergeTags,
  onDataChanged,
  onSelectTagFilter,
}) => {
  // タグ一覧の map では変数名 `t` がタグを指すため、翻訳関数に別名を用意しておく
  const { t, t: translate, language } = useTranslation();
  // 統合・提案の再計算・タグ名の変更はすべて Rust の排他ロックを取る
  const exclusive = useExclusiveGuard();
  const [activeTab, setActiveTab] = useState<'all' | 'suggestions'>('all');
  const [search, setSearch] = useState('');
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editNameJa, setEditNameJa] = useState('');

  // 手動マージ用の選択状態
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [targetTagId, setTargetTagId] = useState<number | null>(null);

  // AI自動提案用の状態
  const [suggestions, setSuggestions] = useState<MergeSuggestion[]>([]);
  const [method, setMethod] = useState<SuggestMethod>('rules');
  // ② は数分かかる。何も出ないと止まって見えるので進捗を出す
  const [scanProgress, setScanProgress] = useState<string>('');
  /**
   * 保存済みの実行状態。**未判定の件数を出すために要る。**
   * 中断で残ったぶん・実行後に増えたタグ・失敗したチャンクが同じ数に入る。
   */
  const [runStatus, setRunStatus] = useState<{
    started_at: number;
    finished_at: number | null;
    pair_count: number;
    judged_count: number;
    unjudged_count: number;
  } | null>(null);
  const [scanningSuggestions, setScanningSuggestions] = useState<boolean>(false);

  /**
   * タブの切り替えは**同期描画なので、素直に state を変えると押した瞬間に固まる**
   * （実測: 提案タブ 590ms）。transition にすると React が新しい木を裏で作り、
   * その間はブラウザに描画を返せるので「読み込み中」が実際に出る。
   * 切り替え前のタブは、新しい木が用意できるまで表示されたまま残る。
   */
  const [isTabPending, startTabTransition] = useTransition();
  /** 方式の切り替え。バックエンド待ちと描画の両方を含む区間 */
  const [loadingSuggestions, setLoadingSuggestions] = useState<boolean>(false);
  const [applyingMerges, setApplyingMerges] = useState<boolean>(false);
  const [applyProgressText, setApplyProgressText] = useState<string>('');
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [previewMediaItem, setPreviewMediaItem] = useState<MediaItem | null>(null);

  /**
   * いま DOM に出している件数。**全件に到達できる**（末尾で足していく）。
   * 検索・並べ替え・種別・方式・タブが変わったら先頭に戻す。
   */
  const [visibleTagCount, setVisibleTagCount] = useState<number>(TAG_PAGE);
  const [visibleSuggestionCount, setVisibleSuggestionCount] = useState<number>(SUGGESTION_FIRST);
  const tagScrollRef = React.useRef<HTMLDivElement>(null);
  const tagSentinelRef = React.useRef<HTMLDivElement>(null);
  const sugScrollRef = React.useRef<HTMLDivElement>(null);
  const sugSentinelRef = React.useRef<HTMLDivElement>(null);
  /**
   * 一覧に出すタグごとのサンプルサムネイル。**表示中のぶんだけ取りに行く。**
   * 5,840件ぶんを先に取ると、開いた瞬間に無駄な往復と保持が増える。
   */
  const [tagThumbs, setTagThumbs] = useState<Record<number, string[]>>({});
  /** 取得済み（0枚だったものを含む）のタグID。同じIDを何度も取りに行かないため */
  const fetchedThumbIdsRef = React.useRef<Set<number>>(new Set());

  const loadMoreTags = React.useCallback(() => setVisibleTagCount((n) => n + TAG_PAGE), []);
  const loadMoreSuggestions = React.useCallback(
    () => setVisibleSuggestionCount((n) => n + SUGGESTION_PAGE),
    []
  );

  // 【一時】計測ログの解釈に要る値。**どのタブを描画したかが要る** ——
  // タブが 'all' のときの render は一覧の行数、'suggestions' のときは提案カードの枚数を指す。
  // reloadSuggestions の依存に足すと読み直しが走るので参照で持つ
  const perfRef = React.useRef({ tags: 0, tab: '' as string, suggestions: 0 });
  perfRef.current = { tags: tags.length, tab: activeTab, suggestions: suggestions.length };

  /**
   * 【一時】描画だけの計測。タブや方式のボタンで印を付け、ペイント後に経過を出す。
   * バックエンドを挟まない切り替え（タブ）はこれでしか測れない。
   */
  const perfMarkRef = React.useRef<{ label: string; t0: number } | null>(null);
  const markPerf = (label: string) => {
    perfMarkRef.current = { label, t0: performance.now() };
  };

  useEffect(() => {
    const mark = perfMarkRef.current;
    if (!mark) return;
    perfMarkRef.current = null;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const { tags: tagCount, tab, suggestions: sugCount } = perfRef.current;
        console.log(
          `[tag-perf] ${mark.label} render=${Math.round(performance.now() - mark.t0)}ms ` +
            `tab=${tab} tags=${tagCount} suggestions=${sugCount} ` +
            `dom=${document.querySelectorAll('.fixed.inset-0.z-50 *').length}`
        );
      })
    );
  });

  // **開くたびに `cleanup_missing_media` を呼んでいたのをやめた。**
  // 全メディアの `Path::exists()` を回るので冷えた状態で約3秒かかり、
  // その間ずっと提案の読み込みと DB を取り合っていた。実データでの回収は0件。
  // 掃除は「同期」の `cleanup_and_detect_moves` が引き継いでいる。

  /** 保存済みの判定と実行状態を読み直す */
  const reloadSuggestions = React.useCallback(async () => {
    // 【一時】暫定対処の計測用（計画 §4）。バックエンドの応答と描画を分けて出す。
    // backend が支配的なら、残りの重さは Rust 側（build_suggestions がグループごとに
    // 2クエリを逐次で投げている）にある
    const t0 = performance.now();
    const [cached, status] = await Promise.all([
      invoke<MergeSuggestion[]>('load_tag_suggestions_cache', { method }),
      invoke<typeof runStatus>('get_suggestion_run_status', { method }),
    ]);
    const backendMs = performance.now() - t0;
    setSuggestions(cached ?? []);
    const initMasterMap: Record<string, number> = {};
    (cached ?? []).forEach((s) => {
      initMasterMap[s.id] = s.target_tag.id;
    });
    setSelectedMasterTagIds(initMasterMap);
    setRunStatus(status ?? null);
    // 既定はどれも未承認。ユーザーは上から見て良いものだけ採る
    setAcceptedIds(new Set());
    setRejectedIds(new Set());

    // 【一時】rAF を2段にしてペイント後まで待つ。1段目はコミット後・描画前に走るため。
    // 読み込み中の表示も、描画が終わったここで初めて下ろす
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setLoadingSuggestions(false);
        console.log(
          `[tag-perf] reload:${method} backend=${Math.round(backendMs)}ms ` +
            `render=${Math.round(performance.now() - t0 - backendMs)}ms ` +
            `tab=${perfRef.current.tab} tags=${perfRef.current.tags} ` +
            `suggestions=${(cached ?? []).length} ` +
            `dom=${document.querySelectorAll('.fixed.inset-0.z-50 *').length}`
        );
      })
    );
  }, [method]);

  // 保存済みの判定から提案を復元する。**方式を切り替えたら読み直す**
  // （方式ごとに独立した枠を持つので、①を回しても②③の結果は残っている）
  useEffect(() => {
    if (!open) return;
    // **描画が終わるまで下ろさない。** バックエンドの応答で下ろすと、
    // 一番長い区間（提案カードの描画）が無表示のまま残る
    setLoadingSuggestions(true);
    reloadSuggestions().catch((e) => {
      setLoadingSuggestions(false);
      console.error('Failed to load tag suggestions cache:', e);
    });
  }, [open, reloadSuggestions]);

  // ② の進捗。段1/段2 とチャンク数が飛んでくる
  useEffect(() => {
    const p = listen<{ phase: string; done: number; total: number; failed: number }>(
      'tag_hypernym_progress',
      (e) => {
        const { phase, done, total, failed } = e.payload;
        setScanProgress(
          `${phase} ${done}/${total}${failed > 0 ? t('tag_modal.label_progress_failed', ' ({n} failed)', { n: failed }) : ''}`
        );
      }
    );
    return () => {
      p.then((un) => un());
    };
  }, []);

  // `tag_suggestions_updated` の購読は削除した。
  // スキャン後に提案を自動生成する処理をやめたため、このイベントを送る側が存在しない
  // （提案の生成は常にユーザーが起動する）。

  // 提案ごとの選択された Master Tag ID (-1 は手入力カスタム)
  const [selectedMasterTagIds, setSelectedMasterTagIds] = useState<Record<string, number>>({});
  // 提案ごとの手入力マスタータグ内容 (suggestionId -> { name, nameJa })
  const [customMasterTags, setCustomMasterTags] = useState<Record<string, { name: string; nameJa: string }>>({});

  // 提案ごとの「マージから除外された Tag ID」集合 (suggestionId -> Set<tagId>)
  const [excludedTagIds, setExcludedTagIds] = useState<Record<string, Set<number>>>({});

  // 画像プレビューモーダル用の状態
  const [previewTag, setPreviewTag] = useState<TagItem | null>(null);
  const [previewMediaList, setPreviewMediaList] = useState<MediaItem[]>([]);
  const [loadingPreview, setLoadingPreview] = useState<boolean>(false);

  // ソート順（デフォルト: 件数が多い順）
  const [sortBy, setSortBy] = useState<'count_desc' | 'count_asc' | 'alpha_asc' | 'ja_asc'>('count_desc');

  // タグ種別フィルタ（基本語 / 記述的タグ）
  const [kindFilter, setKindFilter] = useState<'all' | 'basic' | 'descriptive'>('all');

  // AI Merge 提案を常に対象タグ件数（グループ内タグ数）が多い順（降順）にソート
  const sortedSuggestions = React.useMemo(() => {
    if (!suggestions || !Array.isArray(suggestions)) return [];
    return [...suggestions].filter((s) => s && s.target_tag).sort((a, b) => {
      const aCount = (Array.isArray(a.source_tags) ? a.source_tags.length : 1) + 1;
      const bCount = (Array.isArray(b.source_tags) ? b.source_tags.length : 1) + 1;
      return bCount - aCount;
    });
  }, [suggestions]);

  /**
   * 実行状態の1行表示。**「いつの結果を見ているか」を出す。**
   *
   * `unjudged_count` は中断ぶん・実行後に増えたタグ・失敗したチャンクを
   * 区別せず合算した数（バックエンドの設計）。区別できるのは `finished_at` だけなので、
   * 「途中で終わった」のか「終わった後にタグが増えた」のかはそこで分ける。
   */
  const runStatusText = React.useMemo(() => {
    if (scanningSuggestions || scanProgress) {
      const m = METHODS.find((x) => x.id === method);
      const hint = m ? t(m.hintKey, m.hintDefault) : '';
      return scanProgress ? `${hint} — ${scanProgress}` : hint;
    }
    if (!runStatus) return '';

    const when = new Date((runStatus.finished_at ?? runStatus.started_at) * 1000).toLocaleString(
      language === 'ja' ? 'ja-JP' : 'en-US',
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    );

    if (runStatus.finished_at === null) {
      return t('tag_modal.status_interrupted', '', { when, n: runStatus.unjudged_count });
    }
    if (runStatus.unjudged_count > 0) {
      // 完走したあとに残っている未判定＝実行後に増えたタグ。これが陳腐化の実体
      return t('tag_modal.status_stale', '', { when, n: runStatus.unjudged_count });
    }
    return t('tag_modal.status_fresh', '', { when, n: runStatus.judged_count });
  }, [scanningSuggestions, scanProgress, runStatus, method, language, t]);

  const rejectTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  React.useEffect(() => {
    return () => {
      Object.values(rejectTimersRef.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  // 一覧の絞り込みと並べ替え。**早期 return より前に置く。**
  // 以前はここが素の式で、提案タブを見ている間も 5,840 件の filter と
  // localeCompare が毎レンダー走っていた
  const freeTags = React.useMemo(() => tags.filter((t) => !t.is_category), [tags]);

  /**
   * 一覧の作り直しに使う絞り込み文字列。**入力欄の値そのものではない。**
   *
   * 実データ（タグ 10,123件）では、1文字打つたびに一覧を作り直すと
   * **1打鍵あたり 179ms（最大 308ms）ブロックしていた**（npm run perf の
   * 「実データの形 / タグ絞り込みの入力」）。入力欄の表示は即座に、
   * 一覧の作り直しは後回しにする。
   *
   * 並べ替えと種別も同じ理由で後回しにする（並べ替えは実測 402ms）。
   */
  const deferredSearch = useDeferredValue(search);
  const deferredSortBy = useDeferredValue(sortBy);
  const deferredKindFilter = useDeferredValue(kindFilter);
  /** 入力に一覧が追いついていない間。読み込み中の帯を出すのに使う */
  const isListStale =
    deferredSearch !== search ||
    deferredSortBy !== sortBy ||
    deferredKindFilter !== kindFilter;

  const filteredTags = React.useMemo(() => {
    const q = deferredSearch.toLowerCase();
    return freeTags.filter(
      (t) =>
        (deferredKindFilter === 'all' || t.kind === deferredKindFilter) &&
        (t.name.toLowerCase().includes(q) || (t.name_ja && t.name_ja.toLowerCase().includes(q)))
    );
  }, [freeTags, deferredKindFilter, deferredSearch]);
  const sortedTags = React.useMemo(() => {
    const list = [...filteredTags];
    if (deferredSortBy === 'count_desc') return list.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
    if (deferredSortBy === 'count_asc') return list.sort((a, b) => (a.count ?? 0) - (b.count ?? 0));
    if (deferredSortBy === 'alpha_asc') return list.sort((a, b) => a.name.localeCompare(b.name));
    if (deferredSortBy === 'ja_asc') {
      return list.sort((a, b) =>
        (a.name_ja || a.name).localeCompare(b.name_ja || b.name, 'ja')
      );
    }
    return list;
  }, [filteredTags, deferredSortBy]);

  // 表示件数を先頭に戻す条件。母集団や並びが変わったのに途中から出ていると、
  // 上に何が来たのかが分からなくなる
  useEffect(() => {
    setVisibleTagCount(TAG_PAGE);
  }, [deferredSearch, deferredSortBy, deferredKindFilter, activeTab]);
  useEffect(() => {
    setVisibleSuggestionCount(SUGGESTION_FIRST);
  }, [sortedSuggestions, activeTab]);

  // いま一覧に出ているタグのサムネイルを、まだ取っていないぶんだけまとめて取る。
  // 段階描画で件数が増えるたびに差分だけを1往復で引く
  useEffect(() => {
    if (!open || activeTab !== 'all') return;
    const need = sortedTags
      .slice(0, visibleTagCount)
      .map((tg) => tg.id)
      .filter((id) => !fetchedThumbIdsRef.current.has(id));
    if (need.length === 0) return;
    need.forEach((id) => fetchedThumbIdsRef.current.add(id));
    invoke<Record<string, string[]>>('get_tag_sample_thumbnails', { tagIds: need })
      .then((map) => {
        setTagThumbs((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(map)) next[Number(k)] = v;
          return next;
        });
      })
      .catch((e) => console.error('Failed to fetch tag sample thumbnails:', e));
  }, [open, activeTab, sortedTags, visibleTagCount]);

  // タグ一覧が入れ替わったら取得済みの記録を捨てる（統合や改名でIDの中身が変わる）
  useEffect(() => {
    fetchedThumbIdsRef.current = new Set();
    setTagThumbs({});
  }, [tags]);

  useLoadMoreOnScroll(
    tagScrollRef,
    tagSentinelRef,
    activeTab === 'all',
    visibleTagCount < sortedTags.length,
    visibleTagCount,
    loadMoreTags
  );
  useLoadMoreOnScroll(
    sugScrollRef,
    sugSentinelRef,
    activeTab === 'suggestions',
    visibleSuggestionCount < sortedSuggestions.length,
    visibleSuggestionCount,
    loadMoreSuggestions
  );

  if (!open) return null;

  // タグをクリックしてメイン画面で即座に絞り込み検索
  const handleTriggerSearchFilter = (tagName: string) => {
    if (onSelectTagFilter) {
      onSelectTagFilter(tagName);
      onClose();
    }
  };

  // 画像プレビューモーダルの開閉
  const handleOpenTagPreview = async (tag: TagItem) => {
    setPreviewTag(tag);
    setLoadingPreview(true);
    try {
      const mediaList = await invoke<MediaItem[]>('get_media_by_tag', { tagId: tag.id });
      setPreviewMediaList(mediaList);
    } catch (e) {
      console.error('Failed to fetch media for tag:', e);
      setPreviewMediaList([]);
    } finally {
      setLoadingPreview(false);
    }
  };

  // 編集開始
  const handleStartEdit = (t: TagItem) => {
    setEditingTagId(t.id);
    setEditName(t.name);
    setEditNameJa(t.name_ja || '');
  };

  // 編集保存
  const handleSaveEdit = async (t: TagItem) => {
    if (!editName.trim()) return;
    await onRenameTag(t.id, editName.trim(), editNameJa.trim() || undefined);
    setEditingTagId(null);
    setSuccessToast(translate('tag_modal.toast_renamed', '', { name: t.name }));
    setTimeout(() => setSuccessToast(null), 2500);
  };

  // 手動マージ実行
  const handleExecuteManualMerge = async () => {
    if (!targetTagId || selectedTagIds.length < 2) return;
    const sourceIds = selectedTagIds.filter((id) => id !== targetTagId);
    setApplyingMerges(true);
    try {
      await onMergeTags(targetTagId, sourceIds);
      setSelectedTagIds([]);
      setTargetTagId(null);
      setSuccessToast(t('tag_modal.toast_manual_merged', ''));
      setTimeout(() => setSuccessToast(null), 2500);
    } catch (e) {
      console.error('Failed to execute manual merge:', e);
    } finally {
      setApplyingMerges(false);
    }
  };

  // 選んだ方式で提案を作り直す。
  // **方式ごとに独立**なので、これを回しても他の方式の結果は消えない。
  // ② は未判定のタグだけを処理するので、中断しても次回は続きから走る。
  const handleScanSuggestions = async (fullRescan = false) => {
    if (isScanning || scanningSuggestions) return;
    const spec = METHODS.find((m) => m.id === method)!;
    if (fullRescan) {
      const ok = await ask(
        t('tag_modal.rescan_confirm', ''),
        { title: t('tag_modal.label_rescan_title', 'Rebuild from scratch'), kind: 'warning' }
      );
      if (!ok) return;
    }
    setScanningSuggestions(true);
    setScanProgress('');
    setActiveTab('suggestions');
    try {
      setSuggestions([]);
      setCustomMasterTags({});
      setExcludedTagIds({});
      await runExclusive('building_tag_suggestions', () =>
        invoke<MergeSuggestion[]>(spec.command, fullRescan ? { fullRescan: true } : {})
      );
      // 実行結果は保存されているので、読み出し経路に一本化する
      await reloadSuggestions();
    } catch (e) {
      console.error('Failed to scan suggestions:', e);
      setScanProgress(String(e));
    } finally {
      setScanningSuggestions(false);
    }
  };

  // 提案カード内のマスタータグ変更
  const handleSelectMasterTag = (suggestionId: string, masterId: number) => {
    setSelectedMasterTagIds((prev) => ({
      ...prev,
      [suggestionId]: masterId,
    }));
  };

  // 手入力マスタータグの更新
  const handleCustomMasterTagChange = (suggestionId: string, field: 'name' | 'nameJa', value: string) => {
    setCustomMasterTags((prev) => ({
      ...prev,
      [suggestionId]: {
        name: field === 'name' ? value : prev[suggestionId]?.name || '',
        nameJa: field === 'nameJa' ? value : prev[suggestionId]?.nameJa || '',
      },
    }));
  };

  // 特定のタグをマージ対象から除外 / 復帰（トグル）
  const handleToggleExcludeTag = (suggestionId: string, tagId: number) => {
    setExcludedTagIds((prev) => {
      const currentSet = new Set(prev[suggestionId] || []);
      if (currentSet.has(tagId)) {
        currentSet.delete(tagId);
      } else {
        currentSet.add(tagId);
      }
      return {
        ...prev,
        [suggestionId]: currentSet,
      };
    });
  };

  // Accept / Reject 切り替え
  const handleToggleAccept = (suggestionId: string) => {
    setAcceptedIds((prev) => {
      const next = new Set(prev);
      if (next.has(suggestionId)) {
        next.delete(suggestionId);
      } else {
        next.add(suggestionId);
      }
      return next;
    });
    setRejectedIds((prev) => {
      const next = new Set(prev);
      next.delete(suggestionId);
      return next;
    });
  };

  const handleToggleReject = (suggestionId: string) => {
    if (rejectedIds.has(suggestionId)) {
      if (rejectTimersRef.current[suggestionId]) {
        clearTimeout(rejectTimersRef.current[suggestionId]);
        delete rejectTimersRef.current[suggestionId];
      }
      setRejectedIds((prev) => {
        const next = new Set(prev);
        next.delete(suggestionId);
        return next;
      });
    } else {
      setRejectedIds((prev) => {
        const next = new Set(prev);
        next.add(suggestionId);
        return next;
      });
      setAcceptedIds((prev) => {
        const next = new Set(prev);
        next.delete(suggestionId);
        return next;
      });

      if (rejectTimersRef.current[suggestionId]) {
        clearTimeout(rejectTimersRef.current[suggestionId]);
      }

      rejectTimersRef.current[suggestionId] = setTimeout(() => {
        setSuggestions((prev) => {
          // 却下はペア単位で記録する。**提案の一覧を保存し直すのではない。**
          // 一覧を保存すると、再実行のたびに却下が消えて同じ提案が戻る。
          const rejected = prev.find((s) => s.id === suggestionId);
          if (rejected) {
            invoke('dismiss_tag_suggestion', {
              method,
              targetId: rejected.target_tag.id,
              memberIds: rejected.source_tags.map((t) => t.id),
            }).catch((e) => console.error('Failed to dismiss suggestion:', e));
          }
          return prev.filter((s) => s.id !== suggestionId);
        });
        setRejectedIds((prev) => {
          const next = new Set(prev);
          next.delete(suggestionId);
          return next;
        });
        delete rejectTimersRef.current[suggestionId];
      }, 3000);
    }
  };

  // 承認されたグループ提案を一括適用
  /** 承認された提案を `{ target_id, source_ids }` の並びに変換する */
  const buildMergePlan = async (
    toApply: MergeSuggestion[]
  ): Promise<{ target_id: number; source_ids: number[] }[]> => {
    const items: { target_id: number; source_ids: number[] }[] = [];
    for (const sug of toApply) {
      let masterId = selectedMasterTagIds[sug.id] ?? sug.target_tag.id;

      // 手入力のマスタータグ (-1) は先に作る
      if (masterId === -1) {
        const customInfo = customMasterTags[sug.id];
        if (customInfo && customInfo.name.trim()) {
          const createdTag = await invoke<TagItem>('get_or_create_tag', {
            name: customInfo.name.trim(),
            nameJa: customInfo.nameJa.trim() || undefined,
          });
          masterId = createdTag.id;
        } else {
          masterId = sug.target_tag.id;
        }
      }

      const excludedSet = excludedTagIds[sug.id] || new Set<number>();
      const sourceIds = [sug.target_tag, ...sug.source_tags]
        .filter((t) => t.id !== masterId && !excludedSet.has(t.id))
        .map((t) => t.id);
      if (sourceIds.length > 0) items.push({ target_id: masterId, source_ids: sourceIds });
    }
    return items;
  };

  /**
   * 承認された提案をまとめて適用する。
   *
   * **提案ごとに `merge_tags` を呼んではいけない。** 呼ぶ順で結果が変わるうえ、
   * `merge_tags` は削除済みIDを渡されてもエラーを返さないので、
   * ユーザーには成功と出たまま中身だけが変わる。
   * `apply_tag_merges` は写像を解決してから最終的な統合先ごとに1回だけ実行する。
   */
  const handleApplySelectedSuggestions = async () => {
    const toApply = suggestions.filter((s) => acceptedIds.has(s.id) && !rejectedIds.has(s.id));
    if (toApply.length === 0) return;

    setApplyingMerges(true);
    try {
      setApplyProgressText(t('tag_modal.label_building_plan', 'Building the plan...'));
      const items = await buildMergePlan(toApply);
      if (items.length === 0) return;

      // **取り消せない操作なので、消える提案の数を先に見せる。**
      // 適用後に知らせても手遅れになる
      const invalidated = await invoke<[string, number][]>('count_invalidated_suggestions', {
        items,
        suggestions,
      });
      const lost = invalidated.reduce((n, [, c]) => n + c, 0);
      if (lost > 0) {
        const detail = invalidated.map(([rule, c]) => `${t(ruleLabelKey(rule), rule)}: ${c}${t('tag_modal.label_tag_count_unit', '')}`).join('\n');
        const ok = await ask(
          t('tag_modal.apply_confirm', '', { count: items.length, lost }) + `\n${detail}`,
          { title: t('tag_modal.label_apply_title', 'Apply consolidation'), kind: 'warning' }
        );
        if (!ok) return;
      }

      setApplyProgressText(t('tag_modal.label_applying_count', 'Applying {n}...', { n: items.length }));
      const result = await runExclusive('applying_tag_merges', () =>
        invoke<{
          merged_tags: number;
          targets: number;
          conflicts: { tag_id: number; target_ids: number[] }[];
        }>('apply_tag_merges', { items })
      );

      // **競合があると何も適用されない。** どのタグが競合したかを名前で見せる
      if (result.conflicts.length > 0) {
        const nameOf = (id: number) => tags.find((t) => t.id === id)?.name ?? `#${id}`;
        const lines = result.conflicts.map(
          (c) => `・${nameOf(c.tag_id)} → ${c.target_ids.map(nameOf).join(' / ')}`
        );
        await showMessage(
          t('tag_modal.conflict_message', '', { list: lines.join('\n') }),
          { title: t('tag_modal.label_conflict_title', 'Conflicting targets'), kind: 'error' }
        );
        return;
      }

      // タグ一覧を読み直し、保存済みの判定から提案を組み直す。
      // **必ず読み直すこと** — 統合処理は使われなくなったタグも消すので、
      // 手元のタグ一覧は適用後に必ず古くなる
      await onDataChanged?.();
      await reloadSuggestions();

      setSuccessToast(
        t('tag_modal.toast_merged', '', { merged: result.merged_tags, targets: result.targets })
      );
      setTimeout(() => setSuccessToast(null), 3000);
    } catch (e) {
      console.error('Failed to apply merges:', e);
      await showMessage(t('tag_modal.apply_failed', '', { error: String(e) }), { title: t('tag_modal.label_apply_title', 'Apply consolidation'), kind: 'error' });
    } finally {
      setApplyingMerges(false);
      setApplyProgressText('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 relative">
        {/* Toast Alert Notification */}
        {successToast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-70 bg-emerald-600 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-xl border border-emerald-400/50 flex items-center gap-2 animate-in fade-in zoom-in-95">
            <CheckCircle2 className="w-4 h-4" />
            <span>{successToast}</span>
          </div>
        )}

        {/* Header */}
        <div className="p-4 bg-slate-950/80 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitMerge className="w-5 h-5 text-indigo-400" />
            <h2 className="text-sm font-bold text-white">{t('tag_modal.label_title', 'Tag Management & Group Consolidation')}</h2>
            {/* この画面で何が起きるか。**統合の代償（多様性が減る・取り消せない）まで書く。**
                得だけを書くと、戻せない操作を軽い気持ちで実行させることになる */}
            <TooltipHelp text={t('tag_modal.screen_help', '')} width="w-96" />
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selection & Scanning Action Bar */}
        <div className="px-4 py-2.5 bg-slate-900 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-white/5">
            <button
              onClick={() => {
                markPerf('tab:all');
                startTabTransition(() => setActiveTab('all'));
              }}
              className={`px-3 py-1 text-xs font-semibold rounded-lg transition cursor-pointer whitespace-nowrap ${
                activeTab === 'all'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('tag_modal.label_tab_all', 'All Free Tags')} ({freeTags.length})
            </button>
            <button
              onClick={() => {
                markPerf('tab:suggestions');
                startTabTransition(() => setActiveTab('suggestions'));
              }}
              className={`px-3 py-1 text-xs font-semibold rounded-lg transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                activeTab === 'suggestions'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              {t('tag_modal.label_tab_proposals', 'AI Suggestions')} ({suggestions.length})
            </button>
          </div>

          {/* 方式の切り替えと実行は **AI提案タブのものだけ**。
              一覧タブにも出ていると、一覧の表示に効く切り替えに見える。
              結果は方式ごとに別に保存されているので、切り替えても回し直しは要らない
              （保存済みの判定から組み直す） */}
          {activeTab === 'suggestions' && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-white/5">
                {METHODS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setMethod(m.id)}
                    disabled={scanningSuggestions || loadingSuggestions}
                    title={t(m.hintKey, m.hintDefault)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition cursor-pointer disabled:opacity-50 whitespace-nowrap ${
                      method === m.id
                        ? 'bg-slate-700 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t(m.labelKey, m.labelDefault)}
                  </button>
                ))}
              </div>

              <button
                onClick={() => handleScanSuggestions(false)}
                disabled={scanningSuggestions || applyingMerges || isScanning || exclusive.blocked}
                title={exclusive.reason}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-900/30 cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                {scanningSuggestions ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                <span>{t('tag_modal.label_btn_scan', 'Scan Similar Tags')}</span>
              </button>
            </div>
          )}
        </div>

        {/* 読み込み中の帯。**タブの切り替えと方式の切り替えの両方で出す。**
            どちらも「押したのに何も起きない」時間があり、遅いPCほど長くなる。
            高さを持つ要素にすると出入りのたびに下の内容がずれるので、
            1px の線をタブ行の直下に重ねる */}
        <div
          className="relative h-px shrink-0"
          aria-hidden={!isTabPending && !loadingSuggestions && !isListStale}
        >
          {(isTabPending || loadingSuggestions || isListStale) && (
            <div className="absolute inset-x-0 top-0 h-px overflow-hidden bg-indigo-500/20">
              <div className="h-full w-1/4 bg-indigo-400 animate-loading-slide" />
            </div>
          )}
        </div>

        {/* タブごとの案内。**常設の1行。**
            ? に隠すと、初見のユーザーには存在ごと気付かれない。
            細かい規則（却下の3秒、方式ごとに保存が独立、など）は ? に逃がす */}
        <div className="px-4 py-2 bg-slate-950/40 border-b border-white/5 flex items-center gap-1.5 shrink-0">
          <Info className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          <span className="text-[11px] text-slate-300 leading-snug">
            {activeTab === 'all'
              ? t('tag_modal.guide_all', '')
              : t('tag_modal.guide_proposals', '')}
          </span>
          <TooltipHelp
            text={
              activeTab === 'all'
                ? t('tag_modal.guide_all_help', '')
                : t('tag_modal.guide_proposals_help', '')
            }
            width="w-96"
          />
        </div>

        {/* 実行の状態。**1本にまとめてある。**
            以前は「実行中」「未判定」「最初から作り直す」が別々の帯として縦に積み重なり、
            一覧に使える高さがそのぶん減っていた。同時に意味を持つのは常に1つなので、
            状態を1行、操作を右端に寄せる。 */}
        {activeTab === 'suggestions' && (scanningSuggestions || scanProgress || runStatus) && (
          <div
            className={`mx-4 mt-3 rounded-xl px-3 py-2 text-xs flex items-center justify-between gap-3 shrink-0 border ${
              scanningSuggestions || scanProgress
                ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-200'
                : runStatus && runStatus.unjudged_count > 0
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                : 'bg-slate-950/40 border-white/5 text-slate-400'
            }`}
          >
            <span className="flex items-center gap-2 min-w-0">
              {scanningSuggestions && <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />}
              <span className="truncate">{runStatusText}</span>
            </span>

            <span className="flex items-center gap-3 shrink-0">
              {/* 未判定があるときだけ。中断ぶん・増えたタグ・失敗したチャンクを一括で拾う */}
              {!scanningSuggestions && runStatus && runStatus.unjudged_count > 0 && (
                <button
                  onClick={() => handleScanSuggestions(false)}
                  disabled={applyingMerges || isScanning || exclusive.blocked}
                  title={exclusive.reason}
                  className="px-2.5 py-1 bg-amber-600/80 hover:bg-amber-500 text-white rounded-lg text-xs font-bold transition cursor-pointer disabled:opacity-50"
                >
                  {t('tag_modal.label_btn_resume', 'Continue')}
                </button>
              )}
              {/* 全件やり直し。段1のカテゴリごと引き直したいときの唯一の手段 */}
              {!scanningSuggestions && method === 'hypernym' && runStatus && (
                <button
                  onClick={() => handleScanSuggestions(true)}
                  disabled={applyingMerges || isScanning || exclusive.blocked}
                  title={
                    exclusive.reason ??
                    t('tag_modal.label_title_rescan', 'Discard saved judgements and re-extract hypernyms')
                  }
                  className="text-[11px] text-slate-400 hover:text-slate-200 underline underline-offset-2 cursor-pointer disabled:opacity-50"
                >
                  {t('tag_modal.label_btn_rescan', 'Rebuild from scratch')}
                </button>
              )}
            </span>
          </div>
        )}

        {/* Warning Banner when analysis is running in background */}
        {isScanning && (
          <div className="mx-4 mt-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-xs flex items-center gap-2 animate-in fade-in shrink-0">
            <RefreshCw className="w-4 h-4 animate-spin shrink-0 text-amber-400" />
            <span>{t('tag_modal.scan_warning', 'Currently, image/media analysis is running in the background, so tag editing/merging is temporarily locked.')}</span>
          </div>
        )}

        {/* Tab 1: All Tags List */}
        {activeTab === 'all' && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Search & Manual Merge Toolbar */}
            <div className="p-3 bg-slate-900/50 border-b border-white/5 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-1 min-w-[240px]">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('tag_modal.label_filter_placeholder', 'Filter tags...')}
                    className="w-full bg-slate-950 border border-white/10 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
                  />
                </div>

                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="bg-slate-950 border border-white/10 text-xs text-slate-300 px-2.5 py-1.5 rounded-xl focus:outline-none focus:border-indigo-500/50 shrink-0 font-medium"
                >
                  <option value="count_desc">{t('tag_modal.label_sort_label','Sort')}: {t('tag_modal.label_sort_count_desc','Count (High → Low)')}</option>
                  <option value="count_asc">{t('tag_modal.label_sort_label','Sort')}: {t('tag_modal.label_sort_count_asc','Count (Low → High)')}</option>
                  <option value="alpha_asc">{t('tag_modal.label_sort_label','Sort')}: {t('tag_modal.label_sort_name_asc','Name (A → Z)')}</option>
                  <option value="ja_asc">{t('tag_modal.label_sort_label','Sort')}: {t('tag_modal.label_sort_ja_asc','Japanese')}</option>
                </select>

                {/* タグ種別フィルタ: 基本語 / 記述的タグ */}
                <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-white/5 shrink-0">
                  {(['all', 'basic', 'descriptive'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setKindFilter(k)}
                      className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg transition cursor-pointer ${
                        kindFilter === k ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {k === 'all'
                        ? t('tag_modal.label_kind_all', 'すべて')
                        : k === 'basic'
                        ? t('tag_modal.label_kind_basic', '基本語')
                        : t('tag_modal.label_kind_descriptive', '修飾語')}
                    </button>
                  ))}
                </div>
              </div>

              {selectedTagIds.length >= 2 && (
                <div className="flex items-center gap-2 bg-indigo-950/60 border border-indigo-500/40 p-1.5 rounded-xl animate-in fade-in">
                  <span className="text-[11px] text-indigo-300 font-semibold px-1">
                    {t('tag_modal.label_selected_count','Selected')} ({selectedTagIds.length})
                  </span>
                  <select
                    value={targetTagId || ''}
                    onChange={(e) => setTargetTagId(Number(e.target.value))}
                    className="bg-slate-900 text-xs text-white border border-white/10 rounded-lg px-2 py-1 focus:outline-none"
                  >
                    <option value="">{t('tag_modal.label_choose_master','-- Choose the tag to keep --')}</option>
                    {freeTags
                      .filter((t) => selectedTagIds.includes(t.id))
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name_ja ? `${t.name_ja} (${t.name})` : t.name} ({t.count ?? 0})
                        </option>
                      ))}
                  </select>
                  <button
                    onClick={handleExecuteManualMerge}
                    disabled={!targetTagId || applyingMerges || isScanning || exclusive.blocked}
                    title={exclusive.reason}
                    className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition disabled:opacity-40 cursor-pointer flex items-center gap-1"
                  >
                    {applyingMerges && <RefreshCw className="w-3 h-3 animate-spin" />}
                    <span>{t('tag_modal.label_btn_merge_manual','Consolidate manually')}</span>
                  </button>
                </div>
              )}
            </div>

            {/* List */}
            <div ref={tagScrollRef} className="flex-1 overflow-y-auto p-3 space-y-1 min-h-0">
              {sortedTags.slice(0, visibleTagCount).map((t) => {
                const isEditing = editingTagId === t.id;
                const isSelected = selectedTagIds.includes(t.id);
                return (
                  <div
                    key={t.id}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl border transition ${
                      isSelected
                        ? 'bg-indigo-900/30 border-indigo-500/50'
                        : 'bg-slate-950/60 border-white/5 hover:border-white/10'
                    }`}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedTagIds((prev) => [...prev, t.id]);
                          } else {
                            setSelectedTagIds((prev) => prev.filter((id) => id !== t.id));
                            if (targetTagId === t.id) setTargetTagId(null);
                          }
                        }}
                        className="rounded border-white/20 bg-slate-900 text-indigo-600 focus:ring-0 cursor-pointer"
                      />

                      {isEditing ? (
                        <div className="flex items-center gap-2 flex-1 max-w-md">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder={translate('tag_modal.label_placeholder_name_en', 'English name')}
                            className="bg-slate-900 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none"
                          />
                          <input
                            type="text"
                            value={editNameJa}
                            onChange={(e) => setEditNameJa(e.target.value)}
                            placeholder={translate('tag_modal.label_placeholder_name_ja', 'Japanese name')}
                            className="bg-slate-900 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none"
                          />
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 truncate">
                          <span
                            onClick={() => handleTriggerSearchFilter(t.name)}
                            className="font-mono font-semibold text-xs text-indigo-300 hover:text-indigo-200 cursor-pointer hover:underline"
                            title={translate('tag_modal.label_title_search_tag', 'Click to search this tag in gallery')}
                          >
                            #{t.name}
                          </span>
                          {t.name_ja ? (
                            <span
                              onClick={() => handleTriggerSearchFilter(t.name_ja || t.name)}
                              className="text-xs text-slate-300 bg-slate-800 px-2 py-0.5 rounded-md border border-white/5 font-medium hover:text-white cursor-pointer hover:underline"
                              title={translate('tag_modal.label_title_search_tag', 'Click to search this tag in gallery')}
                            >
                              {t.name_ja}
                            </span>
                          ) : (
                            // 似ているメディアの検索は name_ja をベクトル化する。
                            // 未設定だと英語名にフォールバックするが、英語名は
                            // normalize_tag_en の単数形化で壊れていることがある
                            // （lens -> len）。直せる場所で気付けるようにしておく。
                            <span
                              className="text-[10px] text-amber-300/90 bg-amber-950/30 px-1.5 py-0.5 rounded border border-amber-500/25 font-medium"
                              title={translate(
                                'tag_modal.no_name_ja_help',
                                '日本語名が未設定です。似ているメディアの検索では英語名で代替されるため、精度が落ちることがあります。',
                              )}
                            >
                              {translate('tag_modal.label_no_name_ja', '日本語名なし')}
                            </span>
                          )}
                          <span className="text-[11px] font-bold text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-white/5">
                            ({t.count ?? 0})
                          </span>
                          {t.kind === 'descriptive' && (
                            <span className="text-[9px] font-bold text-slate-500 bg-slate-900/60 px-1.5 py-0.5 rounded border border-white/5 uppercase tracking-wide">
                              {translate('tag_modal.label_kind_descriptive', 'Descriptive')}
                            </span>
                          )}

                          {/* 目のアイコンで開くまで中身が分からないと、
                              どのタグを統合してよいか判断できない。AI提案のカードと同じ見せ方に揃える */}
                          {tagThumbs[t.id] && tagThumbs[t.id].length > 0 && (
                            <SampleThumbStack
                              thumbnails={tagThumbs[t.id]}
                              totalImagesCount={t.count ?? 0}
                            />
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      {onSelectTagFilter && (
                        <button
                          onClick={() =>
                            handleTriggerSearchFilter(language === 'ja' && t.name_ja ? t.name_ja : t.name)
                          }
                          className="p-1.5 text-slate-400 hover:text-indigo-400 hover:bg-slate-800 rounded-lg transition cursor-pointer"
                          title={translate('tag_modal.label_title_filter', 'Filter gallery by this tag')}
                        >
                          <Filter className="w-3.5 h-3.5" />
                        </button>
                      )}

                      <button
                        onClick={() => handleOpenTagPreview(t)}
                        className="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded-lg transition cursor-pointer"
                        title={translate('tag_modal.label_title_preview', 'Preview media with this tag')}
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>

                      {isEditing ? (
                        <button
                          onClick={() => handleSaveEdit(t)}
                          className="p-1.5 bg-emerald-600 text-white hover:bg-emerald-500 rounded-lg transition cursor-pointer"
                          title={translate('tag_modal.label_title_save', 'Save')}
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStartEdit(t)}
                          className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
                          title={translate('tag_modal.label_title_edit', 'Edit tag name & translation')}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* 末尾に来たら次を足す。上限ではないので全件に到達できる */}
              <div ref={tagSentinelRef} className="h-px" />
            </div>
          </div>
        )}

        {/* Tab 2: Group Proposals & Review */}
        {activeTab === 'suggestions' && (
          <div className="flex-1 flex flex-col min-h-0">
            {loadingSuggestions ? (
              // **空表示にしない。** 読み込み中に「提案はまだありません」を出すと、
              // 0件だったのか待っているだけなのかが区別できない
              <div className="flex-1 overflow-hidden p-4 space-y-3">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                  <span>{t('tag_modal.label_loading_suggestions', 'Loading suggestions...')}</span>
                </div>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-28 rounded-2xl border border-white/5 bg-slate-950/40 animate-pulse-subtle"
                  />
                ))}
              </div>
            ) : suggestions.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <Sparkles className="w-10 h-10 text-indigo-400/50 mb-2" />
                <h3 className="text-sm font-semibold text-slate-300">{t('tag_modal.label_proposals_empty_title','No suggestions yet')}</h3>
                <p className="text-xs text-slate-500 max-w-sm mt-1">
                  {t(
                    'tag_modal.proposals_empty_body',
                    'Press "Scan Similar Tags" to look for spelling variants, singular/plural forms and tags close in meaning, and list them as consolidation candidates.',
                  )}
                </p>
              </div>
            ) : (
              <>
                <div className="p-3 bg-slate-950/80 border-b border-white/10 flex items-center justify-between">
                  <span className="text-xs text-slate-300 font-medium">
                    {t('tag_modal.label_proposals_summary','Selected suggestions')} ({acceptedIds.size} / {suggestions.length})
                  </span>

                  <button
                    onClick={handleApplySelectedSuggestions}
                    disabled={acceptedIds.size === 0 || applyingMerges || isScanning || exclusive.blocked}
                    title={exclusive.reason}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-emerald-900/30 cursor-pointer disabled:opacity-40"
                  >
                    {applyingMerges ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>{applyProgressText || t('tag_modal.label_btn_applying','Consolidating...')}</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-4 h-4" />
                        <span>{t('tag_modal.label_btn_apply_merges','Consolidate selected')} ({acceptedIds.size})</span>
                      </>
                    )}
                  </button>
                </div>

                <div ref={sugScrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
                  {sortedSuggestions.slice(0, visibleSuggestionCount).map((sug) => {
                    if (!sug || !sug.target_tag) return null;
                    const sources = Array.isArray(sug.source_tags)
                      ? sug.source_tags.filter(Boolean)
                      : (sug as any).source_tag
                      ? [(sug as any).source_tag]
                      : [];
                    const allMembers = [sug.target_tag, ...sources];
                    const currentMasterId = selectedMasterTagIds[sug.id] ?? sug.target_tag.id;
                    const isCustomMaster = currentMasterId === -1;
                    const masterTag = allMembers.find((t) => t && t.id === currentMasterId) || sug.target_tag;
                    const sourceTags = allMembers.filter((t) => t && t.id !== currentMasterId);

                    const customInfo = customMasterTags[sug.id] || { name: '', nameJa: '' };
                    const excludedSet = excludedTagIds[sug.id] || new Set();
                    const activeSourceCount = sourceTags.filter((t) => !excludedSet.has(t.id)).length;

                    const isAccepted = acceptedIds.has(sug.id) && !rejectedIds.has(sug.id);
                    const isRejected = rejectedIds.has(sug.id);

                    return (
                      <div
                        key={sug.id}
                        className={`p-4 rounded-2xl border transition-all ${
                          isAccepted
                            ? 'bg-slate-950/90 border-indigo-500/50 shadow-lg'
                            : isRejected
                            ? 'bg-slate-950/40 border-red-500/30 opacity-60'
                            : 'bg-slate-950/60 border-white/10'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div className="flex items-center gap-2 max-w-[65%] min-w-0 flex-wrap">
                            {/* **どの規則で候補になったかを個別に出す。**
                                これが無いと、提案が妥当かどうかを判断する材料が無い。
                                複数該当は確度が高いので、件数も併記する */}
                            {sug.rules && sug.rules.length > 0 ? (
                              sug.rules.map((r) => (
                                <span
                                  key={r}
                                  title={r}
                                  className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full text-[11px] font-semibold shrink-0"
                                >
                                  {t(ruleLabelKey(r), r)}
                                </span>
                              ))
                            ) : (
                              <span
                                className="px-2.5 py-0.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full text-[11px] font-semibold truncate"
                                title={sug.reason}
                              >
                                {sug.reason}
                              </span>
                            )}
                            {sug.rules && sug.rules.length > 1 && (
                              <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full text-[11px] font-bold shrink-0">
                                {t('tag_modal.label_rules_matched', 'matches {n} rules', { n: sug.rules.length })}
                              </span>
                            )}
                            <span className="text-xs text-slate-400 shrink-0">
                              ({t('tag_modal.label_member_count', '{n} tags', { n: allMembers.length })})
                            </span>

                            {/* サンプルサムネイルのアバタースタック表示 & ホバーフローティング拡大 & 続きありインジケーター */}
                            {sug.sample_thumbnails && sug.sample_thumbnails.length > 0 && (
                              <SampleThumbStack
                                thumbnails={sug.sample_thumbnails}
                                totalImagesCount={sug.total_images_count}
                              />
                            )}
                          </div>

                          {/* Accept / Reject Buttons */}
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleToggleAccept(sug.id)}
                              className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                                isAccepted
                                  ? 'bg-emerald-600 text-white shadow'
                                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              <ThumbsUp className="w-3.5 h-3.5" />
                              {t('tag_modal.label_btn_accept', 'Approve')}
                            </button>

                            <button
                              onClick={() => handleToggleReject(sug.id)}
                              title={isRejected ? t('tag_modal.reject_cancel_hint','') : t('tag_modal.reject_hint','')}
                              className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                                isRejected
                                  ? 'bg-red-600 text-white shadow animate-pulse'
                                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              <ThumbsDown className="w-3.5 h-3.5" />
                              {isRejected ? t('tag_modal.label_btn_reject_pending','Reject (removed in 3s)') : t('tag_modal.label_btn_reject','Reject')}
                            </button>
                          </div>
                        </div>

                        {/* Group Selection Area */}
                        <div className="bg-slate-900/90 p-3 rounded-xl border border-white/5 space-y-3">
                          {/* Master Selection Dropdown & Custom Input */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] text-emerald-400 font-bold uppercase tracking-wider shrink-0">
                                  {t('tag_modal.label_keep_master', 'Tag to keep')}
                                </span>
                                {!isCustomMaster && (
                                  <button
                                    onClick={() => handleOpenTagPreview(masterTag)}
                                    className="p-1 text-slate-400 hover:text-indigo-300 rounded hover:bg-slate-800 transition cursor-pointer"
                                    title={t('tag_modal.label_title_preview_master', 'Preview media with the tag to keep')}
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>

                              <select
                                value={currentMasterId}
                                onChange={(e) => handleSelectMasterTag(sug.id, Number(e.target.value))}
                                className="bg-slate-950 border border-indigo-500/40 text-xs font-bold text-white px-3 py-1.5 rounded-lg focus:outline-none flex-1 max-w-md"
                              >
                                {allMembers.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    #{m.name} {m.name_ja ? `(${m.name_ja})` : ''} ({m.count ?? 0})
                                  </option>
                                ))}
                                <option value={-1}>
                                  ✏️ {t('tag_modal.label_custom_master', 'Enter my own')}
                                </option>
                              </select>
                            </div>

                            {/* Custom Hand-typed Inputs */}
                            {isCustomMaster && (
                              <div className="flex items-center gap-2 pl-4 pt-1 animate-in fade-in zoom-in-95">
                                <PlusCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                                <input
                                  type="text"
                                  value={customInfo.name}
                                  onChange={(e) => handleCustomMasterTagChange(sug.id, 'name', e.target.value)}
                                  placeholder={t('tag_modal.label_placeholder_custom_en','English name (e.g. drink)')}
                                  className="bg-slate-950 border border-emerald-500/50 rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none flex-1 font-mono"
                                />
                                <input
                                  type="text"
                                  value={customInfo.nameJa}
                                  onChange={(e) => handleCustomMasterTagChange(sug.id, 'nameJa', e.target.value)}
                                  placeholder={t('tag_modal.label_placeholder_custom_ja','Japanese name')}
                                  className="bg-slate-950 border border-emerald-500/50 rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none flex-1"
                                />
                              </div>
                            )}
                          </div>

                          {/* Sources to be Merged & Removed */}
                          <div className="flex items-start gap-2 pt-2 border-t border-white/5">
                            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider shrink-0 mt-1">
                              {t('tag_modal.label_merge_and_remove','Tags to consolidate and remove')} ({activeSourceCount})
                            </span>
                            <div className="flex flex-wrap gap-1.5 flex-1">
                              {sourceTags.map((st) => {
                                const isExcluded = excludedSet.has(st.id);
                                return (
                                  <div
                                    key={st.id}
                                    // **打ち消し線と減光はタグ名だけに掛ける。**
                                    // ここに置くと「戻す」ボタンと目のアイコンにも継承され、
                                    // 押せないボタンに見える
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono border transition ${
                                      isExcluded
                                        ? 'bg-slate-950/40 border-white/5'
                                        : 'bg-slate-950 text-slate-300 border-white/10'
                                    }`}
                                  >
                                    <span className={isExcluded ? 'line-through text-slate-600 opacity-60' : ''}>
                                      #{st.name}
                                      {st.name_ja && (
                                        <span className="text-[10px] font-normal text-slate-500 ml-1 no-underline">
                                          ({st.name_ja})
                                        </span>
                                      )}
                                      <span className="text-[10px] text-slate-500 ml-1 font-sans">
                                        ({st.count ?? 0})
                                      </span>
                                    </span>

                                    {/* Preview Button */}
                                    <button
                                      onClick={() => handleOpenTagPreview(st)}
                                      className="text-slate-400 hover:text-indigo-300 transition cursor-pointer"
                                      title={translate('tag_modal.label_title_preview', 'Preview media with this tag')}
                                    >
                                      <Eye className="w-3 h-3" />
                                    </button>

                                    {/* Exclude / Include Toggle Button */}
                                    <button
                                      onClick={() => handleToggleExcludeTag(sug.id, st.id)}
                                      className={`p-0.5 rounded transition cursor-pointer text-[10px] font-bold ${
                                        isExcluded
                                          ? 'text-emerald-400 hover:bg-emerald-950/50'
                                          : 'text-red-400 hover:bg-red-950/50'
                                      }`}
                                      title={
                                        isExcluded
                                          ? t('tag_modal.label_title_include', 'Include back in the consolidation')
                                          : t('tag_modal.label_title_exclude', 'Exclude from the consolidation')
                                      }
                                    >
                                      {isExcluded ? t('tag_modal.label_btn_include','Include') : t('tag_modal.label_btn_exclude','Exclude')}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {/* 末尾に来たら次を足す。上限ではないので全件に到達できる */}
                  <div ref={sugSentinelRef} className="h-px" />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Image Preview Modal */}
      {previewTag && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="p-4 bg-slate-950 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-bold text-white">
                  {t('tag_modal.label_preview_title', 'Media with this tag')}{' '}
                  <span className="text-indigo-300 font-mono">#{previewTag.name}</span>
                  {previewTag.name_ja && <span className="text-slate-400 ml-1">({previewTag.name_ja})</span>}
                  <span className="text-indigo-400 ml-1">
                    ({previewTag.count ?? 0}
                    {t('tag_modal.label_tag_count_unit', '')})
                  </span>
                </h3>
              </div>
              <button
                onClick={() => setPreviewTag(null)}
                className="p-1 text-slate-400 hover:text-white rounded-lg transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body: Image Grid */}
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              {loadingPreview ? (
                <div className="flex items-center justify-center py-12 text-slate-400 text-xs">
                  <RefreshCw className="w-4 h-4 animate-spin mr-2 text-indigo-400" />
                  {t('tag_modal.label_preview_loading', 'Loading...')}
                </div>
              ) : previewMediaList.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-xs">
                  {t('tag_modal.preview_empty', 'No media currently carries this tag.')}
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {previewMediaList.map((media) => (
                    <TagPreviewCard
                      key={media.id}
                      media={media}
                      onClick={() => setPreviewMediaItem(media)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-3 bg-slate-950 border-t border-white/10 flex justify-end">
              <button
                onClick={() => setPreviewTag(null)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
              >
                {t('tag_modal.label_btn_close_preview', 'Close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* High-Res Media Preview / Video Player Overlay */}
      {previewMediaItem && (
        <div
          onClick={() => setPreviewMediaItem(null)}
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer animate-in fade-in duration-150 select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center justify-center"
          >
            {/\.(mp4|webm|mov|avi|mkv|flv|wmv)$/i.test(previewMediaItem.file_path) ? (
              <video
                src={convertFileSrc(previewMediaItem.file_path)}
                controls
                autoPlay
                className="max-w-full max-h-[80vh] rounded-2xl shadow-2xl border border-white/10"
              />
            ) : (
              <img
                src={
                  previewMediaItem.thumbnail_path
                    ? convertFileSrc(previewMediaItem.thumbnail_path)
                    : convertFileSrc(previewMediaItem.file_path)
                }
                alt={previewMediaItem.file_path.split(/[/\\]/).pop()}
                className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl border border-white/10"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = convertFileSrc(previewMediaItem.file_path);
                }}
              />
            )}
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xs text-slate-300 font-mono bg-slate-900/80 px-3 py-1 rounded-lg border border-white/10 truncate max-w-md">
                {previewMediaItem.file_path.split(/[/\\]/).pop()}
              </span>
              <button
                onClick={() => setPreviewMediaItem(null)}
                className="text-xs text-slate-300 hover:text-white bg-slate-800 px-3 py-1 rounded-lg border border-white/10 transition cursor-pointer"
              >
                {t('tag_modal.label_btn_close', 'Close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ホバー時の拡大表示は SampleThumbStack が body へ portal する。
          ここに置くと、サムネの上をマウスが通るたびにモーダル全体が再描画される */}
    </div>
  );
};
