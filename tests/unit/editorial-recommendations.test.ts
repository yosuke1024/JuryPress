import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  collectEditorialRecommendationFindings,
  recommendationContractApplies,
  designInterventionContractApplies,
  scopeValidationContractApplies,
  beyondMaintainerScopeMatch,
  documentsTheProblemMatch,
  oversizedScopeExpansionMatch,
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

function findingsFor(judges: JudgeSpec[], promptVersion?: string) {
  return collectEditorialRecommendationFindings(contentWith(judges), promptVersion);
}

function oneJudge(judge_id: string, concern: string, action: string, promptVersion?: string) {
  return findingsFor([{ judge_id, concern, action }], promptVersion);
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

  it("rejects Lisa's concern↔action mismatch", () => {
    // The visualization tool shares not one word with the synchronization concern, so it
    // fails the prompt's echo rule outright. Blocking, not advisory: under 4.5.0+ the writer
    // is told to reuse a concern word verbatim, and the 2.1.0 prompt — which carried the same
    // self-check — produced 40 of 40 compliant recommendations, so a violation is a defect in
    // the response rather than a limit of the check.
    const findings = oneJudge('lisa', SCRIPTC.lisa.concern, SCRIPTC.lisa.action);
    const echo = findings.find(f => f.code === 'RECOMMENDATION_CONCERN_ECHO_MISSING');
    expect(echo?.severity).toBe('error');
    expect(echo?.path).toBe('$.judges.0.recommended_next_step.action');
  });

  it("accepts David's and Sarah's concern-aligned recommendations without findings", () => {
    expect(oneJudge('david', SCRIPTC.david.concern, SCRIPTC.david.action)).toEqual([]);
    expect(oneJudge('sarah', SCRIPTC.sarah.concern, SCRIPTC.sarah.action)).toEqual([]);
  });

  it('rejects the full scriptc response, naming every defect in one pass', () => {
    const findings = collectEditorialRecommendationFindings(scriptcContent());
    const errors = findings.filter(f => f.severity === 'error');
    expect(errors.map(f => `${f.path} ${f.code}`)).toEqual([
      // Alex: an organizational end state that also echoes nothing from his concern.
      '$.judges.0.recommended_next_step.action RECOMMENDATION_BEYOND_MAINTAINER_SCOPE',
      '$.judges.0.recommended_next_step.action RECOMMENDATION_CONCERN_ECHO_MISSING',
      // Lisa: the visualization that answers a synchronization concern.
      '$.judges.2.recommended_next_step.action RECOMMENDATION_CONCERN_ECHO_MISSING',
      // Marcus: the foundation transfer. It does echo "compiler", so only scope fails.
      '$.judges.4.recommended_next_step.action RECOMMENDATION_BEYOND_MAINTAINER_SCOPE'
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

  it('rejects founding or joining an institutional body under any name', () => {
    for (const action of [
      'Set up an oversight board to arbitrate roadmap disputes between the vendor and adopters',
      'Join a recognized aerospace standards body to guarantee the protocol outlives the current team',
      'Stand up a technical committee to own the release process across the three vendor forks'
    ]) {
      expect(beyondMaintainerScopeMatch(action), action).not.toBeNull();
    }
  });

  /**
   * The boundary the rule is drawn on: it is the NEW EXTERNAL ORGANIZATION that is out of a
   * maintainer's reach, never the governance vocabulary. Every action below uses that
   * vocabulary and is a first step the maintainer can take alone — including the two the
   * reviewer of this change named — so none may be blocked. Losing this boundary would make
   * the contract reject the very corrections it exists to ask for.
   */
  const LEGITIMATE_FIRST_STEPS = [
    SCRIPTC.sarah.action,
    'Create a lightweight governance framework in GOVERNANCE.md defining ownership and merge responsibilities.',
    'Document the project governance model in GOVERNANCE.md, including maintainer succession and decision rights.',
    'Create a governance model document in the repository that records who merges what and when',
    'Publish a GOVERNANCE.md documenting the maintenance commitment and a bus-factor mitigation plan',
    'Document the ownership and succession policy in the README so adopters can judge continuity risk',
    'Establish a standard contribution guide and public issue board to transform the showcase into a maintainable platform',
    'Establish an open RFC process for core TUI protocol changes to allow external contributors to propose extensions',
    'Formally commit to keeping the core Rust rendering engine open-source under a permissive license',
    'Set up a GitHub Sponsors page so adopters can support the maintenance effort directly',
    // A committee may be mentioned without being founded: the bounded verb-to-object distance
    // is what keeps this from matching across the clause.
    'Add a CI check that runs the parser suite, and send the result to the review committee',
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

describe('the concern echo is exactly the rule the prompt states', () => {
  it('accepts a word reused verbatim', () => {
    expect(oneJudge(
      'david',
      'Zero automated unit or integration tests are present in the repository.',
      'Publish a CI run of the existing tests against the reviewed commit so behaviour is checkable.'
    )).toEqual([]);
  });

  it('rejects a morphological variant, because the prompt asks for the same word', () => {
    // "tests" → "testing" is not verbatim reuse. Accepting it here would enforce a laxer rule
    // than the writer was given, and the prompt names this exact pair as insufficient.
    const findings = oneJudge(
      'david',
      'Zero automated unit or integration tests are present in the repository.',
      'Introduce a comprehensive testing suite utilizing Jest or Vitest.'
    );
    expect(findings.find(f => f.code === 'RECOMMENDATION_CONCERN_ECHO_MISSING')?.severity).toBe('error');
  });

  it('folds case but nothing else', () => {
    expect(oneJudge(
      'lisa',
      'Onboarding strands a new user at the first error message they hit.',
      'Rewrite the first-run Onboarding copy so the error message names the fix.'
    )).toEqual([]);
  });

  it('ignores words too short or too common to prove a link', () => {
    // Only "with", "that" and three-letter words are shared — none of them evidence.
    const findings = oneJudge(
      'sarah',
      'The scope drifts, and that is the risk with a library this young.',
      'Ship a demo with the docs that shows one use case end to end.'
    );
    expect(findings.some(f => f.code === 'RECOMMENDATION_CONCERN_ECHO_MISSING')).toBe(true);
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
    // Echoes "tests", so only the style rules have anything to say — and they only warn.
    const generic = oneJudge('alex', 'The tests barely cover the parser.', 'Add more tests.');
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
/**
 * The documents-the-problem regressions (issue #114). Texts are VERBATIM from the 4.6.0
 * generation records the issue and the 2026-08-26 corpus scan name — three Lisa
 * recommendations that answer a user-facing-friction concern with a document teaching users
 * to endure that friction, plus the corpus's nearest misses, which must stay silent.
 */
const ISSUE_114 = {
  /** season-2-2026-08-15-daily (HermesOffice) — the issue's flagship Lisa example. */
  hermesLisa: {
    concern: 'Cognitive load of terminal-centric developer setup commands.',
    action: 'Draft a desktop setup troubleshooting walkthrough guide specifically addressing terminal execution failures.'
  },
  /** season-2-2026-08-20-daily — a missing in-product refinement loop answered with a manual. */
  ipAsLogoLisa: {
    concern: "Users lack a feedback loop to refine a chosen candidate's expressions or colors within the skill, forcing them to manually rewrite prompts.",
    action: 'Publish a step-by-step guidance document detailing how to refine specific facial attributes using conversational sub-prompts.'
  },
  /** season-2-2026-08-23-daily — layout glitches answered with documented workarounds. */
  zcompleteLisa: {
    concern: 'Prompt layout glitches under complex themes degrade the terminal aesthetics.',
    action: 'Document visual integration workarounds for popular prompt themes to help users fix layout glitches.'
  },
  /** season-2-2026-08-25-daily — the missing document IS the concern; the guide is the fix. */
  walgitLisa: {
    concern: 'The error responses during failed OIDC redirection lack descriptive troubleshooting tips for developers.',
    action: 'Add a dedicated troubleshooting guide in the web UI for authentication failures to assist developers when local credentials expire.'
  },
  /** season-2-2026-08-14-daily — a friction concern answered in the product, as the rule asks. */
  qwenLisa: {
    concern: "Friction caused by manual configuration parameters stops non-technical users from experiencing the interface's core values.",
    action: 'Minimize configuration friction by integrating automatic local backend detection during the first startup sequence.'
  },
  /** season-2-2026-08-15-daily — a friction concern with a non-document deliverable. */
  hermesAlex: {
    concern: 'High friction of source-only installations',
    action: 'Publish prebuilt desktop binary installations via automated GitHub workflows to bypass the developer toolchain requirement.'
  },
  /** season-2-2026-08-16-daily — a guide, but the concern names no user-facing friction. */
  opticalAlex: {
    concern: 'The target hardware requirement makes immediate adoption impossible for standard engineering teams who lack physical optical network interfaces.',
    action: 'Write a hardware emulation guide in README.md to help developers run simulated workloads without physical transceivers.'
  },
  /** season-2-2026-08-10-daily — an INTERACTIVE walkthrough is a product flow, not a document. */
  phoneHarnessLisa: {
    concern: 'Active screen recording and accessibility settings require a full terminal restart to take effect, creating a confusing, discontinuous first-run flow where the doctor script fails silently without immediate feedback.',
    action: 'Implement an interactive walkthrough in the startup routine that detects if a terminal restart is pending after granting permissions and prompts the user to reload.'
  },
  /** season-2-regenerate-minio — "to guide users" is the verb; the tooltips are the product. */
  minioLisa: {
    concern: 'Relies heavily on manual environment variable generation, which can feel intimidating for junior designers or administrators.',
    action: 'Add inline visual hints or documentation tooltips inside the policy matrix view to guide users when configuring permissions.'
  },
  /** season-2-2026-08-12-daily — the pattern on a 4.5.0 record the version gate keeps unjudged. */
  installDriversLisa: {
    concern: 'The installation process forces users to hunt for external drivers and manually configure terminal commands.',
    action: 'Add a step-by-step troubleshooting section in the README focused entirely on the installation steps.'
  }
} as const;

/**
 * The pound0423 regressions (issue #137) — VERBATIM from the published generation record
 * (season-2-manual-33230334870, 2026-08-29, prompt 4.7.0). Three of five judges leapt past
 * the first verifiable step into a scope expansion: Alex to a web-based playground, Sarah to
 * institutionalizing new drama genres on a project the same article praises for its narrow
 * focus, Marcus to a LangChain ecosystem migration. David (a test runner answering the
 * missing-tests concern) and Lisa (an install script answering the manual-debugging concern)
 * are the same record's compliant recommendations and must stay silent.
 */
const POUND = {
  alex: {
    concern: 'The local directory installation path is a massive source of friction for creative writers.',
    action: 'Deploy a web-based playground to bypass the command-line installation process entirely.'
  },
  david: {
    concern: 'Completely lacks any automated test execution script, relying entirely on documented manual test logs.',
    action: 'Write a Python-based test execution script to programmatically verify prompt trigger boundaries.'
  },
  lisa: {
    concern: 'The setup guide expects users to manually debug directory placement if the skill does not load immediately.',
    action: 'Build an automated shell script to handle directory mapping and detect installation errors.'
  },
  sarah: {
    concern: 'No visible project roadmap or guidelines for how community contributors can submit new drama genres.',
    action: 'Publish a contribution guide outlining the roadmap and criteria for adding new drama genres.'
  },
  marcus: {
    concern: "The reliance on the obscure Codex desktop environment limits the project's ecosystem footprint.",
    action: 'Refactor the prompting framework to support the LangChain ecosystem to expand its developer footprint.'
  }
} as const;

/**
 * What the issue's acceptance criteria ask the three regressions to become after repair:
 * concern-specific, maintainer-startable, validation-first, and distinct from each other.
 * Modeled on the issue's own improvement examples; each echoes its judge's real concern.
 */
const POUND_REPAIRED = {
  alex: 'Build a static one-screen prototype that runs one pasted prompt, and confirm three to five creative writers reach a first generated script with no command-line installation.',
  sarah: 'Create an example PR in which an external contributor reproduces the current test checklist for one existing genre, proving the contribution path works before adding new drama genres.',
  marcus: 'Extract one prompt module into an environment-independent fixture and confirm the same format test passes on a single-LLM runner outside the Codex desktop environment.'
} as const;

describe('designInterventionContractApplies — the version gate (issue #114)', () => {
  it('applies from prompt 4.7.0 onward', () => {
    expect(designInterventionContractApplies('4.7.0')).toBe(true);
    expect(designInterventionContractApplies('4.8.1')).toBe(true);
    expect(designInterventionContractApplies('5.0.0')).toBe(true);
  });

  it('never judges records generated before the prompt stated the rule', () => {
    expect(designInterventionContractApplies('4.6.0')).toBe(false);
    expect(designInterventionContractApplies('4.5.0')).toBe(false);
    expect(designInterventionContractApplies('2.1.0')).toBe(false);
    expect(designInterventionContractApplies(null)).toBe(false);
    expect(designInterventionContractApplies(undefined)).toBe(false);
    expect(designInterventionContractApplies('not-a-version')).toBe(false);
  });

  it('is live for the production prompt version in config/season.json', () => {
    // The prompt text and the check ship together, same pin as the 4.5.0 contract above.
    const season = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8')
    );
    expect(designInterventionContractApplies(season.evaluation_prompt_version)).toBe(true);
  });
});

describe('the documents-the-problem regressions (issue #114)', () => {
  it("warns on HermesOffice Lisa's troubleshooting walkthrough for a cognitive-load concern", () => {
    const findings = oneJudge('lisa', ISSUE_114.hermesLisa.concern, ISSUE_114.hermesLisa.action, '4.7.0');
    expect(findings.map(f => f.code)).toEqual(['RECOMMENDATION_DOCUMENTS_THE_PROBLEM']);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].path).toBe('$.judges.0.recommended_next_step.action');
    expect(findings[0].ruleVersion).toBe(EDITORIAL_RECOMMENDATION_RULE_VERSION);
  });

  it("warns on the 08-20 guidance document for a forced-manual-rewrite concern", () => {
    const findings = oneJudge('lisa', ISSUE_114.ipAsLogoLisa.concern, ISSUE_114.ipAsLogoLisa.action, '4.7.0');
    expect(findings.map(f => f.code)).toEqual(['RECOMMENDATION_DOCUMENTS_THE_PROBLEM']);
  });

  it("warns on the 08-23 documented workarounds for layout glitches", () => {
    const findings = oneJudge('lisa', ISSUE_114.zcompleteLisa.concern, ISSUE_114.zcompleteLisa.action, '4.7.0');
    expect(findings.map(f => f.code)).toEqual(['RECOMMENDATION_DOCUMENTS_THE_PROBLEM']);
  });

  it('stays silent when the missing document is itself the concern (08-25 Lisa)', () => {
    expect(oneJudge('lisa', ISSUE_114.walgitLisa.concern, ISSUE_114.walgitLisa.action, '4.7.0')).toEqual([]);
  });

  it('stays silent when a friction concern is answered in the product (Qwen Lisa)', () => {
    expect(oneJudge('lisa', ISSUE_114.qwenLisa.concern, ISSUE_114.qwenLisa.action, '4.7.0')).toEqual([]);
  });

  it('stays silent on a friction concern with a non-document deliverable (HermesOffice Alex)', () => {
    expect(oneJudge('alex', ISSUE_114.hermesAlex.concern, ISSUE_114.hermesAlex.action, '4.7.0')).toEqual([]);
  });

  it('stays silent on a guide answering a concern that names no user-facing friction (08-16 Alex)', () => {
    expect(oneJudge('alex', ISSUE_114.opticalAlex.concern, ISSUE_114.opticalAlex.action, '4.7.0')).toEqual([]);
  });

  it('never judges 4.6.0 records — or direct calls with no version — by the 4.7.0 rule', () => {
    const flagged = (findings: ReturnType<typeof oneJudge>) =>
      findings.filter(f => f.code === 'RECOMMENDATION_DOCUMENTS_THE_PROBLEM');
    expect(flagged(oneJudge('lisa', ISSUE_114.hermesLisa.concern, ISSUE_114.hermesLisa.action, '4.6.0'))).toEqual([]);
    expect(flagged(oneJudge('lisa', ISSUE_114.hermesLisa.concern, ISSUE_114.hermesLisa.action))).toEqual([]);
  });

  it('reports the terms that paired the concern with the documenting action', () => {
    expect(documentsTheProblemMatch(ISSUE_114.hermesLisa.concern, ISSUE_114.hermesLisa.action))
      .toEqual({ frictionTerm: 'Cognitive load', documentTerm: 'guide' });
    expect(documentsTheProblemMatch(ISSUE_114.ipAsLogoLisa.concern, ISSUE_114.ipAsLogoLisa.action))
      .toEqual({ frictionTerm: 'manually', documentTerm: 'guidance' });
    expect(documentsTheProblemMatch(ISSUE_114.zcompleteLisa.concern, ISSUE_114.zcompleteLisa.action))
      .toEqual({ frictionTerm: 'glitches', documentTerm: 'workarounds' });
  });

  it('does not mistake a compliant product-side action for a document (archive-scan guards)', () => {
    // Both texts are what the 4.7.0 rule ASKS Lisa to write — an interactive product flow, and
    // in-product tooltips whose sentence merely uses "guide" as a verb — so both must be null.
    expect(documentsTheProblemMatch(ISSUE_114.phoneHarnessLisa.concern, ISSUE_114.phoneHarnessLisa.action)).toBeNull();
    expect(documentsTheProblemMatch(ISSUE_114.minioLisa.concern, ISSUE_114.minioLisa.action)).toBeNull();
  });

  it('does not mistake a product-side workaround for documented workarounds', () => {
    // "workaround" also names a code intervention; only a documenting verb in the same
    // clause makes it a document. Synthetic action on the real 08-23 concern.
    expect(documentsTheProblemMatch(
      ISSUE_114.zcompleteLisa.concern,
      'Implement a compatibility workaround in the renderer for popular prompt themes to prevent layout glitches.'
    )).toBeNull();
  });

  it('recognizes the 08-12 README troubleshooting section as the pattern (matcher only — its 4.5.0 record stays unjudged)', () => {
    expect(documentsTheProblemMatch(ISSUE_114.installDriversLisa.concern, ISSUE_114.installDriversLisa.action))
      .toEqual({ frictionTerm: 'manually', documentTerm: 'troubleshooting' });
    expect(
      oneJudge('lisa', ISSUE_114.installDriversLisa.concern, ISSUE_114.installDriversLisa.action, '4.5.0')
        .filter(f => f.code === 'RECOMMENDATION_DOCUMENTS_THE_PROBLEM')
    ).toEqual([]);
  });

  it('suppresses the warning when the concern carries both friction and missing-docs vocabulary', () => {
    // Synthetic mechanics check: the carve-out outranks the friction match, because it only
    // ever suppresses — over-matching costs recall, never a false report.
    expect(documentsTheProblemMatch(
      'Manual setup is undocumented, leaving users without instructions.',
      'Write a setup guide covering the manual steps.'
    )).toBeNull();
  });
});

describe('scopeValidationContractApplies — the version gate (issue #137)', () => {
  it('applies from prompt 4.8.0 onward', () => {
    expect(scopeValidationContractApplies('4.8.0')).toBe(true);
    expect(scopeValidationContractApplies('4.9.1')).toBe(true);
    expect(scopeValidationContractApplies('5.0.0')).toBe(true);
  });

  it('never judges records generated before the prompt stated the rule', () => {
    expect(scopeValidationContractApplies('4.7.0')).toBe(false);
    expect(scopeValidationContractApplies('4.5.0')).toBe(false);
    expect(scopeValidationContractApplies('2.1.0')).toBe(false);
    expect(scopeValidationContractApplies(null)).toBe(false);
    expect(scopeValidationContractApplies(undefined)).toBe(false);
    expect(scopeValidationContractApplies('not-a-version')).toBe(false);
  });

  it('is live for the production prompt version in config/season.json', () => {
    // The prompt text and the check ship together, same pin as the 4.5.0 contract above.
    const season = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8')
    );
    expect(scopeValidationContractApplies(season.evaluation_prompt_version)).toBe(true);
  });
});

describe('the pound0423 regressions (issue #137)', () => {
  it("warns on Alex's web-based playground for an installation-friction concern", () => {
    const findings = oneJudge('alex', POUND.alex.concern, POUND.alex.action, '4.8.0');
    expect(findings.map(f => f.code)).toEqual(['RECOMMENDATION_OVERSIZED_SCOPE_EXPANSION']);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].path).toBe('$.judges.0.recommended_next_step.action');
    expect(findings[0].ruleVersion).toBe(EDITORIAL_RECOMMENDATION_RULE_VERSION);
  });

  it("warns on Sarah's new-genre pipeline for a missing-guidelines concern", () => {
    const findings = oneJudge('sarah', POUND.sarah.concern, POUND.sarah.action, '4.8.0');
    expect(findings.map(f => f.code)).toEqual(['RECOMMENDATION_OVERSIZED_SCOPE_EXPANSION']);
  });

  it("warns on Marcus's LangChain ecosystem migration for a desktop-dependency concern", () => {
    const findings = oneJudge('marcus', POUND.marcus.concern, POUND.marcus.action, '4.8.0');
    expect(findings.map(f => f.code)).toEqual(['RECOMMENDATION_OVERSIZED_SCOPE_EXPANSION']);
  });

  it('reports each regression under its own expansion class', () => {
    expect(oversizedScopeExpansionMatch(POUND.alex.action))
      .toEqual({ expansionTerm: 'Deploy a web-based', expansionClass: 'distribution_surface' });
    expect(oversizedScopeExpansionMatch(POUND.sarah.action))
      .toEqual({ expansionTerm: 'adding new drama genres', expansionClass: 'market_expansion' });
    expect(oversizedScopeExpansionMatch(POUND.marcus.action))
      .toEqual({ expansionTerm: 'support the LangChain ecosystem', expansionClass: 'ecosystem_migration' });
  });

  it("stays silent on the same record's compliant recommendations (David, Lisa)", () => {
    expect(oneJudge('david', POUND.david.concern, POUND.david.action, '4.8.0')).toEqual([]);
    expect(oneJudge('lisa', POUND.lisa.concern, POUND.lisa.action, '4.8.0')).toEqual([]);
  });

  it('flags exactly the three regressions on the whole five-judge record, and nothing blocks', () => {
    const findings = findingsFor(
      Object.entries(POUND).map(([judge_id, texts]) => ({ judge_id, concern: texts.concern, action: texts.action })),
      '4.8.0'
    );
    expect(findings.filter(f => f.severity === 'error')).toEqual([]);
    expect(findings.map(f => f.path).sort()).toEqual([
      '$.judges.0.recommended_next_step.action',
      '$.judges.3.recommended_next_step.action',
      '$.judges.4.recommended_next_step.action'
    ]);
    expect(new Set(findings.map(f => f.code))).toEqual(new Set(['RECOMMENDATION_OVERSIZED_SCOPE_EXPANSION']));
  });

  it('never judges 4.7.0 records — or direct calls with no version — by the 4.8.0 rule', () => {
    // The pound0423 record itself is 4.7.0: revalidating the archive must leave it exactly
    // as it shipped. The contract is a rule for future generations, not a retroactive verdict.
    const flagged = (findings: ReturnType<typeof oneJudge>) =>
      findings.filter(f => f.code === 'RECOMMENDATION_OVERSIZED_SCOPE_EXPANSION');
    expect(flagged(oneJudge('alex', POUND.alex.concern, POUND.alex.action, '4.7.0'))).toEqual([]);
    expect(flagged(oneJudge('alex', POUND.alex.concern, POUND.alex.action))).toEqual([]);
  });
});

describe('legitimate expansions and validation-first actions (issue #137 carve-outs)', () => {
  it("does not mistake a web-native project's browser playground for a surface change", () => {
    // Verbatim 4.4.0 corpus text (Bonsai): the project IS web tech, so a browser playground
    // is a demo inside its own medium. "web-based" is the surface marker, not "browser".
    expect(oversizedScopeExpansionMatch(
      'Create a zero-install interactive browser playground that lets developers edit Bonsai code and see the DOM update in real-time.'
    )).toBeNull();
  });

  it('does not mistake an ecosystem-integration document for an ecosystem migration', () => {
    // Verbatim 4.5.0 corpus text: a drafted document is exactly the first-step artifact the
    // contract asks for — "draft" commits to a document, not a migration.
    expect(oversizedScopeExpansionMatch(
      'Draft a standard ecosystem integration document detailing how non-Claude runtimes can execute the standalone skill outside of Claude Code.'
    )).toBeNull();
  });

  it('does not reach a distant "ecosystem" across the bounded verb-to-object window', () => {
    // Verbatim 4.4.0 corpus text (keysmith): "support" governs "wrappers", not the ecosystem
    // named four words later.
    expect(oversizedScopeExpansionMatch(
      'Expand the keysmith framework to support generic local AI wrappers beyond the Codex CLI ecosystem'
    )).toBeNull();
  });

  it("does not mistake documenting an EXISTING cloud offering for standing one up", () => {
    // Verbatim 4.3.0 corpus text: the enterprise offering already exists; the action is the
    // roadmap document that explains it.
    expect(oversizedScopeExpansionMatch(
      'Publish a definitive open-source roadmap detailing the feature split between the local CLI and the cloud enterprise offering.'
    )).toBeNull();
  });

  it('suppresses the warning when the expansion arrives as a validation artifact', () => {
    // A web-based PROTOTYPE measured against an observable outcome is the validation-first
    // step the rule asks for — the carve-out is what keeps legitimate expansion work legal.
    expect(oversizedScopeExpansionMatch(
      'Deploy a web-based prototype of the paste-one-prompt flow and measure whether five writers finish installation without the CLI.'
    )).toBeNull();
  });
});

describe('the repaired pound0423 recommendations (issue #137 acceptance)', () => {
  const repairedJudges = () => Object.entries(POUND).map(([judge_id, texts]) => ({
    judge_id,
    concern: texts.concern,
    action: (POUND_REPAIRED as any)[judge_id] ?? texts.action
  }));

  it('each repaired action answers its own concern and carries no findings at all', () => {
    expect(oneJudge('alex', POUND.alex.concern, POUND_REPAIRED.alex, '4.8.0')).toEqual([]);
    expect(oneJudge('sarah', POUND.sarah.concern, POUND_REPAIRED.sarah, '4.8.0')).toEqual([]);
    expect(oneJudge('marcus', POUND.marcus.concern, POUND_REPAIRED.marcus, '4.8.0')).toEqual([]);
  });

  it("Sarah's repaired action may still NAME the genre expansion — the example PR in front of it is what clears it", () => {
    // "before adding new drama genres" alone would match the market class; the carve-out
    // recognizes the validation artifact and stands down. Legitimate genre work stays legal.
    expect(oversizedScopeExpansionMatch(POUND_REPAIRED.sarah)).toBeNull();
  });

  it('the whole repaired record is finding-free: five concern-specific, distinct first steps', () => {
    // Distinctness is asserted by the absence of the cross-judge duplication error, the same
    // rule every published record clears.
    expect(findingsFor(repairedJudges(), '4.8.0')).toEqual([]);
  });
});

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
    // Lisa's mismatch is blocking too — the acceptance criterion is that a recommendation
    // unrelated to its concern does not publish.
    expect(
      verdict.errors.some(e =>
        e.code === 'RECOMMENDATION_CONCERN_ECHO_MISSING'
        && e.path === '$.judges.2.recommended_next_step.action')
    ).toBe(true);
  });

  it('fails a 4.5.0 record on the Lisa mismatch alone, with nothing else wrong', () => {
    // The narrowest form of the acceptance criterion: one disconnected recommendation in an
    // otherwise clean article is enough to withhold publication.
    const content = cleanContent();
    const lisa = content.judges.find((judge: any) => judge.judge_id === 'lisa');
    lisa.concerns = [SCRIPTC.lisa.concern];
    lisa.recommended_next_step.action = SCRIPTC.lisa.action;

    const verdict = validate(content, '4.5.0');
    expect(verdict.status).toBe('failed');
    expect(verdict.errors.map(e => e.code)).toEqual(['RECOMMENDATION_CONCERN_ECHO_MISSING']);
  });

  it('keeps judging 4.4.0 records by their own contract — the scriptc defects still pass', () => {
    // The published scriptc review is a 4.4.0 record. It was generated against a prompt that
    // never stated the echo rule, so revalidating it must leave it exactly as it is: the
    // contract is a rule for future generations, not a retroactive verdict on the archive.
    const verdict = validate(scriptcShapedContent(), '4.4.0');
    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.filter(w => w.code.startsWith('RECOMMENDATION_'))).toEqual([]);
  });

  it('passes contract-clean content with no recommendation findings under 4.7.0 too', () => {
    // cleanContent() is not friction-free — Alex's concern says "manual steps" — so this also
    // pins that a friction concern answered in the product stays silent end to end.
    const verdict = validate(cleanContent(), '4.7.0');
    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.filter(w => w.code.startsWith('RECOMMENDATION_'))).toEqual([]);
  });

  it('records the documents-the-problem warning on a 4.7.0 record and still publishes it', () => {
    const content = cleanContent();
    const lisa = content.judges.find((judge: any) => judge.judge_id === 'lisa');
    lisa.concerns = [ISSUE_114.hermesLisa.concern];
    lisa.recommended_next_step.action = ISSUE_114.hermesLisa.action;

    const verdict = validate(content, '4.7.0');
    expect(verdict.status).toBe('passed'); // a warning is a signal, never a gate
    const flagged = verdict.warnings.filter(w => w.code === 'RECOMMENDATION_DOCUMENTS_THE_PROBLEM');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].path).toBe('$.judges.2.recommended_next_step.action');
  });

  it('keeps judging 4.6.0 records by their own contract — the HermesOffice Lisa passes clean', () => {
    const content = cleanContent();
    const lisa = content.judges.find((judge: any) => judge.judge_id === 'lisa');
    lisa.concerns = [ISSUE_114.hermesLisa.concern];
    lisa.recommended_next_step.action = ISSUE_114.hermesLisa.action;

    const verdict = validate(content, '4.6.0');
    expect(verdict.status).toBe('passed');
    expect(verdict.warnings.filter(w => w.code === 'RECOMMENDATION_DOCUMENTS_THE_PROBLEM')).toEqual([]);
  });

  function poundShapedContent(): any {
    const content = cleanContent();
    for (const judge of content.judges) {
      const texts = (POUND as any)[judge.judge_id];
      judge.concerns = [texts.concern];
      judge.recommended_next_step = { ...judge.recommended_next_step, action: texts.action };
    }
    return content;
  }

  it('passes contract-clean content with no recommendation findings under 4.8.0 too', () => {
    const verdict = validate(cleanContent(), '4.8.0');
    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.filter(w => w.code.startsWith('RECOMMENDATION_'))).toEqual([]);
  });

  it('records the three oversized-scope-expansion warnings on a 4.8.0 record and still publishes it', () => {
    const verdict = validate(poundShapedContent(), '4.8.0');
    expect(verdict.status).toBe('passed'); // a warning is a signal, never a gate
    const flagged = verdict.warnings.filter(w => w.code === 'RECOMMENDATION_OVERSIZED_SCOPE_EXPANSION');
    expect(flagged.map(f => f.path).sort()).toEqual([
      '$.judges.0.recommended_next_step.action',
      '$.judges.3.recommended_next_step.action',
      '$.judges.4.recommended_next_step.action'
    ]);
  });

  it('keeps judging 4.7.0 records by their own contract — the pound0423 record passes exactly as it shipped', () => {
    const verdict = validate(poundShapedContent(), '4.7.0');
    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.filter(w => w.code === 'RECOMMENDATION_OVERSIZED_SCOPE_EXPANSION')).toEqual([]);
  });

  it('publishes the repaired pound0423 record with no recommendation findings at all', () => {
    const content = poundShapedContent();
    for (const judge of content.judges) {
      const repaired = (POUND_REPAIRED as any)[judge.judge_id];
      if (repaired) judge.recommended_next_step = { ...judge.recommended_next_step, action: repaired };
    }
    const verdict = validate(content, '4.8.0');
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
