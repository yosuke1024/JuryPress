# Editorial QA fixes — September 2026

## Diary body separators (#140)

`diary-validator-1.7.0` normalizes double-escaped LF/CRLF/CR separators in both
body languages after parsing, before structural validation and entry creation.
The saved model response is untouched; normalization is recorded as a warning.
Unsupported controls fail structural validation with the body field and language.
Archive rendering uses the same separator normalization, so the next ordinary
site build repairs paragraph display without editing stored entries or history.
No prose, translation, state, generation call, or publication schedule is changed.

## Diary continuity (#143)

`diary-v10` carries a bounded closing excerpt from each of the writer's last two
public entries alongside their existing focus metadata. Previously the main
continuity excerpt kept only the first 2,000 characters: the concrete final action
could disappear even though the prompt asked the writer to continue it.
The prompt now asks a reused conflict to change an action, cost, relationship,
judgment, or unresolved stage. Returning to the same endpoint needs a new cause
or consequence. Callbacks, backsliding, and unresolved or petty endings remain
valid. This is context and writing guidance, with no new quality gate or retry.
The regression tests preserve Alex's unsaved deletions and Sarah's closed drawer
after long bodies. Actual narrative improvement needs observation of new entries.

## Diary cross-person scene comparison (#148)

`diary-v11` keeps each recent entry's title, central object, conflict, decisive event,
and ending together in the bounded five-person cycle context. The prompt asks the next
writer to change the incident or consequence when two or more concrete scene components
would align with one recent entry. This prevents a recent scene from being transplanted
to another diarist by changing only the name or material while preserving legitimate
callbacks, shared themes, and different encounters with recurring objects. It adds no
validator, retry, generation call, or publication gate. Existing entries are unchanged;
the narrative effect must be checked on new `diary-v11` publications.
