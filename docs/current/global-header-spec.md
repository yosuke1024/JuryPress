---
title: JuryPress PixApps Global Header Integration Spec
status: implemented
---

# JuryPress PixApps Global Header Integration Spec

## 1. Overview
JuryPress における PixApps グローバルヘッダーの統合仕様。最上位に共通の `GlobalHeader` を配置し、その下（2段目）に JuryPress 独自の `SiteHeader` (ContextNavigation) をマウントして、デザインとナビゲーションの一貫性を実現する。

## 2. Integration Architecture

### Asset Synchronization
* JuryPress は Cloudflare Workers 上で `/jurypress/*` のルーティングを担当するが、ローカル開発・テスト環境において `pixapps-landing` リポジトリ上の `/global-header.js`, `/global-header.css`, `/logo.png` を透過的にロードするために、ビルド/起動前にアセット同期スクリプト (`JuryPress/scripts/sync-global-header.ts`) を実行して `public/` ディレクトリ以下に同期させる。
* 同期後のアセットは単体でのビルドおよび CI が通るように Git 追跡対象とする。

### 1段目: GlobalHeader (64px)
* `Layout.astro` に `/global-header.css` と `/global-header.js` をインクルードし、`<body>` 直下に `<div id="global-header"></div>` プレースホルダをマウント。
* `global-header.js` の `isJuryPress` 判定により、言語切り替えボタンは `English only`（非活性）として表示される。

### 2段目: SiteHeader (ContextNavigation) (48px)
* `SiteHeader.astro` 内の元の PixApps へのブランドリンク、スラッシュ区切り、およびモバイルトグルを削除。JuryPress のワードマークとローカルナビゲーションリンクのみを表示するようにリファクタリング。
* デスクトップ表示時には、`global-header.css` により `.site-header` のスタイルが `position: fixed; top: 64px; height: 48px; z-index: 990` へ自動上書きされ、2段目に綺麗に固定表示される。
* モバイル表示（768px 以下）では、`.site-header` は非表示となり、GlobalHeader のハンバーガーメニュー内「Current Section (JuryPress)」グループへリンク群が自動パース・統合される。

---

## Implementation Report

本統合仕様は以下のようにリファクタリング（是正）され、最終実装が完了しました。

1. **Astro静的サーバーサイドレンダリングへの移行**:
   * クライアントサイドJS (`global-header.js`) によるプレースホルダ `<div id="global-header"></div>` へのDOM動的インジェクションおよび後付け処理を廃止。
   * ビルド時に静的にHTMLを出力する [GlobalHeader.astro](file:///Users/suzukiyousuke/repo/JuryPress/src/components/GlobalHeader.astro) を新規に作成し、[Layout.astro](file:///Users/suzukiyousuke/repo/JuryPress/src/layouts/Layout.astro) で `<GlobalHeader />` を直接レンダリング。これによりレイアウトシフト（チラつき）や初期化の遅延、二重ヘッダーなどの問題を完全に解決しました。
2. **Context Navigationの整理と統合**:
   * 旧 `SiteHeader.astro` を完全に削除し、6項目（Reviews, Rankings, The Jury, Rubric, Methodology, About）に限定した [JuryPressContextNavigation.astro](file:///Users/suzukiyousuke/repo/JuryPress/src/components/JuryPressContextNavigation.astro) を作成。
   * モバイル表示（768px以下）では、Astro側でレンダリングしたこのContext Navigationを `display: none` で隠し、[GlobalHeader.astro](file:///Users/suzukiyousuke/repo/JuryPress/src/components/GlobalHeader.astro) のハンバーガーメニュー内「JuryPress」セクション（手動統合）にて一本化して提供することで、モバイルでハンバーガーメニューが重複する問題を解消しました。
   * 「実験説明」バナー（`A PixApps experiment...`）をナビゲーション間から削除し、[SiteFooter.astro](file:///Users/suzukiyousuke/repo/JuryPress/src/components/SiteFooter.astro) 内のアトリビューションセクションへ移設しました。
3. **データ整合性自動検証のフック**:
   * [data.ts](file:///Users/suzukiyousuke/repo/JuryPress/src/lib/data.ts) 内に `validateIntegrity()` を実装し、ビルドやテストでのデータ読み込み時に自動実行するようにしました。このテストは、Jury Scoreの整合性、Verdict表記の一貫性、関連当事者レビューのランキングからの除外アサーションを自動的に保証します。

Playwright テストによって DOM 検証およびデスクトップ（1440px）/モバイル（390px）幅での Visual Regression が検証され、すべてパスしています。
