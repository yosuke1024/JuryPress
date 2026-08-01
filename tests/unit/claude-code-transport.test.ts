import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CLAUDE_CODE_ENGINE_VERSION,
  CLAUDE_WRAPPER_SYSTEM_PROMPT,
  ClaudeCodeTransport,
  ClaudeCodeTransportError,
  buildClaudeChildEnv,
  buildClaudeCliArgs,
  buildClaudeUserPrompt,
  classifyClaudeFailure,
  readClaudeModelUsed,
  readClaudeTokenUsage,
  resolveClaudeTimeoutMs
} from '../../src/lib/evaluation/claude-code-transport';
import type { LlmGenerationRequest } from '../../src/lib/evaluation/llm-transport';

const REQUEST: LlmGenerationRequest = {
  requestedModel: 'claude-opus-5',
  prompt: 'EDITORIAL PROMPT BODY',
  jsonSchema: { type: 'object', properties: { judges: { type: 'array' } } },
  thinkingBudget: 'high'
};

describe('the CLI process is caged', () => {
  const args = buildClaudeCliArgs({ model: 'claude-opus-5', systemPrompt: 'WRAPPER' });

  it('gives the model no tools at all', () => {
    // brief §12: no Bash, Edit, Write, Git, GitHub, WebFetch, WebSearch, MCP, Agent, Task.
    const toolsIndex = args.indexOf('--tools');
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(args[toolsIndex + 1]).toBe('');
  });

  it('loads no MCP servers, no skills and no settings files', () => {
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
    expect(args).toContain('--disable-slash-commands');
    const sourcesIndex = args.indexOf('--setting-sources');
    expect(sourcesIndex).toBeGreaterThan(-1);
    expect(args[sourcesIndex + 1]).toBe('');
  });

  it('replaces the agent system prompt rather than appending to it', () => {
    // --append-system-prompt would leave Claude Code's own repository-exploring persona in
    // place underneath the wrapper.
    expect(args).toContain('--system-prompt');
    expect(args).not.toContain('--append-system-prompt');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('WRAPPER');
  });

  it('denies anything unlisted instead of prompting, and takes exactly one turn', () => {
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
    expect(args).toContain('--no-session-persistence');
  });

  it('never passes --json-schema', () => {
    // Structured output re-prompts on schema mismatch and returns NOTHING when the retry
    // budget runs out. Both break response-first persistence: content would drive retries, and
    // a schema-violating response — a normal excluded result under Gemini — would vanish.
    expect(args).not.toContain('--json-schema');
  });

  it('never uses --bare or a model fallback', () => {
    // --bare cannot read OAuth, so it cannot authenticate a subscription; --fallback-model
    // would silently answer with a model the record does not name.
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--fallback-model');
  });

  it('requests the JSON result envelope for the pinned model', () => {
    expect(args).toContain('--print');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5');
  });
});

describe('the child environment is an allow-list, not an inheritance', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    GEMINI_API_KEY: 'gemini-primary',
    GEMINI_FALLBACK_API_KEY: 'gemini-fallback',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    GITHUB_TOKEN: 'gh-token',
    JURYPRESS_ISSUE_TOKEN: 'issue-token',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-pass'
  } as NodeJS.ProcessEnv;

  const child = buildClaudeChildEnv(parent);

  it('passes only the credential this process needs', () => {
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
  });

  it('withholds every other secret the pipeline happens to hold', () => {
    // Structural, not procedural: a prompt injection cannot exfiltrate a variable the process
    // was never given, whatever it manages to talk the model into.
    for (const key of [
      'GEMINI_API_KEY', 'GEMINI_FALLBACK_API_KEY', 'CLOUDFLARE_API_TOKEN',
      'GITHUB_TOKEN', 'JURYPRESS_ISSUE_TOKEN'
    ]) {
      expect(child[key]).toBeUndefined();
    }
    expect(Object.values(child)).not.toContain('cf-token');
    expect(Object.values(child)).not.toContain('gh-token');
  });

  it('drops ANTHROPIC_API_KEY so a stray key cannot move the run onto metered billing', () => {
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('turns off telemetry, error reporting and the autoupdater', () => {
    expect(child.DISABLE_TELEMETRY).toBe('1');
    expect(child.DISABLE_ERROR_REPORTING).toBe('1');
    expect(child.DISABLE_AUTOUPDATER).toBe('1');
    expect(child.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });
});

describe('the wrapper instruction is transport plumbing, not editorial guidance', () => {
  it('states the untrusted-input boundary the brief requires', () => {
    const wrapper = CLAUDE_WRAPPER_SYSTEM_PROMPT.toLowerCase();
    expect(wrapper).toContain('never instruction');
    expect(wrapper).toContain('do not use tools');
    expect(wrapper).toContain('environment variable');
    expect(wrapper).toContain('ignore previous instructions');
    expect(wrapper).toContain('do not read, write, create or modify any file');
  });

  it('expresses no editorial opinion whatsoever', () => {
    // The editorial prompt is the variable under test. Anything here that shaped persona, tone
    // or judgment would change what is being compared while claiming only the provider moved.
    //
    // The instruction half is checked in isolation: the UNTRUSTED INPUT half necessarily names
    // things like "change a score" and "external article text", because naming the attack is
    // how it is refused. Those are descriptions of hostile input, not direction to the writer.
    const wrapper = CLAUDE_WRAPPER_SYSTEM_PROMPT.toLowerCase();
    const untrustedAt = wrapper.indexOf('untrusted input');
    expect(untrustedAt).toBeGreaterThan(-1);
    const instructions = wrapper.slice(0, untrustedAt);

    for (const editorialWord of [
      'persona', 'judge', 'jury', 'rubric', 'criteri', 'score', 'verdict', 'headline',
      'article', 'review', 'critical', 'concise', 'tone', 'voice', 'audience'
    ]) {
      expect(instructions).not.toContain(editorialWord);
    }

    // And the mentions that do exist appear only as refused input, never as guidance.
    expect(wrapper.slice(untrustedAt)).toContain('change a score');
    expect(wrapper.slice(untrustedAt)).toContain('external article text');
  });

  it('passes the editorial prompt through byte-for-byte', () => {
    const built = buildClaudeUserPrompt(REQUEST);
    expect(built).toContain(REQUEST.prompt);
    // The schema travels as text because --json-schema is unusable here.
    expect(built).toContain(JSON.stringify(REQUEST.jsonSchema));
  });
});

describe('failure classification never judges content', () => {
  it('treats auth, model and request errors as terminal', () => {
    expect(classifyClaudeFailure({
      exitCode: 1, timedOut: false, spawnFailed: false, stderr: 'OAuth token expired'
    })).toEqual({ category: 'AUTHENTICATION_FAILED', retryable: false });
    expect(classifyClaudeFailure({
      exitCode: 1, timedOut: false, spawnFailed: false, stderr: 'model_not_found'
    }).retryable).toBe(false);
    expect(classifyClaudeFailure({
      exitCode: null, timedOut: false, spawnFailed: true, stderr: ''
    })).toEqual({ category: 'CLI_NOT_AVAILABLE', retryable: false });
  });

  it('treats limits, outages and timeouts as retryable', () => {
    expect(classifyClaudeFailure({
      exitCode: 1, timedOut: false, spawnFailed: false, stderr: 'usage limit reached'
    })).toEqual({ category: 'USAGE_LIMIT_REACHED', retryable: true });
    expect(classifyClaudeFailure({
      exitCode: 1, timedOut: false, spawnFailed: false, stderr: 'overloaded'
    }).retryable).toBe(true);
    expect(classifyClaudeFailure({
      exitCode: null, timedOut: true, spawnFailed: false, stderr: ''
    })).toEqual({ category: 'TIMEOUT', retryable: true });
  });

  it('has no classification a response body could ever reach', () => {
    // The whole function takes process-level facts. There is no `content` parameter, so an
    // unparseable or schema-violating response is structurally incapable of causing a retry.
    const source = readFileSync('src/lib/evaluation/claude-code-transport.ts', 'utf8');
    const signature = source.slice(
      source.indexOf('export function classifyClaudeFailure'),
      source.indexOf('}): { category: string; retryable: boolean }')
    );
    for (const forbidden of ['rawResponse', 'parsed', 'content', 'schema']) {
      expect(signature).not.toContain(forbidden);
    }
  });
});

describe('metadata is read, never invented', () => {
  it('reports the served model only when exactly one was used', () => {
    expect(readClaudeModelUsed({ modelUsage: { 'claude-opus-5-20260101': {} } }))
      .toBe('claude-opus-5-20260101');
    expect(readClaudeModelUsed({})).toBeNull();
    expect(readClaudeModelUsed({ modelUsage: {} })).toBeNull();
    // Two models means there is no single answer; guessing one would be provenance fiction.
    expect(readClaudeModelUsed({ modelUsage: { a: {}, b: {} } })).toBeNull();
  });

  it('keeps unreported token counts null rather than zero', () => {
    expect(readClaudeTokenUsage({})).toEqual({
      inputTokens: null, outputTokens: null, thinkingTokens: null,
      totalTokens: null, cachedInputTokens: null
    });
    expect(readClaudeTokenUsage({ usage: { input_tokens: 10 } })).toEqual({
      inputTokens: 10, outputTokens: null, thinkingTokens: null,
      // No total is derived from half a measurement.
      totalTokens: null, cachedInputTokens: null
    });
  });

  it('derives a total only from counts that were actually reported', () => {
    expect(readClaudeTokenUsage({
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7 }
    })).toEqual({
      inputTokens: 100, outputTokens: 50, thinkingTokens: null,
      totalTokens: 150, cachedInputTokens: 7
    });
  });

  it('never reports a thinking-token count Claude Code does not publish', () => {
    expect(readClaudeTokenUsage({ usage: { input_tokens: 1, output_tokens: 1 } }).thinkingTokens)
      .toBeNull();
  });
});

describe('timeout resolution', () => {
  it('falls back to the default for absent or nonsensical values', () => {
    expect(resolveClaudeTimeoutMs({})).toBe(900_000);
    expect(resolveClaudeTimeoutMs({ JURYPRESS_CLAUDE_TIMEOUT_MS: 'soon' })).toBe(900_000);
    expect(resolveClaudeTimeoutMs({ JURYPRESS_CLAUDE_TIMEOUT_MS: '-1' })).toBe(900_000);
    expect(resolveClaudeTimeoutMs({ JURYPRESS_CLAUDE_TIMEOUT_MS: '60000' })).toBe(60_000);
  });
});

describe('transport failure is a real failure, never a fallback', () => {
  it('throws rather than returning an empty response when the CLI cannot run', async () => {
    const transport = new ClaudeCodeTransport({
      binary: '/nonexistent/claude-binary-for-tests',
      env: { NODE_ENV: 'test', CLAUDE_CODE_OAUTH_TOKEN: 't' }
    });

    // No response was obtained, so there is nothing to persist and nothing to judge. The
    // reservation survives and the run resumes later — it never routes to Gemini.
    await expect(transport.generate({ ...REQUEST, maxAttempts: { primary: 1, fallback: 1 } }))
      .rejects.toThrow(ClaudeCodeTransportError);
  });

  it('cannot reach the Gemini transport even if something asked it to', () => {
    const source = readFileSync('src/lib/evaluation/claude-code-transport.ts', 'utf8');
    const imports = source.match(/^\s*import[\s\S]*?from\s+'[^']+';/gm)?.join('\n') ?? '';
    expect(imports).not.toMatch(/gemini/i);
    expect(source).not.toContain('generateWithFailover');
    expect(source).not.toContain('GoogleGenAI');
    expect(CLAUDE_CODE_ENGINE_VERSION).toBe('claude-code-transport-v1');
  });
});
