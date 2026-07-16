# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, etc.) when working
in this repository. `CLAUDE.md` is a symlink to this file.

## Project Overview

JuryPress is an autonomous review pipeline for open-source software. Each day an
automated job selects a trending repo/tool, filters it through an **Eligibility
Gate**, collects public evidence, and evaluates it with **5 simulated personas ×
6 rubric criteria** in a **single structured Gemini API call**. Articles publish
fully automatically — no human review — and errors/weak articles/rejections are
logged as valid experimental results.

The Astro site (`src/pages`) renders this content into a static site deployed to
Cloudflare. Editorial content itself lives in a **separate private repo**, not here
(see Data Modes).

## Commands

```bash
npm run dev              # sync global header, then astro dev
npm run build            # sync header + astro build + validate:content
npm run preview          # serve the built site
npm run typecheck        # astro sync && tsc --noEmit
npm run test             # == test:unit (vitest: tests/unit + tests/integration)
npm run test:e2e         # playwright (tests/e2e)
npm run validate:content # tsx scripts/validate-content.ts (integrity/anti-fixture checks)
```

Prefer running the dev server in background mode (`astro dev --background`; manage with
`astro dev stop` / `status` / `logs`) so the session isn't blocked.

Most scripts require `JURYPRESS_DATA_MODE` to be set (`fixture` or `production`) —
they fail-fast if it is unset. For local dev/tests use `fixture`.

Run a single test:
```bash
JURYPRESS_DATA_MODE=fixture npx vitest run tests/unit/<file>.test.ts
JURYPRESS_DATA_MODE=fixture npx vitest run -t "<test name substring>"
npx playwright test tests/e2e/<file>.spec.ts
```

Dry-run the daily pipeline (evaluate + generate JSON, no commit/deploy):
```bash
DRY_RUN=true TARGET_DATE=2026-07-14 GEMINI_API_KEY="..." \
  JURYPRESS_DATA_MODE=production \
  JURYPRESS_CONTENT_ROOT="/absolute/path/to/content/data" \
  npx tsx scripts/run-daily.ts
```
`run-daily.ts` with no args runs the normal daily pipeline (select → collect →
evaluate → write → publication state). `DRY_RUN=true` evaluates and logs the
resolved slug but writes no review, evidence, publication-state, or run files.
The live Gemini smoke test runs only under `LIVE_GEMINI_SMOKE_TEST=true`.

## Data Modes (critical)

Everything that reads content resolves through `src/lib/content-root.ts`:
- **`fixture`** → reads `tests/fixtures/` (reviews, rejections). Used for dev, tests, CI, and local builds.
- **`production`** → reads `JURYPRESS_CONTENT_ROOT` (absolute path to the private content repo's `data/` dir; e.g. `../JuryPress-content/data`).

`JURYPRESS_DATA_MODE` is **mandatory** — there is no default; unset throws. In
`production`, a missing/traversal (`..`, `.`) `JURYPRESS_CONTENT_ROOT` throws. CI
explicitly asserts both fail-closed behaviors. Astro (`astro.config.mjs`) additionally
requires `JURYPRESS_SITE_URL` (https or localhost) in production.

## Architecture

**Daily pipeline** (`scripts/run-daily.ts`), each stage is a class in `src/lib/`:
1. **Selection** (`selection/selector.ts` + `sources/`) — a `SourceAdapter` per source
   (HN top/show, GitHub breakout/oss/developer-tools, HuggingFace spaces, cross-source;
   dispatched by `sources/index.ts`). Which source runs depends on the day of week and
   season config. The Eligibility Gate rejects non-OSS/stale/unrunnable candidates.
   Popularity metrics affect selection only, never the score.
2. **Evidence** (`evidence/collector.ts`) — collects public evidence, validated against
   `schemas/evidence.ts`.
3. **Evaluation** (`evaluation/evaluator.ts`) — one Gemini call produces all 5 personas ×
   6 criteria, validated against `schemas/evaluation.ts`. `lib/daily-evaluation.ts`
   prepares the candidate with integrity context and finalizes the refined review.
4. **Scoring/verdict** (`verdict.ts`, `jury.ts`) — the final score is recomputed
   **deterministically in code** from the AI's raw 0–5 scores; `getConsensus()` maps the
   judge score range to a consensus label. Missing evidence → "not assessable" → null →
   the review is **unranked**.
5. **Archive/publish** (`review-archive.ts`, `publication-integrity.ts`) — writes the
   review JSON into the content root and records provenance.

**Site** (`src/pages/`) — Astro static pages reading content via `src/lib/data.ts`
(`getAllReviews()` etc.). Dynamic routes: `reviews/[slug]`, `judges/[judge]`,
`rankings/monthly/[...month]`, plus JSON/RSS/OG-image endpoints. Related-party products
(JuryPress, Judgie-AI) are excluded from rankings.

**Schemas** (`src/schemas/`, Zod) are the source of truth for every pipeline artifact
(selection, evidence, evaluation, jury, review) and gate cross-stage data. Config lives
in `config/` (`sources.yml`, `season.json`, `seasons/`, `rubrics/`, `selection/`).

`npm run dev`/`build` first run `scripts/sync-global-header.ts` to sync the shared
global header — don't hand-edit generated header assets. Cloudflare deploy uses the
`build:cloudflare` / `deploy:cloudflare` scripts with `BASE_PATH=/jurypress/`.

## Conventions & Gotchas

- **No fixtures/placeholders in production.** `production` mode must load zero fixture
  files or fallback/dummy metadata. Real metrics (stars, forks, license, README) must be
  fetched live; if any mandatory field is missing, selection/publish **fails fast** rather
  than substituting placeholders. `validate:content` and the build reject synthetic values
  (fake URLs like `github.com/example/fixture`, template rationales like
  `Highly detailed evaluation of {criterion}`, homogeneous persona voices). See
  `docs/current/data-integrity-remediation.md`.
- **Gemini failover.** Primary key retries (default 3) then falls back to
  `GEMINI_FALLBACK_API_KEY` (default 3 more) — use keys from *different* GCP projects.
  Raw keys/project names never appear in generated files, logs, or CI summaries.
- **Licensing split.** Source code is MIT; editorial content, generated media, branding,
  and publication data are **not** MIT and are not in this repo (`LICENSING.md`).
- Node `>=22.12.0` required. TypeScript is strict; run `npm run typecheck` (needs
  `astro sync` first, which the script handles).
