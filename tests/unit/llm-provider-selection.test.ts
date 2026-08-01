import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LLM_PROVIDER,
  GEMINI_DEFAULT_MODEL,
  LLM_PROVIDERS,
  LlmProviderConfigurationError,
  assertProviderCredentials,
  authenticationModeFor,
  isLlmProvider,
  resolveGenerationModel,
  resolveMappingModel,
  resolveProvider,
  strictParse
} from '../../src/lib/evaluation/llm-transport';
import { createTransport } from '../../src/lib/evaluation/transport-factory';

/**
 * Provider selection is the one decision that must never guess.
 *
 * Every case here is about the same property: the run either uses the provider the operator
 * chose, with that provider's credentials, or it stops. There is no path where a typo, a missing
 * secret, or a failure on one provider quietly routes the run to the other — that would put two
 * providers' output under one run key and make the whole comparison meaningless.
 */
describe('provider resolution is fail-closed', () => {
  it('defaults to Gemini when nothing is configured', () => {
    expect(resolveProvider({})).toBe('gemini');
    expect(DEFAULT_LLM_PROVIDER).toBe('gemini');
  });

  it('treats an empty or whitespace value as unset rather than as an error', () => {
    // A workflow that passes `${{ vars.X }}` for an unset variable sends an empty string.
    expect(resolveProvider({ JURYPRESS_LLM_PROVIDER: '' })).toBe('gemini');
    expect(resolveProvider({ JURYPRESS_LLM_PROVIDER: '   ' })).toBe('gemini');
  });

  it('resolves each supported provider', () => {
    expect(resolveProvider({ JURYPRESS_LLM_PROVIDER: 'gemini' })).toBe('gemini');
    expect(resolveProvider({ JURYPRESS_LLM_PROVIDER: 'anthropic-claude-code' }))
      .toBe('anthropic-claude-code');
  });

  it('refuses an unknown provider instead of falling back to the default', () => {
    // The failure mode this prevents: a typo in a repository variable silently publishing a
    // month of articles from a provider nobody selected.
    expect(() => resolveProvider({ JURYPRESS_LLM_PROVIDER: 'claude' }))
      .toThrow(LlmProviderConfigurationError);
    expect(() => resolveProvider({ JURYPRESS_LLM_PROVIDER: 'anthropic' }))
      .toThrow(/Unknown LLM provider/);
    expect(() => resolveProvider({ JURYPRESS_LLM_PROVIDER: 'openai' }))
      .toThrow(/Unknown LLM provider/);
  });

  it('exposes exactly the providers that have a transport', () => {
    expect([...LLM_PROVIDERS]).toEqual(['gemini', 'anthropic-claude-code']);
    for (const provider of LLM_PROVIDERS) {
      expect(createTransport(provider).provider).toBe(provider);
    }
    expect(isLlmProvider('gemini')).toBe(true);
    expect(isLlmProvider('gpt')).toBe(false);
  });
});

describe('credential preflight requires only the selected provider', () => {
  it('accepts a Gemini run with no Claude secret present', () => {
    expect(() => assertProviderCredentials('gemini', { GEMINI_API_KEY: 'k' })).not.toThrow();
  });

  it('accepts a Claude run with no Gemini secret present', () => {
    expect(() => assertProviderCredentials('anthropic-claude-code', {
      CLAUDE_CODE_OAUTH_TOKEN: 't'
    })).not.toThrow();
  });

  it('fails closed when the selected provider has no credential', () => {
    expect(() => assertProviderCredentials('gemini', {})).toThrow(/GEMINI_API_KEY/);
    expect(() => assertProviderCredentials('anthropic-claude-code', {}))
      .toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    // A secret wired from an unset GitHub secret arrives as an empty string, not as absent.
    expect(() => assertProviderCredentials('anthropic-claude-code', {
      CLAUDE_CODE_OAUTH_TOKEN: ''
    })).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('refuses to run Claude when an API key would silently override the subscription', () => {
    // ANTHROPIC_API_KEY wins over subscription auth inside the CLI, so a run would move onto
    // metered billing with nothing in the record to show it. Refuse rather than bill by accident.
    expect(() => assertProviderCredentials('anthropic-claude-code', {
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      ANTHROPIC_API_KEY: 'sk-ant-xxx'
    })).toThrow(/would override subscription/);
  });

  it('never puts a credential value in the error message', () => {
    const secret = 'sk-ant-super-secret-value';
    try {
      assertProviderCredentials('anthropic-claude-code', {
        CLAUDE_CODE_OAUTH_TOKEN: 't',
        ANTHROPIC_API_KEY: secret
      });
      throw new Error('expected a configuration error');
    } catch (e: any) {
      expect(e.message).not.toContain(secret);
    }
  });
});

describe('model resolution', () => {
  it('preserves Gemini resolution exactly, including the historical default', () => {
    // Regression guard: no workflow sets GEMINI_MODEL, so production has always run on this
    // default. Provider abstraction must not have moved it.
    expect(resolveGenerationModel('gemini', {})).toBe(GEMINI_DEFAULT_MODEL);
    expect(resolveGenerationModel('gemini', { GEMINI_MODEL: 'gemini-x' })).toBe('gemini-x');
    expect(resolveMappingModel('gemini', {})).toBe(GEMINI_DEFAULT_MODEL);
    expect(resolveMappingModel('gemini', { GEMINI_MODEL: 'gemini-x' })).toBe('gemini-x');
    expect(resolveMappingModel('gemini', {
      GEMINI_MODEL: 'gemini-x',
      GEMINI_MAPPING_MODEL: 'gemini-map'
    })).toBe('gemini-map');
  });

  it('gives Claude no default model at all', () => {
    // A pinned identifier is the point of the comparison. Substituting one silently would make
    // two runs incomparable without anything in the record saying so.
    expect(() => resolveGenerationModel('anthropic-claude-code', {}))
      .toThrow(/JURYPRESS_GENERATION_MODEL/);
    expect(() => resolveGenerationModel('anthropic-claude-code', {
      JURYPRESS_GENERATION_MODEL: '  '
    })).toThrow(/JURYPRESS_GENERATION_MODEL/);
    expect(resolveGenerationModel('anthropic-claude-code', {
      JURYPRESS_GENERATION_MODEL: 'claude-opus-5'
    })).toBe('claude-opus-5');
  });

  it('runs Claude mapping on the generation model until it is split deliberately', () => {
    // The initial migration adds ONE variable — the provider. A second model difference would
    // make an unexplained mapping result impossible to attribute.
    expect(resolveMappingModel('anthropic-claude-code', {
      JURYPRESS_GENERATION_MODEL: 'claude-opus-5'
    })).toBe('claude-opus-5');
    expect(resolveMappingModel('anthropic-claude-code', {
      JURYPRESS_GENERATION_MODEL: 'claude-opus-5',
      JURYPRESS_MAPPING_MODEL: 'claude-sonnet-5'
    })).toBe('claude-sonnet-5');
  });

  it('never lets Gemini variables reach Claude model resolution, or the reverse', () => {
    expect(() => resolveGenerationModel('anthropic-claude-code', { GEMINI_MODEL: 'gemini-x' }))
      .toThrow(/JURYPRESS_GENERATION_MODEL/);
    expect(resolveGenerationModel('gemini', { JURYPRESS_GENERATION_MODEL: 'claude-opus-5' }))
      .toBe(GEMINI_DEFAULT_MODEL);
  });
});

describe('provenance helpers', () => {
  it('reports the authentication mode without touching the credential', () => {
    expect(authenticationModeFor('gemini')).toBe('api_key');
    expect(authenticationModeFor('anthropic-claude-code')).toBe('subscription_oauth');
  });

  it('parses strictly and identically for every provider', () => {
    // Deliberately unforgiving: a transport that quietly unwrapped a code fence would hide the
    // exact output-discipline difference this migration exists to measure.
    expect(strictParse('{"a":1}')).toEqual({ a: 1 });
    expect(strictParse('```json\n{"a":1}\n```')).toBeNull();
    expect(strictParse('Here is the JSON: {"a":1}')).toBeNull();
    expect(strictParse('')).toBeNull();
  });
});
