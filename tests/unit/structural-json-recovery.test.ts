import { describe, expect, it } from 'vitest';
import { parseWithStructuralRecovery, strictParse } from '../../src/lib/evaluation/llm-transport';

/**
 * Recovery from a response that is complete except for its closing brackets.
 *
 * The rule these tests pin down is narrow on purpose: close what is open, never supply what is
 * missing. Everything that would require guessing at content has to stay unparsed, because a
 * response the validator never sees is a failure a human investigates — while a response quietly
 * completed with invented structure is a failure nobody ever sees.
 */
describe('structural JSON recovery', () => {
  it('leaves a valid document alone and reports no repair', () => {
    const { value, recovery } = parseWithStructuralRecovery('{"a":[1,2],"b":"x"}');
    expect(value).toEqual({ a: [1, 2], b: 'x' });
    expect(recovery).toBeNull();
  });

  it('closes a document that ends one bracket short', () => {
    const { value, recovery } = parseWithStructuralRecovery('{"judges":[{"id":"alex"}]');
    expect(value).toEqual({ judges: [{ id: 'alex' }] });
    expect(recovery).toEqual({ appended: '}' });
  });

  it('closes several levels in the order the open containers demand', () => {
    const { value, recovery } = parseWithStructuralRecovery('{"a":{"b":["c"');
    expect(recovery).toEqual({ appended: ']}}' });
    expect(value).toEqual({ a: { b: ['c'] } });
  });

  it('refuses a string cut in half, because no bracket restores lost text', () => {
    expect(parseWithStructuralRecovery('{"verdict":"the jury conclu').value).toBeNull();
  });

  it('refuses a promised value that never arrived', () => {
    expect(parseWithStructuralRecovery('{"a":1,').value).toBeNull();
    expect(parseWithStructuralRecovery('{"a":').value).toBeNull();
  });

  it('refuses a number or literal that may itself be truncated', () => {
    // `1` could have been `12`, and `tru` is not `true` yet. Both are content, not structure.
    expect(parseWithStructuralRecovery('{"score":1').value).toBeNull();
    expect(parseWithStructuralRecovery('{"ok":tru').value).toBeNull();
  });

  it('refuses to invent an empty container', () => {
    // `{"a":{` was going to hold something. Closing it asserts that it was empty.
    expect(parseWithStructuralRecovery('{"a":{').value).toBeNull();
  });

  it('refuses a mismatched document, which is malformed rather than truncated', () => {
    expect(parseWithStructuralRecovery('{"a":[1}').value).toBeNull();
  });

  it('is not fooled by brackets and escapes inside strings', () => {
    const raw = '{"note":"a } and a ] and an escaped \\" quote"';
    const { value, recovery } = parseWithStructuralRecovery(raw);
    expect(recovery).toEqual({ appended: '}' });
    expect((value as any).note).toBe('a } and a ] and an escaped " quote');
  });

  it('does not close a document that is already complete but followed by prose', () => {
    // Trailing commentary is not truncation; appending brackets cannot make it parse.
    expect(parseWithStructuralRecovery('{"a":1}\n\nHope this helps!').value).toBeNull();
  });

  it('recovers the production response that was excluded on 2026-08-01', () => {
    // The shape that failed: minified, structurally complete to the last field, one `}` short.
    // `stop_reason` was `end_turn` and no fence was present — the model simply stopped early.
    const article = {
      schema_version: '3.0.0',
      product: { name: 'KnowAct-GUIClaw' },
      judges: ['alex', 'david', 'lisa', 'sarah', 'marcus'].map(id => ({
        judge_id: id,
        criteria: Array.from({ length: 6 }, (_, i) => ({ criterion_id: `c${i}`, score: 3 }))
      }))
    };
    const truncated = JSON.stringify(article).slice(0, -1);
    expect(strictParse(truncated)).toBeNull();

    const { value, recovery } = parseWithStructuralRecovery(truncated);
    expect(recovery).toEqual({ appended: '}' });
    expect(value).toEqual(article);
  });

  it('closes a response that stopped early, leaving the shortfall for the validator', () => {
    // Structural completeness is not content completeness. Three judges close as cleanly as
    // five, and this layer must not be the one that decides an article is unfinished.
    const partial = '{"schema_version":"3.0.0","judges":[{"judge_id":"alex"},{"judge_id":"david"}]';
    const { value, recovery } = parseWithStructuralRecovery(partial);
    expect(recovery).toEqual({ appended: '}' });
    expect((value as any).judges).toHaveLength(2);
  });
});
