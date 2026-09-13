# Editorial Metrics 2.0 and Prompt 4.9 candidate

## Status and prompt history (2026-09-13, #142)

Prompt 4.9.0 is implemented as a candidate. Production remains at 4.8.1 until a
multi-article shadow comparison verifies voice, judgment, evidence discipline, and RNS.
The production 4.8.1 fixes are documented in `article-qa-fixes.md`.

The candidate draws on the professional/discourse/rhythm writing craft referenced in
[#142](https://github.com/yosuke1024/JuryPress/issues/142) and
[Sepia](https://github.com/Nanako0129/sepia). It adds a short section allowing uneven depth,
avoiding outline narration and repeated summaries, making judgments with reversal
conditions, and preserving persona voice. No runtime dependency or detector is added.

Recent-review contrast adds the first sentence (up to 200 characters) of jury_summary.
The reader and prompt block cap history at three published reviews and tolerate missing or
corrupt records. The new middle opening is shown only to 4.9+; 4.8.x prompts retain their
previous contrast text for controlled comparison.

## Instrument semantics

Metrics 2.0 retain the existing intensity and lexical-echo readings and add:

- `rhythm` for the whole article (including the judges) and each judge's own prose;
- sentence count, mean words per sentence, population sentence-length standard deviation,
  and mean absolute difference between adjacent sentence lengths;
- `judgeWordCountSpread`, the maximum minus minimum judge word count.

The existing prose views, sentence splitter, and English word tokenizer are reused. This is
an approximate, deterministic text instrument; field boundaries without terminal punctuation
can join into one sentence. Empty input has zero sentences and null statistics; one sentence
has SD zero and no adjacent delta (null). Statistics are rounded to two decimal places.

There is no threshold, warning, quality verdict, aggregate score, retry, or publication gate.
Values are for corpus comparison, not AI detection or an objective to optimize. A higher SD
is not evidence of better prose. Existing stored readings retain their instrument versions.
The normal metrics attachment and shadow output automatically include the new readings;
no production LLM stage changes. JuryDiary is outside this change.

## Shadow procedure before enabling 4.9

Use several existing 4.8.0 runs with saved evidence, their stored responses, and the archive
as it stood immediately before each run. Keep provider and requested model fixed; the
script rejects changing either in prompt comparison mode. Check actual model versions in
`comparison-metadata.json` as well. Use a trusted local checkout of the private content
repository and the existing authorized model credentials; never copy credentials into artifacts.

Example for each selected run (paths and run key are placeholders):

```sh
JURYPRESS_DATA_MODE=production \
JURYPRESS_CONTENT_ROOT=/path/to/content/data \
JURYPRESS_LLM_PROVIDER=gemini \
GEMINI_MODEL=gemini-3.5-flash \
npx tsx scripts/shadow-generate.ts \
  --run-key season-2-2026-09-09-daily \
  --archive-as-of /path/to/archive-before-run/data \
  --prompt-version 4.9.0 \
  --out /path/outside-content/shadow-2026-09-09
```

The stored 4.8.0 response is the baseline; this command makes one candidate generation.
It never publishes or writes to the real content root. Default provider-comparison behavior
is unchanged when `--prompt-version` is absent. The legacy `claude-*` output filenames are
retained for compatibility; authoritative provider/prompt metadata is in the comparison JSON.

Compare the blinded articles and both sides in `editorial-metrics.json`. Record concrete
observations about all five voices, judgment, evidence claims, RNS usefulness, lexical echo,
intensity, rhythm, and judge length spread. Discard comparisons with a changed actual model
or incorrect archive snapshot. Do not adopt the candidate just because a number improved.
Only then change `config/season.json` to 4.9.0 and close #142.

No live comparison was run for this implementation: the current execution environment had
no supported model credentials/CLI and no callable workflow-dispatch capability. #142 stays
open for the comparative generation and reading; implementation tests do not substitute for it.
