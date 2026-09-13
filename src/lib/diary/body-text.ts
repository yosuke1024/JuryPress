/** Decode only line separators, never JSON-unescape arbitrary prose or the stored response. */
export function normalizeDiaryBody(body: string): string {
  return body.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n');
}

/** Controls with no textual interpretation must be rejected, not silently deleted. */
export function hasInvalidDiaryBodyControl(body: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)
    || /\\(?:[0bfv](?![a-z])|u00(?:0[0-8bcef]|1[0-9a-f]|7f)\b)/i.test(body);
}

/** Shared by new responses and archive rendering; no archive file is rewritten. */
export function diaryBodyParagraphs(body: string): string[] {
  return normalizeDiaryBody(body).split(/\n\s*\n/)
    .map(paragraph => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}
