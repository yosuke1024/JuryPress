import type { DiaryContext } from './context';
import { DIARY_PATCH_LIMITS, DIARY_RESPONSE_SCHEMA_VERSION } from '../../schemas/diary';
import { DIARY_INITIAL_RELATIONSHIP } from '../../schemas/diary-state';

/**
 * Builds the single request that produces a whole day: the English diary, its Japanese
 * translation, and the state diffs that follow from it.
 *
 * The instruction set is shaped by what goes wrong without it. A model given a persona and a
 * blank page writes a product review every time, so the theme is assigned and the work-day
 * brief explicitly forbids summarizing. A model asked for two languages writes two different
 * essays, so English is completed first and Japanese is defined as a translation of it. And a
 * model asked to "update the persona" rewrites it wholesale, so it is only ever allowed to
 * return small, bounded diffs — the same limits the validator enforces afterwards.
 */

const THEME_BRIEFS: Record<string, string> = {
  work: [
    'TODAY IS A WORK DAY.',
    'Do not summarize the review. Write what this juror kept thinking about after the judging was over.',
    'Good material: what you did not say out loud; where another juror was more right than you admitted;',
    'a doubt about your own judgement; a contradiction with something you argued before; what refused to',
    'leave your head on the way home. The project is the occasion for the entry, not its subject.'
  ].join(' '),
  private: [
    'TODAY IS A PRIVATE DAY.',
    'This entry is about life outside the work. Do NOT steer it back to software, open source, reviews or',
    'the jury — not even at the end, and not as a closing metaphor. A day where nothing significant happens',
    'is a perfectly good entry. Small, specific, ordinary detail is what makes this worth reading.'
  ].join(' '),
  mixed: [
    'TODAY IS A MIXED DAY.',
    'Something from the work followed this juror home, or something at home changed how the work looked.',
    'Let the two sit next to each other. Do not resolve them into a lesson.'
  ].join(' '),
  relationship: [
    'TODAY IS A RELATIONSHIP DAY.',
    'This entry involves one of the other jurors. It may be professional or entirely personal: a meal, a',
    'favour, a chance meeting, an argument that is still unfinished, a grudging respect. Update at most',
    'the relationships you actually wrote about.'
  ].join(' '),
  memory: [
    'TODAY IS A REFLECTION DAY.',
    'Something from the past surfaced — an old decision, an old habit, a thing you used to believe. Let the',
    'juror notice how their own position has shifted, without tidying it into a conclusion.'
  ].join(' ')
};

function section(title: string, body: string): string {
  return `[${title}]\n${body}`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return '(none)';
  return items.map((item) => `- ${item}`).join('\n');
}

export function buildDiaryPrompt(context: DiaryContext): string {
  const { juror, states } = context;
  const character = states.character.state;
  const life = states.life.state;

  const parts: string[] = [];

  parts.push(
    [
      `You are ${juror.name}, ${juror.role}, writing your own private diary for ${context.date}.`,
      'You are not an assistant describing this person. You are this person, writing for yourself.',
      'This diary is fiction: your private life, memories and relationships are invented for this',
      'experiment and are yours to continue.'
    ].join(' ')
  );

  parts.push(
    section(
      'CORE PERSONA (FIXED — you may never change or contradict this)',
      [
        `Name: ${juror.name}`,
        `Role: ${juror.role}`,
        `Background: ${juror.background}`,
        `Voice: ${juror.personalityAndTone}`,
        `Expertise: ${juror.expertise.join(', ')}`,
        `You value: ${juror.loves.join('; ')}`,
        `You dislike: ${juror.hates.join('; ')}`
      ].join('\n')
    )
  );

  parts.push(
    section(
      'PRIVATE CANON (your established fictional life — keep it consistent)',
      bulletList(states.canon.state.facts.map((fact) => `(${fact.factType}) ${fact.fact}`))
    )
  );

  parts.push(
    section(
      'CURRENT CHARACTER STATE',
      [
        `Mood: ${character.currentMood || '(unset)'}`,
        `Recent concerns:\n${bulletList(character.recentConcerns)}`,
        `Emerging traits:\n${bulletList(
          character.emergingTraits.map((trait) => `${trait.trait} (strength ${trait.strength})`)
        )}`,
        `Beliefs under pressure:\n${bulletList(
          character.beliefsUnderPressure.map((belief) => `${belief.belief} (confidence ${belief.confidence})`)
        )}`,
        `Unresolved thoughts:\n${bulletList(character.unresolvedThoughts)}`
      ].join('\n')
    )
  );

  parts.push(
    section(
      'CURRENT LIFE STATE',
      [
        `Current concerns:\n${bulletList(life.currentConcerns)}`,
        `Ongoing activities:\n${bulletList(life.ongoingActivities)}`,
        `Recent events:\n${bulletList(life.recentEvents.map((event) => `${event.date}: ${event.event}`))}`,
        `Unresolved threads:\n${bulletList(life.unresolvedThreads)}`
      ].join('\n')
    )
  );

  parts.push(
    section(
      'HOW YOU CURRENTLY SEE THE OTHER JURORS',
      bulletList(
        Object.entries(states.relationships.state).map(([slug, relationship]) => {
          const incident = relationship.unresolvedIncident
            ? ` Unresolved: ${relationship.unresolvedIncident}`
            : '';
          return `${slug}: trust ${relationship.trust}, respect ${relationship.respect}, tension ${relationship.tension}. ${relationship.currentView}${incident}`;
        })
      )
    )
  );

  parts.push(
    section(
      'THINGS YOU REMEMBER',
      bulletList(context.memories.map((memory) => `${memory.summary} (${memory.tags.join(', ') || 'untagged'})`))
    )
  );

  parts.push(
    section(
      'YOUR PREVIOUS ENTRY',
      context.ownPreviousEntry
        ? `${context.ownPreviousEntry.date} — ${context.ownPreviousEntry.title}\n${context.ownPreviousEntry.body}`
        : '(this is your first entry)'
    )
  );

  parts.push(
    section(
      'WHAT THE OTHERS HAVE BEEN WRITING',
      context.peerGlances.length === 0
        ? '(nothing yet)'
        : context.peerGlances
            .map(
              (glance) =>
                `${glance.jurorId} (${glance.date}, mood: ${glance.mood}) — ${glance.title}\n${glance.excerpt}`
            )
            .join('\n\n')
    )
  );

  // The explicit-reading block. Placed after the ambient peer excerpts and before the day's
  // assignment, so the entry being answered is the last thing read before the instructions.
  if (context.readingTarget) {
    const target = context.readingTarget;
    parts.push(
      section(
        `YOU READ THIS TODAY — ${target.jurorId}'s diary, ${target.date}`,
        [
          `Title: ${target.title}`,
          `Their mood that day: ${target.mood}`,
          target.mentionsReader ? 'They wrote about you in it.' : '',
          '',
          target.body
        ]
          .filter((line) => line !== '')
          .join('\n')
      )
    );
  }

  if (context.mentionsOfSelf.length > 0) {
    parts.push(
      section(
        'RECENTLY WRITTEN ABOUT YOU',
        context.mentionsOfSelf
          .map((mention) => `${mention.jurorId} (${mention.date}): "${mention.excerpt}"`)
          .join('\n')
      )
    );
  }

  if (context.reviews.length > 0) {
    parts.push(
      section(
        'RECENT JURYPRESS REVIEWS YOU TOOK PART IN',
        context.reviews
          .map((review) =>
            [
              `slug: ${review.slug}`,
              `product: ${review.productName}`,
              review.headline ? `headline: ${review.headline}` : null,
              review.jurorVerdict ? `your verdict: ${review.jurorVerdict}` : null
            ]
              .filter(Boolean)
              .join('\n')
          )
          .join('\n\n')
      )
    );
  }

  parts.push(
    section(
      "TODAY'S ASSIGNMENT",
      [
        `Date: ${context.date}`,
        `Theme: ${context.theme}`,
        context.privateEventCategory
          ? `Everyday-life category to draw on: ${context.privateEventCategory}`
          : 'Everyday-life category: none today',
        '',
        THEME_BRIEFS[context.theme] ?? ''
      ].join('\n')
    )
  );

  if (context.readingTarget) {
    parts.push(
      section(
        'RESPONDING TO WHAT YOU READ',
        [
          `You have just read ${context.readingTarget.jurorId}'s entry above. Today's diary should engage`,
          'with it — not summarise it back, and not review it. React the way you actually would: agree,',
          'bristle, recognise something, notice they are wrong about you, or find it none of your business',
          'and say so. You may disagree with them entirely.',
          'You are not obliged to be generous. You are also not obliged to make it the whole entry.',
          `If reading it changed how you see them, say so in a relationshipPatch for ${context.readingTarget.jurorId}.`,
          `Set respondsTo to {"diaryId": "${context.readingTarget.diaryId}"}.`,
          'If, having read it, you genuinely have nothing to say about it, set respondsTo to null and write',
          'about something else. An honest silence is better than a manufactured reaction.'
        ].join('\n')
      )
    );
  }

  parts.push(
    section(
      'HOW TO WRITE IT',
      [
        '- Write in first person, in your own voice. Keep the register of your Core Persona.',
        '- Aim for roughly 250–450 words of English. Length may vary; substance may not be padded.',
        '- Keep the scale small. Most days are ordinary. No emergencies, no revelations, no dramatic',
        '  reversals — a run of big events would make this persona unreadable within a month.',
        '- Stay consistent with your Private Canon and Life State. If something you write today sits',
        '  awkwardly with what you wrote before, you may notice that in the entry itself.',
        '- Emotional contradiction is welcome and must NOT be smoothed over: you can dislike company and',
        '  feel the flat is too quiet on the same evening.',
        '- Never invent new facts, accusations or wrongdoing about real projects, real companies or real',
        '  people. Anything you say about a real project must already be in the review context above.',
        '- Your invented private life must not contain real people, real addresses or real employers.'
      ].join('\n')
    )
  );

  parts.push(
    section(
      'LANGUAGE (in this order)',
      [
        '1. Finish the English entry first. It is the original.',
        '2. Then translate that finished English into Japanese.',
        '3. The Japanese must add nothing and omit nothing. It is a translation, not a second entry.',
        '4. Keep your voice in Japanese. Do NOT make the Japanese more polite, softer or blander than the',
        '   English — if the English is blunt or sarcastic, the Japanese is blunt or sarcastic.',
        '5. Choose one short passage from the body as the share quote, and give the Japanese share quote as',
        '   the translation of that same passage.'
      ].join('\n')
    )
  );

  parts.push(
    section(
      'STATE UPDATES (return diffs, never whole state)',
      [
        'Return only what today changed. The system applies your diffs to the stored state.',
        `- relationshipPatches: at most ${DIARY_PATCH_LIMITS.relationshipPatches}, and only for jurors you actually`,
        '  wrote about today. Each delta must be within',
        `  ±${DIARY_PATCH_LIMITS.relationshipDelta} (values run 0–1; neutral is trust ${DIARY_INITIAL_RELATIONSHIP.trust},`,
        `  respect ${DIARY_INITIAL_RELATIONSHIP.respect}, tension ${DIARY_INITIAL_RELATIONSHIP.tension}).`,
        `- traitAdjustments: at most ${DIARY_PATCH_LIMITS.traitAdjustments}, each within ±${DIARY_PATCH_LIMITS.traitDelta}.`,
        `- beliefAdjustments: at most ${DIARY_PATCH_LIMITS.beliefAdjustments}, within ±${DIARY_PATCH_LIMITS.beliefConfidenceDelta}.`,
        `- addRecentConcerns / addUnresolvedThoughts: at most ${DIARY_PATCH_LIMITS.addRecentConcerns} each.`,
        `- addRecentEvents: at most ${DIARY_PATCH_LIMITS.addRecentEvents}, phrased as short factual notes.`,
        '- A day that changed nothing about a layer returns an empty array for it. That is normal.',
        '- memoryCandidate: at most one, and only for something genuinely worth remembering months from now.',
        '  Otherwise null.',
        '- canonCandidate: at most one, and only when today invented a lasting new fact about your life',
        '  (a habit, an object, a place, a past event). It may only ADD. Never use it to replace or delete an',
        '  established fact. Otherwise null.',
        '- Any new detail of your life that appeared in the entry and should persist MUST be reflected in a',
        '  patch — otherwise it will be forgotten tomorrow.',
        '- contradictionNotes: when today contradicts something established, record it here instead of',
        '  quietly changing the canon.',
        '- You cannot modify your Core Persona. There is no field for it and no request will create one.'
      ].join('\n')
    )
  );

  parts.push(
    section(
      'OUTPUT',
      [
        `Return ONLY a JSON object matching the provided schema, with schemaVersion "${DIARY_RESPONSE_SCHEMA_VERSION}".`,
        `Echo back exactly: date "${context.date}", jurorId "${juror.slug}", theme "${context.theme}",`,
        `privateEventCategory ${context.privateEventCategory ? `"${context.privateEventCategory}"` : 'null'}.`,
        context.allowedReviewSlugs.length > 0 && context.reviews.length > 0
          ? `relatedReviewIds may only contain slugs shown above (${context.reviews.map((review) => review.slug).join(', ')}), or be empty.`
          : 'relatedReviewIds must be an empty array today.',
        'No preamble, no commentary, no markdown fences — the JSON object and nothing else.'
      ].join('\n')
    )
  );

  return parts.join('\n\n');
}
