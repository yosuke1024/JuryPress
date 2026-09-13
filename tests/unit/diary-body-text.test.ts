import { describe, expect, it } from 'vitest';
import { diaryBodyParagraphs, normalizeDiaryBody } from '../../src/lib/diary/body-text';
import { validateDiaryResponse } from '../../src/lib/diary/validator';
import { createDiaryResponse } from '../helpers/diary-fixtures';

function validate(response: ReturnType<typeof createDiaryResponse>) {
  return validateDiaryResponse({ parsed: response, expected: {
    date: response.date, jurorId: response.jurorId, theme: response.theme,
    privateEventCategory: response.privateEventCategory
  } });
}

describe('diary body line separators (#140)', () => {
  it.each(['\\n', '\\r\\n', '\\r', '\r\n', '\n'])('normalizes %j in both languages without mutating the persisted input', separator => {
    const response = createDiaryResponse();
    response.diary.body.en += `${separator}${separator}When Hugo arrived, I put the tool down.`;
    response.diary.body.ja += `${separator}${separator}ヒューゴが来たとき、工具を置いた。`;
    const before = structuredClone(response);
    const result = validate(response);
    expect(result.status).toBe('passed');
    expect(response).toEqual(before);
    for (const lang of ['en', 'ja'] as const) {
      expect(result.response!.diary.body[lang]).toContain('\n\n');
      expect(result.response!.diary.body[lang]).not.toContain('\\n');
      expect(diaryBodyParagraphs(result.response!.diary.body[lang])).toHaveLength(2);
    }
  });

  it('renders the public Marcus escape regression as separate paragraphs, preserving words', () => {
    // Public excerpts from 2026-08-30-marcus, not its private generation record.
    expect(diaryBodyParagraphs('...from the waste.\\n\\nWhen Hugo arrived...'))
      .toEqual(['...from the waste.', 'When Hugo arrived...']);
    expect(diaryBodyParagraphs('...作業だった。\\n\\nマリーナの...'))
      .toEqual(['...作業だった。', 'マリーナの...']);
  });

  it.each(['\u0000', '\u0007', '\u001b', '\\u0000', '\\b'])('rejects non-normalizable control %j with a language-specific path', control => {
    for (const lang of ['en', 'ja'] as const) {
      const response = createDiaryResponse();
      response.diary.body[lang] += ` ${control} `;
      const result = validate(response);
      expect(result.status).toBe('failed');
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: 'DIARY_INVALID_BODY_CONTROL', path: `$.diary.body.${lang}`
      }));
      expect(result.response).toBeNull();
    }
  });

  it('is idempotent and does not unescape quotes, unicode, or HTML', () => {
    const body = 'He said \\"hello\\". \\u65e5 <em>word</em>\\n\\nNext.';
    const normalized = normalizeDiaryBody(body);
    expect(normalized).toBe('He said \\"hello\\". \\u65e5 <em>word</em>\n\nNext.');
    expect(normalizeDiaryBody(normalized)).toBe(normalized);
  });
});
