/**
 * System-protection scans shared by the V3 validator branch and the strict evaluate()
 * wrapper. These are the ONLY whole-content text scans that survive into the editorial-first
 * pipeline, and the bar for belonging here is strict: a check must detect data corruption,
 * injection, or fixture leakage — never style, wording, hedging, or opinion. A sentence can
 * only trip these by being broken, not by being bold.
 */

import { isValidDisplayName } from '../identity';

export interface SystemProtectionDefect {
  code: string;
  path: string;
  message: string;
}

/**
 * Known fixture/placeholder values that must never appear in production content.
 *
 * Every entry must be CONTEXTUAL. The bare numerics "1250" and "106" that the audit-era scan
 * carried are deliberately absent: they were substring-matched against the whole serialized
 * article, so "1,060 stars", "106,000 downloads" or a commit count of 1250 would trip them —
 * and under the editorial pipeline this scan is a blocking quality error rather than a
 * smoke-test assertion, so a real repository metric could exclude a real article. The
 * contextual forms below catch the actual fixture without that collision.
 */
const BANNED_FIXTURE_STRINGS = [
  '1250 stars', '106 stars', 'fixture-product',
  'https://github.com/example/fixture', 'a product used for testing the ci and ui components'
];

const CJK_RUN_PATTERN = /[\u3000-\u9FFF\uAC00-\uD7AF]+/g;
const REPEATED_WORD_PATTERN = /\b(\w+)\s+\1\s+\1\s+\1\b/i;
/**
 * Residual-markup check. Deliberately the SAME pattern the repair pass neutralizes
 * (repair.ts HTML_TAG_PATTERN), and deliberately applied PER FIELD.
 *
 * A whole-document `/<[a-z][\s\S]*>/` scan is unsatisfiable rather than strict: because
 * `[\s\S]*` crosses the JSON separators, two individually-clean sentences — "scales to <n
 * workers" in one field and "the ratio is 3>2 in practice" in another — concatenate into a
 * match that no per-field repair can remove, so the article would fail a gate it cannot pass.
 * Scanning each field with the repair's own pattern makes this a true residual check:
 * anything it can detect, repair has already fixed, so a hit means markup survived somewhere
 * repair does not reach.
 */
const RESIDUAL_MARKUP_PATTERN = /<[a-zA-Z/][^>]*>/;

/** Every string in the content, flattened with its dotted path. */
function textFields(value: unknown, path = '$'): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => textFields(entry, `${path}.${index}`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entry]) => textFields(entry, `${path}.${key}`));
  }
  return [];
}

/**
 * Scans content for corruption/injection defects. Runs post-repair, so markup inside public
 * text fields has already been folded to a harmless [tag] form.
 */
export function findSystemProtectionDefects(content: unknown): SystemProtectionDefect[] {
  const defects: SystemProtectionDefect[] = [];
  const jsonStr = JSON.stringify(content);
  const jsonStrLower = jsonStr.toLowerCase();

  // The product name is data corruption's favorite field: an upstream identity failure
  // ("React &middot;", "or install uv:") propagates it into every sentence of the article.
  // This is an identity check, not a style check — a sentence cannot trip it; only a name
  // that is markup residue, a sentence fragment, or a section heading can.
  const productName = (content as any)?.product?.name;
  if (typeof productName === 'string' && !isValidDisplayName(productName)) {
    defects.push({
      code: 'PRODUCT_NAME_INVALID',
      path: '$.product.name',
      message: `"${productName}" is not a publishable product name (markup residue, sentence/instruction fragment, or document section heading).`
    });
  }

  for (const field of textFields(content)) {
    if (RESIDUAL_MARKUP_PATTERN.test(field.text)) {
      defects.push({
        code: 'HTML_TAGS_IN_OUTPUT',
        path: field.path,
        message: 'HTML tags found in output.'
      });
    }
  }

  for (const banned of BANNED_FIXTURE_STRINGS) {
    if (jsonStrLower.includes(banned.toLowerCase())) {
      defects.push({
        code: 'FIXTURE_VALUE_LEAKED',
        path: '$',
        message: `Production Data integrity Violation: Fixture/placeholder value detected: "${banned}"`
      });
    }
  }

  // CJK in English output is the model's characteristic mid-article language lapse — with one
  // sanctioned exception: the product's own name. A project genuinely named with CJK
  // characters must be nameable in its review (the blanket form of this scan excluded the
  // "AI 短劇編劇" article on 2026-08-29), so a CJK run drawn verbatim from a valid display
  // name is the name doing its job. Every other run is still corruption: a language lapse
  // produces runs the name does not contain, and a name that is itself corrupt fails
  // isValidDisplayName, which both voids the exemption and trips PRODUCT_NAME_INVALID above.
  const sanctionedCjkSource =
    typeof productName === 'string' && isValidDisplayName(productName) ? productName : '';
  const foreignCjkRuns = [...new Set(jsonStr.match(CJK_RUN_PATTERN) ?? [])]
    .filter(run => !sanctionedCjkSource.includes(run));
  if (foreignCjkRuns.length > 0) {
    const shown = foreignCjkRuns.slice(0, 3).map(run => `"${run}"`).join(', ');
    const elided = foreignCjkRuns.length > 3 ? `, +${foreignCjkRuns.length - 3} more` : '';
    defects.push({
      code: 'MIXED_LANGUAGE_CORRUPTION',
      path: '$',
      message: `Mixed-language corruption detected: CJK characters found in English output (${shown}${elided}).`
    });
  }

  if (REPEATED_WORD_PATTERN.test(jsonStr)) {
    defects.push({
      code: 'REPEATED_WORD_CORRUPTION',
      path: '$',
      message: 'Repeated word sequence detected in output.'
    });
  }

  return defects;
}
