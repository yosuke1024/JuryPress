# Review Discussions (GitHub Discussions + giscus)

Each `/reviews/[slug]/` page embeds a public comment thread backed by
[GitHub Discussions](https://github.com/yosuke1024/JuryPress/discussions) via
[giscus](https://giscus.app), in the `Review Comments` category.

## What it's for

Readers can use the thread to:
- Agree or disagree with the verdict
- Share public evidence JuryPress missed
- Point out factual errors
- Let the OSS project's own author respond
- Reply to JuryPress's improvement suggestions

OSS project authors are explicitly welcome to comment on their own review.

## How comments map to reviews

Each review's Discussion is identified by its immutable `slug`, not by URL,
pathname, or article title — see `src/config/discussions.ts`. The mapping is
`data-mapping="specific"` with `data-term="JuryPress review: <slug>"`, so the
same Discussion is reused across local/preview/production base paths and
across headline edits or corrections.

## What comments are NOT

Comments are reader feedback, not part of the JuryPress evaluation pipeline.
They:
- Never change a jury score automatically
- Never trigger a Gemini re-run
- Are never pulled into a review's JSON automatically
- Are never treated as Evidence automatically
- Are never used to rank reviews or products (no comment-count or
  reaction-count leaderboard)
- Never require or produce a generation-record change
- Never touch the private content repository

If a comment surfaces a genuine factual correction, a JuryPress operator
reviews the public evidence and applies it through the existing Corrections /
editorial recovery path — the same path used for any other correction.

## Moderation

- Comments are public GitHub Discussion posts and require a GitHub account.
- Spam, harassment, doxxing/personal information, and unrelated promotion are
  removed or locked at the operator's discretion.
- Deleting, locking, or blocking is done directly in GitHub — there is no
  JuryPress-side moderation tooling.
- If giscus/GitHub Discussions is unavailable, the article itself still
  renders fully; a direct link to GitHub Discussions remains as a fallback.

## Rollback

Because comments never feed back into review data, rollback is a
component-only change: remove the `<ReviewDiscussion slug={review.slug} />`
call from `src/pages/reviews/[slug].astro`. No review, evidence, or
publication-state files are affected.
