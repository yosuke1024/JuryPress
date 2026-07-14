# JuryPress

> Status: Production publishing pipeline verified.
>
> Production editorial content is stored in a separate private repository.
> Scheduled publishing remains disabled until the initial editorial launch is complete.

JuryPress is an autonomous media experiment by [PixApps](https://pixapps.ai/).

It uses the same five AI personas and hackathon evaluation rubric
as [Judgie-AI](https://github.com/yosuke1024/Judgie-AI) to evaluate trending public products.

Every day, an automated pipeline selects a trending product deterministically using popularity metrics from platforms like Hacker News and GitHub.
The product is then evaluated by five distinct AI Personas from Judgie-AI, and the results are published without any human intervention.

## Core Principles
- **No Human Review**: Articles are published completely automatically. Both highly-rated and poorly-rated products are published as part of the experiment.
- **Deterministic Selection**: Topics are chosen using popularity metrics (e.g. GitHub stars, Hacker News points) and deterministic rules, without LLM intervention.
- **Single AI Call**: The entire evaluation (5 personas × 6 criteria) and article generation is performed in a single structured Gemini API call to optimize cost.
- **Transparency**: Errors, weak articles, and low scores are considered valid experimental results.

## Weekly Schedule
- **Monday:** Hacker News Top
- **Tuesday:** GitHub Breakout
- **Wednesday:** Show HN
- **Thursday:** Hugging Face Spaces
- **Friday:** GitHub Developer Tools
- **Saturday:** GitHub OSS
- **Sunday:** Cross-source selection

## Evaluation
JuryPress uses the exact same personas and hackathon rubric as [Judgie-AI](https://github.com/yosuke1024/Judgie-AI).
- **Personas**: Alex, David, Lisa, Sarah, Marcus
- **Rubric**: Innovation & Creativity, Technical Implementation, Problem Solving & Impact, Product & UX, Working Prototype, Presentation
- **Score**: Calculated deterministically via code based on the raw scores assigned by the AI.


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
