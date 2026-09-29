# Loma (Local Ollama Media Analyzer)

Loma は、ローカル VLM (画像解析用大規模言語モデル) を用いて、PC内の画像・動画メディアを自動的に解析・自動タグ付け・カテゴリ分類・高速検索できるデスクトップアプリケーションです。

解析は PC 上の [Ollama](https://ollama.com/) で行うため、写真がクラウドに送られることはありません。

![Loma のメイン画面](images/main-gallery.png)

- **ダウンロード**: [最新リリース](https://github.com/hakage-you/loma/releases/latest)（Windows 版）
- **ソースコード**: [GitHub リポジトリ](https://github.com/hakage-you/loma)

本ソフトウェアを実行・利用したことによって生じるいかなる損害・損失・不利益についても、開発者は一切の責任を負いません。あくまで自己責任でご利用ください。

---

## 使う人向け

- [使用方法ガイド](usage.md) — モデルの選び方から、スキャン・絞り込み・似ているメディアの検索まで、スクリーンショット付きで説明しています。
- Ollama・FFmpeg の準備は [README の「2. 動作環境のセットアップ」](https://github.com/hakage-you/loma#2-動作環境のセットアップ) を先にご確認ください。

## リリースノート

- [v0.5.0](release-notes/v0.5.0.md)
- [v0.4.2](release-notes/v0.4.2.md)
- [v0.4.1](release-notes/v0.4.1.md)
- [v0.4.0](release-notes/v0.4.0.md)

## 開発する人向け

- [VLM 連携の知見](vlm-notes.md) — Ollama と VLM を扱ううえで踏んだ落とし穴と実測データ。解析プロンプトを変更する前に読んでください。
- [リリース手順](release.md)
- ビルド方法は [README の「4. ビルドおよび開発手順」](https://github.com/hakage-you/loma#4-ビルドおよび開発手順) にあります。
