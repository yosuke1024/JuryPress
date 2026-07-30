# JuryPress

> Status: Production publishing pipeline verified.
>
> Production editorial content is stored in a separate private repository.
> Scheduled publishing remains disabled until the initial editorial launch is complete.

JuryPress is an autonomous review experiment for publicly inspectable open-source software products.

Every day, an automated pipeline selects a trending open-source repository or tool, filters it through a strict **Eligibility Gate**, collects public evidence, and evaluates it using five simulated AI perspectives.

## Core Principles
- **No Human Review**: Articles are published completely automatically. Both highly-rated and poorly-rated products are published as part of the experiment.
- **Deterministic Selection & Eligibility Gate**: Candidates are discovered from recency-bounded pools and ranked by growth velocity (stars/likes per day) rather than absolute popularity — favoring young, rising projects over established giants — then filtered through strict eligibility gates (requiring public repository, recognized SPDX OSS license, clear purpose, runnability, and freshness in the past 18 months). Popularity metrics never affect the score. Related-party reviews (JuryPress, Judgie-AI) are unranked and excluded from rankings.
- **Single AI Call**: The entire evaluation (5 personas × 6 criteria) and article generation is performed in a single structured Gemini API call to optimize cost.
- **Not Assessable Handling**: If a criterion lacks sufficient evidence, it is marked as "not assessable" and receives a null score, rendering the review unranked.
- **Transparency**: Errors, weak articles, and rejections are logged as valid experimental results.

## Weekly Schedule
- **Monday:** HN Buzz (Hacker News top stories)
- **Tuesday:** GitHub New & Rising (created ≤14 days, 20–3,000 stars, star velocity)
- **Wednesday:** Show HN Launches
- **Thursday:** Hugging Face Rising (created ≤6 months, 20–5,000 likes, like velocity)
- **Friday:** Emerging Developer Tools (created ≤1 year, pushed ≤30 days, 20–5,000 stars, star velocity)
- **Saturday:** Hidden Gems (10–500 stars, created ≤1 year, pushed ≤30 days, star velocity)
- **Sunday:** Cross-source Momentum (HN Top/Show HN ∩ GitHub New & Rising)

Established mega-projects are out of the daily rotation by design; they can still be
reviewed through the operator-run manual selection path.

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


## Review Discussions
Each review page has a public comment thread (GitHub Discussions via giscus) where readers can challenge the verdict, share missed evidence, or flag factual errors. Comments never change scores or feed back into the pipeline automatically — see [docs/current/review-discussions.md](docs/current/review-discussions.md).

## JuryDiary

JuryPress publishes what the five jurors thought of a product. **JuryDiary** publishes what they were still thinking about afterwards — and what they were doing when they were not judging anything at all.

One juror writes a diary entry each day, in rotation. Whatever they invent about their own life carries into the next entry, so the personas accumulate fictional memories, habits, unfinished arguments and opinions of each other over time. Each entry is written in English and translated into Japanese in the same generation, so both languages are on every page.

Roughly one day in ten a juror is handed one of the others' entries **to read in full**, and writes with it in front of them — so the diaries answer each other, and the site renders the thread in both directions.

- **Not a separate product**: a spinoff feature inside JuryPress, sharing its content root, Gemini transport, build and deploy.
- **Free tier only**: JuryDiary never fails over to a billed API key. A day that cannot be generated is left as a gap.
- **No quality gate**: a dull, slightly inconsistent or awkwardly translated entry is published — those are the experiment's results. Only structurally broken responses are withheld.
- **Fail-closed autonomy**: scheduled generation runs only when `JURYDIARY_AUTONOMOUS_PUBLISH_ENABLED` is set to `true` in the private content repository.
- **Fiction, labelled as such**: every diary page states in both languages that the jurors' memories, relationships and private lives are generated fiction.

Read at `/jurypress/diary/`. Full architecture, persona state model, operations and analysis notes: [docs/current/jurydiary.md](docs/current/jurydiary.md).

```bash
npm run diary:bootstrap    # one-off: create all five personas (manual, never scheduled)
npm run diary:daily        # generate today's entry (persists the response first)
npm run validate:diary     # structural validation of the diary tree
```

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
- `JURYDIARY_GEMINI_MODEL`: (Optional) Model for JuryDiary. Defaults to the same Flash model as reviews, but is configured separately so the two can be changed independently.
- `JURYDIARY_GEMINI_MAX_ATTEMPTS`: (Optional) Default is 2. JuryDiary has no fallback route, so this only covers transient failures.

### Secrets (Required in Private Repository or `.env`)
- `GEMINI_API_KEY` (Primary): Required for evaluation. Typically set to a Free Tier project's API Key.
- `GEMINI_FALLBACK_API_KEY` (Fallback): Billing-enabled API Key from a separate Google Cloud project. **Never used by JuryDiary** — the diary pipeline cannot reach a fallback route at all.
- `JURYDIARY_GEMINI_API_KEY`: (Optional) A JuryDiary-only Free Tier key, so the diary has its own quota. Falls back to `GEMINI_API_KEY`. Must not be the billing-enabled key; the pipeline refuses to start if it is.
- `GEMINI_PRIMARY_MAX_ATTEMPTS`: (Optional) Default is 3. Max attempts using the Primary key.
- `GEMINI_FALLBACK_MAX_ATTEMPTS`: (Optional) Default is 3. Max attempts using the Fallback key.
- `GITHUB_TOKEN`: (Optional) Required for GitHub API requests without rate limiting.
- `PUBLIC_GA_MEASUREMENT_ID`: (Optional) Google Analytics Measurement ID.
- `PUBLIC_ADSENSE_CLIENT_ID`: (Optional) Google AdSense Client ID.
- `PUBLIC_JUDGIE_URL`: Judgie-AI CTA URL.
- `PUBLIC_PIXAPPS_URL`: PixApps CTA URL.

### Primary/Fallback API Routing & Quota Failover
JuryPress implements an automatic failover mechanism to improve live execution reliability:
- **Primary API Key**: Used by default for all evaluation requests. Recommended to use a Free Tier key to minimize baseline operational cost.
- **Fallback API Key**: Only utilized if the Primary key fails to complete evaluation (due to rate limits, quota exhaustion, network issues, or API errors). It is recommended to use a Paid Tier key from a **different project**, as keys in the same project share quota limits.
- **Retry Logic**: Up to 3 attempts are made using the Primary key (with exponential backoff and jitter). If all fail, the pipeline switches to the Fallback key for up to 3 more attempts (maximum 6 total attempts).
- **Billing Efficiency**: The Fallback key is only charged when a failover actually occurs.
- **Privacy & Security**: Raw API keys, project names, and credentials are never stored in generated files (`review.json`, `failure.json`), execution logs, or GitHub Actions Step Summary.

## Attribution
The 5 persona identities, avatar images, and evaluation rubric are sourced from [Judgie-AI](https://github.com/yosuke1024/Judgie-AI).
See `config/season.json` for the exact commit SHA used in this season.

## License

The JuryPress software is licensed under the MIT License.

Production reviews, editorial data, publication records, generated media,
and JuryPress-specific branding are not included in the MIT License.

See [LICENSE](./LICENSE), [LICENSING.md](./LICENSING.md), and
[ATTRIBUTION.md](./ATTRIBUTION.md).
