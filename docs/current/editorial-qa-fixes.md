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

## Diary real-project fiction boundary (#150)

`diary-v12` keeps a real project from becoming an invented direct-use incident in a juror's
private life. A review remains material the juror read or judged: the prompt may turn it into a
character-specific opinion, doubt, or disagreement, but not into a claim that the juror installed
the project, met its maintainers, or suffered a crash, corruption, data loss, or other harm. A
scene that needs an invented malfunction uses an unidentifiable fictional tool or a generic
situation. This changes only prompt guidance and its version; it adds no validator, retry,
generation call, or publication gate, and does not rewrite existing entries.

## Diary translation referent fidelity (#162)

`diary-v16` treats concrete referents as translation facts alongside the existing schedule-fact
contract. The Japanese must preserve the English entry's object, material, food, body or object
part, quantity, and physical state instead of substituting a plausible neighbour. It must also use
natural Japanese rather than transliterating ordinary English connectors. A final in-request pass
compares each Japanese sentence with its completed English counterpart for changed referents,
attributes, actions, quantities, and relationships. This remains guidance inside the existing
single generation: it adds no LLM call, retry, subjective quality gate, or rewrite of published
entries. Its effect must be checked on new `diary-v16` publications.
