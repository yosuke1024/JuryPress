---
title: Production Data Integrity & Evidence Quality Remediation
status: implemented
created_at: 2026-07-14T17:00:00+09:00
updated_at: 2026-07-16T14:15:00+09:00
---

# Production Data Integrity & Evidence Quality Remediation Specification

This document defines the specifications to ensure production data integrity, evidence quality, persona differentiation, and to prevent fixture/placeholder data leaks in JuryPress.

## 1. Absolute Prohibition of Fixtures and Placeholders in Production

* `JURYPRESS_DATA_MODE=production` must strictly load zero fixture files, fallbacks, or dummy metadata.
* Real repository metrics (stargazers_count, forks_count, etc.) must be dynamically collected from the GitHub API and written to the article metadata.
* If any mandatory metadata (e.g. stars, license, or README) cannot be fetched from the API, selection and publication must fail immediately (Fail-Fast).
* Popularity metrics (e.g. stars, forks) must not be substituted with hardcoded placeholders (e.g. `1250` stars, `150` stars).
* Synthetic or fake values such as placeholder URLs (`https://github.com/example/fixture`), synthetic HN IDs, or demo summaries must be rejected during build/validate phases.
* The system will save a `provenance` field in the review metadata to guarantee that no fixture files or default configurations were used.

## 2. Prohibition of Placeholder Rationale and Template Text

* Rationale matching the template `Highly detailed evaluation of {criterion} criteria.` or abstract valuations like "Highly detailed evaluation" or "Strong technical implementation" without evidence are strictly banned.
* Every judge must provide non-homogenous, context-specific rationales based strictly on the collected Evidence.
* For each persona, the fields `score`, `confidence`, `rationale`, `evidenceIds`, `evidenceClassification`, `observedStrength`, and `observedLimitation` are mandatory.

## 3. Persona Differentiation Gate

* The 5 simulated professional perspectives must have unique voices and judgments.
* The system will validate the following:
  * `primaryConcern` is not identical across all 5 judges.
  * `decisiveQuestion` is not identical across all 5 judges.
  * The set of `keyStrengths` is not completely identical across all 5 judges.
  * The average similarity of the criterion reasoning text between judges does not exceed a threshold (e.g., character Jaccard similarity or overlap ratio < 0.85).
* If persona validation fails, the system will retry generation up to 3 times. If it still fails, publication is aborted.

## 4. Evidence Coverage Matrix

* The confidence level of each criterion must match the actual evidence types available:
  * **Purpose & Usefulness**: README, official documentation, landing page, source discussion.
  * **Implementation Evidence**: source tree, runnable package, release artifact, demo, installation script, CI configuration, test directories.
  * **Technical Quality**: actual source files, architecture/configuration files, test files, CI definitions, security-related files, error handling.
  * **Usability & Onboarding**: installation instructions, CLI help, screenshots, demo, documentation, actual runnable observation.
  * **Differentiation & Insight**: README, architecture description, comparison documentation, source discussion, identified alternatives.
  * **Project Health & Stewardship**: repository creation/update timestamps, commit history, contributor count, releases/tags, changelog, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, license.
* **README-only Restriction**: If a repository only has a README as evidence, the confidence level for *Technical Quality* and *Project Health & Stewardship* must be at most `low` or `not_assessable`. High/medium confidence is prohibited.

## 5. GitHub Repository Evidence Expansion

* The following metadata must be gathered dynamically from the GitHub API and repository tree:
  * `stargazers_count`, `forks_count`, `open_issues_count`
  * SPDX license key
  * Timestamps: `created_at`, `updated_at`, `pushed_at`
  * Default branch
  * Commit activity or commit count
  * Contributors list
  * Releases/tags and latest release date
  * Workflow file paths (e.g. `.github/workflows/`)
  * Documentation files: `CONTRIBUTING`, `SECURITY`, `CODE_OF_CONDUCT`, `CHANGELOG`
  * Package manifests (e.g. `package.json`, `Cargo.toml`)
  * Container/build configurations (e.g. `Dockerfile`, `docker-compose.yml`)
* Missing fields must be stored as `unknown` or empty and never guessed.

## 6. Classification of Discussion Evidence

* Hacker News discussion comments must be parsed, classified, and mapped.
* Points from comments (adoption evidence, criticisms, creator replies, maintenance/security concerns) must be stored in the evidence list.
* Discussion comments must be classified as `community_claim` in `evidence_classifications` to distinguish them from source-confirmed facts.

## 7. Precise Evidence ID Mapping

* Every criterion rationale must reference *only* the specific Evidence IDs that support it.
* Reference to a single evidence ID (e.g., `ev-1` README) across all criteria to claim High Confidence is forbidden.
* *Technical Quality* must reference source code or tests. *Project Health* must reference metadata or commit activity.

## 8. Abolition of V1 Score Migration

* Historical V1-to-V2 score maps are discontinued.
* Related-party reviews (JuryPress and Judgie-AI) must be evaluated from scratch using Open Product Rubric v2.
* Remove all v1-specific terminology (e.g. `hackathon rubric`, `Migrated from V1`, `Given the hackathon context`) from published pages.

## 9. SSO for Rubrics and Season Configurations

* `config/season.json`, the prompt templates, README, Rubric page, and Methodology page must all share the same Single Source of Truth for Season 2 rules.

## 10. Publication Gate validations

* A strict validator script (`validate-content.ts`) runs before deployment. It checks:
  * Dynamic GitHub metadata is present.
  * SPDX license is recognized and approved.
  * Runnability evidence is present.
  * No placeholder text is used.
  * No fixture value leaks.
  * Persona differentiation passes.
  * Evidence coverage matches confidence levels.
  * Scores match recalculated average scores.
  * All referenced Evidence IDs resolve.
  * Related-party ranking exclusion policy is applied.
* Any single failure halts publication and logs the error in a structured format inside `failures/`.

## 11. Additional Corrections & Bugfixes

### Judge-Specific Rankings Bug
* On the individual judge rankings page (`/rankings/judges/[judge]/`), the scores rendered on the product cards must display that specific judge's score (e.g., "ALEX'S SCORE: 4.5") instead of the overall average Jury Score. The sorting order must match the specific judge's scores, and the layout must consistently reflect that the ranking is from that judge's perspective.

### Methodology Selection Description
* The selection description in `methodology.astro` will be revised to accurately represent Selection Policy v2. Instead of implying a simple weekly rotation of popularity platforms, it will describe how candidate links from those weekly rotating sources are automatically filtered through the **Hard Eligibility Gate** (public repository, SPDX license, freshness, runnability, and clear purpose) to ensure only valid open-source products are chosen.

## Implementation Report

### Phase 1 remediation (2026-07-16)

* SelectorからDaily Publishまで、canonical identity、immutable metadata snapshot、structured discussion evidenceを含む型付きCollection Resultを保持するようにした。
* Gemini生成スキーマから信頼済みIntegrity情報を分離し、アプリケーション側でスコア再計算前に注入するFail-closed経路へ変更した。
* 新規記事専用のRefined schemaとPublication Gateを追加し、snapshot全体、field単位のclaim attribution、test execution SHA、counter-evidenceの対象固有対応を決定論的に検証するようにした。
* Legacy Review schemaは変更せず読み取り互換性を維持した。
* CIに独立したcontent validationを追加し、Refined fixtureの成功・失敗CLIテストを含む回帰テストを追加した。
* Production Contentの移行・再生成・公開は実施していない。
