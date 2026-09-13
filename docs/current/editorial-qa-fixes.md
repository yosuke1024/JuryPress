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
