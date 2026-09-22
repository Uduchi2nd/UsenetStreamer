# 30% whole-file screening

Based on upstream v1.8.4. This patch is in UsenetStreamer, not Remux or vnphim.

## Behavior
For each recognized video/ISO/archive file, sort NZB articles by segment number, deduplicate IDs, then select ceil(30% of articles). Divide the whole ordered file into that many disjoint, evenly spaced sections and choose one random article from each. This covers beginning, middle and end; it is not a prefix download. PAR2/NFO and other ancillary files are excluded. Multipart archive parts are each sampled; existing archive format/header checks remain.

STAT requests use batches of 16 on an exclusively leased existing NNTP connection. The configured two-connection pool remains in use. A positive result requires every selected article to return223 with the expected message ID.430 marks missing; drain the current batch and reject early. Timeout, unexpected response or transport error returns sample-incomplete/unverified, never verified. Sampling has a12-second network deadline after pool acquisition; the existing acquire and outer triage deadlines still apply. No video BODY download is added by this sampler; existing archive header inspection may still fetch data.

The pinned nntp0.3.1 library serializes commands. The sampler takes over only an idle leased socket, then destroys/replaces it even on success so its parser cannot consume stale pipeline replies. This avoids a second connection pool. Updating the NNTP library requires revisiting this adapter.

Completed history jobs now enter normal triage rather than bypassing it. Completed search results without a verified decision are withheld; they are no longer seeded directly into Smart Play. This applies to normal search listings, not manually opened history-library links or previously saved playback URLs. Existing unverified non-history candidate behavior remains. The stream-cache namespace is bumped so old8-piece decisions are not reused. Upstream candidate/time/indexer budgets and primary-provider choice remain in force.

## Deployment and verification
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
