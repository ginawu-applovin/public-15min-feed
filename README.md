# Public.com 15-Minute Markets — feed

Static JSON for the Public.com playable ads, rebuilt from Public's
event-contract API and served from GitHub Pages with CORS open.

**Endpoint:** <https://ginawu-applovin.github.io/public-15min-feed/feed.json>

| Path | What |
|---|---|
| `feed.json` | every market |
| `crypto.json` · `commodities.json` · `financials.json` | one lane each |
| `status.json` | last build attempt, outcome, reason, counters, run URL |
| `/` | status page |

This repo is public because GitHub Pages is refused on private repos on this
plan. It holds a fetch script and public market data — the same data the ads
serve to the world. The creatives live in a separate private repo.

## How it serves

```
Public API  ──▶  Actions loop  ──▶  feed branch  ──▶  Pages  ──▶  ads
                 every ~5 min       docs/ only        CORS open
```

Pages serves **branch `feed`, path `/docs`** — not an Actions artifact deploy.
The loop force-pushes a single parentless commit holding `docs/` alone, built
with `read-tree` / `write-tree` / `commit-tree`, so the branch stays at one
commit instead of growing by ~66 per run and the working tree is never
switched out from under the running loop.

Each push fires the `pages-build-deployment` workflow, which purges the CDN.
Measured: the four data files return `MISS` with `age=0` rather than ageing
out the 600-second `max-age`, so the refresh interval governs staleness, not
the cache.

## Why a loop and not a cron

GitHub's scheduler is unreliable at high frequency. Measured on this repo:
in the 90 minutes after the workflow was created it delivered **zero**
scheduled runs, and across roughly 13 hours it delivered **two** — neither on
the `*/5` cadence.

So the cron is not the cadence. One run refreshes on its own clock for about
5.5 hours (`INTERVAL=300`, deadline 330 minutes). The schedule entries exist
only to restart it when a run hits that deadline:

| cron | role |
|---|---|
| `*/5 * * * *` | kept in case it ever fires; it has not |
| `17 */3 * * *` | the real restart seed — infrequent, and off the contended top of the hour |

Because a run lasts longer than the 3-hourly gap, a tick lands while a run is
active. With `concurrency: cancel-in-progress: false` it becomes the queued
successor and starts the moment the current run ends. GitHub holds at most one
pending run per concurrency group, so ticks cannot pile up.

**Confirmed end to end on 2026-10-30:** run `41019853995` (scheduled 07:24)
ran to completion; the tick at 10:05 queued behind it and took over without a
gap in publishing.

Having each run dispatch its own successor is not available — GitHub refuses
to start a workflow from an action authenticated with `GITHUB_TOKEN`, and a
personal access token in a public repo's secrets is a standing write
credential not worth the convenience.

## Build guards

The script validates before it writes, so a bad pass cannot clobber a good
feed:

| guard | value | why |
|---|---|---|
| `NEAR_CLOSE_SECONDS` | 120 | odds collapse toward settlement in the last seconds of a window; a build there once served "Up 99% / Down 1%" into a fresh window |
| `MIN_MARKETS` | 10 | targets read `TBD` for the first minutes after a window opens |
| all three lanes non-empty | — | catches a partial API response that would render an empty tab |

A refused build publishes the **previous** feed again alongside a fresh
`status.json`, so the endpoint never goes stale-empty and the refusal is
visible on the live site rather than only in a log that does not flush for
hours. Expect several refusals an hour; roughly 70% of attempts publish.

## Kill switch

Set the repo variable `LOOP` to `off`. Each run then does a single pass and
exits. Unset or any other value means loop.

## Rebuilding locally

```bash
node scripts/fetch_feed.mjs --out docs
```

No dependencies, Node 20+. Takes about 1.5s and writes all four JSON files.
`SHEET_ID` is optional and enables the Google Sheet override tab; without it
the catalog in the script is used as-is.

## Staleness

The ad shows a window that opened a few minutes ago. Target price and odds are
a recent snapshot, not the live book. Each response carries `expires_at` and
`fetched_at`, the creatives' `rollClose()` keeps the countdown on the right
quarter-hour boundary, and nothing claims a LIVE badge.

There is no live spot price in Public's API, so every market carries
`spot_source: "window_open"` and `spot` repeats `open`. That is a known gap
waiting on a quote endpoint from Public, not a bug in this feed.
