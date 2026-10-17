const crypto = require('crypto');
const { sanitizeDecisionForCache, isTriageFinalStatus } = require('../../utils/helpers');
const { normalizeResolutionToken } = require('../../utils/parsers');

const FOREGROUND_RESOLUTIONS = ['4k', '1080p'];

function getReleaseResolution(candidate) {
  const result = candidate?.result || candidate || {};
  const match = result.title?.match(/(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|8k|4k|uhd)/i);
  const token = result.resolution || result.release?.resolution || match?.[0];
  return token ? normalizeResolutionToken(String(token).trim()) : null;
}

function getResolutionCoverage(candidates, getStatus) {
  const present = new Set(), verified = new Set();
  let hasVerified = false;
  for (const candidate of candidates) {
    const resolution = getReleaseResolution(candidate);
    if (FOREGROUND_RESOLUTIONS.includes(resolution)) present.add(resolution);
    if (getStatus(candidate) === 'verified') {
      hasVerified = true;
      verified.add(resolution);
    }
  }
  const missing = FOREGROUND_RESOLUTIONS.filter(resolution => present.has(resolution) && !verified.has(resolution));
  return { missing, ready: hasVerified && missing.length === 0 };
}

// Reserve a place for each requested resolution before applying existing
// candidate/indexer limits. Preserve the original order for the other releases.
function prioritizeResolutionCandidates(candidates, resolutions, concurrency = resolutions.length) {
  const remaining = candidates.slice(), first = [];
  const rounds = Math.ceil(concurrency / Math.max(1, resolutions.length));
  for (let round = 0; round < rounds; round++) {
    for (const resolution of resolutions) {
      const index = remaining.findIndex(candidate => getReleaseResolution(candidate) === resolution);
      if (index >= 0) first.push(...remaining.splice(index, 1));
    }
  }
  return [...first, ...remaining];
}

// Balance active candidates across missing resolutions, so extra workers try
// two of each rather than filling every spare slot with more 4K releases.
// Once a resolution verifies, focus spare workers on the remaining gaps.
function createResolutionQueue(candidates, resolutions) {
  const pending = candidates.slice(), active = new Map(), verified = new Set();
  return {
    next() {
      if (!pending.length) return null;
      const missing = resolutions.filter(resolution => !verified.has(resolution));
      const available = missing.filter(resolution => pending.some(candidate => getReleaseResolution(candidate) === resolution));
      const leastActive = Math.min(...available.map(resolution => active.get(resolution) || 0));
      const preferred = available.filter(resolution => (active.get(resolution) || 0) === leastActive);
      let index = pending.findIndex(candidate => preferred.includes(getReleaseResolution(candidate)));
      if (index < 0) index = 0;
      const [candidate] = pending.splice(index, 1);
      const resolution = getReleaseResolution(candidate);
      active.set(resolution, (active.get(resolution) || 0) + 1);
      return candidate;
    },
    complete(candidate, status) {
      const resolution = getReleaseResolution(candidate);
      active.set(resolution, Math.max(0, (active.get(resolution) || 0) - 1));
      if (status === 'verified') verified.add(resolution);
    },
  };
}

// Keep the complete check running, but allow a response after a genuinely
// verified release of each requested resolution is available.
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
        resolution: getReleaseResolution(candidate),
      })),
      policy,
    })).digest('hex');
    const existing = active.get(key);
    if (existing) return { job: existing, joined: true };

    const decisions = new Map();
    const candidatesByUrl = new Map(candidates.map(candidate => [candidate.downloadUrl, candidate]));
    const verifiedResolutions = new Set();
    const requiredResolutions = options.foregroundResolutions || [];
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
        if (decision.status === 'verified') {
          verifiedResolutions.add(getReleaseResolution(candidatesByUrl.get(url)));
          if (requiredResolutions.every(resolution => verifiedResolutions.has(resolution))) {
            resolveVerified(job.snapshot());
          }
        }
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

module.exports = {
  createProgressiveTriage, mergeCompletedDecisions, getReleaseResolution,
  getResolutionCoverage, prioritizeResolutionCandidates, createResolutionQueue,
};
