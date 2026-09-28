import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  EmbeddingCleanupResult,
  EmbeddingDiagnostics,
  EmbeddingProgressPayload,
  EmbeddingStatus,
  EmbeddingStorageInfo,
} from '../types';
import { runBackground, runExclusive } from './useBusy';

/**
 * 概念スペクトラム検索（タグのベクトル化）まわりの状態と操作。
 *
 * **設定画面の他の項目と性質が違う。** 他は「値を入れて保存する」だけだが、
 * ここは生成・計測・削除・破棄という実行を伴い、それぞれ進捗と結果を持つ。
 * 14個の state が設定画面本体に混ざっていたので分けた。
 *
 * 保存そのものは呼び出し側が持つ（他の設定とまとめて1往復で書くため）。
 * ここが返すのは「保存する値」と「実行する操作」だけ。
 */
export function useEmbeddingSettings(settings: Record<string, string>) {
  // --- 保存される値 ---
  const [embeddingModel, setEmbeddingModel] = useState(
    settings.spectrum_embedding_model || 'bge-m3'
  );
  const [includeDescriptive, setIncludeDescriptive] = useState<boolean>(
    settings.spectrum_include_descriptive === 'true'
  );
  const [centering, setCentering] = useState<boolean>(settings.spectrum_centering !== 'false');

  // --- 実行の状態 ---
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [progress, setProgress] = useState<EmbeddingProgressPayload | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<EmbeddingDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [storageInfo, setStorageInfo] = useState<EmbeddingStorageInfo | null>(null);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  /** 削除・破棄の実行結果。件数と解放量を出さないと、押しても何が起きたか分からない */
  const [cleanupResult, setCleanupResult] = useState<EmbeddingCleanupResult | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  /** 設定を開いたときと、実行のたびに取り直す */
  const refreshStatus = async () => {
    try {
      setStatus(await invoke<EmbeddingStatus>('get_embedding_status'));
    } catch (e) {
      setError(String(e));
    }
    try {
      setStorageInfo(await invoke<EmbeddingStorageInfo>('get_embedding_storage_info'));
    } catch {
      // 保存領域の情報は補助的なので、取れなくても他の表示は続ける
      setStorageInfo(null);
    }
  };

  /** 保存済みの値を画面に反映し直す（設定を開き直したとき用） */
  const syncFromSettings = (next: Record<string, string>) => {
    if (next.spectrum_embedding_model) setEmbeddingModel(next.spectrum_embedding_model);
    if (next.spectrum_include_descriptive !== undefined) {
      setIncludeDescriptive(next.spectrum_include_descriptive === 'true');
    }
    if (next.spectrum_centering !== undefined) {
      setCentering(next.spectrum_centering !== 'false');
    }
  };

  /**
   * 未ベクトル化タグを一括生成する。
   * スキャン・タグマージと同じグローバルロックを共有するため、実行中は他の処理が弾かれる。
   */
  const generate = async () => {
    setError(null);
    setCleanupResult(null);
    setIsGenerating(true);
    setProgress({ total: 0, current: 0, status: 'running' });
    const unlistenPromise = listen<EmbeddingProgressPayload>('embedding_progress', (event) => {
      setProgress(event.payload);
    });
    try {
      await runBackground(() => invoke('generate_tag_embeddings'));
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsGenerating(false);
      unlistenPromise.then((unlisten) => unlisten());
    }
  };

  /** 使用中でないモデルのベクトルを削除する。自動では走らない（明示操作のみ） */
  const cleanup = async () => {
    setIsCleaningUp(true);
    setError(null);
    setCleanupResult(null);
    try {
      setCleanupResult(
        await runExclusive('processing_embeddings', () =>
          invoke<EmbeddingCleanupResult>('cleanup_unused_embeddings')
        )
      );
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsCleaningUp(false);
    }
  };

  const runDiagnostics = async () => {
    setDiagnosticsLoading(true);
    setError(null);
    try {
      // 画面上のトグルをそのまま渡す。保存済みの値で測ると、切り替えても
      // 結果が変わらず「効いていない」ように見える。
      // この2つはタグのベクトルに影響しないので、その場で測り直せる。
      setDiagnostics(
        await invoke<EmbeddingDiagnostics>('get_embedding_diagnostics', {
          centering,
          includeDescriptive,
        })
      );
    } catch (e) {
      setError(String(e));
      setDiagnostics(null);
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  /** 使用中のモデルのベクトルを破棄する（作り直したいとき用）。取り返しがつかないので確認を取る */
  const discard = async () => {
    setIsCleaningUp(true);
    setError(null);
    setCleanupResult(null);
    setConfirmDiscard(false);
    try {
      setCleanupResult(
        await runExclusive('processing_embeddings', () =>
          invoke<EmbeddingCleanupResult>('discard_embeddings')
        )
      );
      await refreshStatus();
      // 破棄後の分布を出したままにすると、消えたデータの結果を見せ続けることになる
      setDiagnostics(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsCleaningUp(false);
    }
  };

  return {
    embeddingModel,
    setEmbeddingModel,
    includeDescriptive,
    setIncludeDescriptive,
    centering,
    setCentering,
    status,
    progress,
    isGenerating,
    error,
    setError,
    diagnostics,
    diagnosticsLoading,
    storageInfo,
    isCleaningUp,
    cleanupResult,
    setCleanupResult,
    confirmDiscard,
    setConfirmDiscard,
    refreshStatus,
    syncFromSettings,
    generate,
    cleanup,
    runDiagnostics,
    discard,
  };
}

export type EmbeddingSettings = ReturnType<typeof useEmbeddingSettings>;
