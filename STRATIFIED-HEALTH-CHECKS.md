# 30% whole-file screening

Based on upstream v1.8.4. This patch is in UsenetStreamer, not Remux or vnphim.

## Behavior
For each recognized video/ISO/archive file, sort NZB articles by segment number, deduplicate IDs, then select ceil(30% of articles). Divide the whole ordered file into that many disjoint, evenly spaced sections and choose one random article from each. This covers beginning, middle and end; it is not a prefix download. PAR2/NFO and other ancillary files are excluded. Multipart archive parts are each sampled; existing archive format/header checks remain.

STAT requests use batches of 64 on an exclusively leased existing NNTP connection. The configured two-connection pool remains in use. A positive result requires every selected article to return223 with the expected message ID.430 marks missing; drain the current batch and reject early. Timeout, unexpected response or transport error returns sample-incomplete/unverified, never verified. Sampling has a12-second network deadline after pool acquisition; the existing acquire and outer triage deadlines still apply. No video BODY download is added by this sampler; existing archive header inspection may still fetch data.

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

The sampler now pipelines 64 queries rather than 16 over the same connections.
Coverage stays at 30%; successful samples still require every selected reply,
including a matching article ID. Missing pieces drain the outstanding batch
before rejecting. This reduces protocol round trips without adding connections.
Active file jobs per batch are bounded by the configured parallelism and NNTP
connection count, rather than launching every candidate at once. This prevents
the first file's archive-header reads from waiting behind a whole batch of
other files' sampling. The candidate and time budgets remain in effect. The
current Containerfile also overlays and syntax-checks progressive.js.

The queue gives an idle worker to each missing target resolution before
starting alternatives of a resolution already in progress. After a resolution
verifies, remaining missing resolutions take priority. Resolution representatives
are selected before the existing candidate/indexer caps; neither cap is raised.
Renderer labels, cached coverage and worker scheduling use the same resolution
parser, including 2160p/UHD aliases. The runner is now included in the overlay.

Focused checks: `node --test test/stratified.test.js test/progressive.test.js test/runner-progressive.test.js`.
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
