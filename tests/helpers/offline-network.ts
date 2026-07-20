/**
 * Preloaded into run-daily subprocesses (`node --import tsx --import <this>`) to make the
 * "no network" assumption of the integration tests explicit instead of environmental.
 *
 * These tests assert what the pipeline does when an outbound call cannot be made — the
 * selector re-running and failing, Gemini never being reached. They used to get that from
 * the sandbox simply having no route out, which made their runtime depend on how long a real
 * connection took to give up: the candidate-less selection test took ~6s and blew vitest's
 * 5s default, and on a runner with a route out and a GITHUB_TOKEN the selector would have
 * reached the live GitHub API and asserted something else entirely.
 *
 * Failing the call here instead makes it instant and identical everywhere. The rejection
 * mimics undici's shape for an unreachable host, so callers that discriminate on network
 * errors take the same branch they take against a real offline socket.
 */
const offline = () => {
  const error = new TypeError('fetch failed');
  (error as { cause?: unknown }).cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo'
  });
  return Promise.reject(error);
};

globalThis.fetch = offline as unknown as typeof globalThis.fetch;

/**
 * EvidenceCollector.safeFetch does not use fetch — it drives node's http/https directly — so
 * stubbing fetch alone left it free to reach the real network from a test run. That was
 * survivable only because the selector failed first and collection never started; adding any
 * new outbound call to the collector would have made the tests hit live sites.
 *
 * The stub emits ENOTFOUND on the request object, which is the shape safeFetch's error
 * handler already expects, so it takes the same branch as a genuinely unreachable host.
 */
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

// Loaded through createRequire, not `import * as http`: an ESM namespace object is frozen,
// so the properties cannot be replaced. The CommonJS exports object is the same object the
// collector's own `import http from 'http'` resolves to, and it is writable.
const nodeRequire = createRequire(import.meta.url);

function offlineRequest(): unknown {
  const request = new EventEmitter();
  Object.assign(request, {
    end: () => {},
    destroy: () => {},
    setTimeout: () => {},
    write: () => {}
  });
  setImmediate(() => {
    request.emit(
      'error',
      Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo'
      })
    );
  });
  return request;
}

for (const moduleName of ['node:http', 'node:https']) {
  const mod = nodeRequire(moduleName) as Record<string, unknown>;
  mod.request = offlineRequest;
  mod.get = offlineRequest;
}
