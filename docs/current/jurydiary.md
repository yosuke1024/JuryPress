---
title: JuryDiary — Autonomous Persona Diaries
status: implemented
created_at: 2026-07-30T10:00:00+09:00
updated_at: 2026-08-18T21:30:00+09:00
---

# JuryDiary

JuryPress publishes what its five AI jurors thought of a product. **JuryDiary publishes what
they were still thinking about afterwards** — and what they were doing when they were not
judging anything at all.

One juror writes each day, in rotation. Whatever they invent about their own life carries into
the next entry, so the personas accumulate memories, habits, unfinished arguments and opinions
of each other over months. The value of the experiment is the accumulation and its git history,
not the literary quality of any single day.

JuryDiary is **not** a separate product, repository, domain, or backend. It is a spinoff
feature inside JuryPress, sharing its content-root model, its Gemini transport, its build and
its deploy.

## Contents

1. [Architecture](#1-architecture)
2. [Persona state model](#2-persona-state-model)
3. [Rotation, themes and reading](#3-rotation-themes-and-reading)
4. [Generation flow](#4-generation-flow)
5. [The structural gate](#5-the-structural-gate)
6. [Events and git history](#6-events-and-git-history)
7. [Free-tier-only policy](#7-free-tier-only-policy)
8. [Failure behaviour](#8-failure-behaviour)
9. [Bootstrap](#9-bootstrap)
10. [Running it](#10-running-it)
11. [Enabling and stopping autonomy](#11-enabling-and-stopping-autonomy)
12. [Public / private data boundary](#12-public--private-data-boundary)
13. [Fiction disclosure](#13-fiction-disclosure)
14. [Site structure and analytics](#14-site-structure-and-analytics)
15. [Future analysis](#15-future-analysis)

---

## 1. Architecture

| Concern | Location |
|---|---|
| Schemas | `src/schemas/diary.ts`, `diary-state.ts`, `diary-record.ts`, `diary-bootstrap.ts` |
| Rotation / theme / reading / patches | `src/lib/diary/{rotation,theme,reading,patch-engine,validator}.ts` |
| Subject recurrence | `src/lib/diary/focus.ts` |
| Project continuity | `src/lib/diary/projects.ts` |
| Scene and argument | `src/lib/diary/scene.ts` |
| Central tension and ending | `src/lib/diary/tension.ts` |
| Schedule continuity | `src/lib/diary/{schedule,relative-dates}.ts` |
| Persistence | `src/lib/diary/{storage,record-store,state-store,entry-store,config}.ts` |
| Prompt & context | `src/lib/diary/{context,prompt,review-context}.ts` |
| Gemini access | `src/lib/diary/gemini.ts` (over the shared `lib/evaluation/gemini-transport.ts`) |
| Site | `src/pages/diary/**`, `src/components/diary/**`, `src/lib/diary/{data,og-image,analytics}.ts` |
| CLIs | `scripts/run-diary.ts`, `scripts/diary-bootstrap.ts`, `scripts/validate-diary-content.ts` |
| Workflow | `.github/workflows/daily-diary.yml` in the **private content repo** |
| Production data | `data/diary/**` in the **private content repo** |

Everything JuryDiary persists lives under `<contentRoot>/diary/`. That is a hard requirement,
not a preference: the content repo's push script stages `data/` and nothing else, so a diary
file written anywhere else would be generated, used, and then silently dropped at commit time.

```text
data/diary/
├── config.json                                  # start date + rotation order
├── jurors/<slug>/
│   ├── private-canon.json                       # fictional life setting (additive only)
│   ├── character-state.json                     # mood, concerns, traits, beliefs
│   ├── life-state.json                          # what is going on off the clock
│   ├── relationships.json                       # how they see the other four
│   └── memories.json                            # long-term, selected by importance
├── generations/diary-<YYYY-MM-DD>-<juror>.json  # verbatim response + record state
├── entries/<YYYY>/<MM>/<YYYY-MM-DD>-<juror>.json  # what the site renders
├── events/<YYYY>/<MM>/<YYYY-MM-DD>-<juror>.json   # the applied diff, with hashes
└── failures/diary-<YYYY-MM-DD>-<juror>.json     # days that produced no response
```

**Core Persona is absent from this tree on purpose.** It lives in
`config/rubrics/open-source-product-v2.json` and is read through `lib/jury.ts`, which JuryDiary
only ever reads. There is no writable representation of Core Persona anywhere in JuryDiary —
a stronger guarantee than a validation rule, because nothing can edit a file that does not exist.

## 2. Persona state model

Five layers, in decreasing order of stability (brief §8):

| Layer | Stability | Written by |
|---|---|---|
| **Core Persona** | Fixed forever | Nothing. Read-only from the rubric config. |
| **Private Canon** | Slow, additive only | One `canonCandidate` per day, at most |
| **Character State** | Daily drift | `characterStatePatch` |
| **Life State** | Daily | `lifeStatePatch` |
| **Relationship State** | Only on days they interact | `relationshipPatches` |

Plus **memories**, promoted one at a time when a day produces something worth remembering months
later.

### Bounded movement

The model returns *diffs*, never whole state, and every diff is bounded (`DIARY_PATCH_LIMITS`):

- relationship `trust`/`respect`/`tension` ∈ [0, 1], at most **±0.05** per day
- at most **2** relationships patched per day, never the juror themselves
- at most **2** trait adjustments (±0.05), **1** belief adjustment (±0.1)
- at most **2** new concerns, **2** new unresolved thoughts, **2** new life events
- at most **1** new memory and **1** new canon fact
- a new memory's `importance` ∈ [0, 1] (`DIARY_MEMORY_IMPORTANCE`) — a weight deciding which
  memory is evicted first, not a 1–5 rating

An out-of-range delta is a **structural failure, not a clamped value**. Clamping would hide a
prompt regression behind state that still looks plausible; a missing day is visible.

### Every bound the validator can fail a day on is stated in the prompt

This is a hard rule, and it is the rule JuryDiary was launched without. On 2026-08-01, its first
generated day, `importance` was enforced at [0, 1] and described to the model only as "worth
remembering months from now". Gemini answered 2 — the obvious reading of an unstated rating — and
the day was discarded, entry and canon fact and all.

Auditing the rest of the gate found the same shape in five more places, one of which the prompt
actively induced: `canonCandidate.factType` is a nine-value enum, and the prompt offered "an
object", which is not one of them (the accepted value is `possession`). A day that took that
suggestion would have been discarded for following instructions.

So the prompt now states, interpolated from the same constants the validator reads:

| Family | Constant | Breaking it |
|---|---|---|
| Delta bounds and every list cap | `DIARY_PATCH_LIMITS` | fatal |
| Memory importance scale | `DIARY_MEMORY_IMPORTANCE` | fatal |
| Body/title/mood/quote floors, length ratio, Japanese-script ratio | `DIARY_TEXT_LIMITS` | fatal |
| Accepted canon fact types | `DIARY_CANON_FACT_TYPES` | fatal |
| Legal relationship targets — peers only, never self | `JUDGE_SLUGS` | fatal |
| The same juror patched twice in one day | (validator-side `Set`) | fatal |
| `contradictionNotes` cap | `DIARY_PATCH_LIMITS` | **warn and truncate** |
| `projectUpdates` cap | `DIARY_PATCH_LIMITS` | **warn and truncate** |
| Accepted project movements | `DIARY_PROJECT_MOVEMENTS` | **warn and drop the update** |
| Accepted focus levels | `DIARY_INTERACTION_LEVELS`, `DIARY_ABSTRACTION_LEVELS` | **warn and set the level aside** |
| `scheduledEvents` cap | `DIARY_PATCH_LIMITS` | **warn and truncate** |
| Accepted schedule movements | `DIARY_SCHEDULE_MOVEMENTS` | **warn and drop the event** |

The last six rows are the reason the prompt names them as exceptions rather than saying
"everything above". Telling a model that an overage is fatal when the validator quietly truncates
it is the same defect as this section describes, pointed the other way: it would buy caution that
costs entries nobody needed to lose. What separates the two groups is not importance, it is reach:
the fatal rows all end in a state file or a rendered page, and the exceptions end in tomorrow's
prompt.

`tests/unit/diary-prompt.test.ts` asserts each of these field-by-field — deriving the list caps
from `DIARY_PATCH_LIMITS` itself, so a cap added to the schema without a prompt line fails CI. A
bound the validator keeps and the prompt withholds is not a strict gate; it is a trap, and it costs
a day that cannot be regenerated.

Saturation at the ends of the [0, 1] scale is a documented boundary, applied only to values that
were already in range.

### Bounded memory

Recent-state lists are FIFO with caps (`DIARY_STATE_CAPS`): 6 concerns, 6 unresolved thoughts,
10 recent events, 8 emerging traits, 60 memories, and so on. Anything evicted is recorded in
that day's event file, so the git history keeps what the state file drops. Forgetting is a real
property of these personas, not an accident of a context limit.

### Canon collisions

Canon is **additive only**. A candidate that collides with an established single-valued fact
(`home`, `companion`) is *not* applied — it becomes a contradiction note. A juror does not
quietly move house; the tension is preserved as material to read later (brief §10.3, §11).

Emotional contradiction is never treated as an error. "I prefer living alone" and "the flat felt
unusually empty tonight" are allowed to coexist, and the prompt explicitly asks for them not to
be smoothed over.

## 3. Rotation, themes and reading

**Duty** follows the calendar from a configured `startDate`, five-day cycle, JST:

```text
alex → david → lisa → sarah → marcus → alex …
```

Two properties matter more than the arithmetic:

- **Timezone-independent.** Duty is computed from an already-resolved JST date key via
  `Date.UTC` calendar arithmetic, so the host's timezone cannot change whose turn it is.
- **Failure-independent.** A day that failed leaves a gap and the next day proceeds to the next
  juror. No catch-up, no shift. A missing entry reads as an outage, not a reshuffle.

**Themes** are chosen by code and handed to the model, never chosen by the model — a model given
a persona and a blank page writes a product review every time. The seed is
`sha256("diary-theme:<date>:<juror>")`, so a re-run of any day produces the same brief as the
first attempt.

| Theme | Weight |
|---|---|
| `work` | 30% |
| `private` | 30% |
| `mixed` | 25% |
| `relationship` | 10% |
| `memory` | 5% |

On `private` and `mixed` days an everyday-life category is also drawn (13 options: `home`,
`food`, `small_failure`, `rest`, …). On other days it is `null` — handing a model a domestic
prompt it was not asked to use is how every entry ends up mentioning a burnt dinner.

Review context is included **only** on `work` and `mixed` days. The surest way to stop a diary
turning back into a review summary is to not put the reviews in front of it.

### Explicit reading

Every prompt carries a short excerpt of what the other four last wrote — ambient awareness. On
a `relationship` day the duty juror additionally gets **one specific entry in full** and writes
with it in front of them. That is what turns five parallel monologues into something that can
argue back.

- **Roughly one day in ten.** Often enough that threads form across weeks; rare enough that the
  diary does not become a reply column where nobody has a life.
- **Code assigns the target, and records it.** `readingTargetId` is written onto the generation
  record before the call, so apply-time validation cannot drift from what was actually handed
  over — the same treatment the date, juror and theme get.
- **Being written about wins.** If any recent entry named the reader, the most recent of those
  is chosen; that is what lets a remark travel back to the person it was about. Otherwise the
  choice is spread across the 21-day window by hash, rather than always landing on yesterday.
- **The reply is a link, not a summary.** The model returns `respondsTo: {diaryId}` and nothing
  else; the reaction itself is the diary body. Asking for a separate summary line would
  duplicate prose it has already written.
- **A juror may decline.** Reading something and having nothing to say is a warning, not a
  failure — an honest silence beats a manufactured reaction. Claiming to answer an entry that
  was never assigned *is* a failure: that would fabricate a thread the archive does not contain.

Both directions render on the site: the reply says what it was written after reading, and the
answered entry gains the reply — which usually lands days later, and is the part worth finding.

### Shape variation

The first week of entries exposed a convergence problem (issue #105): every diarist, in
different vocabulary, wrote the same day — a tactile private-life prop, turned into a metaphor
for a professional contradiction, closed with a polished lesson. Different job titles, one
narrator.

Two prompt-side measures counter it, from `diary-v4`:

- **Recent arcs in context.** The newest `arcGlanceCount` entries across all diarists — the
  writer's own included — are reduced to their first and last sentences and shown as "how
  recent entries opened and closed". Peer excerpts could not serve here: they show only how
  entries begin, and the tidy-lesson habit lives in how they end.
- **The arc named, and permission withdrawn from it.** The prompt names prop → metaphor →
  lesson as the default to avoid, asks for a different opening device, emotional course and
  ending type than the arcs shown, and explicitly permits days that end unresolved,
  non-moralizing, or entirely unprofessional — dialogue, avoidance, pettiness, mistaken
  certainty, consequences that have not landed.

Shape is steered in the prompt and nowhere else. **No validator rule bans domestic objects,
reflection, or any narrative technique** — a repeated structure is a dull result, and dull
results publish (§5). The gate stays structural.

### Subject variation

Shape was only half of it (issue #110). Alex's 2026-08-01, 08-06 and 08-11 entries took three
different shapes and still told the same day: the Hermes Baby ribbon, and the argument that
manual friction belongs in a hobby and not in software. Nothing had regressed — the newest of
the three was the best written — but continuity context kept re-electing one object and one
thesis as the centre of the story, because the context carried the previous bodies and nothing
saying what any of them had been *about*.

So from `diary-v5` the response carries `entryFocus`: four short fields in which the writer
describes the entry it has just written.

| Field | What it holds |
|---|---|
| `dominantSubject` | The event or situation the entry turns on |
| `anchorObject` | The object at the centre of it, or **null** |
| `centralTension` | The argument, conflict or question it carries |
| `endingState` | How it ends — unresolved, decided, interrupted, resigned |

Three more fields join them from `diary-v7`, describing the entry's *mode* rather than its centre,
and three more from `diary-v9`, describing what its conflict pressed on and what became of it. Both
sets are read across all five diarists and are covered in [Scene and argument](#scene-and-argument)
and [Central tension and ending](#central-tension-and-ending).

`anchorObject` is nullable because a model required to name an object invents one to fill the
field, manufacturing exactly the object-centred entry this is meant to loosen. Null is offered
in the prompt as the frequently honest answer.

The focus is stored on the entry, and the writer's own newest two (`DIARY_RECENT_FOCUS_COUNT`)
are read back to them on their next duty day. It is self-reported and therefore fallible — a
writer may describe the day it meant to write. That is accepted: the alternative is a second
model call to summarize the first, which JuryDiary does not have and will not buy (§7), and a
wrong focus costs a nudge, never a day.

**Background continuity and central engine are separated by name.** A prop that is present —
used, mentioned, complained about, simply in the room — is welcome every day and needs no
justification. What must change hands is the role of *carrying* the entry: supplying its
metaphor, its tension and its conclusion. The prompt states that the test is the role, not the
noun.

`lib/diary/focus.ts` compares the two most recent focus records and, when they agree on a
centre, the prompt escalates: it names the shared terms and asks for a materially different
dominant event or tension today, with one carve-out — a day that genuinely revises the belief,
moves the relationship or lands the consequence is not a repeat, and should say what changed.

Three properties keep that from becoming a ban list:

- **It reads only the four central-role fields, never a body.** A typewriter mentioned in
  passing is invisible to it. Comparing bodies would flag precisely the background continuity
  this protects.
- **It cannot fail a day.** The strongest outcome is a paragraph of prompt text. There is no
  validator rule, and `entryFocus` itself is checked only by a warning
  (`DIARY_ENTRY_FOCUS_INCOMPLETE`) that names which fields were left blank.
- **No noun is forbidden.** The prompt says so in the section itself. The terms it quotes back
  come from the writer's own description of its own entries — a statement of what happened, not
  a forbidden-word list.

A worked example, on Alex. Two consecutive entries with the same centre:

```json
{ "dominantSubject": "a failed ribbon change on the Hermes Baby",
  "anchorObject": "the Hermes Baby typewriter",
  "centralTension": "You cannot optimize your way out of manual mechanics.",
  "endingState": "resigned" }

{ "dominantSubject": "replacing the ribbon on the Hermes Baby",
  "anchorObject": "the Hermes Baby typewriter",
  "centralTension": "Manual friction gives a hobby its soul but has no place in software.",
  "endingState": "settled into a lesson" }
```

Shared terms: `ribbon`, `hermes`, `baby`, `typewriter` in the subject, `manual` in the tension.
The third day is asked for a different centre — and the typewriter stays exactly where it is:

```json
{ "dominantSubject": "Leo deciding about the marketplace without asking me",
  "anchorObject": null,
  "centralTension": "Being consulted and being listened to are different things.",
  "endingState": "annoyed, and aware that is unfair" }
```

The Hermes Baby may still be on the desk in that entry, may still be typed on, may still be
complained about. It is no longer the reason the entry exists. Nothing about the persona was
edited to achieve that: canon, habits and beliefs are untouched, and the same object is legal
again tomorrow as an anchor if the day genuinely turns on it.

### Project continuity

Shape and subject are both a persona repeating itself. The third failure is a persona
*contradicting* itself, and it reads as continuity working until you put the two entries side by
side (issue #111).

On 2026-08-02 David "sat in my garage workshop, applying the third coat of varnish to the cedar
bookcase". On 08-07 he wrote about Marcus and his spice jars. On 08-12 he was "on the third coat of
varnish on the cedar bookcase", weighing a bubble in the second layer as a live decision the third
coat had not yet sealed. No entry said the finish had been stripped. Both days are good days; the
sequence has a bookcase that un-advanced itself.

Neither earlier measure could have caught that, and neither should have. #110 asks a subject to
stop being the centre; here the subject coming back is exactly what a diary accumulating over
months is for. What must not come back is the stage.

Nothing in the context could hold one. `ongoingActivities` is a list of sentences with no date and
no stage, and David's read "Applying another coat of varnish to a custom-built cedar bookcase" — a
stage, stored as an activity, unchanged since the day it was added and re-shown in every prompt
since. The only other trace of the bookcase was the bodies themselves, and a body does not
announce which coat it is on.

So from `diary-v6` the response carries `projectUpdates`, at most
`DIARY_PATCH_LIMITS.projectUpdates` of:

| Field | What it holds |
|---|---|
| `project` | What it is, in the words earlier entries used for it |
| `stage` | Where it now stands, concretely — which coat, which chapter, what is left |
| `movement` | `started`, `advanced`, `completed`, `failed` or `restarted` |

These are *movements*, not statuses, and the difference is load-bearing. A project nobody touched
today is simply not reported: the ledger keeps its last stated stage, and a value meaning
"unchanged" would be a standing excuse for restating one. `restarted` and `failed` are the two
that make arriving at a stage twice coherent, which is why they are the ones that explain a repeat
instead of being one.

`lib/diary/projects.ts` reduces the writer's own recent entries to a ledger — one row per project,
newest statement wins — and the prompt shows it as "where your ongoing projects stand", with the
instruction that a returning project resumes from there and that the ledger outranks the undated
`ongoingActivities` line when the two disagree. Completed projects stay in it: a finished bookcase
is exactly the thing a later entry can quietly put back on the workbench.

The check compares today's reported stage against that ledger and reports a project whose stage
says **nothing the last one did not already say**, unless the movement is `restarted` or `failed`.
Containment in that one direction, not similarity: a stage that has moved always brings a word the
old one lacked, so requiring a new term asks "did anything happen" in a way rephrasing cannot
answer. The other direction is left alone deliberately — "sanding the shelves" followed by "sanding
the shelves and cutting the back panel" contains the old stage whole and is still a day's work, and
an advisory that fires on that is an advisory nobody reads.

The same three properties as §Subject variation hold, for the same reasons:

- **It reads only what the writer said about its own projects, never a body.** A bookcase leaned
  against in passing is invisible to it.
- **It cannot fail a day.** The outputs are a prompt section and a `DIARY_PROJECT_STAGE_REPEATED`
  warning on the generation record. An unrecognised movement is dropped and an over-long list
  truncated, both with warnings; nothing here is fatal.
- **No project is forbidden.** A hobby may return as often as it likes, take months, be abandoned
  and picked up again. The only request is that it returns to the stage it was left at.

The ledger starts empty. Entries written before `diary-v6` carry no `projectUpdates`, and inventing
stages for them in code would be guessing at a project nobody stated — so each juror's ledger fills
from their next duty day onwards, exactly as `entryFocus` did.

### Scene and argument

The fourth failure is the one all three earlier measures pass (issue #113). Sarah's 2026-08-14 entry
argues a product-management thesis about scope and cognitive load; Marcus's 08-15 argues a venture
thesis about platform leverage and rent extraction. Different jurors, different vocabulary, different
objects, different arguments — so the arc comparison sees two shapes, the centre comparison sees two
unrelated subjects, and the project ledger sees nothing at all. Read one after the other they are the
same entry: a professional position stated near the top, the middle spent proving it with private
detail, a polished general principle at the end. Sarah's even contains a real disagreement with Alex,
and it changes nothing, because the disagreement is *reported as evidence* rather than happening on
the page.

What the two share is not a noun. It is a mode, and a mode has to be described before it can be
compared, so from `diary-v7` `entryFocus` carries three more fields:

| Field | What it holds |
|---|---|
| `sceneEvent` | What observably happens in the entry — who acts, answers, refuses, decides, gets something wrong — or **null** |
| `interactionLevel` | `none`, `reported` or `direct`: how much of another person is actually on the page |
| `abstractionLevel` | `scene`, `mixed` or `argument`: how much of the entry is the position rather than the day |

`sceneEvent` is nullable for the mirror image of `anchorObject`'s reason. A writer required to name an
event names one the text does not contain, and the field then certifies exactly the entry it was meant
to notice. `interactionLevel` separates `reported` from `direct` because that distinction is the whole
of Sarah's entry: a scale that only asked "was another juror in it" would have scored it full marks.
It is shown to the next writer and decides nothing in code — a predicate that treated "nobody else was
there" as a symptom would fire on an evening alone with a broken boiler, which the prompt calls a
perfectly good entry in the same breath.

Both levels are plain strings on the wire, with the accepted values enforced as a **warning**, exactly
like `projectUpdates.movement` and for the same reason — these fields reach tomorrow's prompt and
nothing else, so a word the pipeline cannot read is set aside with `DIARY_UNKNOWN_FOCUS_LEVEL` and the
entry publishes. For that same reason the validation schema is, in this one place, more tolerant than
the request: Gemini is asked for all seven focus fields, and a response that omits one of these three
is still applied with the field read as unstated. The four older fields keep their standing, because
an entry naming no subject at all is a defective shape rather than an under-described one.

Unlike `entryFocus`'s first four fields, the scene half is read back **across all five diarists**.
`lib/diary/scene.ts` reduces the newest `DIARY_RECENT_CYCLE.entryCount` entries — one full rotation —
to how each spent its day, and the prompt shows them as "how recent entries spent the day". The window
is cross-juror because the failure is: two entries with nothing else in common were still the same
kind of entry, and a writer shown only its own history would see none of that.

The prompt then names the essay as the anti-pattern, asks for something that happens where the reader
can see it, and states the request as an order of operations rather than a content rule — *the event
happens first and the thinking has to deal with it*. A reflection that would have come out word for
word without the event is the tell: there the event is decoration and the entry is a position paper
with a prop in it. When `DIARY_RECENT_CYCLE.essayRun` of the rotation have gone that way, the section
escalates and names the diarists, because the point of the finding is that it is not one persona
repeating itself.

The same three properties as the two sections above, for the same reasons:

- **It reads only the writer's own account of its own entry, never a body.** A metaphor-heavy
  paragraph is invisible to it; a day that says nothing happened is not. Two stated fields decide
  it — mostly the argument, and no event — and nothing else does.
- **It cannot fail a day.** An argument-led entry is a legitimate day and publishes. The outputs are a
  prompt section and a `DIARY_ENTRY_ESSAY_RUN` warning, and that warning fires on a *run* — today
  plus the cycle it was written into — never on a single day, because warning about one would be the
  quality opinion this pipeline is not allowed to hold.
- **No subject, and no technique, is required or forbidden.** Professional topics stay welcome in
  full; dialogue is never required and neither is another person; a quiet day is still a good day. The
  prompt says all of this in the section itself.

A worked five-juror sample, one rotation, as its writers would describe it
(`tests/helpers/diary-fixtures.ts`, asserted in `tests/unit/diary-scene.test.ts` — these are fixtures,
not generated entries):

| Juror | What happened | Interaction | Abstraction | Ended |
|---|---|---|---|---|
| alex | Leo rolled the deploy back and mentioned it afterwards, in one line | `direct` | `scene` | unresolved — the reply is still in the draft box |
| david | the neighbour came for the drill halfway through the last bracket | `direct` | `mixed` | the shelf is one screw short and the drill went back next door |
| lisa | *(nothing on the page)* | `none` | `argument` | settled into a principle |
| sarah | Marcus answered the scope question with a retention figure I could not argue with | `direct` | `mixed` | conceded, and irritated at having conceded so quickly |
| marcus | *(nothing on the page)* | `reported` | `argument` | a general principle about extraction |

Three of the five contain an event that complicates the writer's own reading of it, and those three
end on a consequence, an action or somebody else's answer rather than on a maxim. Sarah's row is the
one that matters most: it is wholly professional, in role vocabulary, about scope — and it is not the
failure, because the argument arrives as something another person said and she has to concede to it.
The two that are the failure are lisa's and marcus's, and two of five is deliberately one short of the
threshold: this is a cycle the guidance leaves alone, and the tests add a third to watch the run
appear.

The scene half starts empty, like everything before it. The 17 entries published under `diary-v3` and
`diary-v4` have no focus at all, and an entry written under `diary-v5` or `v6` has the first four
fields and not these three; the context builder skips a focus whose scene half is entirely unstated
rather than showing a row of blanks, and `isArgumentLed` never flags an unstated level. Scoring those
entries in code would mean inventing the signal the next prompt is about to quote back.

### Scheduled commitments

The fifth failure is the third one pointed at the future, and it is visible from the public site
alone (issue #120).

On 2026-08-16 Alex wrote that Leo's mother wanted them **"next month"** to clear out the attic. On
08-21 — five calendar days later — Alex and Leo were clearing it. The entry does not say the visit
was moved forward, that something urgent happened, or that "next month" had been wrong. Both
entries are individually readable; their calendars cannot both be true.

The project ledger cannot hold that, and adding a row to it would not have helped. A stage is a
fact about the past — "the third coat is on" — and a plan is a claim about a day that has not
arrived, stated in words that only mean something relative to the day they were written on.
Nothing in the context carried either half: `unresolvedThreads` and `currentConcerns` are undated
sentences, and the entry body says "next month" to a reader and nothing at all to a pipeline.

So from `diary-v8` the response carries `scheduledEvents`, at most
`DIARY_PATCH_LIMITS.scheduledEvents` of:

| Field | What it holds |
|---|---|
| `event` | What is going to happen, in the words earlier entries used for it |
| `participants` | Who it involves besides the writer; empty when it is only them |
| `when` | The time it was given, **in the writer's own words** — "next month", "on Saturday" — or **null** |
| `movement` | `made`, `kept`, `moved` or `dropped` |
| `changeReason` | Why the plan changed, when it did; **null** when nothing changed |

`when` is words rather than a date on purpose. A date computed by the model is a date nobody can
check, and a model asked for one on a day it is also writing two languages and eleven patch fields
will sometimes produce a plausible wrong one. `lib/diary/relative-dates.ts` resolves the phrase
against the date of the entry that said it, so "next month" written on 2026-08-16 becomes
2026-09-01 – 2026-09-30 and re-resolves to the same days on every re-run.

That resolver is a closed list, not a date parser, and it is governed by two rules:

- **An unrecognised phrase resolves to nothing.** "Once the weather turns" and "in a few weeks"
  get no window, and a commitment with no window is never the subject of a finding. A window this
  code invented would be used to accuse a later entry of missing a plan nobody stated.
- **An ambiguous phrase resolves to the union of its readings.** "Next Friday" is the coming
  Friday to some speakers and the following week's to others, so the window spans both. Choosing
  would report a dialect difference as a contradiction.

Windows are also *windows*: "next month" is thirty days, a point named in weeks carries a few
days' slack either side, and the edges of a month ("the end of next month") are a week.

`lib/diary/schedule.ts` reduces the writer's own recent entries to the commitments still standing
— newest statement wins — and the prompt shows them as "what you have already said you would do",
each with its own words and the days those words cover. Unlike the project ledger, **a resolved
commitment is dropped**: a finished bookcase can be quietly put back on the workbench and so stays
on the project list, but a visit that has happened or been called off is not a plan, and carrying
it forward as one is how a writer gets told to keep an appointment it already kept. An older entry
cannot reopen what a newer one closed. The lookback is longer than the project ledger's
(`DIARY_SCHEDULE_LEDGER.ownEntryLookback`, twelve of the writer's own entries — about nine weeks at
one duty day in five) because a plan made for "next month" has to still be on the list when next
month arrives.

The check compares a commitment the entry reports as `kept` against the window the archive holds
for it, and reports one kept outside that window with no `changeReason` given. What it compares
against is not the entry's own date but **the days since the writer's last entry**. Duty comes
round every fifth day, so an entry is never only about the date at the top of it: a plan made for
"tomorrow" is kept the day after, off-page, and written up four days later. Judging that against
the entry date alone would fire on nearly every short-horizon plan a diarist ever makes, and an
advisory that is always on is one nobody reads.

Two further findings close the ways round it. `DIARY_SCHEDULE_CHANGE_UNEXPLAINED` covers a plan
reported as `moved` or `dropped` with nothing said about why — a ledger row that will be quoted
back to the writer with a change nobody can account for, which is the original defect one step
earlier. `DIARY_SCHEDULED_EVENT_RETIMED` covers the hole the window check leaves on its own: an
entry that simply re-states a standing plan at a nearer date, as though it were new, resets the
window, and the entry that then keeps it lands inside the new one and draws nothing at all. Both
compare only what resolves — two times that cannot be compared are not a difference, and a plan
re-stated in different words that mean the same days is not a change.

The same three properties as the sections above, for the same reasons:

- **It reads only what the writer said about its own plans, never a body.** A dinner mentioned in
  passing is invisible to it, exactly as a bookcase leaned against in passing is invisible to the
  project ledger.
- **It cannot fail a day.** The outputs are a prompt section and warnings —
  `DIARY_SCHEDULED_EVENT_OUT_OF_WINDOW`, `DIARY_SCHEDULE_CHANGE_UNEXPLAINED`,
  `DIARY_SCHEDULED_EVENT_RETIMED`, plus a dropped event, an unknown movement and a truncated
  list. The 08-21 entry would have published exactly as written; what prevents the contradiction
  is the ledger in the next prompt, not the check that notices afterwards.
- **No plan is binding, and none is required.** A commitment may be moved, called off, or left to
  lapse and written about a month late. The only request is that the entry say which of those
  happened, in its own prose — the prompt states explicitly that `changeReason` records the
  explanation and does not replace it.

The two languages are held to the same schedule. The `LANGUAGE` section adds that dates, time
windows and changes of plan are facts rather than shading: if the English says a visit was brought
forward, the Japanese says so and why, and "next month" does not become "soon" in translation. A
schedule that survives in one language and goes vague in the other makes the two sides different
entries, which is the defect this section exists to prevent, arriving through the other door.

Everything here reads published entries only — no Private Canon, no state file, no memory patch,
no raw response — so nothing it puts into a prompt can carry any of those into public prose.

The ledger starts empty, like every continuity field before it. Entries published under `diary-v3`
through `diary-v7` carry no `scheduledEvents`, and inventing plans for them in code would be
guessing at commitments nobody stated, so each juror's ledger fills from their next duty day
onwards. The 08-16 entry that started this is not retroactively repaired; the next one like it is
the one the ledger catches.

### Central tension and ending

The sixth failure is the fourth one moved up an altitude, and it is visible from the public site
alone (issue #127).

Four consecutive entries, `diary-v7`, no human edit. Alex 08-21 sorts an attic to an efficient plan
and is interrupted by Leo and by his own over-planned childhood notebook. David 08-22 wants to
sort, weigh, label and reject damaged tomatoes, and ends up eating one unmeasured. Lisa 08-23 has
her symmetrical elevation spoiled by scaffolding and draws the scaffolding. Sarah 08-24 remembers a
lemonade stand organised so thoroughly it never sold lemonade. Four jurors, four scenes, four
objects, four sets of relationships — and one conflict between them: **a need for order, precision,
symmetry or planning meets imperfect reality and is softened by it.** Three of the four soften; the
fourth is pushed toward it.

Every earlier measure passes that sequence. The arcs differ. The centres differ, and the centre
comparison reads one juror's own last two entries anyway — these are four different diarists. Three
of the four contain another person acting on the page, so the mode comparison sees no essay run.
The projects and the plans are all straight. What recurs is the *editorial function* of the day:
which value gets pressed, and which way it gives. Read one at a time these are four good entries;
read in sequence they are four illustrations of one moral rather than four lives going on at once.

`centralTension` was already on the record for all four and reported nothing, because four writers
describe one conflict in four private vocabularies — "efficient sorting", "quality control",
"visual symmetry", "operational control" share no word, and the term overlap that finds a repeated
*subject* finds nothing here. A function has to be named in a shared vocabulary before it can be
counted. So from `diary-v9` `entryFocus` carries three more fields:

| Field | What it holds |
|---|---|
| `beliefChallenged` | The conviction, standard or preference the day pressed on, in the writer's own words |
| `pressuredValue` | One of `order`, `competence`, `autonomy`, `loyalty`, `honesty`, `ambition`, `care`, `standing` |
| `endingDirection` | One of `change`, `refusal`, `regression`, `escalation`, `unresolved`, `mistaken_certainty` |

`pressuredValue` flattens on purpose: "that the shelf should be level" and "that the roadmap should
be followed" are one word here, and at the altitude a reader notices they are one conflict.
`beliefChallenged` sits beside the label in the writer's own words and is what the next writer
actually reads; the label only makes counting possible. There is no ninth value called `other` —
that is where every day that did not quite fit would go, and a bucket holding a third of the
archive reports nothing. Both lists are plain strings on the wire, checked as **warnings**, exactly
like the two level fields of `diary-v7` and for the same reason: they reach tomorrow's prompt and
nothing else, so a word the pipeline cannot read is set aside with `DIARY_UNKNOWN_FOCUS_LEVEL` and
the entry publishes.

**What is counted is the pair, never one half.** Four jurors pressing their own standards in one
rotation is a theme, and a theme is allowed to come round; four of them being softened out of it in
the same rotation is a moral, and a diary with a moral has one author instead of five. So a shared
value with a different ending is left alone — by the prompt, by the advisory, and deliberately, in
both directions: a rotation that ends the same way for five different reasons is not a finding
either.

`lib/diary/tension.ts` reads the newest `DIARY_TENSION_CYCLE.entryCount` entries — **four**, not
five — and shows them as "what the last cycle put under pressure". Four, because at one duty day in
five those four are the other diarists exactly once each and today is the fifth: the five-day cycle
the issue reports on, assembled from inside it. A fifth row would be the writer's own previous day,
which the centre comparison already handles and which would make the rotation look more convergent
than it is by counting one persona twice.

The prompt then names the one-moral rotation as the anti-pattern, offers the other five endings by
name, and points out that pressure can come from something other than another person being
reasonable at you. When `DIARY_TENSION_CYCLE.convergentRun - 1` of the four shown already agree on
a pair, the section escalates and names the diarists, the value and the direction — today would
complete the run. The validator counts the same rotation from the other end, with today's own pair
in hand, and records `DIARY_ENTRY_TENSION_CONVERGENCE` when `count + 1` reaches the threshold.

Four of five, where the essay run is three of five, because this is a narrower claim. An essay run
says the entries had no days in them, which one field decides. This says four different people
reached for the same conviction and gave way in the same direction, and three of five is a
coincidence a rotation can produce honestly — a threshold that fired on it would be asking jurors
to avoid each other's values rather than to have their own.

The same three properties as the sections above, for the same reasons:

- **It reads only the writer's own account of its own entry, never a body.** A day full of tidy
  domestic detail is invisible to it. Two labels decide the count, and nothing else does.
- **It cannot fail a day.** All four of the entries above are good entries and would publish again
  unchanged. The outputs are a prompt section and a warning, and the warning fires on a rotation —
  today plus the four it was written into — never on a single day.
- **No value, no subject and no ending is forbidden.** Order may be pressed every day of the week,
  and being softened out of a position is one of six legitimate endings rather than the wrong one.
  The prompt says so in the section itself, and adds the line that matters most: if today genuinely
  softened you, say so and say it plainly.

The two documented rotations (`tests/helpers/diary-fixtures.ts`, asserted in
`tests/unit/diary-tension.test.ts` — these are fixtures, not generated entries):

| Juror | What was under pressure | Value | Ended |
|---|---|---|---|
| alex | that being trusted and being told first are the same thing | `standing` | `unresolved` |
| david | that a job worth doing is worth doing to the millimetre | `order` | `change` |
| lisa | that an interface nobody wrote down was never actually finished | `order` | `refusal` |
| sarah | that a decision I can defend beats one that merely works | `competence` | `change` |
| marcus | that a portfolio has to be worth something to somebody other than me | `ambition` | `refusal` |

Five central tensions, four values, three endings, and no pair twice — a rotation the guidance
leaves alone. David and Lisa are the row that matters: both press `order`, one is softened out of
it and the other will not move. Two entries agreeing about what is at stake and disagreeing about
what to do with it are two lives, and this is the case no advisory may ever fire on.

`DIARY_CONVERGED_CYCLE_SAMPLE` is the same rotation written the other way — the shape of the four
public entries above, with a fifth day added, since the advisory counts a rotation and the issue's
evidence stops at four:

| Juror | What was under pressure | Value | Ended |
|---|---|---|---|
| alex | that an hour planned properly is an hour saved | `order` | `change` |
| david | that anything worth keeping can be weighed and labelled first | `order` | `change` |
| lisa | that a drawing should be true to the shape underneath | `order` | `change` |
| sarah | that a plan agreed in advance is the plan | `order` | `unresolved` |
| marcus | that a mess is only a system nobody has written yet | `order` | `change` |

The count works from both ends. The first four contain three `order`/`change` entries, which is
where the prompt speaks up; Marcus's entry completes the run, which is what the validator records.
All five press `order`, and that alone is not the finding — Sarah presses it too and leaves it
open, and five entries pressing order with five different endings would pass unremarked.

Everything here reads published entries only — no Private Canon, no state file, no memory patch, no
raw response — so nothing it puts into a prompt or a finding can carry any of those into public
prose.

The tension half starts empty, like everything before it. The entries published through `diary-v8`
carry a centre and a mode and no vocabulary for their conflict; the context builder skips a focus
whose tension half is entirely unstated rather than showing a row of blanks, and an unstated value
matches nothing — two entries that both declined to name one have not written the same conflict.
Scoring the existing archive in code would mean inventing the signal the next prompt is about to
quote back.

## 4. Generation flow

Three CLI invocations, so the workflow can commit between them:

```text
resolve duty + theme + reading assignment
  → skip if already generated / published / excluded
  → build context (state, own last entry, peers, recent openings/closings, how the last
                   rotation spent its days, own recent entry focuses, open projects and
                   their last stage, mentions, memories, reviews, and on relationship days
                   the full entry being read)
  → ONE Gemini call
  → persist verbatim response to the generation record      ← commit here
  → parse + structural validation
  → apply patches → event + persona state
  → write entry
  → build
  → commit (entry + event + 5 state files + record, atomically)
  → deploy
  → mark published                                          ← commit state sync
```

**Response-first persistence** is inherited unchanged from the article pipeline: the verbatim
response is on disk before anything parses it, and **a run whose response is stored never calls
Gemini again**. Resuming is free; re-generating by accident is impossible.

The record has three axes and, deliberately, no quality axis:

| Axis | Values |
|---|---|
| `generation.status` | `succeeded` \| `unavailable` |
| `structural.status` | `pending` \| `passed` \| `failed` |
| `application.status` | `pending` \| `applied` \| `skipped` |
| `publication.status` | `pending` \| `published` \| `excluded` |

### Atomicity

A published diary and its persona state can never disagree (brief §15):

- the entry file is only written after patches applied cleanly
- entry, event, all five state files and the record are committed in **one commit**
- `publication.status = published` is set only **after a successful deploy**
- every state file carries `lastEventId`; applying the same day twice is refused, as is
  applying onto a partially-updated persona or replaying an older day over newer state
- every event records the before/after `sha256` of each state file

If a run dies mid-way, the next run converges from the stored response: state on disk has not
moved, so the patches apply cleanly; or state has moved but the entry is missing, and the run
completes the remaining writes without re-applying.

## 5. The structural gate

**JuryDiary has no quality gate and never will.** A boring day, a slightly inconsistent day, a
translation with a flattened joke — all published, because they are the experiment's results.

Publication is refused only for structural damage:

- the response is not JSON, or not the agreed shape
- an unknown top-level field (the shape a "let me also edit the persona" hallucination takes)
- either language empty, stubbed, or below its length floor
- `body.ja` containing too little Japanese script to be a translation (catches the English body
  pasted into the Japanese field)
- a length ratio outside [0.2, 3.0] between the two languages
- a patch beyond its per-day limit, or aimed at an unknown juror
- an identity that disagrees with the day, juror, theme or category the code assigned
- a reply pointing at an entry that was never assigned to be read

Warnings never cost a day: a share quote that is not a verbatim span, a dropped review
reference, truncated contradiction notes, a blank field in the entry's own focus description,
a focus level the pipeline cannot read, a rotation that has spent most of its entries arguing
positions with nothing happening in them, a rotation in which four diarists pressed one value and
gave way in one direction, a project put back at a stage the archive had already reached, a plan
carried out weeks away from the window the archive gave it, a plan moved or called off with
nothing said about why, or a juror who read someone's entry and had nothing to say about it.

**A structurally invalid response is a normal completion** — exit 0, record `excluded`, green
workflow, no entry, no state change. It is not an incident.

## 6. Events and git history

```text
bootstrap state + every event in date order = current state
```

Current state is a cache for fast reads; the event stream is the audit record. Each event
carries the normalized patch actually applied (not what the model asked for), what was pruned
to respect the caps, the before/after hash of all five state files, and the model, prompt
version and schema version that produced it.

Commit messages:

```text
diary(david): persist 2026-07-30 generation [skip ci]
diary(david): publish 2026-07-30 entry
diary(david): publish-state 2026-07-30 [skip ci]
diary(david): exclude 2026-07-30 structural [skip ci]
```

## 7. Free-tier-only policy

JuryDiary must never bill (brief §12.2). This is enforced structurally, not procedurally:

- `src/lib/diary/gemini.ts` can only reach the transport's `primaryOnly` mode, which **does not
  construct a fallback client at all**
- it additionally refuses to run if handed the value of `GEMINI_FALLBACK_API_KEY`
- the workflow does not pass `GEMINI_FALLBACK_API_KEY` into any diary step
- credential order: `JURYDIARY_GEMINI_API_KEY` → `GEMINI_API_KEY`. Never the billed key.
- attempts default to **2**. There is no second credential to escalate to, so the only failure
  worth retrying is a transient one. A credential error fails immediately; a quota error gets
  one more try in case it is a per-minute limit rather than a daily one.

Model resolution is independent of the article pipeline: `JURYDIARY_GEMINI_MODEL`, defaulting to
`gemini-3.5-flash`. Changing `GEMINI_MODEL` for reviews does not change what writes the diaries.

**Quality is never a reason to regenerate.** There is no code path from a stored response to a
second Gemini call.

## 8. Failure behaviour

| Situation | Result |
|---|---|
| No response obtained | Exit 1, red workflow, `data/diary/failures/…` written, **no** record, persona untouched, day left as a gap |
| Response obtained, structurally invalid | Exit 0, **green**, record `excluded`, no entry, persona untouched |
| Response stored, run interrupted | Next run resumes from the stored response, no Gemini call |
| Day already applied | Idempotent no-op |
| Day already published | Idempotent no-op, no rebuild |
| Persona state missing or partial | Exit 1. Never silently re-initialised — that would erase the experiment |

Failure notes carry a sanitized error category only, never a credential (verified by test).

Missing days are expected and are not backfilled. There is no backfill command in this version.

## 9. Bootstrap

One manual, never-scheduled operation creates all five personas:

```bash
npm run diary:bootstrap
```

- Refuses to run if any juror already has state, unless `--force`.
- `--force` permits **overwriting state**, never re-buying the response: a stored bootstrap
  response is re-applied rather than regenerated.
- One Gemini call produces all five fictional lives; the response is persisted before parsing,
  like any other.
- Starting canon is deliberately sparse (brief §8.2): one home, at most one close person, two
  hobbies, two habits, one weakness, at most one object/place. The rest is meant to emerge from
  the diaries.
- **The model is never asked for a number.** `trust`/`respect`/`tension` are written by code at
  0.50 / 0.50 / 0.20 — a model asked to invent relationship scores produces a cast of allies and
  rivals on day one, which is the opposite of watching relationships form.
- Writes `data/diary/config.json` with `startDate` defaulting to the bootstrap day.

Review the output for structural sanity before enabling autonomy. Human editing of the content
is not required.

## 10. Running it

All commands run in the **public repo** (`app/` in the workflows), against a content root.

```bash
# Generate today's diary (persists the response; does not apply it)
JURYPRESS_DATA_MODE=production JURYPRESS_CONTENT_ROOT=/path/to/content/data \
  npm run diary:daily

# A specific day
npm run diary:daily -- --target-date 2026-08-02

# Inspect the prompt without calling Gemini
npm run diary:daily -- --target-date 2026-08-02 --dry-run

# Apply a stored response: structural gate, patches, event, entry
npm run diary:daily -- --apply-record --run-key diary-2026-08-02-david

# Mark published (only after a successful deploy)
npm run diary:daily -- --update-status published --run-key diary-2026-08-02-david

# Validate the whole diary tree
npm run validate:diary
```

`validate:diary` is deliberately **separate** from `validate:content`: the article workflows use
that command as their push-time gate, and wiring diary data into it would let a corrupt diary
file block a review from publishing. The two experiments share a repository, not a fate.

### Workflow (private repo)

`.github/workflows/daily-diary.yml`, `workflow_dispatch` inputs:

| Input | Values |
|---|---|
| `operation` | `publish_today` \| `resume` \| `bootstrap` |
| `target_date` | `YYYY-MM-DD`, optional |
| `resume_run_key` | `diary-<YYYY-MM-DD>-<juror>`, required for `resume` |

It shares the `jurypress-daily-publish` concurrency group with every other writing workflow,
`cancel-in-progress: false`. A separate group would let a diary run deploy a `dist/` built from
an older checkout and briefly un-publish a review that had just gone out.

## 11. Enabling and stopping autonomy

Scheduled runs are **fail-closed** on a repository variable, exactly like the article pipeline:

```yaml
if: ${{ github.event_name != 'schedule' || vars.JURYDIARY_AUTONOMOUS_PUBLISH_ENABLED == 'true' }}
```

- **Unset (default): cron does nothing.** Merging JuryDiary does not start it.
- To enable: repo → Settings → Secrets and variables → Actions → Variables →
  `JURYDIARY_AUTONOMOUS_PUBLISH_ENABLED = true`
- To stop: delete the variable or set it to anything else. Manual dispatch always works.

Schedule: `17 9 * * *` UTC (18:17 JST) — two hours after the daily article run, and independent
of it. A diary is generated whether or not a review was published that day.

## 12. Public / private data boundary

| Public (`yosuke1024/JuryPress`, MIT) | Private (`yosuke1024/JuryPress-content`) |
|---|---|
| Schemas, pipeline, CLIs, site, tests, docs | Every diary entry, event, generation record |
| Fixture diary data under `tests/fixtures/diary/` | All five personas' canon, state, relationships, memories |
| — | `config.json`, failures |

No persona state is stored in the public repository. A curated or anonymised public dataset is a
possible future step, not part of this version.

## 13. Fiction disclosure

Every diary page carries, in both languages:

> JuryDiary is an autonomous fiction experiment. Its AI jurors develop fictional memories,
> relationships, and private lives over time. Entries may be inconsistent, strange, or
> unexpectedly honest.

> JuryDiaryは、自律生成されるフィクション実験です。AI審査員は架空の記憶、人間関係、私生活を少しずつ形成します。
> 日記には矛盾、不自然さ、思いがけない本音が含まれることがあります。

The prompt additionally forbids inventing facts, accusations or wrongdoing about real projects,
companies or people, and forbids real people, addresses or employers appearing in the invented
private lives. Anything a diary says about a real project must already be in its review context.

## 14. Site structure and analytics

| URL | Page |
|---|---|
| `/jurypress/diary/` | Index: latest entry, archive, duty roster, the five diarists |
| `/jurypress/diary/<YYYY-MM-DD>-<juror>/` | One entry, English and Japanese |
| `/jurypress/diary/jurors/<juror>/` | One diarist: public persona, entries, recent moods, themes |
| `/jurypress/diary/rss.xml` | Diary feed |
| `/jurypress/diary/og/<YYYY-MM-DD>-<juror>.png` | Social card |

URLs never contain the generated title, so a title change cannot move a page.

Both languages are in the same page, stacked, with correct `lang` attributes and no JavaScript
required to read either. Share controls are progressive enhancement: the quote, attribution and
permalink are present as text, and the buttons stay hidden unless a script can make them work.

The juror pages publish only what Core Persona already makes public plus what the entries say.
Private Canon, relationship scores, trait strengths and memory importance never reach the site —
publishing the numbers would turn a diary into a dashboard.

Analytics (GA4 via the existing Partytown-forwarded `dataLayer`, no user ids, no separate
backend): `jury_diary_view`, `jury_diary_share`, `jury_diary_quote_copy`,
`jury_diary_language_change`, `jury_diary_related_review_click`, `jury_diary_juror_archive_view`,
with `juror_slug`, `theme`, `language`, `entry_date`.

## 15. Future analysis

The stored format is designed so these can be answered later from git alone:

- **Persona** — who changed most and least; when a juror turned optimistic or bleak; which
  project preceded a belief shift; whether private life bled into evaluation posture.
- **Relationships** — highest trust and highest tension pairs; one-sided respect; a rivalry that
  became understanding; pairs who differ at work and off the clock; which replies moved a
  relationship and which were ignored (`respondsToDiaryId` plus the event's relationship patch).
- **Private life** — hobbies the model invented unprompted; threads that ran for weeks; settings
  it quietly forgot; recurring people, animals, objects and places; the work/life ratio.
- **Popularity** — views and share rate per juror; English vs Japanese preference; private vs
  work entries; whether persona change tracks popularity; the single most-shared sentence.

Everything needed for the first three is in `events/` and the state files. The fourth needs the
analytics events above.

## Operating principles

> Content quality may be experimental. Operational quality, structure, safety and history
> integrity may not.

- A dull day is fine. A day that is only private life is fine. A little inconsistency is fine.
- Imperfect translation is fine. Personality drift is fine.
- Never regenerate for quality. Never publish something structurally broken.
- Never feed it secrets. Never invent a real person's private information.
- Never invent new accusations about real projects. Never fail over to a paid API.
- Do not fear gaps. Do not make the machinery heavy. Decide on sophistication after 30 days.
