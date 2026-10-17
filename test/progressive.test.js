const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgressiveTriage, mergeCompletedDecisions } = require('../src/services/triage/progressive');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const candidates = [
  { downloadUrl: 'https://example.invalid/a', title: 'Movie A', size: 100 },
  { downloadUrl: 'https://example.invalid/b', title: 'Movie B', size: 90 },
];
const outcome = decisions => ({ decisions, elapsedMs: 20, evaluatedCount: decisions.size, candidatesConsidered: 2, timedOut: false });

test('cold response waits for actual verification and leaves slower checks running', async () => {
  const rest = deferred();
  let callback;
  const coordinator = createProgressiveTriage(async (_, options) => {
    callback = options.onDecision;
    await rest.promise;
    return outcome(new Map([
      [candidates[0].downloadUrl, { status: 'verified' }],
      [candidates[1].downloadUrl, { status: 'blocked' }],
    ]));
  });
  const { job } = coordinator.start('movie:one', candidates, {});
  let returned = false;
  job.foreground.then(() => { returned = true; });
  await tick();
  for (const status of ['pending', 'unverified', 'fetch-error', 'unverified_7z', 'blocked']) {
    callback(candidates[0].downloadUrl, { status });
    await tick();
    assert.equal(returned, false, `${status} must not look ready`);
  }
  callback(candidates[0].downloadUrl, { status: 'verified', nzbPayload: 'metadata' });
  const early = await job.foreground;
  assert.equal(early.inProgress, true);
  assert.equal(early.decisions.get(candidates[0].downloadUrl).status, 'verified');
  assert.equal(job.done, false);
  rest.resolve();
  assert.equal((await job.completion).decisions.get(candidates[1].downloadUrl).status, 'blocked');
});

test('equivalent concurrent requests share both metadata fetching and checks', async () => {
  const finish = deferred();
  let calls = 0;
  const coordinator = createProgressiveTriage(async () => { calls++; await finish.promise; return outcome(new Map()); });
  const first = coordinator.start('profile:one:movie', candidates, { timeBudgetMs: 15 });
  const second = coordinator.start('profile:one:movie', candidates, { timeBudgetMs: 15 });
  assert.equal(first.joined, false);
  assert.equal(second.joined, true);
  assert.equal(first.job, second.job);
  await tick();
  assert.equal(calls, 1);
  finish.resolve();
  await first.job.completion;
  const next = coordinator.start('profile:one:movie', candidates, { timeBudgetMs: 15 });
  assert.equal(next.joined, false);
  await next.job.completion;
});

test('profiles, release identities and health policies never share an active job', async () => {
  const finish = deferred();
  const coordinator = createProgressiveTriage(async () => { await finish.promise; return outcome(new Map()); });
  const first = coordinator.start('profile:one', candidates, { triageOptions: { statSampleCount: 8 } });
  const profile = coordinator.start('profile:two', candidates, { triageOptions: { statSampleCount: 8 } });
  const policy = coordinator.start('profile:one', candidates, { triageOptions: { statSampleCount: 16 } });
  const differentRelease = coordinator.start('profile:one', [{ ...candidates[0], publishDateMs: 123 }], { triageOptions: { statSampleCount: 8 } });
  assert.equal(profile.joined, false);
  assert.equal(policy.joined, false);
  assert.equal(differentRelease.joined, false);
  assert.equal(new Set([first.job.id, profile.job.id, policy.job.id, differentRelease.job.id]).size, 4);
  finish.resolve();
  await Promise.all([first.job, profile.job, policy.job, differentRelease.job].map(job => job.completion));
});

test('a warm response can read progress immediately while work remains pending', async () => {
  const finish = deferred();
  const coordinator = createProgressiveTriage(async () => { await finish.promise; return outcome(new Map()); });
  const { job } = coordinator.start('warm', candidates, {});
  assert.equal(job.snapshot().inProgress, true);
  assert.equal(job.snapshot().decisions.size, 0);
  assert.equal(job.done, false);
  finish.resolve();
  await job.completion;
});

test('a cached response resumes the original run even after its verified candidates are removed from pending', async () => {
  const finish = deferred();
  let callback, calls = 0;
  const coordinator = createProgressiveTriage(async (_, options) => {
    calls++;
    callback = options.onDecision;
    await finish.promise;
    return outcome(new Map());
  });
  const { job } = coordinator.start('profile:one', candidates, {});
  await tick();
  callback(candidates[0].downloadUrl, { status: 'verified' });
  await job.foreground;
  const resumed = coordinator.get(job.id, 'profile:one');
  assert.equal(resumed, job);
  assert.equal(resumed.snapshot().inProgress, true);
  assert.equal(calls, 1);
  assert.equal(coordinator.get(job.id, 'profile:two'), null);
  finish.resolve();
  await job.completion;
  assert.equal(coordinator.get(job.id, 'profile:one'), null);
});

test('when nothing verifies, completion preserves the real failures', async () => {
  const decisions = new Map([[candidates[0].downloadUrl, { status: 'blocked' }]]);
  const coordinator = createProgressiveTriage(async (_, options) => {
    options.onDecision(candidates[0].downloadUrl, decisions.get(candidates[0].downloadUrl));
    return outcome(decisions);
  });
  const { job } = coordinator.start('bad', candidates, {});
  assert.equal((await job.foreground).decisions.get(candidates[0].downloadUrl).status, 'blocked');
  assert.equal(job.done, true);
});

test('runner failure releases the shared job and permits a later retry', async () => {
  const coordinator = createProgressiveTriage(async () => { throw new Error('offline'); });
  const first = coordinator.start('fail', candidates, {});
  await assert.rejects(first.job.foreground, /offline/);
  await assert.rejects(first.job.completion, /offline/);
  const retry = coordinator.start('fail', candidates, {});
  assert.equal(retry.joined, false);
  await assert.rejects(retry.job.foreground, /offline/);
});

test('clearing jobs does not let an older completion remove a newer job', async () => {
  const old = deferred(), next = deferred();
  let calls = 0;
  const coordinator = createProgressiveTriage(async () => {
    await (++calls === 1 ? old.promise : next.promise);
    return outcome(new Map());
  });
  const first = coordinator.start('config', candidates, {});
  await tick();
  coordinator.clear();
  const second = coordinator.start('config', candidates, {});
  await tick();
  old.resolve();
  await first.job.completion;
  assert.equal(coordinator.start('config', candidates, {}).job, second.job);
  next.resolve();
  await second.job.completion;
});

function cacheMeta() {
  return {
    version: 1,
    triageRunId: 7,
    finalNzbResults: candidates,
    triageDecisionsSnapshot: [[candidates[0].downloadUrl, { status: 'verified' }]],
    triagePendingDownloadUrls: [candidates[1].downloadUrl],
    triageComplete: false,
  };
}

test('completion patches the right response, never stores payload bytes, and clears only final decisions', () => {
  const meta = cacheMeta();
  const decisions = new Map([[candidates[1].downloadUrl, { status: 'verified', nzbPayload: 'large private metadata' }]]);
  assert.equal(mergeCompletedDecisions(meta, 7, decisions), true);
  assert.equal(meta.triageComplete, true);
  assert.deepEqual(meta.triagePendingDownloadUrls, []);
  assert.equal(new Map(meta.triageDecisionsSnapshot).get(candidates[1].downloadUrl).nzbPayload, undefined);
});

test('inconclusive completion remains pending; old results cannot overwrite final proof', () => {
  const meta = cacheMeta();
  const decisions = new Map([
    [candidates[0].downloadUrl, { status: 'blocked' }],
    [candidates[1].downloadUrl, { status: 'unverified' }],
    ['https://example.invalid/stale', { status: 'verified' }],
  ]);
  mergeCompletedDecisions(meta, 7, decisions);
  const saved = new Map(meta.triageDecisionsSnapshot);
  assert.equal(saved.get(candidates[0].downloadUrl).status, 'verified');
  assert.equal(saved.get(candidates[1].downloadUrl).status, 'unverified');
  assert.equal(saved.has('https://example.invalid/stale'), false);
  assert.equal(meta.triageComplete, false);
});

test('completion from a previous response generation cannot patch a replacement', () => {
  const meta = cacheMeta(), original = structuredClone(meta);
  assert.equal(mergeCompletedDecisions(meta, 6, new Map()), false);
  assert.deepEqual(meta, original);
});
