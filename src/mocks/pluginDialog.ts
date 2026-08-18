// モック版 @tauri-apps/plugin-dialog。OSネイティブダイアログはブラウザで開けないため、
// 常にキャンセル相当(null)を返す。「フォルダ追加」ボタン自体の見た目確認が目的。
export async function open(_options?: unknown): Promise<string | string[] | null> {
  console.info('[mock dialog] open() called — native dialog is unavailable in mock mode');
  return null;
}

/** 確認ダイアログ。モックでは常に承諾扱いにして、後続の見た目を確認できるようにする */
export async function ask(msg: string, _options?: unknown): Promise<boolean> {
  console.info('[mock dialog] ask():', msg);
  return true;
}

/** 通知ダイアログ */
export async function message(msg: string, _options?: unknown): Promise<void> {
  console.info('[mock dialog] message():', msg);
}
