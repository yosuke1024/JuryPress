# JuryPress

> Status: Public technical preview.
>
> The site currently uses fixture data for verification.
> Scheduled autonomous publishing is disabled until the production audit is complete.
JuryPress is a fully automated AI media experiment. 
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
To run the project locally:

```bash
npm install
npm run build
npm run preview
```

### Dry Run (Evaluate without publishing)
```bash
# Evaluate a product and generate JSON but do not commit or deploy
DRY_RUN=true TARGET_DATE=2026-07-14 GEMINI_API_KEY="..." npx tsx scripts/run-daily.ts
```

## Configuration & Environment
The following secrets are required in GitHub Actions or `.env`:
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
MIT
