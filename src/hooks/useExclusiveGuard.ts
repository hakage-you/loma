import { useBusy } from './useBusy';
import { useTranslation } from '../contexts/I18nContext';

/**
 * 排他ロックを取る操作のボタンを、押せない間だけ押せなくするための判定。
 *
 * **`disabled` にするだけで終わらせないこと。** 理由を出さないと、
 * ユーザーには「ボタンが壊れた」ようにしか見えない。`reason` を `title` に入れる。
 *
 * 対象のコマンドは `src/constants/exclusiveCommands.ts`（`npm run check:exclusive` が
 * Rust の実体と突き合わせる）。
 */
export function useExclusiveGuard(): { blocked: boolean; reason?: string } {
  const { exclusiveBlocked, blockedByScan } = useBusy();
  const { t } = useTranslation();

  if (!exclusiveBlocked) return { blocked: false };
  return {
    blocked: true,
    reason: blockedByScan
      ? t(
          'busy.blocked_reason_scanning',
          '解析の実行中はタグやフォルダを変更できません。完了するか、停止してから操作してください。'
        )
      : t('busy.blocked_reason', '別の処理が実行中のため、いまは実行できません。'),
  };
}
