/**
 * Turning a plan's own words into the days it covers.
 *
 * Issue #120: on 2026-08-16 Alex wrote that Leo's mother wanted them to come "next month" to
 * clear out the attic. On 08-21 — five days later — Alex and Leo were already clearing it, and
 * the entry never said the visit had been brought forward. Both entries read perfectly well;
 * their calendars disagree.
 *
 * A diarist states a commitment the way people do, in a phrase relative to the day they are
 * writing on, and "next month" only means something once you know it was said on 2026-08-16.
 * So the phrase is resolved against the date of the entry that said it, and what comes out is a
 * *window* rather than a date — "next month" is thirty days, not one.
 *
 * Two rules govern everything here:
 *
 *   - **An unrecognised phrase resolves to nothing, never to a guess.** A window this module
 *     invented would be used to accuse a later entry of contradicting a plan nobody actually
 *     stated. Silence costs one advisory check; a wrong window costs the writer a false
 *     accusation and the archive a warning nobody can act on.
 *   - **An ambiguous phrase resolves to the union of its readings.** "next Friday" is the
 *     coming Friday to some speakers and the Friday of the following week to others, and
 *     picking one reading would manufacture exactly the contradiction this exists to find. The
 *     window spans both, so a plan kept under either reading is inside it.
 *
 * Nothing here reads a diary body. It is handed the phrase the writer put in the structured
 * field and the date of the entry that put it there, and that is all it ever sees.
 */

/** A span of days, inclusive at both ends, in YYYY-MM-DD. */
export interface DiaryDateWindow {
  start: string;
  end: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MILLIS_PER_DAY = 86_400_000;

/** Written numbers a plan is likely to use. Beyond twelve, people write digits. */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  // Longest first: "a couple of weeks" must not be read as "a week" by an earlier "a".
  ['a couple of', 2], ['a couple', 2],
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7],
  ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
  ['a', 1], ['an', 1]
]);

const WEEKDAYS: readonly string[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'
];

/** How many days at the end of a month count as "the end of the month". */
const MONTH_EDGE_DAYS = 7;

/**
 * Days of slack either side of a point named in weeks. Somebody who says "in three weeks" has
 * not named a day, and treating the arithmetic result as one would fail a plan kept on the
 * Thursday of the right week.
 */
const WEEK_POINT_SLACK = 3;

function parseIso(date: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(date.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toEpochDay(date: string): number | null {
  const parts = parseIso(date);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day) / MILLIS_PER_DAY;
}

function fromEpochDay(epochDay: number): string {
  const moment = new Date(epochDay * MILLIS_PER_DAY);
  return formatIso(moment.getUTCFullYear(), moment.getUTCMonth() + 1, moment.getUTCDate());
}

/** Calendar-day arithmetic, safe across month and year boundaries. */
export function addDays(date: string, days: number): string {
  const epochDay = toEpochDay(date);
  if (epochDay === null) throw new Error(`[Diary Dates] Not a date: ${date}`);
  return fromEpochDay(epochDay + days);
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(date: string): number {
  const epochDay = toEpochDay(date);
  if (epochDay === null) throw new Error(`[Diary Dates] Not a date: ${date}`);
  // 1970-01-01 was a Thursday.
  return (((epochDay + 4) % 7) + 7) % 7;
}

/** Whether a day falls inside a window, both ends included. */
export function windowContains(window: DiaryDateWindow, date: string): boolean {
  return date >= window.start && date <= window.end;
}

/** Whether two windows share at least one day. */
export function windowsOverlap(a: DiaryDateWindow, b: DiaryDateWindow): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** The whole of the calendar month `offset` months from the one `date` falls in. */
function calendarMonth(date: string, offset: number): DiaryDateWindow | null {
  const parts = parseIso(date);
  if (!parts) return null;
  const zeroBased = parts.month - 1 + offset;
  const year = parts.year + Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12 + 1;
  return { start: formatIso(year, month, 1), end: formatIso(year, month, daysInMonth(year, month)) };
}

/** The Monday-to-Sunday week `offset` weeks from the one `date` falls in. */
function calendarWeek(date: string, offset: number): DiaryDateWindow {
  // Monday-based, because "next week" starts on a Monday to the people who say it.
  const sinceMonday = (weekdayOf(date) + 6) % 7;
  const monday = addDays(date, -sinceMonday + offset * 7);
  return { start: monday, end: addDays(monday, 6) };
}

/** The Saturday-and-Sunday of the week `offset` weeks from the one `date` falls in. */
function weekend(date: string, offset: number): DiaryDateWindow {
  const week = calendarWeek(date, offset);
  return { start: addDays(week.start, 5), end: week.end };
}

/**
 * The phrase reduced to what can be matched: lower case, no punctuation, single spaces, and
 * without the hedges people put in front of a plan. "sometime around the end of next month"
 * and "the end of next month" are the same window, and a hedge is not a different plan.
 */
function normalize(phrase: string): string {
  let text = phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (;;) {
    const stripped = text.replace(
      /^(some ?time|at|on|in|around|about|roughly|probably|maybe|perhaps|likely|by|before|during|over|starting|beginning) (?=\S)/,
      ''
    );
    // "in two weeks" must keep its "in": strip a leading word only when what follows still
    // starts with an article or a determiner, which is where the hedges sit.
    if (stripped === text || !/^(the|this|next|a|an) /.test(stripped)) break;
    text = stripped;
  }
  return text;
}

/** The count a phrase names, or null when it names a vague one ("a few", "several"). */
function countIn(text: string): number | null {
  const digits = /^(\d{1,3}) /.exec(text);
  if (digits) {
    const value = Number(digits[1]);
    return value > 0 ? value : null;
  }
  for (const [word, value] of NUMBER_WORDS) {
    if (text === word || text.startsWith(`${word} `)) return value;
  }
  return null;
}

/** Strips the count off the front of a phrase, leaving the unit and anything after it. */
function afterCount(text: string): string {
  const digits = /^\d{1,3} /.exec(text);
  if (digits) return text.slice(digits[0].length);
  for (const word of NUMBER_WORDS.keys()) {
    if (text.startsWith(`${word} `)) return text.slice(word.length + 1);
  }
  return text;
}

/**
 * The days a stated plan covers, or null when its words do not resolve to any.
 *
 * `phrase` is the time window in the writer's own words — "next month", "on Saturday", "in a
 * fortnight" — and `sourceDate` is the entry that said it. A phrase this module does not
 * recognise, an empty one, and a date that is not a date all return null, which the callers
 * read as "there is nothing here to check against".
 */
export function resolveRelativeWindow(phrase: string, sourceDate: string): DiaryDateWindow | null {
  if (parseIso(sourceDate) === null) return null;
  const text = normalize(phrase);
  if (text.length === 0) return null;

  // An absolute date the writer spelled out. It needs no resolving and is the one phrase whose
  // meaning cannot drift with the entry that carries it.
  const spelled = phrase.trim();
  if (parseIso(spelled) !== null) return { start: spelled, end: spelled };

  const day = (offset: number): DiaryDateWindow => {
    const at = addDays(sourceDate, offset);
    return { start: at, end: at };
  };

  switch (text) {
    case 'today':
    case 'this morning':
    case 'this afternoon':
    case 'this evening':
    case 'tonight':
      return day(0);
    case 'tomorrow':
    case 'tomorrow morning':
    case 'tomorrow afternoon':
    case 'tomorrow evening':
    case 'tomorrow night':
      return day(1);
    case 'the day after tomorrow':
      return day(2);
    case 'this weekend':
      return weekend(sourceDate, 0);
    case 'next weekend':
      return weekend(sourceDate, 1);
    case 'this week':
      return calendarWeek(sourceDate, 0);
    case 'next week':
      return calendarWeek(sourceDate, 1);
    case 'this month':
      return calendarMonth(sourceDate, 0);
    case 'next month':
      return calendarMonth(sourceDate, 1);
    case 'this year':
      return calendarYear(sourceDate, 0);
    case 'next year':
      return calendarYear(sourceDate, 1);
    default:
      break;
  }

  const edge = matchMonthEdge(text, sourceDate);
  if (edge) return edge;

  const weekday = matchWeekday(text, sourceDate);
  if (weekday) return weekday;

  return matchCount(text, sourceDate);
}

function calendarYear(date: string, offset: number): DiaryDateWindow | null {
  const parts = parseIso(date);
  if (!parts) return null;
  const year = parts.year + offset;
  return { start: formatIso(year, 1, 1), end: formatIso(year, 12, 31) };
}

/**
 * "the end of next month", "the start of the month" and their variants. A month has an end and
 * a beginning that people plan around, and both are a week rather than a day.
 */
function matchMonthEdge(text: string, sourceDate: string): DiaryDateWindow | null {
  const match = /^(?:the )?(end|start|beginning) of (?:(the|this|next) )?month$/.exec(text);
  if (!match) return null;
  const month = calendarMonth(sourceDate, match[2] === 'next' ? 1 : 0);
  if (!month) return null;
  return match[1] === 'end'
    ? { start: addDays(month.end, -(MONTH_EDGE_DAYS - 1)), end: month.end }
    : { start: month.start, end: addDays(month.start, MONTH_EDGE_DAYS - 1) };
}

/**
 * A weekday named on its own — "on Saturday", "next Friday", "Thursday".
 *
 * The window runs from the next occurrence of that weekday to the one after it, covering both
 * readings of "next Friday" at once. Deciding between them would be a coin toss whose losing
 * side reports a contradiction that is really a dialect difference.
 */
function matchWeekday(text: string, sourceDate: string): DiaryDateWindow | null {
  const match = /^(?:(?:on|this|next|coming) )*([a-z]+)$/.exec(text);
  if (!match) return null;
  const index = WEEKDAYS.indexOf(match[1]);
  if (index < 0) return null;

  const ahead = (index - weekdayOf(sourceDate) + 7) % 7 || 7;
  const first = addDays(sourceDate, ahead);
  return { start: first, end: addDays(first, 7) };
}

/** "in three weeks", "two months from now", "in a year". */
function matchCount(text: string, sourceDate: string): DiaryDateWindow | null {
  const body = text.startsWith('in ') ? text.slice(3) : text;
  const count = countIn(body);
  if (count === null) return null;

  const unit = afterCount(body).replace(/ (from now|from today|time)$/, '').trim();
  switch (unit) {
    case 'day':
    case 'days':
      return { start: addDays(sourceDate, count), end: addDays(sourceDate, count) };
    case 'week':
    case 'weeks': {
      const point = addDays(sourceDate, count * 7);
      return { start: addDays(point, -WEEK_POINT_SLACK), end: addDays(point, WEEK_POINT_SLACK) };
    }
    case 'fortnight': {
      const point = addDays(sourceDate, 14);
      return { start: addDays(point, -WEEK_POINT_SLACK), end: addDays(point, WEEK_POINT_SLACK) };
    }
    case 'month':
    case 'months':
      return calendarMonth(sourceDate, count);
    case 'year':
    case 'years':
      return calendarYear(sourceDate, count);
    default:
      return null;
  }
}
