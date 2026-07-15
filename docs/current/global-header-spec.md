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

本統合仕様は `Layout.astro` へのインクルード、`SiteHeader.astro` の不要ブランド・モバイルトグル削除、`sync-global-header.ts` によるアセット同期処理の導入によって実装が完了しました。
Playwright テストによって DOM 検証およびデスクトップ（1440px）/モバイル（390px）幅での Visual Regression が検証され、すべてパスしています。
