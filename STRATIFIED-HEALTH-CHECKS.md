# 30% whole-file screening

Based on upstream v1.8.4. This patch is in UsenetStreamer, not Remux or vnphim.

## Behavior
For each recognized video/ISO/archive file, sort NZB articles by segment number, deduplicate IDs, then select ceil(30% of articles). Divide the whole ordered file into that many disjoint, evenly spaced sections and choose one random article from each. This covers beginning, middle and end; it is not a prefix download. PAR2/NFO and other ancillary files are excluded. Multipart archive parts are each sampled; existing archive format/header checks remain.

STAT requests use batches of 128 on an exclusively leased existing NNTP connection. The configured two-connection pool remains in use. A positive result requires every selected article to return223 with the expected message ID.430 marks missing; drain the current batch and reject early. Timeout, unexpected response or transport error returns sample-incomplete/unverified, never verified. Sampling has a12-second network deadline after pool acquisition; the existing acquire and outer triage deadlines still apply. No video BODY download is added by this sampler; existing archive header inspection may still fetch data.

The pinned nntp0.3.1 library serializes commands. The sampler takes over only an idle leased socket, then destroys/replaces it even on success so its parser cannot consume stale pipeline replies. This avoids a second connection pool. Updating the NNTP library requires revisiting this adapter.

Completed history jobs now enter normal triage rather than bypassing it. Completed search results without a verified decision are withheld; they are no longer seeded directly into Smart Play. This applies to normal search listings, not manually opened history-library links or previously saved playback URLs. Existing unverified non-history candidate behavior remains. The stream-cache namespace is bumped so old8-piece decisions are not reused. Upstream candidate/time/indexer budgets and primary-provider choice remain in force.

## Original deployment and verification — 2026-09-22
Build: podman build -f Containerfile.stratified -t localhost/usenetstreamer:stratified30-v1 .
Base image is pinned by digest to the previous production1.8.4 image. Only server.js and the two triage modules are overlaid. Seven focused node tests passed (`node --test test/stratified.test.js`): section coverage, duplicate IDs, fragmented replies, batched early rejection, unexpected status/identity, timeout cleanup, and leased-client disposal.

Real patched-engine tests on2026-09-22:
- E12 HHWEB: accepted618/618 selected pieces,0missing,0.532s.
- E14 AilMWeb: rejected after32/307 selected pieces,15missing,0.537s.
- E13 PTerWEB: rejected after32/2016 selected pieces,10missing,0.270s.
Missing counts are within checked samples, not total missing articles.
Fresh authenticated live addon listing: E12 retained healthy HHWEB(4.886s); E13 andE14 returned no Usenet streams(4.338/4.571s), excluding broken completed entries. Downstream AIOStreams/Remux/client caches may retain old listings until refreshed.

Container image ID:3b5dccbf506cb2fe17bf34b436f2f558c5b0ed5538e369477d43645489330e7c.
Canonical checkout on nimo:/root/usenetstreamer-fork. Seedbox build tree:~/usenet/stratified-build. Runtime image and ~/usenet/recreate-pod.sh updated. Health check now authenticates the protected manifest using existing environment credentials; uncredentialed manifest returns401. First deployment rolled back because its probe omitted authentication, not because the image crashed. Authenticated readiness and podman healthcheck pass after correction.

Rollback: stop/rename current usenetstreamer, rename preserved usenetstreamer-pre-stratified30 back to usenetstreamer and start it; restore image reference from ~/usenet/backups/recreate-pod.pre-stratified30.sh. Keep the corrected authenticated health check. NzbDAV and media data were not changed/deleted. Local image must be rebuilt from this fork when upgrading upstream; the patch is independently removable.

## Limits
30% remains sampling: isolated missing pieces can escape. STAT existence is not proof of readable bodies; the primary provider can lack pieces available on backups. Do not turn timeout into permanent missing-data evidence. This patch does not add automatic playback-failure quarantine or claim complete-file integrity. Diagnostics/raw results live privately under ~/usenet/debug-no-pain; no credentials or article IDs are committed.

## Progressive responses — 2026-10-17

Blocking mode returns once one release of each available target resolution
(4K and 1080p) passes the existing complete check, while the same batch finishes
checking alternates in the background. Cached verified choices count toward
their own resolution; when both available resolutions are covered, pending
alternates do not block. A title with only one target resolution needs one
verified choice; other resolutions fall back to the first verified choice.
The normal batch completion/deadline still releases the wait if a target has
no successful candidate. Unchecked and inconclusive candidates never count
as verified coverage.

Concurrent equivalent health jobs share their NZB downloads and NNTP work.
Jobs are isolated by profile, candidate identity and health policy. Cached
responses retain pending placeholders and a run ID so a second visit resumes
the original job and its completion can update the correct cache entry. A stale
completion cannot overwrite a replacement response or a newer final decision.
Verified NZB payloads are retained in the existing disk cache; unverified NZBs
are not promoted to that cache. Normal failed-job filtering remains in place.
Hidden ISO/executable releases are excluded before spending health-check work.

The sampler initially grew from 16 to 64 queries over the same connections;
the benchmark below selects 128 for the current build.
Coverage stays at 30%; successful samples still require every selected reply,
including a matching article ID. Missing pieces drain the outstanding batch
before rejecting. This reduces protocol round trips without adding connections.
Active release jobs are bounded by the configured download concurrency and
parallel-NZB limit, currently four. The shared NNTP pool separately caps network
connections at two. Queued archive/header reads finish verification before the
pool starts another queued article scan, avoiding the earlier backlog behind
every candidate's sampling. Candidate and time budgets remain in effect.

The queue balances active candidates across missing target resolutions: with
four jobs and both targets present, two initially try 4K and two try 1080p.
After a resolution verifies, remaining missing resolutions take priority.
Enough representatives for those workers are reserved before the existing
candidate/indexer caps; neither cap is raised.
Renderer labels, cached coverage and worker scheduling use the same resolution
parser, including 2160p/UHD aliases. The runner is now included in the overlay.

Focused checks: `node --test test/stratified.test.js test/progressive.test.js test/runner-progressive.test.js test/nntp-priority.test.js`.
The tests cover proof before early responses, duplicate job sharing, profile
isolation, resuming partial cached responses, runner failures, stale cache
generations, pending decisions, and the sampler's existing protocol guarantees.
Newly verified alternatives appear on a subsequent listing refresh; the HTTP
response already sent to a client is not modified.

Initial first-verified-build checks on 2026-10-17 took 21.441 seconds before
that change and 10.353 seconds with it; subsequent requests took 0.205–0.211
seconds and gained additional verified releases after background completion.
These are individual observations, not a latency guarantee: indexer search
alone took about five seconds. Eighteen focused tests passed on the deployed
image. Hosted addon deadlines still need to cover search plus first verification.

The resolution-aware follow-up passes 26 focused tests, including real runner
integration checks for one worker per missing resolution, retrying failed
1080p candidates before more 4K alternatives, respecting candidate/indexer
caps, returning after one verified choice when only 1080p is present, and
preserving successful results when the other resolution reaches the deadline.

## STAT window benchmark — 2026-10-17

Replayed the same seeded 30% samples from cached verified Infinity Castle
4K/1080p NZBs: 5,463 and 6,148 article IDs respectively. Each trial used two
concurrent test connections, with no video BODY requests or indexer downloads.
The live service remained running and idle. Warmups were excluded; nine paired
trials per window used balanced ordering across an initial pass and a six-order
confirmation pass. Times below are median durations until both availability
samples finished, excluding connection setup, XML parsing, archive inspection
and indexer search.

| STATs per connection | Both samples, median | Complete scored samples | Missing controls rejected |
| --- | --- | --- | --- |
| 64 | 2.200 s | 18/18 | 4/4 |
| 128 | 1.975 s | 18/18 | 4/4 |
| 256 | 2.055 s | 18/18 | 4/4 |

Selected 128, about 10.2% faster than 64 for this check workload. Production
still uses two connections, allowing at most 256 pipelined STATs outstanding.
The 256 window did not improve the pooled median over 128 and sent more
queries before rejecting a missing-article batch. The 30% coverage, article-ID
matching, batch draining, parser disposal and existing deadlines are unchanged.
This is a sampler measurement, not a 10.2% promise for complete listing time.
Numeric evidence is retained privately at
`~/usenet/stat-window-benchmark-20261017/decision.json`; raw fixture selections
and logs in that directory must remain private.

## Parallel release queues — 2026-10-17

Release-job concurrency now honors `NZB_TRIAGE_DOWNLOAD_CONCURRENCY`, capped by
the candidate and parallel-NZB limits. With the current values (4/16/4), four
release jobs overlap their metadata downloads and health work. Each NNTP lease
still belongs to one task; the two-connection pool is not enlarged. The sampler
uses lower-priority leases so archive/header reads that complete verification
can overtake queued scans. FIFO order within each priority, acquisition
deadlines, batch draining and parser disposal remain. A replacement that
finishes connecting after pool shutdown is immediately closed.

The foreground still waits for one verified choice per available target
resolution or normal batch completion/deadline. Work that already verified a
resolution is retained while another candidate of that resolution is slow.
Equivalent requests still share a job and its background completion updates
the matching cached response. Explicit background mode uses the same
resolution preferences. No unchecked result can satisfy the foreground gate.

Thirty-two focused tests cover these rules, including two workers per
resolution despite many larger 4K candidates, a successful alternate overtaking
a stalled first candidate, lease priority on both release and replacement,
closing queued leases, and late-replacement cleanup.

Isolated full-check comparison used four real cached NZBs (two per resolution;
three from Infinity Castle and one other cached 4K release), fixed candidate
ranking, seeded article samples and the normal bounded archive-header checks.
Warmups were excluded and order alternated. Connection setup and indexer
search are outside these measurements. A second controlled scenario delayed
the first 4K metadata response by six seconds using an in-memory stub; no
indexer download was made for that delay.

| Scenario | Trials per version | Two jobs, median to both verified | Four jobs, median to both verified |
| --- | --- | --- | --- |
| Cached metadata | 3 | 3.098 s | 3.104 s |
| Simulated slow first metadata source | 2 | 4.956 s | 3.032 s |

The benefit is hedging a slow candidate; already-ready metadata is not a
general speedup. All twelve trials, including warmups, verified all four
releases without timeouts, stayed within two NNTP connections, and received
the same 1,680,398 bytes for their complete four-release check. RSS was
141–150 MiB. This benchmark is not a claim about full page-load latency.
Private numeric evidence and raw diagnostic logs are retained under
`~/usenet/candidate-queues-benchmark-20261017/`.
