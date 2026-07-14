# JuryPress

> Status: Production publishing pipeline verified.
>
> Production editorial content is stored in a separate private repository.
> Scheduled publishing remains disabled until the initial editorial launch is complete.

JuryPress is an autonomous review experiment for publicly inspectable open-source software products.

Every day, an automated pipeline selects a trending open-source repository or tool, filters it through a strict **Eligibility Gate**, collects public evidence, and evaluates it using five simulated AI perspectives.

## Core Principles
- **No Human Review**: Articles are published completely automatically. Both highly-rated and poorly-rated products are published as part of the experiment.
- **Deterministic Selection & Eligibility Gate**: Candidates are chosen based on popularity metrics (which do not affect the score) and filtered through strict eligibility gates (requiring public repository, recognized SPDX OSS license, clear purpose, runnability, and freshness in the past 18 months). Related-party reviews (JuryPress, Judgie-AI) are unranked and excluded from rankings.
- **Single AI Call**: The entire evaluation (5 personas × 6 criteria) and article generation is performed in a single structured Gemini API call to optimize cost.
- **Not Assessable Handling**: If a criterion lacks sufficient evidence, it is marked as "not assessable" and receives a null score, rendering the review unranked.
- **Transparency**: Errors, weak articles, and rejections are logged as valid experimental results.

## Weekly Schedule
- **Monday:** Hacker News Top
- **Tuesday:** GitHub Breakout
- **Wednesday:** Show HN
- **Thursday:** Hugging Face Spaces
- **Friday:** GitHub Developer Tools
- **Saturday:** GitHub OSS
- **Sunday:** Cross-source selection

## Evaluation (JuryPress Open Product Rubric v2)
JuryPress uses five simulated professional perspectives to evaluate products.
- **Personas**: Alex (Entrepreneur), David (Engineer), Lisa (UX Designer), Sarah (Product Manager), Marcus (VC)
- **Rubric Criteria**:
  - Purpose & Usefulness (20%)
  - Implementation Evidence (20%)
  - Technical Quality (20%)
  - Usability & Onboarding (15%)
  - Differentiation & Insight (15%)
  - Project Health & Stewardship (10%)
- **Score**: Calculated deterministically via code based on raw scores (0–5, 0.5 steps) assigned by the AI. Popularity metrics are excluded from scoring.


## Local Execution

To run the project locally (using test fixtures):

```bash
npm install
npm run build
npm run preview
```

### Dry Run (Evaluate without publishing)
```bash
# Evaluate a product and generate JSON but do not commit or deploy
DRY_RUN=true TARGET_DATE=2026-07-14 GEMINI_API_KEY="..." JURYPRESS_DATA_MODE=production JURYPRESS_CONTENT_ROOT="/absolute/path/to/content/data" npx tsx scripts/run-daily.ts
```

## Configuration & Environment

### Environment Variables
- `JURYPRESS_DATA_MODE`: Set to `fixture` for testing (uses public repo fixtures) or `production` for publication (requires `JURYPRESS_CONTENT_ROOT`).
- `JURYPRESS_CONTENT_ROOT`: Absolute path to the directory containing production reviews and editorial data.

### Secrets (Required in Private Repository or `.env`)
- `GEMINI_API_KEY`: Required for evaluation.
- `GITHUB_TOKEN`: (Optional) Required for GitHub API requests without rate limiting.
- `PUBLIC_GA_MEASUREMENT_ID`: (Optional) Google Analytics Measurement ID.
- `PUBLIC_ADSENSE_CLIENT_ID`: (Optional) Google AdSense Client ID.
- `PUBLIC_JUDGIE_URL`: Judgie-AI CTA URL.
- `PUBLIC_PIXAPPS_URL`: PixApps CTA URL.

## Attribution
The 5 persona identities, avatar images, and evaluation rubric are sourced from [Judgie-AI](https://github.com/yosuke1024/Judgie-AI).
See `config/season.json` for the exact commit SHA used in this season.

## License

The JuryPress software is licensed under the MIT License.

Production reviews, editorial data, publication records, generated media,
and JuryPress-specific branding are not included in the MIT License.

See [LICENSE](./LICENSE), [LICENSING.md](./LICENSING.md), and
[ATTRIBUTION.md](./ATTRIBUTION.md).
