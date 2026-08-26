import type { DiaryContext } from './context';
import {
  DIARY_ABSTRACTION_LEVELS,
  DIARY_CANON_FACT_TYPES,
  DIARY_ENDING_DIRECTIONS,
  DIARY_INTERACTION_LEVELS,
  DIARY_MEMORY_IMPORTANCE,
  DIARY_PATCH_LIMITS,
  DIARY_PRESSURED_VALUES,
  DIARY_PROJECT_MOVEMENTS,
  DIARY_RESPONSE_SCHEMA_VERSION,
  DIARY_SCHEDULE_MOVEMENTS,
  DIARY_TEXT_LIMITS
} from '../../schemas/diary';
import { DIARY_INITIAL_RELATIONSHIP } from '../../schemas/diary-state';
import { JUDGE_SLUGS } from '../../schemas/jury';

/**
 * Builds the single request that produces a whole day: the English diary, its Japanese
 * translation, and the state diffs that follow from it.
 *
 * The instruction set is shaped by what goes wrong without it. A model given a persona and a
 * blank page writes a product review every time, so the theme is assigned and the work-day
 * brief explicitly forbids summarizing. A model asked for two languages writes two different
 * essays, so English is completed first and Japanese is defined as a translation of it. A
 * model asked to "update the persona" rewrites it wholesale, so it is only ever allowed to
 * return small, bounded diffs — the same limits the validator enforces afterwards. And a
 * model left to shape the day converges on one arc for every diarist — private prop,
 * professional metaphor, tidy lesson (issue #105) — so the prompt names that arc as the
 * default to avoid, shows how the newest entries opened and closed, and grants explicit
 * permission for days that end unresolved, unprofessional, or unimproved. Shape is steered
 * here and only here: the structural gate has no opinion on it, by design.
 *
 * Shape was only half of it. A juror whose entries take three different shapes can still write
 * the same day three times, because continuity context keeps re-electing one object and one
 * argument as the centre of the story (issue #110). So the prompt also shows the writer what
 * its own last entries were *about*, separates a prop that is present from a prop that is
 * carrying the entry, and — when two consecutive days already agree on a centre — asks for a
 * materially different one today. That is a request, never a rule: no subject is banned here,
 * and the gate still has no opinion.
 *
 * The third failure is the opposite of the second, and needs the opposite answer. A project a
 * juror keeps coming back to is the diary working as intended — until it comes back to a stage
 * it had already passed, as David's cedar bookcase did ten days and one entry apart (issue
 * #111). So the prompt also carries a ledger of where the archive left each ongoing project,
 * and asks that a returning project resume from there: advance it, land a consequence, or say
 * what undid it. Nothing about that is a ban either; the subject is welcome, the reset is not.
 *
 * The fourth is none of the above and survives all three. Two entries may take different
 * shapes, turn on different subjects and keep every project straight, and still both be
 * essays: a professional position stated near the top, the middle spent proving it with
 * private detail, a general principle at the end (issue #113 — Sarah 08-14, Marcus 08-15).
 * Nothing they share is a noun, so the prompt shows what the last rotation was *made of* —
 * what happened in each entry, how much of another person was in it, how much of it was the
 * argument — and asks today to contain something that happens and to let that complicate the
 * thinking rather than illustrate it. Professional subjects stay welcome; dialogue is never
 * required; the gate still has no opinion.
 *
 * The fifth is the third one pointed at the future (issue #120). Alex wrote on 2026-08-16 that
 * Leo's mother wanted them "next month" to clear out the attic, and on 08-21 they were clearing
 * it, with nothing to say the visit had moved. The project ledger cannot hold that, because a
 * plan is not a stage: it is a claim about a day that has not arrived. So the prompt also
 * carries the commitments the archive left standing, with the words each was given and the days
 * those words resolve to, and asks that keeping one either happen inside its window or say what
 * changed. The plan is free to move; the move is not free to be silent.
 *
 * The sixth is the fourth one moved up an altitude (issue #127). Four consecutive entries kept
 * four voices, four scenes and four sets of relationships, and carried one conflict between
 * them: a need for order, precision, symmetry or planning meets imperfect reality and is
 * softened by it. Every earlier measure passes it — different shapes, different centres, four
 * different diarists, three of the four with somebody else acting on the page — because what
 * recurs is the editorial function of the day rather than anything in it. So the prompt shows
 * what the rest of the rotation put under pressure and which way each one gave, and asks that
 * today not be the fourth entry to press the same value and give the same way. The value may
 * recur; the pair may not. A theme is not a moral until every juror draws it.
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
  /* The validator rejects an unknown slug and a self-patch separately; both reduce to this list. */
  const peerSlugs = JUDGE_SLUGS.filter((slug) => slug !== juror.slug);

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

  if (context.recentArcs.length > 0) {
    parts.push(
      section(
        'HOW RECENT ENTRIES OPENED AND CLOSED',
        [
          'The newest published entries — yours and the others’ — reduced to their first and last',
          'lines. This is shape information: how days have been opening and how they have been',
          'ending lately. It is not content to reuse.',
          '',
          context.recentArcs
            .map((arc) =>
              [
                `- ${arc.jurorId}, ${arc.date} (${arc.theme} day)`,
                `  opened: "${arc.opening}"`,
                `  closed: "${arc.closing}"`
              ].join('\n')
            )
            .join('\n')
        ].join('\n')
      )
    );
  }

  if (context.recentCycle.length > 0) {
    parts.push(
      section(
        'HOW RECENT ENTRIES SPENT THE DAY',
        [
          'The same recent entries, described by their own writers: what actually happened in',
          'each one, how much of another person was in it, how much of it was the argument',
          'rather than the day, and how it ended. This is what the diary has been made of',
          'lately. It is not material to reuse and not a scoreboard to beat.',
          '',
          context.recentCycle
            .map((glance) =>
              [
                `- ${glance.jurorId}, ${glance.date} (${glance.theme} day)`,
                `  what happened: ${glance.sceneEvent ?? '(nothing on the page — reflection only)'}`,
                `  another person in it: ${glance.interactionLevel || '(unstated)'}`,
                `  the entry was mostly: ${glance.abstractionLevel || '(unstated)'}`,
                `  ended: ${glance.endingState || '(unstated)'}`
              ].join('\n')
            )
            .join('\n')
        ].join('\n')
      )
    );
  }

  if (context.recentTensions.length > 0) {
    parts.push(
      section(
        'WHAT THE LAST CYCLE PUT UNDER PRESSURE',
        [
          'The entries before yours in this rotation — the other diarists — described by their',
          'own writers: the conflict each one carried, the conviction it pressed on, and what',
          'the entry did with that conviction by its last line. This is what the diary has been',
          'arguing about lately, at the altitude a reader notices. It is not material to reuse',
          'and not a set of positions to answer.',
          '',
          context.recentTensions
            .map((glance) =>
              [
                `- ${glance.jurorId}, ${glance.date} (${glance.theme} day)`,
                `  the conflict: ${glance.centralTension || '(unstated)'}`,
                `  what was under pressure: ${glance.beliefChallenged || '(unstated)'}` +
                  `${glance.pressuredValue ? ` [${glance.pressuredValue}]` : ''}`,
                `  and by the end: ${glance.endingDirection || '(unstated)'}`
              ].join('\n')
            )
            .join('\n')
        ].join('\n')
      )
    );
  }

  if (context.recentFocuses.length > 0) {
    parts.push(
      section(
        'WHAT YOUR OWN LAST ENTRIES WERE ABOUT',
        [
          'Your most recent entries, each reduced to what it was actually about. This is subject',
          'information, not material: it is here so you can see what your story has already spent',
          'its days on.',
          '',
          context.recentFocuses
            .map((glance) =>
              [
                `- ${glance.date} (${glance.theme} day) — ${glance.title}`,
                `  dominant subject: ${glance.focus.dominantSubject}`,
                `  anchor object: ${glance.focus.anchorObject ?? '(none)'}`,
                `  central tension: ${glance.focus.centralTension}`,
                `  ended: ${glance.focus.endingState}`
              ].join('\n')
            )
            .join('\n')
        ].join('\n')
      )
    );
  }

  if (context.projectLedger.length > 0) {
    parts.push(
      section(
        'WHERE YOUR ONGOING PROJECTS STAND',
        [
          'Projects you have written about before, each left exactly where your own last entry',
          'on it left it. This is the state they are in today. It is not a list of things to',
          'write about — most days will touch none of them.',
          '',
          context.projectLedger
            .map((row) =>
              [
                `- ${row.project}: ${row.stage}`,
                `  (${row.movement}, last written ${row.date})`
              ].join('\n')
            )
            .join('\n')
        ].join('\n')
      )
    );
  }

  if (context.pendingCommitments.length > 0) {
    parts.push(
      section(
        'WHAT YOU HAVE ALREADY SAID YOU WOULD DO',
        [
          'Plans you have written down before and have not yet carried out, called off or moved.',
          'Each shows the time you gave it in your own words and the days those words cover,',
          'worked out from the entry that said them. This is not a list of things to do today —',
          'most days will touch none of them.',
          '',
          context.pendingCommitments
            .map((row) =>
              [
                `- ${row.event}`,
                `  with: ${row.participants.length > 0 ? row.participants : '(nobody named)'}`,
                row.when === null
                  ? '  when: you gave it no time'
                  : row.window === null
                    ? `  when: "${row.when}" (no fixed days)`
                    : `  when: "${row.when}" — ${row.window.start} to ${row.window.end}`,
                `  (said on ${row.date})`
              ].join('\n')
            )
            .join('\n')
        ].join('\n')
      )
    );
  }

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
      'THE SHAPE OF THE ENTRY (vary it)',
      [
        'Left alone, entries in this diary all collapse into one arc: open on a tactile',
        'private-life object, turn it into a metaphor for a professional contradiction, close on',
        'a polished lesson or a balanced realization. Any single day written that way reads fine.',
        'Five diarists doing it every day read as one narrator wearing five job titles. Do not',
        'default to that arc.',
        ...(context.recentArcs.length > 0
          ? [
              'Look at HOW RECENT ENTRIES OPENED AND CLOSED above. If that arc is what the latest',
              'entries did, today must take a different shape: a different opening device, a',
              'different emotional course, a different kind of ending.'
            ]
          : []),
        '- A diary owes nobody a lesson. A day may end unresolved, mid-thought, petty, avoidant,',
        '  bored, or plain wrong: you may state a problem and not solve it, or be certain and',
        '  mistaken. Arriving at maturity or self-correction is one mode among many, never the',
        '  destination every entry must reach.',
        '- A private thing may stay private. It does not have to become a metaphor for the work,',
        '  and an ordinary object may simply be present without meaning anything.',
        '- Other shapes a day can take: a scene left open; friction with another person, in actual',
        '  dialogue; something observed that never becomes self-analysis; acting before reflecting,',
        '  with the reflection never arriving; humor or pettiness without redemption; a decision',
        '  whose consequences have not landed yet; a memory that complicates a belief instead of',
        '  settling it.',
        '- None of this bans reflection, domestic detail, or a conclusion a day genuinely earned.',
        '  What it rules out is reaching the same shape as the recent entries because it is the',
        '  easy one.'
      ].join('\n')
    )
  );

  parts.push(
    section(
      'THE DAY ITSELF (something has to happen in it)',
      [
        'An entry can be entirely in character, well written, and still be an essay: a position',
        'from your professional life stated near the top, the middle spent proving it with',
        'details from your private life, a general principle at the end. Two diarists wrote',
        'exactly that on consecutive days with no subject, no object and no vocabulary in',
        'common. One at a time they are articulate. In sequence they turn five people into five',
        'columnists whose private lives exist to illustrate their professional opinions.',
        '- Something has to happen where the reader can see it. Somebody acts, answers, refuses,',
        '  changes their mind, gets something wrong, gives up, walks out, or leaves a consequence',
        '  hanging. It can be small and undramatic — most days are — but it has to happen in the',
        '  entry rather than be reported as having happened somewhere before it.',
        '- The order matters more than the content. The event happens first and the thinking has',
        '  to deal with it. If your reflection would have come out word for word the same without',
        '  the event, the event was decoration and the entry is a position paper with a prop in it.',
        '- Let what happened complicate the position rather than confirm it. A person can be right',
        '  in an inconvenient way, or wrong in a way you cannot prove, or simply uninterested in',
        '  the argument you were having with yourself.',
        '- An ending may be a consequence, an unanswered message, something you did, or somebody',
        '  else’s reply — not only a principle you arrived at. A last line that would work as the',
        '  last line of a column is usually not the last line of a diary.',
        ...(context.essayRun
          ? [
              '',
              'THE LAST CYCLE HAS BEEN ARGUING.',
              `${context.essayRun.count} of the last ${context.essayRun.total} entries — ` +
                `${context.essayRun.jurorIds.join(', ')} — argued a position with nothing happening ` +
                'in them, by their own writers’ account. See HOW RECENT ENTRIES SPENT THE DAY above.',
              'Today is not another one. Whatever it is about, and however professional its subject,',
              'the entry has to contain something that occurs.'
            ]
          : []),
        '',
        'Nothing here bans a subject or prescribes a technique. Your work, your expertise and the',
        'vocabulary of your job are welcome in any entry, including in all of one. Dialogue is not',
        'required, and neither is another person: a day alone can be full of things happening. An',
        'uneventful day is still a good entry — "nothing much happened" is not the same as "nothing',
        'happens in this text". And a single day that is one long argument with yourself is a fine',
        'day to write; it is a whole rotation of them this is asking you to break.'
      ].join('\n')
    )
  );

  parts.push(
    section(
      'THE CENTRE OF THE ENTRY (move it)',
      [
        'Continuity is not repetition. Your objects, habits, hobbies and convictions should keep',
        'turning up — that is what makes these entries one person rather than five strangers with',
        'one name. What has to keep moving is what an entry is *about*.',
        '- Background continuity: a thing is present. It is used, mentioned, complained about, sat',
        '  next to, or simply there in the room. It carries no argument and proves no point. This',
        '  is welcome every single day, and needs no justification.',
        '- Central engine: the same thing is what the day turns on — it supplies the metaphor, the',
        '  tension and the conclusion. That is the role that has to change hands.',
        '- The test is the role, not the noun. Your typewriter, your kitchen, your commute and your',
        '  standing arguments may appear as often as they like. They should not all be the reason',
        '  the entry exists.',
        ...(context.recurringFocus
          ? [
              '',
              'YOUR LAST TWO ENTRIES ALREADY SHARE A CENTRE.',
              context.recurringFocus.sharedSubjectTerms.length > 0
                ? `Both were about the same thing: ${context.recurringFocus.sharedSubjectTerms.join(', ')}.`
                : 'They were about different things.',
              context.recurringFocus.sharedTensionTerms.length > 0
                ? `Both carried the same argument: ${context.recurringFocus.sharedTensionTerms.join(', ')}.`
                : 'Their arguments differed.',
              'Today must turn on a materially different dominant event or tension: a different part',
              'of your life, a different person, a different problem, a different thing at stake.',
              'The old subject is not forbidden and does not have to disappear — it may sit in the',
              'background of today like any other established detail. It must not be the engine a',
              'third time.',
              'One exception, and it is a real one: if today genuinely *changes* something about that',
              'subject — a belief you actually revise, a relationship it actually moves, a consequence',
              'that actually lands — then write that, and make the change the point. A new angle on',
              'the same conclusion is not a change.'
            ]
          : []),
        '',
        'Nothing in this section bans anything. No object, hobby, topic, callback, running joke or',
        'reply to another juror is off limits, and a subject you have written about before may be',
        'written about again. The only request is that today is not the third day in a row that one',
        'subject and one argument carry the entry.'
      ].join('\n')
    )
  );

  parts.push(
    section(
      'THE CONFLICT, AND HOW IT ENDS (vary it across the rotation)',
      [
        'Five people can write five different scenes, in five voices, about five different objects,',
        'and still hand the reader one story. Four consecutive entries did: someone wanted things',
        'in order — sorted, labelled, symmetrical, planned — reality was not, and they were gently',
        'softened out of it. Different jurors, different rooms, different objects, no shared word',
        'between them. Each entry was good. Together they read as four illustrations of one moral',
        'rather than four lives going on at the same time.',
        '- What must not repeat is the pair: the same conviction pressed, and the same thing',
        '  happening to it. Either half alone is ordinary. Two diarists can both be arguing with',
        '  their own standards this week — provided the second is not talked out of it exactly as',
        '  the first was.',
        '- Being softened toward imperfection is one ending among several, not the mature one. You',
        '  may also refuse to move and mean it; go back to a worse habit you thought you had left;',
        '  make the problem larger than it was; leave it open and know you have; or end certain,',
        '  where the day you just described gives the reader room to doubt you.',
        '- The pressure can come from somewhere new: not only another person being reasonable at',
        '  you. A thing that breaks, a rule that turns out to be yours alone, an old letter, your',
        '  own body, somebody who is simply not interested in the argument you are having.',
        '- Consequences count as endings. Someone is annoyed with you tomorrow; a favour is owed;',
        '  a person stops explaining themselves to you. That is a different ending from a private',
        '  adjustment nobody else notices.',
        ...(context.tensionConvergence
          ? [
              '',
              'THE ROTATION HAS BEEN MAKING ONE POINT.',
              `${context.tensionConvergence.count} of the last ${context.tensionConvergence.total} entries — ` +
                `${context.tensionConvergence.jurorIds.join(', ')} — put the same thing under ` +
                `pressure (${context.tensionConvergence.pressuredValue}) and gave way the same ` +
                `way (${context.tensionConvergence.endingDirection}), by their own writers’ account.`,
              'See WHAT THE LAST CYCLE PUT UNDER PRESSURE above.',
              'Yours would be the next one. Either press something else today, or press the same',
              `thing and let it end some other way than ${context.tensionConvergence.endingDirection}.`,
              'Do not write a day about not doing that — write a different day.'
            ]
          : []),
        '',
        'No conviction is off limits and no ending is wrong, including the one the rotation has',
        'been using. Your own standards, your own precision, your own plans are yours and may be',
        'pressed as often as your life presses them. This asks about the shape of a week, not',
        'about the honesty of today: if today genuinely softened you, say so and say it plainly.'
      ].join('\n')
    )
  );

  parts.push(
    section(
      'THE STAGE YOUR PROJECTS ARE AT (projectUpdates)',
      [
        'A hobby that keeps coming back is what a diary accumulating over months is for. What',
        'must not come back is a stage you have already passed.',
        ...(context.projectLedger.length > 0
          ? [
              'WHERE YOUR ONGOING PROJECTS STAND, above, is where the archive left each of them.',
              'If today touches one, it resumes from there: move it on, let a consequence land,',
              'or notice it has been sitting untouched. Do not narrate a stage that entry already',
              'recorded as though it were today’s work, and do not finish something the archive',
              'already says you finished.'
            ]
          : []),
        '- A project is allowed to go backwards. Varnish gets stripped, a coat dries wrong, a',
        '  plan is torn up and begun again. That is a good day to write. Say in the entry what',
        '  undid it, and record the movement as restarted or failed.',
        '- Your CURRENT LIFE STATE lists ongoing activities with no stage and no date, so a line',
        '  there can be weeks out of date. Where the two disagree, the projects above are the',
        '  newer statement.',
        '',
        'After the entry is finished, record what it did to your projects, in English:',
        '- project: what it is. Use the same words you used before if it is one of the above,',
        '  so the two statements are recognisably about the same thing.',
        '- stage: where it now stands, concretely — which coat, which chapter, what is left. A',
        '  stage that has moved says something the last one did not.',
        `- movement: exactly one of ${DIARY_PROJECT_MOVEMENTS.join(', ')}.`,
        'An entry that moved no project returns an empty array, and that is the common case.',
        'Do not list a project today did not touch: it keeps the stage shown above until an',
        'entry actually moves it, and restating that stage is what this section exists to stop.',
        '',
        'Nothing here forbids a subject. Any project, hobby or possession may return as often as',
        'it likes, may take months, may be abandoned and picked up again. The only requirement',
        'is that it returns to the stage it was left at rather than to an earlier one.'
      ].join('\n')
    )
  );

  parts.push(
    section(
      'PLANS YOU MAKE AND PLANS YOU KEEP (scheduledEvents)',
      [
        'A diary that never plans anything has no future in it, and a plan that quietly happens',
        'at the wrong time makes every date in the archive worthless. Both are avoidable in the',
        'same move: say when, and say when that changes.',
        ...(context.pendingCommitments.length > 0
          ? [
              'WHAT YOU HAVE ALREADY SAID YOU WOULD DO, above, is what the archive is still holding',
              'you to. If today carries one of them out, it happens inside the days shown — or the',
              'entry says, in its own prose, that the plan moved and why. Brought forward because',
              'something went wrong, pushed back because nobody had the weekend free, gone ahead of',
              'schedule on somebody else\u2019s insistence: all good days to write. A plan that simply',
              'happens weeks off its own date, with the entry not noticing, is the one thing this',
              'section exists to stop.'
            ]
          : []),
        '- A plan is allowed to change. Dates move, visits are cancelled, somebody gets ill and the',
        '  weekend is gone. Write what changed, and record the movement as moved or dropped.',
        '- You are not obliged to keep a plan on time, or at all. A commitment you have let slide',
        '  for a month is a real thing to write about; so is deciding you will not do it.',
        '- Your CURRENT LIFE STATE lists concerns and threads with no dates at all. Where it and the',
        '  plans above disagree about when something is happening, the plans above are the statement',
        '  that had a date on it.',
        '',
        'Then record what today did to your plans, in English:',
        '- event: what is going to happen, or has just happened. Use the same words you used before',
        '  if it is one of the above, so the two statements are recognisably about the same thing.',
        '- participants: who it involves besides you. An empty string if it is only you.',
        '- when: the time you gave it, in the words you would actually use — "next month", "on',
        '  Saturday", "in a fortnight", "the end of next month". Do not compute a date; the words',
        '  are worked out against today\u2019s date for you. On a plan you are moving, this is the',
        '  new time, not the old one. Null when you gave it no time at all, and null on the day you',
        '  keep or drop it.',
        `- movement: exactly one of ${DIARY_SCHEDULE_MOVEMENTS.join(', ')}. "made" — you have said`,
        '  today that this will happen. "kept" — it happened. "moved" — it is still on, at a',
        '  different time. "dropped" — it is off.',
        '- changeReason: why the plan changed, when it did — moved, dropped, or kept outside the',
        '  days it was given. Null on a plan simply made, or kept when it said it would be. What',
        '  you put here must also be in the entry itself: this field records the explanation, it',
        '  does not replace it.',
        'An entry that made and kept no plans returns an empty array, and that is the common case.',
        'Do not re-list a plan today did not touch: it stays exactly as shown above until an entry',
        'actually keeps it, moves it or calls it off. Stating one of them again at a different time',
        'is a move, not a new plan — record it as moved and say what changed.',
        '',
        'Nothing here obliges you to plan anything, and no plan is binding. The only requirement is',
        'that the archive can tell a plan kept from a plan changed, because you said which it was.'
      ].join('\n')
    )
  );

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
        '5. Dates, time windows and changes of plan are facts, not shading. If the English says a',
        '   visit was brought forward, the Japanese says it was brought forward and why; if the',
        '   English says next month, the Japanese does not say soon. A schedule that survives in one',
        '   language and goes vague in the other makes the two entries different entries.',
        '6. Choose one short passage from the body as the share quote, and give the Japanese share quote as',
        '   the translation of that same passage.',
        '',
        'Hard floors. These are not style guidance — a response that misses one is discarded in full:',
        `- body.en at least ${DIARY_TEXT_LIMITS.minBodyEn} characters; body.ja at least ${DIARY_TEXT_LIMITS.minBodyJa}.`,
        `- title at least ${DIARY_TEXT_LIMITS.minTitle} characters and mood at least ${DIARY_TEXT_LIMITS.minMood}, in BOTH languages; neither may be empty.`,
        `- shareQuote at least ${DIARY_TEXT_LIMITS.minShareQuote} characters in both languages, and the English at`,
        `  most ${DIARY_TEXT_LIMITS.maxShareQuote}.`,
        `- At least ${Math.round(DIARY_TEXT_LIMITS.minJapaneseRatio * 100)}% of body.ja must be kana or kanji. Any real translation clears this easily;`,
        '  the floor exists to catch the English being copied into the Japanese field.',
        `- The two bodies must be the same entry: ja/en length ratio stays within`,
        `  ${DIARY_TEXT_LIMITS.minLengthRatio}–${DIARY_TEXT_LIMITS.maxLengthRatio}, so neither side may be a summary of the other.`
      ].join('\n')
    )
  );

  parts.push(
    section(
      'DESCRIBING WHAT YOU WROTE (entryFocus)',
      [
        'After the entry is finished, describe it in entryFocus — what you actually wrote, not what',
        'you set out to write. Short phrases, in English, even though the entry is in two languages.',
        '- dominantSubject: the event or situation the entry turns on.',
        '- anchorObject: the physical object at the centre of it, or null. Null is the honest answer',
        '  more often than not: an object that merely appears is not the anchor, and no day needs one.',
        '- centralTension: the argument, conflict or question the entry carries, in one sentence.',
        '- beliefChallenged: the conviction, standard or preference today actually pressed on, in',
        '  one short phrase — "that a plan should survive other people", "that I am owed a reply",',
        '  "that I can be relied on for this". Yours, not the argument’s: name the thing that would',
        '  have to give.',
        `- pressuredValue: exactly one of ${DIARY_PRESSURED_VALUES.join(', ')}.`,
        '  order — things done properly, precisely, to plan, in their place. competence — being',
        '  good at this, and turning out to be right. autonomy — being left to decide, unaided.',
        '  loyalty — what you owe one particular person. honesty — saying the true thing rather',
        '  than the smooth one. ambition — that this should get somewhere, and that it matters.',
        '  care — looking after someone or something that depends on you. standing — being taken',
        '  seriously: consulted, credited, not talked past.',
        '  Pick the nearest. It is a filing label, not a definition: beliefChallenged above',
        '  carries what the conviction actually was, so this never has to be exact.',
        '- endingState: how it ends — unresolved, decided, interrupted, resigned, still annoyed,',
        '  quietly pleased, and so on. Describe the ending you wrote; do not improve it here.',
        `- endingDirection: exactly one of ${DIARY_ENDING_DIRECTIONS.join(', ')}.`,
        '  change — the conviction moved; you hold it differently now. refusal — it was pressed',
        '  and you did not move. regression — you fell back on an older version of yourself you',
        '  thought you had left. escalation — nothing settled and the problem got bigger, or a new',
        '  one appeared. unresolved — still open at the last line, and you know it.',
        '  mistaken_certainty — you end sure, and the day you described gives room to doubt you.',
        '  This is what happened to the conviction, not whether the day went well.',
        '- sceneEvent: the thing that observably happens in the entry — what somebody does, says,',
        '  refuses, decides, gets wrong or leaves hanging — or null if the entry contains no such',
        '  moment. Null is an honest answer and is better than naming an event the text does not',
        '  actually contain.',
        `- interactionLevel: exactly one of ${DIARY_INTERACTION_LEVELS.join(', ')}. "none" — nobody`,
        '  else acts or speaks. "reported" — another person is in the entry, but summarized: what',
        '  they had argued, what they would say. "direct" — somebody acts or answers in the entry’s',
        '  own present and you have to deal with it.',
        `- abstractionLevel: exactly one of ${DIARY_ABSTRACTION_LEVELS.join(', ')}. "scene" — mostly`,
        '  what happened. "mixed" — an event and a reflection, neither one reducible to the other.',
        '  "argument" — mostly the position, with the day supplying the evidence for it.',
        'Describe what you wrote, not what you meant to write: the scene fields and the tension',
        'fields are both read back to the whole rotation, and an entry scored "scene" because it',
        'should have been one, or "refusal" because that would have been the braver day, hides the',
        'pattern from everybody. A word outside the four lists above is set aside with a warning —',
        'it costs the next prompt a line, and this entry nothing.',
        'This is the only part of your answer that is about the entry rather than being it. It is',
        'read back to you on your next duty day, so a description that flatters today misleads you',
        'tomorrow. It is never published and never shown to the other jurors.'
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
        `  targetJurorId must be one of: ${peerSlugs.join(', ')}. Never yourself, and never the same`,
        '  juror twice in one day.',
        `- traitAdjustments: at most ${DIARY_PATCH_LIMITS.traitAdjustments}, each within ±${DIARY_PATCH_LIMITS.traitDelta}.`,
        `- beliefAdjustments: at most ${DIARY_PATCH_LIMITS.beliefAdjustments}, within ±${DIARY_PATCH_LIMITS.beliefConfidenceDelta}.`,
        `- addRecentConcerns: at most ${DIARY_PATCH_LIMITS.addRecentConcerns}.`,
        `- addUnresolvedThoughts: at most ${DIARY_PATCH_LIMITS.addUnresolvedThoughts}.`,
        `- resolveUnresolvedThoughts: at most ${DIARY_PATCH_LIMITS.resolveUnresolvedThoughts}.`,
        `- addRecentEvents: at most ${DIARY_PATCH_LIMITS.addRecentEvents}, phrased as short factual notes.`,
        `- addCurrentConcerns: at most ${DIARY_PATCH_LIMITS.addCurrentConcerns}; resolveCurrentConcerns: at most ${DIARY_PATCH_LIMITS.resolveCurrentConcerns}.`,
        `- addOngoingActivities: at most ${DIARY_PATCH_LIMITS.addOngoingActivities}; completeOngoingActivities: at most ${DIARY_PATCH_LIMITS.completeOngoingActivities}.`,
        `- addUnresolvedThreads: at most ${DIARY_PATCH_LIMITS.addUnresolvedThreads}; resolveUnresolvedThreads: at most ${DIARY_PATCH_LIMITS.resolveUnresolvedThreads}.`,
        '- A day that changed nothing about a layer returns an empty array for it. That is normal.',
        '- memoryCandidate: at most one, and only for something genuinely worth remembering months from now.',
        '  Otherwise null.',
        `  importance is a decimal weight from ${DIARY_MEMORY_IMPORTANCE.min} to ${DIARY_MEMORY_IMPORTANCE.max} — NOT a 1–5 or 1–10 rating.`,
        '  It decides only which memory is dropped first once the store is full: 0.9 is something you will',
        '  still be carrying next year, 0.2 is something you will probably have forgotten.',
        '- canonCandidate: at most one, and only when today invented a lasting new fact about your life.',
        '  It may only ADD. Never use it to replace or delete an established fact. Otherwise null.',
        `  factType must be exactly one of these values: ${DIARY_CANON_FACT_TYPES.join(', ')}.`,
        '  Use the value, not a synonym — an owned object is "possession", not "object" or "item".',
        '- Any new detail of your life that appeared in the entry and should last belongs in a',
        '  patch — otherwise it will be forgotten tomorrow. The caps above still win: if today produced more',
        '  lasting detail than they allow, keep the most important within the cap and let the rest go',
        '  unrecorded. Never exceed a cap in order to save a detail.',
        `- contradictionNotes: at most ${DIARY_PATCH_LIMITS.contradictionNotes}. When today contradicts something established, record it`,
        '  here instead of quietly changing the canon. Extra notes beyond that are dropped rather than fatal.',
        `- projectUpdates: at most ${DIARY_PATCH_LIMITS.projectUpdates}, as described above. Extra entries are dropped rather than fatal.`,
        `- scheduledEvents: at most ${DIARY_PATCH_LIMITS.scheduledEvents}, as described above. Extra entries are dropped rather than fatal.`,
        '- You cannot modify your Core Persona. There is no field for it and no request will create one.',
        '',
        'Hard limits, checked exactly: every "at most" count above, every ± delta, the importance range,',
        'the factType value, and the relationship-target rules. Break one of those and the response is',
        'discarded whole — the entry too, not just the offending patch — and that day never exists.',
        'contradictionNotes is not one of them. Neither is projectUpdates or scheduledEvents,',
        'wherever they are quoted: an overage there is truncated,',
        'an unrecognised movement is dropped, and a plan kept outside its window is noted and',
        'published like any other day, because all of those cost tomorrow a line of context and',
        'nothing else. Nor is entryFocus, including its four listed-value',
        'fields: a blank or unrecognised value there is noted and set aside, and the entry still',
        'publishes. Neither is the 0–1 relationship scale or',
        '"only jurors you wrote about": those shape a good day, they do not decide whether there',
        'is one.'
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
