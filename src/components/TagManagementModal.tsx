import React, { useState, useEffect, useTransition, useDeferredValue } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { runExclusive } from '../hooks/useBusy';
import { useLoadMoreOnScroll } from '../hooks/useLoadMoreOnScroll';
import { useExclusiveGuard } from '../hooks/useExclusiveGuard';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { listen } from '@tauri-apps/api/event';
// **`window.confirm` / `window.alert` は使わない。** Tauri の webview では表示されず、
// confirm は false 相当になるため、確認を出したつもりで何も起きない状態になる。
import { ask, message as showMessage } from '@tauri-apps/plugin-dialog';
import { X, GitMerge, Sparkles, RefreshCw, CheckCircle2, Info } from 'lucide-react';
import { TagItem, MergeSuggestion, MediaItem } from '../types';
import { useTranslation } from '../contexts/I18nContext';
import { TooltipHelp } from './TooltipHelp';
import { SuggestMethod, METHODS, ruleLabelKey } from '../constants/suggestMethods';
import { AllTagsTab } from './tagManagement/AllTagsTab';
import { SuggestionsTab } from './tagManagement/SuggestionsTab';
import { TagMediaListModal, MediaPreviewOverlay } from './tagManagement/TagMediaPreview';

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
   * Esc で閉じる。**重なっている層は手前から1つずつ**。
   *   画像の拡大 → タグのプレビュー → タグ管理そのもの
   *
   * 「変更途中」とみなすのは、閉じると消えるもの:
   *   タグ名の編集中 / 承認した提案 / 手動統合で選んだタグ
   */
  useEscapeToClose({
    open,
    onClose,
    onEscapeFirst: () => {
      if (previewMediaItem) {
        setPreviewMediaItem(null);
        return true;
      }
      if (previewTag) {
        setPreviewTag(null);
        return true;
      }
      return false;
    },
    isDirty: () =>
      editingTagId !== null || acceptedIds.size > 0 || selectedTagIds.length > 0,
    confirm: () =>
      ask(t('app.discard_confirm', ''), {
        title: t('app.label_discard_title', 'Discard changes'),
        kind: 'warning',
      }),
  });

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

  // **開くたびに `cleanup_missing_media` を呼んでいたのをやめた。**
  // 全メディアの `Path::exists()` を回るので冷えた状態で約3秒かかり、
  // その間ずっと提案の読み込みと DB を取り合っていた。実データでの回収は0件。
  // 掃除は「同期」の `cleanup_and_detect_moves` が引き継いでいる。

  /** 保存済みの判定と実行状態を読み直す */
  const reloadSuggestions = React.useCallback(async () => {
    const [cached, status] = await Promise.all([
      invoke<MergeSuggestion[]>('load_tag_suggestions_cache', { method }),
      invoke<typeof runStatus>('get_suggestion_run_status', { method }),
    ]);
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

    // **rAF を2段にしてペイント後まで待つ。** 1段目はコミット後・描画前に走るため、
    // ここで下ろさないと「読み込み中」が消えた後に固まって見える
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setLoadingSuggestions(false);
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
          <AllTagsTab
            sortedTags={sortedTags}
            freeTags={freeTags}
            visibleTagCount={visibleTagCount}
            search={search}
            setSearch={setSearch}
            sortBy={sortBy}
            setSortBy={setSortBy}
            kindFilter={kindFilter}
            setKindFilter={setKindFilter}
            editingTagId={editingTagId}
            editName={editName}
            setEditName={setEditName}
            editNameJa={editNameJa}
            setEditNameJa={setEditNameJa}
            onStartEdit={handleStartEdit}
            onSaveEdit={handleSaveEdit}
            selectedTagIds={selectedTagIds}
            setSelectedTagIds={setSelectedTagIds}
            targetTagId={targetTagId}
            setTargetTagId={setTargetTagId}
            onExecuteManualMerge={handleExecuteManualMerge}
            applyingMerges={applyingMerges}
            tagThumbs={tagThumbs}
            onOpenTagPreview={handleOpenTagPreview}
            onTriggerSearchFilter={handleTriggerSearchFilter}
            onSelectTagFilter={onSelectTagFilter}
            isScanning={!!isScanning}
            exclusive={exclusive}
            scrollRef={tagScrollRef}
            sentinelRef={tagSentinelRef}
          />
        )}

        {/* Tab 2: Group Proposals & Review */}
        {activeTab === 'suggestions' && (
          <SuggestionsTab
            sortedSuggestions={sortedSuggestions}
            suggestions={suggestions}
            visibleSuggestionCount={visibleSuggestionCount}
            acceptedIds={acceptedIds}
            rejectedIds={rejectedIds}
            onToggleAccept={handleToggleAccept}
            onToggleReject={handleToggleReject}
            selectedMasterTagIds={selectedMasterTagIds}
            onSelectMasterTag={handleSelectMasterTag}
            customMasterTags={customMasterTags}
            onCustomMasterTagChange={handleCustomMasterTagChange}
            excludedTagIds={excludedTagIds}
            onToggleExcludeTag={handleToggleExcludeTag}
            onOpenTagPreview={handleOpenTagPreview}
            onApplySelected={handleApplySelectedSuggestions}
            loadingSuggestions={loadingSuggestions}
            applyingMerges={applyingMerges}
            applyProgressText={applyProgressText}
            isScanning={!!isScanning}
            exclusive={exclusive}
            scrollRef={sugScrollRef}
            sentinelRef={sugSentinelRef}
          />
        )}
      </div>

      <TagMediaListModal
        tag={previewTag}
        media={previewMediaList}
        loading={loadingPreview}
        onClose={() => setPreviewTag(null)}
        onSelect={setPreviewMediaItem}
      />

      <MediaPreviewOverlay media={previewMediaItem} onClose={() => setPreviewMediaItem(null)} />

      {/* ホバー時の拡大表示は SampleThumbStack が body へ portal する。
          ここに置くと、サムネの上をマウスが通るたびにモーダル全体が再描画される */}
    </div>
  );
};
