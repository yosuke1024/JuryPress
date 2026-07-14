---
title: Editorial Design System & PixApps Family Integration Specification
status: implemented
last_updated: 2026-07-14
---

# Editorial Design System & PixApps Family Integration Specification

本ドキュメントは、JuryPress のビジュアルアイデンティティ（温かみがあり信頼できる編集誌風のビジュアル、AI陪審員による評価メディア）および PixApps 製品ファミリーへの統合に関する永続的な仕様（SSOT）を定義します。

---

## 1. ビジュアル・デザインシステム

全体のデザインは、現代的な AI メディアにありがちな「紫・青のネオンカラーや光沢グラデーション、過剰なアニメーション」を完全に排除し、「歴史ある新聞・雑誌の判決書」を想起させる落ち着いたトーンをベースとしています。

### A. カラーパレット (CSS Tokens)
すべてのカラーは [tokens.css](file:///Users/suzukiyousuke/repo/JuryPress/src/styles/tokens.css) にて CSS 変数として定義され、一元管理されています。

| 役割 | 変数名 | カラーコード | 用途 |
|:---|:---|:---|:---|
| カンバス | `--color-canvas` | `#f4efe6` | サイト全体の基本背景（ウォームペーパー） |
| 表面色 | `--color-surface` | `#fffdf8` | 各種カードやリストの背景色 |
| 表面色（ミュート） | `--color-surface-muted`| `#faf7ef` | テーブルヘッダー等の薄い背景色 |
| テキスト（メイン） | `--color-ink` | `#17201d` | 主要な見出しや本文テキスト |
| テキスト（ミュート） | `--color-ink-muted` | `#5f6762` | サブタイトルや詳細テキスト |
| テキスト（弱） | `--color-ink-faint` | `#7a817c` | メタデータや小さな注意書き |
| アクセント色 | `--color-accent` | `#b85c2d` | スコア、CTAボタン、重要リンクなどの強調（オレンジブラウン） |
| ルール（薄） | `--color-rule` | `#d5ccbd` | セクション間などの細い罫線 |
| ルール（濃） | `--color-rule-strong` | `#aaa091` | 外枠や強調する二重線 |

### B. タイポグラフィ
* **Editorial Serif (見出し等)**: `Georgia, "Times New Roman", serif`
  * 記事のメインヘッドライン、各セクションの見出し、スコア数値、ブランドの Wordmark などに適用され、信頼感のあるジャーナリズムの雰囲気を醸成します。
* **Interface Sans (ナビゲーション・本文等)**: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
  * ナビゲーションリンク、補足説明、フォーム、ラベルなどに適用され、読みやすさを確保します。
* **Tabular Numbers (等幅数値)**:
  * スコア比較テーブル、VerdictPlate、ランキング一覧などの数値表示箇所において、数字のズレ（ガタつき）を防ぐため、`font-variant-numeric: tabular-nums;` をクラスとして適用しています。

### C. レイアウト幅の制限
コンテンツ幅は [global.css](file:///Users/suzukiyousuke/repo/JuryPress/src/styles/global.css) にて以下の3段階で厳密に制御されています。

* **`--width-page` (1180px)**: トップページ、審査員一覧、ランキングなど、複数カラムグリッドを使用する総合ページ用。
* **`--width-article` (760px)**: 記事詳細ページなど、メタデータと本文が並列するページ用。
* **`--width-reading` (680px)**: About、Privacy、Methodology などの長文読み物用。

---

## 2. PixApps 製品ファミリー統合 & アトリビューション仕様

JuryPress は PixApps の自律的なメディア実験プロジェクトであるため、製品間の遷移において以下のブランド仕様を満たす必要があります。

### A. ヘッダー (SiteHeader)
* 左側に `PixApps / JuryPress` のブランド階層を表示。`JuryPress` 部分を Editorial Wordmark として太字強調します。
* モバイル表示（`max-width: 768px`）の際は、JavaScript を一切ロードしない軽量なネイティブ `<details>` & `<summary>` タグを用いたアコーディオン型メニューを使用します。

### B. フッター (SiteFooter)
フッターには、プロジェクトの性質をユーザーに明確に伝えるため、以下の2つのアトリビューションを必ず含めます。
1. **運営元アトリビューション**: JuryPress が `PixApps` の自律メディア実験である旨。
2. **AIペルソナアトリビューション**: 審査員のAIペルソナ定義およびルーブリックが `Judgie-AI` から提供されている旨。

### C. トラッキング (UTMパラメータ)
PixApps や Judgie-AI など外部の自社ファミリー製品に遷移するすべてのリンクには、以下の構成の UTM パラメータを付与します。
* `utm_source=jurypress`
* `utm_medium=referral`
* `utm_campaign=product_ecosystem`
* `utm_content={リンクが存在する位置 (例: header, footer, review_cta)}`

---

## 3. レビュー記事詳細ページの構成

[reviews/[slug].astro](file:///Users/suzukiyousuke/repo/JuryPress/src/pages/reviews/[slug].astro) では、5人のAIによる証拠に基づく評価を明確に可視化します。

### A. 判決プレート (VerdictPlate)
円形の進捗サークルは廃止され、二重罫線で囲まれた紙面風の [VerdictPlate.astro](file:///Users/suzukiyousuke/repo/JuryPress/src/components/VerdictPlate.astro) に刷新されました。
* **Consensus Label (合意度ラベル)**: 5人の審査員のスコアの最大値と最小値の差分（`max - min`）から、以下のルールに基づき算出されます。
  * `diff <= 5.0`: **Strong Consensus**
  * `diff <= 12.0`: **General Agreement**
  * `diff <= 20.0`: **Split Decision**
  * `diff > 20.0`: **Highly Divisive**
* **Jury Score**: 5人の個別スコアの算術平均値。
* **Range**: 最大・最小スコアの幅。

### B. 合意と対立 (Agreed / Split)
審査員間で合意した点 (`what_jury_agreed`) および対立した点 (`where_jury_disagreed`) を、左右2カラム（モバイル時は1カラムにスタック）の並列リストで対比表示し、評価の多様性を分かりやすく強調します。

### C. 折りたたみアコーディオン (Scorecard Details)
* ユーザーがスクロール疲れを起こさないよう、各ジャッジの個別スコアカード（6基準の採点詳細、証拠、理由）はデフォルトで `<details>` タグ内に折りたたまれており、ユーザーが必要に応じて展開する設計となっています。

---

## 4. OGP 画像仕様

[og/[slug].svg.ts](file:///Users/suzukiyousuke/repo/JuryPress/src/pages/og/[slug].svg.ts) により動的生成される SVG は以下の要件に従います。
* **配色 & 枠線**: `#f4efe6` カンバスに `#d5ccbd` と `#aaa091` の細い二重外枠。
* **文字書体**: プロダクト名は Georgia セリフ体で大きく表示。
* **ジャッジアバター**: 5人のAI（Alex, David, Lisa, Sarah, Marcus）の頭文字バッジ（A, D, L, S, M）を SVG 要素のみで横並びに描画。
* **スコアボックス**: VerdictPlate 同様、右端に JURY SCORE、RANGE、CONSENSUS LABEL を囲むボックスを配置。
* **署名表記**: `NO HUMAN EDITOR · EXPERIMENT` を右上部に表示。

---

## Implementation Report

### 実装完了報告 (2026-07-14)
* **デザイントークン & レイアウト**: `src/styles/tokens.css` と `src/styles/global.css` を定義。`Layout.astro` への適用を完了しました。
* **ブランド統合**: `SiteHeader.astro`, `SiteFooter.astro` を作成。各種リンクへの UTM トラッキング引数の自動付与を実装しました。
* **ページリニューアル**: トップ、レビュー詳細、審査員一覧、審査員プロフィール、ルーブリック、ランキング (総合、ジャッジ別、月次) の各 Astro テンプレートを tokens を基盤として全面的にリニューアルしました。
* **検証テスト**: コンセンサスラベル計算の境界条件テスト `tests/unit/consensus.test.ts` を追加し、すべてのテストがパスすることを確認しました。Playwright により9パターンのビューポートでスクリーンショットを自動生成・検証しました。
