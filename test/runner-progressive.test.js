const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createProgressiveTriage } = require('../src/services/triage/progressive');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const good = () => ({ decisions: [{ decision: 'accept', blockers: [], archiveFindings: [{ status: 'segment-ok' }] }] });

// Exercise the real runner/scheduler/coordinator. Inject only network/storage
// dependencies so these tests cannot make indexer or NNTP requests.
function loadRunner(check) {
  const filename = require.resolve('../src/services/triage/runner');
  const failNetwork = () => { throw new Error('Unexpected network request'); };
  const dependencies = {
    axios: { get: failNetwork },
    './index': { triageNzbs: check },
    '../../utils/userAgent': { getDefaultDownloadUserAgent: () => 'test' },
    '../newznab': { getDownloadUserAgentForIndexer: () => null, getProxyForIndexer: () => '' },
    '../indexer': { getManagerProxy: () => '' },
    '../../utils/proxyAgent': { proxiedGet: failNetwork },
    '../../cache/diskNzbCache': { getFromDisk: () => null },
  };
  const original = Module._load;
  Module._load = function(request, parent, ...args) {
    if (parent?.filename === filename && Object.hasOwn(dependencies, request)) return dependencies[request];
    return original.call(this, request, parent, ...args);
  };
  try {
    delete require.cache[filename];
    return require(filename).triageAndRank;
  } finally {
    Module._load = original;
    delete require.cache[filename];
  }
}
function release(id, resolution, size) {
  return { downloadUrl: `https://example.invalid/${id}`, title: `Movie ${id} ${resolution}`, resolution, size };
}
function options(releases, extra = {}) {
  return {
    timeBudgetMs: 1000, maxCandidates: releases.length, downloadConcurrency: 2,
    foregroundResolutions: ['4k', '1080p'],
    nzbPayloadCache: new Map(releases.map(candidate => [candidate.downloadUrl, candidate.downloadUrl])),
    ...extra,
  };
}

test('real runner gives each resolution a worker and retries the missing choice before more verified-quality alternatives', async () => {
  const releases = [release('uhd-a', '2160p', 100), release('uhd-b', '2160p', 90),
    release('hd-a', '1080p', 50), release('hd-b', '1080p', 40), release('sd', '720p', 20)];
  const gates = new Map(releases.map(candidate => [candidate.downloadUrl, deferred()]));
  const started = [];
  let active = 0, maxActive = 0;
  const runner = loadRunner(async ([payload]) => {
    started.push(payload);
    maxActive = Math.max(maxActive, ++active);
    try { return await gates.get(payload).promise; } finally { active--; }
  });
  const { job } = createProgressiveTriage(runner).start('two-resolutions', releases, options(releases));
  let returned = false;
  job.foreground.then(() => { returned = true; });
  await tick();
  assert.deepEqual(started, [releases[0].downloadUrl, releases[2].downloadUrl]);
  gates.get(releases[0].downloadUrl).resolve(good());
  await tick();
  assert.equal(started[2], releases[3].downloadUrl);
  assert.equal(returned, false);
  gates.get(releases[2].downloadUrl).resolve({ decisions: [{ decision: 'reject', blockers: ['missing-pieces'] }] });
  await tick();
  assert.equal(returned, false);
  gates.get(releases[3].downloadUrl).resolve(good());
  const early = await job.foreground;
  assert.equal(early.inProgress, true);
  assert.equal(early.decisions.get(releases[0].downloadUrl).status, 'verified');
  assert.equal(early.decisions.get(releases[3].downloadUrl).status, 'verified');
  assert.equal(early.decisions.get(releases[2].downloadUrl).status, 'blocked');
  assert.equal(job.done, false);
  assert.equal(maxActive, 2);
  for (const gate of gates.values()) gate.resolve(good());
  assert.equal((await job.completion).evaluatedCount, releases.length);
});

test('runner keeps a 1080p candidate inside its own cap despite many larger 4K releases', async () => {
  const releases = Array.from({ length: 20 }, (_, i) => release(`uhd-${i}`, '4k', 100 - i));
  releases.push(release('hd', '1080p', 10));
  const started = [];
  const runner = loadRunner(async ([payload]) => { started.push(payload); return good(); });
  const result = await runner(releases, options(releases, { maxCandidates: 2 }));
  assert.deepEqual(started, [releases[0].downloadUrl, releases.at(-1).downloadUrl]);
  assert.equal(result.candidatesConsidered, 2);
});

test('a stalled resolution cannot hold the response past the existing triage budget', async () => {
  const releases = [release('uhd', '4k', 100), release('hd', '1080p', 50)];
  const stalled = deferred();
  const runner = loadRunner(async ([payload]) => payload === releases[0].downloadUrl ? stalled.promise : good());
  const { job } = createProgressiveTriage(runner).start('deadline', releases, options(releases, { timeBudgetMs: 40 }));
  const result = await job.foreground;
  assert.equal(result.timedOut, true);
  assert.equal(result.decisions.get(releases[0].downloadUrl).status, 'error');
  assert.equal(result.decisions.get(releases[1].downloadUrl).status, 'verified');
  assert.equal(job.done, true);
  stalled.resolve(good());
});

test('a title offering only 1080p returns after one verified choice while its alternate keeps running', async () => {
  const releases = [release('hd-a', '1080p', 50), release('hd-b', '1080p', 40)];
  const alternate = deferred();
  const runner = loadRunner(async ([payload]) => payload === releases[0].downloadUrl ? good() : alternate.promise);
  const { job } = createProgressiveTriage(runner).start('hd-only', releases,
    options(releases, { foregroundResolutions: ['1080p'] }));
  assert.equal((await job.foreground).inProgress, true);
  assert.equal(job.done, false);
  alternate.resolve(good());
  await job.completion;
});

test('four workers balance two candidates per resolution and return before a stalled first candidate', async () => {
  const releases = [release('uhd-a', '4k', 100), release('uhd-b', '4k', 90),
    release('uhd-c', '4k', 80), release('hd-a', '1080p', 50), release('hd-b', '1080p', 40)];
  const gates = new Map(releases.map(candidate => [candidate.downloadUrl, deferred()]));
  const started = [];
  let active = 0, maxActive = 0;
  const runner = loadRunner(async ([payload]) => {
    started.push(payload); maxActive = Math.max(maxActive, ++active);
    try { return await gates.get(payload).promise; } finally { active--; }
  });
  const { job } = createProgressiveTriage(runner).start('four-workers', releases,
    options(releases, { downloadConcurrency: 4 }));
  await tick();
  assert.deepEqual(started, [releases[0], releases[3], releases[1], releases[4]].map(candidate => candidate.downloadUrl));
  gates.get(releases[1].downloadUrl).resolve(good());
  gates.get(releases[4].downloadUrl).resolve(good());
  const early = await job.foreground;
  assert.equal(early.decisions.get(releases[1].downloadUrl).status, 'verified');
  assert.equal(early.decisions.get(releases[4].downloadUrl).status, 'verified');
  assert.equal(early.decisions.has(releases[0].downloadUrl), false);
  assert.equal(job.done, false);
  assert.equal(maxActive, 4);
  for (const gate of gates.values()) gate.resolve(good());
  await job.completion;
});

test('four candidates include two of each resolution inside the runner candidate cap', async () => {
  const releases = Array.from({ length: 20 }, (_, i) => release(`uhd-${i}`, '4k', 100 - i));
  releases.push(release('hd-a', '1080p', 10), release('hd-b', '1080p', 9));
  const seen = [];
  const runner = loadRunner(async ([payload]) => { seen.push(payload); return good(); });
  await runner(releases, options(releases, { downloadConcurrency: 4, maxCandidates: 4 }));
  assert.deepEqual(new Set(seen), new Set([releases[0], releases[1], releases.at(-2), releases.at(-1)].map(candidate => candidate.downloadUrl)));
});
