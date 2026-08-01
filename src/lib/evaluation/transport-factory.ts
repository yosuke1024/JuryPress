import { GeminiTransport } from './gemini-transport';
import { ClaudeCodeTransport } from './claude-code-transport';
import { LlmProviderConfigurationError, type LlmProvider, type LlmTransport } from './llm-transport';

/**
 * Maps a resolved provider to its transport.
 *
 * Separate from llm-transport.ts so the contract module — the types, the provider resolution and
 * the credential preflight — stays importable without pulling in either implementation, and so
 * neither implementation ends up importing the module that constructs it.
 *
 * The provider is decided once, at the start of a run, and recorded on the generation record.
 * Nothing downstream may re-resolve it: a run's provider is fixed for the life of that run, and
 * a failure in one provider never routes to the other.
 */
export function createTransport(provider: LlmProvider): LlmTransport {
  switch (provider) {
    case 'gemini':
      return new GeminiTransport();
    case 'anthropic-claude-code':
      return new ClaudeCodeTransport();
    default: {
      // Unreachable given resolveProvider()'s fail-closed check, kept so a future enum member
      // added without a transport fails loudly instead of defaulting to Gemini.
      const unhandled: never = provider;
      throw new LlmProviderConfigurationError(`No transport is registered for provider "${unhandled}".`);
    }
  }
}
