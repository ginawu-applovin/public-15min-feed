# Public.com 15-Minute Markets — feed

Static JSON for the Public.com playable ads, rebuilt from Public's
event-contract API and served from GitHub Pages with CORS open.

**Endpoint:** <https://ginawu-applovin.github.io/public-15min-feed/feed.json>

| Path | What |
|---|---|
| `feed.json` | every market |
| `crypto.json` · `commodities.json` · `financials.json` | one lane each |
| `/` | status page |

This repo is public because GitHub Pages requires it. It holds a fetch script
and public market data — the same data the ads serve to the world. The
creatives live in a separate private repo.

## Rebuilding

```bash
node scripts/fetch_feed.mjs --out docs
```

No dependencies, Node 20+. Takes about 1.5s and writes all four JSON files.

## Automatic refresh — one step to switch on

`workflow/refresh.yml` runs the rebuild every 5 minutes and deploys to Pages.
It is not active yet: a token needs the `workflow` scope before GitHub will
accept a file under `.github/workflows/`.

```bash
gh auth refresh -h github.com -s workflow
mkdir -p .github/workflows && git mv workflow/refresh.yml .github/workflows/
git commit -am "Activate the refresh workflow" && git push
```

Then **Settings → Pages → Source: GitHub Actions**.

Until that happens the feed is whatever was last committed — re-run the script
and push to update it.

## Staleness

GitHub Actions' shortest cron is 5 minutes and scheduled runs get delayed, so
the feed runs 5–15 minutes behind on a market that closes every 15. The
creatives handle it: `rollClose()` keeps the countdown on the right
quarter-hour boundary, every response carries `expires_at`, and nothing claims
a LIVE badge.
