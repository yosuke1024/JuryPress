import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  collectEditorialRecommendationFindings,
  recommendationContractApplies,
  beyondMaintainerScopeMatch,
  EDITORIAL_RECOMMENDATION_RULE_VERSION
} from '../../src/lib/evaluation/editorial-recommendations';
import { validateContent } from '../../src/lib/generation/validator';
import { createEditorialFixture } from '../fixtures/refined-review';

/**
 * The editorial recommendation contract (issue #85), pinned against the review that exposed
 * it: the scriptc article shipped Lisa recommending a visualization for a synchronization
 * concern, and Alex and Marcus both prescribing organizational independence — a governance
 * model and a foundation transfer — as a "next step" for a v0.0.17 project.
 *
 * The judge texts below are VERBATIM from the published scriptc generation record
 * (season-2-2026-07-27-daily). They are the regression fixtures the issue's acceptance
 * criteria name, so they must not be paraphrased.
 */

/** Verbatim from the scriptc record: concern[0] and recommended action per judge. */
const SCRIPTC = {
  alex: {
    concern: "The risk of complete project abandonment based on Vercel's previous experimental tracks like Zerolang",
    action: "Create a clear independent governance model to assure startup founders of the project's long-term maintenance"
  },
  david: {
    concern: 'Treating all numbers as f64 floats causes unnecessary performance penalties on standard integer operations',
    action: 'Implement a primitive integer type inference pass within the compiler frontend to bypass generic f64 arithmetic'
  },
  lisa: {
    concern: 'Manually keeping the JSON FFI manifest synchronized with TypeScript declarations introduces error-prone friction',
    action: 'Develop an interactive visual graphing tool for the coverage command to clearly map dynamic boundaries'
  },
  sarah: {
    concern: 'Complete absence of a published roadmap detailing planned API support and compiler milestones',
    action: 'Publish an official compatibility roadmap indicating which ES2025 features will be permanently out of scope'
  },
  marcus: {
    concern: 'High risk of project stagnation if Vercel shifts focus away from compiler labs',
    action: 'Transfer the core runtime and compiler to a neutral foundation to build genuine developer trust'
  }
} as const;

type JudgeSpec = { judge_id: string; concern: string; action: string };

function contentWith(judges: JudgeSpec[]): any {
  return {
    judges: judges.map(judge => ({
      judge_id: judge.judge_id,
      concerns: [judge.concern],
      recommended_next_step: { action: judge.action, criterion_id: 'purpose_usefulness' }
    }))
  };
}

function scriptcContent(): any {
  return contentWith(Object.entries(SCRIPTC).map(([judge_id, texts]) => ({
    judge_id,
    concern: texts.concern,
    action: texts.action
  })));
}

function findingsFor(judges: JudgeSpec[]) {
  return collectEditorialRecommendationFindings(contentWith(judges));
}

function oneJudge(judge_id: string, concern: string, action: string) {
  return findingsFor([{ judge_id, concern, action }]);
}

describe('recommendationContractApplies — the version gate', () => {
  it('applies from prompt 4.5.0 onward', () => {
    expect(recommendationContractApplies('4.5.0')).toBe(true);
    expect(recommendationContractApplies('4.6.1')).toBe(true);
    expect(recommendationContractApplies('5.0.0')).toBe(true);
  });

  it('never judges records generated before the prompt stated the contract', () => {
    expect(recommendationContractApplies('4.4.0')).toBe(false);
    expect(recommendationContractApplies('4.0.0')).toBe(false);
    expect(recommendationContractApplies('2.1.0')).toBe(false);
    expect(recommendationContractApplies(null)).toBe(false);
    expect(recommendationContractApplies(undefined)).toBe(false);
    expect(recommendationContractApplies('not-a-version')).toBe(false);
  });

  it('is live for the production prompt version in config/season.json', () => {
    // The prompt text and this contract ship together. If season.json is ever rolled back
    // below 4.5.0 while the 4.5.0 prompt text remains, records would be generated under
    // instructions the validator no longer enforces — this pin makes that visible.
    const season = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8')
    );
    expect(recommendationContractApplies(season.evaluation_prompt_version)).toBe(true);
  });
});

describe('the scriptc regressions (issue #85)', () => {
  it("rejects Alex's governance model as an organizational end state", () => {
    const findings = oneJudge('alex', SCRIPTC.alex.concern, SCRIPTC.alex.action);
    const scope = findings.find(f => f.code === 'RECOMMENDATION_BEYOND_MAINTAINER_SCOPE');
    expect(scope?.severity).toBe('error');
    expect(scope?.path).toBe('$.judges.0.recommended_next_step.action');
    expect(scope?.message).toContain('governance model');
  });

  it("rejects Marcus's foundation transfer as an organizational end state", () => {
    const findings = oneJudge('marcus', SCRIPTC.marcus.concern, SCRIPTC.marcus.action);
    const scope = findings.find(f => f.code === 'RECOMMENDATION_BEYOND_MAINTAINER_SCOPE');
    expect(scope?.severity).toBe('error');
    expect(scope?.message).toContain('to a neutral foundation');
  });

  it("records Lisa's concern↔action mismatch as a warning", () => {
    // The visualization tool shares not one meaningful word with the synchronization concern.
    // Deliberately a WARNING: as an error, zero lexical overlap would have excluded 24 of the
    // 27 editorial records published before this contract — legitimate actions answer a
    // concern in solution vocabulary all the time. The prompt's word-echo rule is what makes
    // future occurrences rare; this finding is how the survivors stay visible.
    const findings = oneJudge('lisa', SCRIPTC.lisa.concern, SCRIPTC.lisa.action);
    const disconnected = findings.find(f => f.code === 'RECOMMENDATION_CONCERN_DISCONNECTED');
    expect(disconnected?.severity).toBe('warning');
    expect(findings.filter(f => f.severity === 'error')).toEqual([]);
  });

  it("accepts David's and Sarah's concern-aligned recommendations without findings", () => {
    expect(oneJudge('david', SCRIPTC.david.concern, SCRIPTC.david.action)).toEqual([]);
    expect(oneJudge('sarah', SCRIPTC.sarah.concern, SCRIPTC.sarah.action)).toEqual([]);
  });

  it('rejects the full scriptc response on exactly the two organizational actions', () => {
    const findings = collectEditorialRecommendationFindings(scriptcContent());
    const errors = findings.filter(f => f.severity === 'error');
    expect(errors.map(f => f.code)).toEqual([
      'RECOMMENDATION_BEYOND_MAINTAINER_SCOPE',
      'RECOMMENDATION_BEYOND_MAINTAINER_SCOPE'
    ]);
    expect(errors.map(f => f.path)).toEqual([
      '$.judges.0.recommended_next_step.action',
      '$.judges.4.recommended_next_step.action'
    ]);
  });

  it("catches the Alex/Marcus governance convergence per action, not by text similarity", () => {
    // The two actions share a solution CLASS (organizational independence) but almost no
    // vocabulary — "governance model" vs "neutral foundation" — so no lexical similarity rule
    // can pair them. Each is rejected on its own as beyond maintainer scope, which is what
    // resolves the duplication: the shared class itself is the defect.
    const findings = collectEditorialRecommendationFindings(scriptcContent());
    expect(findings.filter(f => f.code === 'RECOMMENDATION_DUPLICATED_ACROSS_JUDGES')).toEqual([]);
    expect(
      findings.filter(f => f.code === 'RECOMMENDATION_BEYOND_MAINTAINER_SCOPE')
    ).toHaveLength(2);
  });
});

describe('organizational end states — the corpus habit', () => {
  // Marcus produced an institutional "next step" in 4 of the 27 editorial reviews published
  // before this contract. All verbatim from generation records; all must be rejected.
  const CORPUS_DEFECTS = [
    "Establish an independent open-source foundation or steering committee to guide the project's long-term evolution",
    'Form an independent research consortium or steering committee to govern the crowdsourced adversarial testing efforts',
    'Establish an open-source governance model or join a recognized aerospace/SDR working group to guarantee long-term maintenance'
  ];

  it.each(CORPUS_DEFECTS)('rejects: %s', action => {
    expect(beyondMaintainerScopeMatch(action)).not.toBeNull();
  });

  it('rejects funding and sponsorship acquisition as a next step', () => {
    expect(beyondMaintainerScopeMatch('Secure corporate sponsorship to fund a dedicated maintenance team')).not.toBeNull();
    expect(beyondMaintainerScopeMatch('Raise seed funding to hire two full-time maintainers')).not.toBeNull();
  });

  // First-step artifacts a maintainer can publish alone — including every governance-flavored
  // action the corpus contains that is genuinely executable. None may match.
  const LEGITIMATE_FIRST_STEPS = [
    SCRIPTC.sarah.action,
    'Publish a GOVERNANCE.md documenting the maintenance commitment and a bus-factor mitigation plan',
    'Document the ownership and succession policy in the README so adopters can judge continuity risk',
    'Establish a standard contribution guide and public issue board to transform the showcase into a maintainable platform',
    'Establish an open RFC process for core TUI protocol changes to allow external contributors to propose extensions',
    'Formally commit to keeping the core Rust rendering engine open-source under a permissive license',
    'Set up a GitHub Sponsors page so adopters can support the maintenance effort directly',
    // The metaphor the foundation pattern must never reach.
    'Create a solid foundation for the test suite by adding fixtures for the parser edge cases',
    // Governance as a product feature, not a restructuring.
    'Implement a data governance model for dataset access controls in the admin interface'
  ];

  it.each(LEGITIMATE_FIRST_STEPS)('accepts: %s', action => {
    expect(beyondMaintainerScopeMatch(action)).toBeNull();
  });
});

describe('cross-judge duplication', () => {
  const aligned = (judge_id: string) => ({
    judge_id,
    concern: 'The published roadmap never states whether the plugin API ships in the next release.',
    action: 'Publish a roadmap entry stating whether the plugin API ships in the next release.'
  });

  it('rejects two judges recommending the identical action', () => {
    const findings = findingsFor([aligned('alex'), aligned('david')]);
    const duplicated = findings.find(f => f.code === 'RECOMMENDATION_DUPLICATED_ACROSS_JUDGES');
    expect(duplicated?.severity).toBe('error');
    expect(duplicated?.message).toContain('alex');
    expect(duplicated?.message).toContain('david');
  });

  it('rejects the same step reworded', () => {
    const findings = findingsFor([
      {
        judge_id: 'sarah',
        concern: 'No roadmap covers the planned ES2025 compatibility work.',
        action: 'Publish a compatibility roadmap covering the planned ES2025 features.'
      },
      {
        judge_id: 'marcus',
        concern: 'The missing roadmap makes the ES2025 compatibility strategy unreadable for adopters.',
        action: 'Publish an official compatibility roadmap covering all planned ES2025 features and milestones.'
      }
    ]);
    expect(findings.some(f => f.code === 'RECOMMENDATION_DUPLICATED_ACROSS_JUDGES')).toBe(true);
  });

  it('accepts distinct actions that merely share a subsystem', () => {
    // Two judges talking about the same compiler share its vocabulary without recommending
    // the same step. The corpus-wide maximum containment between real distinct actions was
    // 0.44; the threshold must stay far above pairs like this.
    const findings = findingsFor([
      {
        judge_id: 'david',
        concern: 'Treating all numbers as f64 floats causes performance penalties on integer operations.',
        action: 'Implement an integer type inference pass in the compiler frontend to bypass f64 arithmetic.'
      },
      {
        judge_id: 'lisa',
        concern: 'The compiler frontend reports type errors without naming the offending source line.',
        action: 'Extend the compiler frontend diagnostics to name the source line for every type error.'
      }
    ]);
    expect(findings.filter(f => f.code === 'RECOMMENDATION_DUPLICATED_ACROSS_JUDGES')).toEqual([]);
  });
});

describe('concern↔action alignment', () => {
  it('meets morphological variants through stemming', () => {
    // Verbatim from a published record: "tests" answers to "testing suite". Plain token
    // matching misses the pair and cried disconnect on a perfectly aligned recommendation.
    const findings = oneJudge(
      'david',
      'Zero automated unit or integration tests are present in the repository',
      'Introduce a comprehensive testing suite utilizing Jest or Vitest'
    );
    expect(findings.filter(f => f.code === 'RECOMMENDATION_CONCERN_DISCONNECTED')).toEqual([]);
  });

  it('never blocks on the lexical signal alone', () => {
    const findings = oneJudge('lisa', SCRIPTC.lisa.concern, SCRIPTC.lisa.action);
    for (const finding of findings) {
      expect(finding.code).not.toBe('RECOMMENDATION_BEYOND_MAINTAINER_SCOPE');
      expect(finding.severity).toBe('warning');
    }
  });
});

describe('structure and style', () => {
  it('rejects a missing or empty action as a missing section', () => {
    const missing = collectEditorialRecommendationFindings({
      judges: [{ judge_id: 'alex', concerns: ['A concern.'], recommended_next_step: { action: '   ', criterion_id: 'purpose_usefulness' } }]
    });
    expect(missing[0]?.code).toBe('REQUIRED_SECTION_MISSING');
    expect(missing[0]?.severity).toBe('error');
  });

  it('rejects a judge with no primary concern to address', () => {
    const findings = findingsFor([{ judge_id: 'alex', concern: '', action: 'Publish the CI output for the reviewed commit.' }]);
    expect(findings[0]?.code).toBe('REQUIRED_SECTION_MISSING');
    expect(findings[0]?.path).toBe('$.judges.0.concerns.0');
  });

  it('warns on generic, too-short and question-phrased actions', () => {
    const generic = oneJudge('alex', 'The test suite is thin.', 'Add more tests.');
    expect(generic.map(f => f.code)).toContain('RECOMMENDATION_GENERIC');
    expect(generic.map(f => f.code)).toContain('RECOMMENDATION_TOO_SHORT');
    expect(generic.every(f => f.severity === 'warning')).toBe(true);

    const question = oneJudge(
      'lisa',
      'Onboarding stalls at the first error message.',
      'Could the onboarding error messages name the fix instead of the internal function?'
    );
    expect(question.map(f => f.code)).toContain('RECOMMENDATION_PHRASED_AS_QUESTION');
  });

  it('stamps every finding with the contract rule version', () => {
    for (const finding of collectEditorialRecommendationFindings(scriptcContent())) {
      expect(finding.ruleVersion).toBe(EDITORIAL_RECOMMENDATION_RULE_VERSION);
    }
  });
});

/**
 * The validator wiring: the contract judges 4.5.0+ records, and ONLY 4.5.0+ records. The
 * scriptc record itself (4.4.0) must remain valid under revalidation — it was generated to a
 * prompt that never stated these rules, and records are never judged by rules they were not
 * written to satisfy.
 */
describe('validateContent — version-dispatched enforcement', () => {
  /** Editorial fixture content with five contract-clean, concern-aligned recommendations. */
  function cleanContent(): any {
    const content = JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
    const rewrites: Record<string, { concern: string; action: string }> = {
      alex: {
        concern: 'Installation requires six manual steps before the first successful run, which will stall adoption by small teams.',
        action: 'Ship a one-command installation script that collapses the six manual steps and prints the first-run URL at the end.'
      },
      david: {
        concern: 'The repository ships no automated tests, so regressions can only be caught by hand.',
        action: 'Introduce an automated testing workflow in CI that runs the parser suite on every push and fails on regressions.'
      },
      lisa: {
        concern: 'Error messages name internal functions instead of the fix, which strands new users at their first failure.',
        action: 'Rewrite the five most common error messages to name the fix and link the relevant documentation section.'
      },
      sarah: {
        concern: 'The README promises a plugin API that the roadmap never mentions, leaving the scope ambiguous.',
        action: 'Publish a roadmap entry stating whether the plugin API is in scope for the next release.'
      },
      marcus: {
        concern: 'The project depends on a single maintainer with no succession plan, a real bus-factor risk.',
        action: 'Publish a succession plan naming a co-maintainer and the bus-factor mitigation steps for the next release.'
      }
    };
    for (const judge of content.judges) {
      const rewrite = rewrites[judge.judge_id];
      judge.concerns = [rewrite.concern];
      judge.recommended_next_step = { ...judge.recommended_next_step, action: rewrite.action };
    }
    return content;
  }

  function scriptcShapedContent(): any {
    const content = cleanContent();
    for (const judge of content.judges) {
      const texts = (SCRIPTC as any)[judge.judge_id];
      judge.concerns = [texts.concern];
      judge.recommended_next_step = { ...judge.recommended_next_step, action: texts.action };
    }
    return content;
  }

  function validate(content: any, promptVersion: string) {
    return validateContent({
      content,
      originalContent: content,
      evidences: createEditorialFixture().context.evidences,
      humanEdited: false,
      promptVersion
    });
  }

  it('passes contract-clean 4.5.0 content with no recommendation findings', () => {
    const verdict = validate(cleanContent(), '4.5.0');
    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.filter(w => w.code.startsWith('RECOMMENDATION_'))).toEqual([]);
  });

  it('fails a 4.5.0 record that reproduces the scriptc defects', () => {
    const verdict = validate(scriptcShapedContent(), '4.5.0');
    expect(verdict.status).toBe('failed');
    expect(
      verdict.errors.filter(e => e.code === 'RECOMMENDATION_BEYOND_MAINTAINER_SCOPE')
    ).toHaveLength(2);
    expect(
      verdict.warnings.some(w => w.code === 'RECOMMENDATION_CONCERN_DISCONNECTED')
    ).toBe(true);
  });

  it('keeps judging 4.4.0 records by their own contract — the scriptc defects still pass', () => {
    const verdict = validate(scriptcShapedContent(), '4.4.0');
    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.filter(w => w.code.startsWith('RECOMMENDATION_'))).toEqual([]);
  });

  it('holds human edits of 4.5.0 records to the same contract', () => {
    const original = cleanContent();
    const edited = JSON.parse(JSON.stringify(original));
    edited.judges[4].recommended_next_step.action =
      'Transfer the project to a neutral foundation to guarantee long-term stewardship.';
    const verdict = validateContent({
      content: edited,
      originalContent: original,
      evidences: createEditorialFixture().context.evidences,
      humanEdited: true,
      promptVersion: '4.5.0'
    });
    expect(verdict.status).toBe('failed');
    expect(verdict.errors.some(e => e.code === 'RECOMMENDATION_BEYOND_MAINTAINER_SCOPE')).toBe(true);
  });
});
