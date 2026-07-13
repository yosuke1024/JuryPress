# Attribution

JuryPress is an experimental automated review media. 
The system leverages the following technologies and assets:

- **AI Model**: Google Gemini (via `@google/genai` SDK)
- **Framework**: Astro (via `@astrojs`)
- **UI Architecture & Personas**: 
  - Based on the [Judgie-AI](https://github.com/yosuke1024/judgie-ai) multi-persona evaluation system and rubric.
  - Using rubric commit SHA version documented in `config/season.json`.
- **Avatars**: 
  - The judge avatars (Alex, David, Lisa, Marcus, Sarah) are copied from [Judgie-AI](https://github.com/yosuke1024/judgie-ai/tree/main/src/assets/avatars).
  - Used under the MIT License originally granted by Judgie-AI.
- **Data Sources**: Hacker News, GitHub API, HuggingFace Spaces.
