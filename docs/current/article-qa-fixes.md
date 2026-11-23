# Editorial QA fixes — prompt history

## Prompt 4.8.7 / validator 3.8.0 (2026-11-23)

Issue #139 recurred in Prompt 4.8.6 articles when single-person stewardship or issue-triage
concerns were answered by a contribution guide, triage protocol, rotation, or release
automation alone. Those artifacts can reduce toil, but do not show that another person can
actually complete the work.

Prompt 4.8.7 asks for one bounded handoff exercise through the existing repository process:
another contributor completes one release, triage, review, or maintenance task, and the
result records success, failure, or the point where the primary maintainer is still required.
`RECOMMENDATION_STEWARDSHIP_WITHOUT_HANDOFF` records the lexical pattern as an advisory
warning. It does not block publication, rewrite a recommendation, add a model call, or change
the rubric, scores, selection, repair bounds, or response-first contract. Archived 4.8.6
articles retain their original contract; the new rule starts with routine 4.8.7 generation.

## Prompt 4.8.1 / validator 3.8.0 (2026-09-13)

Issues #139 and #144 exposed two omissions in the 4.8.0 self-check.

- A specification or guide could answer a compatibility, dependency, or traction concern
  without checking whether the underlying problem changed. The prompt now asks for a
  versioned fixture, executable contract test/matrix, integration prototype, or adoption
  measurement as appropriate. Missing documentation remains a legitimate document-only fix.
  `RECOMMENDATION_DOCUMENT_WITHOUT_VALIDATION` is an advisory from 4.8.1 onward. The
  distilled Shepherdr Sarah/Marcus regression fixtures include two distinct corrected steps.
- Source snapshot numbers were shown to the writer but not carried into persisted editorial
  validation. Daily generation, manual validation, shadow validation, and existing intensity
  revalidation now pass the saved collection snapshot. Numeric star/fork mentions, including
  word numbers, are compared across every public text field. Each mismatching occurrence
  produces `METADATA_NUMBER_MISMATCH` with its field and character offset.

Both are warnings, never publication gates or new retry targets. The lexical checks are
advisory: they cannot prove semantic improvement or tell a current repository count from
all historical, competitor, or hypothetical mentions. They do not rewrite prose, scores,
human-edit provenance, or raw responses. Qualitative claims such as low traction and
near-zero attention remain available. No live metadata is fetched for validation.

The patch enables 4.8.1 for the next routine generation. It does not edit archived articles.
Prompt 4.8.0 retains its prior text for shadow comparisons. No rubric, selection, scoring,
LLM-call count, intensity-repair bounds, or publication behavior changes.
