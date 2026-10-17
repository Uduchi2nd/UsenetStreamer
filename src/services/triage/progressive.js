const crypto = require('crypto');
const { sanitizeDecisionForCache, isTriageFinalStatus } = require('../../utils/helpers');

// Keep the complete check running, but allow a response after a genuinely
// verified release is available. Equivalent concurrent requests share the work.
function createProgressiveTriage(runTriage, now = Date.now) {
  const active = new Map();
  let nextId = 0;

  function start(scope, candidates, options) {
    const { logger, onDecision, nzbPayloadCache, ...policy } = options;
    const key = crypto.createHash('sha256').update(JSON.stringify({
      scope,
      candidates: candidates.map(candidate => ({
        url: candidate.downloadUrl,
        title: candidate.title,
        size: candidate.size,
        indexerId: candidate.indexerId,
        indexer: candidate.indexer,
        published: candidate.publishDateMs,
      })),
      policy,
    })).digest('hex');
    const existing = active.get(key);
    if (existing) return { job: existing, joined: true };

    const decisions = new Map();
    const startedAt = now();
    let resolveVerified;
    const firstVerified = new Promise(resolve => { resolveVerified = resolve; });
    const job = {
      id: ++nextId,
      scope,
      done: false,
      result: null,
      snapshot() {
        if (job.done && job.result) return job.result;
        return {
          decisions: new Map(decisions),
          elapsedMs: now() - startedAt,
          timedOut: false,
          inProgress: true,
          candidatesConsidered: candidates.length,
          evaluatedCount: [...decisions.values()].filter(decision =>
            ['verified', 'blocked', 'unverified', 'unverified_7z'].includes(decision.status)).length,
        };
      },
    };
    active.set(key, job);
    job.completion = Promise.resolve().then(() => runTriage(candidates, {
      ...options,
      onDecision(url, decision) {
        decisions.set(url, decision);
        if (onDecision) {
          try { onDecision(url, decision); } catch (_) { /* same behavior as runner */ }
        }
        // Mounted, skipped, timed out, and inconclusive releases cannot release
        // the foreground wait. Only the runner's full verification can do so.
        if (decision.status === 'verified') resolveVerified(job.snapshot());
      },
    })).then(result => {
      job.result = result;
      job.done = true;
      return result;
    }, error => {
      job.done = true;
      throw error;
    });
    job.foreground = Promise.race([firstVerified, job.completion]);
    // A request with an existing verified release does not await foreground.
    // Attach a handler while leaving the original promise rejectable to callers.
    job.foreground.catch(() => {});
    const forget = () => {
      if (active.get(key) === job) active.delete(key);
    };
    job.completion.then(forget, forget);
    return { job, joined: false };
  }

  function get(id, scope) {
    for (const job of active.values()) {
      if (job.id === id && job.scope === scope && !job.done) return job;
    }
    return null;
  }
  return { start, get, clear: () => active.clear() };
}

// An old completion must not modify a replacement cache entry or overwrite a
// newer final decision. Keep unresolved releases pending for subsequent retries.
function mergeCompletedDecisions(meta, jobId, decisions) {
  if (!meta || meta.version !== 1 || meta.triageRunId !== jobId) return false;
  const eligible = new Set((meta.finalNzbResults || []).map(result => result.downloadUrl));
  const merged = new Map(meta.triageDecisionsSnapshot || []);
  for (const [url, decision] of decisions) {
    if (!eligible.has(url) || isTriageFinalStatus(merged.get(url)?.status)) continue;
    const sanitized = sanitizeDecisionForCache(decision);
    if (sanitized) merged.set(url, sanitized);
  }
  meta.triageDecisionsSnapshot = [...merged];
  meta.triagePendingDownloadUrls = (meta.triagePendingDownloadUrls || [])
    .filter(url => !isTriageFinalStatus(merged.get(url)?.status));
  meta.triageComplete = meta.triagePendingDownloadUrls.length === 0;
  return true;
}

module.exports = { createProgressiveTriage, mergeCompletedDecisions };
