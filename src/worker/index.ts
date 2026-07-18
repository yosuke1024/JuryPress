import { handleReviewRequestApi, type ReviewRequestWorkerEnv } from './review-requests';

/**
 * Worker entrypoint. `run_worker_first` limits invocation to /jurypress/api/*, so the
 * static site keeps its pure-assets serving path; the fallthrough to ASSETS below only
 * matters for requests that reach the worker anyway (e.g. workers.dev traffic).
 */
const API_PATH = '/jurypress/api/review-requests';
const API_PREFIX = '/jurypress/api/';

export default {
  async fetch(request: Request, env: ReviewRequestWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === API_PATH) {
      return handleReviewRequestApi(request, env);
    }

    if (url.pathname.startsWith(API_PREFIX)) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // Never handle non-API requests in the worker: delegate straight to static assets.
    return env.ASSETS.fetch(request);
  }
};
