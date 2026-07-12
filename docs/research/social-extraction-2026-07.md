# TikTok / IG / YouTube Place-Extraction — Research Report (verified 2026-07-12)

Researched for PLAN-V1.md M4 (B1c social extraction). Web-verified by a dedicated research
agent; sources at bottom. Re-verify the Meta/TikTok endpoints at M4.1 spike time — platforms
flip-flop.

## TikTok

| Method | What you get | Cost | Fragility (1-5) | ToS risk (1-5) |
|---|---|---|---|---|
| Public oEmbed (`tiktok.com/oembed`) | `title` field = full caption text, author, embed HTML. No auth needed. Confirmed working in current (2026) embed guides. | Free | 2 | 1 |
| Official Display/Content API | Only surfaces content of a **TikTok-connected user** via OAuth Login Kit — no arbitrary "look up any public URL" endpoint. Requires app review (~1–2 weeks solo-dev). Not useful for "paste any link". | Free but gated | 3 | 1 |
| yt-dlp | Video file + full metadata/description via `--write-info-json --skip-download`. Comments not standard for TikTok. | Free (self-hosted) | 3 (breaks every 4-8 wks) | 3 (breaches ToS) |

## Instagram

| Method | What you get | Cost | Fragility | ToS risk |
|---|---|---|---|---|
| oEmbed (Graph API) | Basic Display API killed Dec 2024; **June 15, 2026: Meta reversed course — oEmbed for IG/FB/Threads works tokenless again** for public posts, at lower rate limits. Caption/title only, no comments. | Free | 3 (Meta has flip-flopped before) | 1 |
| Graph API (token) | Only content of a connected Business/Creator account you manage — not arbitrary Reels. | Free | 2 | 1 |
| yt-dlp / gallery-dl | Reels supported but IG now requires browser cookies/login for almost all fetches; frequent breakage. | Free | 4 | 3-4 (session ban risk) |

## YouTube (easy case)

Data API v3: `videos.list(part=snippet)` = 1 unit (title+description), `commentThreads.list` =
1 unit, free 10,000-units/day quota (~thousands of videos/day). oEmbed gives title with zero
key. Only `captions.download` (subtitle track) needs OAuth+ownership — not needed.

## Third-party scrapers (plain HTTPS, Vercel-friendly)

- **Apify** — `apify/instagram-scraper` $1.50/1k posts; comment scraper $0.0075/post;
  `clockworks/tiktok-scraper` $1.70/1k. Caption, comments, video download URL. Mature; $5/mo
  free credit; individual actors do break.
- **ScrapeCreators** — one unified REST API for TikTok/IG/YouTube, $10/5,000 credits
  (1 req = 1 credit), no headless browser your side — good serverless fit. Newer vendor.
- **EnsembleData** — unified TikTok+IG+YT+X+Reddit, free 50 units/day then $100+/mo tiers,
  no login needed, solid reputation. Daily-reset units penalize bursts.
- **Bright Data** — ~$0.75/1k pay-per-success, 5,000 free credits/mo, most battle-tested,
  enterprise-skewed.

## Video-frame + vision LLM

No turnkey "URL in → place name out" product. DIY standard: fetch MP4 (scraper's returned URL,
or yt-dlp), sample 3-6 frames with ffmpeg, send to a vision LLM (OCR on-screen text + landmark
ID). **Do NOT run yt-dlp/ffmpeg inside Vercel serverless** (no persistent binaries, size/time
limits) — use a small worker (the soupai.cloud VPS is available). Meter per-user: vision calls
cost far more than caption parsing.

## Recommended architecture

Caption-first, free: TikTok oEmbed + IG tokenless oEmbed + YouTube Data API give captions at $0.
Run caption (+ top comments where cheap) through the existing place-name LLM extraction — this
alone should resolve most tagged/hashtag posts. Fallback tier: paid unified scraper
(ScrapeCreators or EnsembleData, ~$0.5–2/1k) for comments and MP4 URLs. Final tier (optional,
gated): frame analysis on the VPS worker → vision LLM. Meter everything per-link and per-user.

## Legal/ToS reality (not legal advice)

Post-*hiQ v. LinkedIn* (settled 2022, reaffirmed since), scraping publicly viewable data without
login is not CFAA "unauthorized access" — still holds in 2026. But platform ToS ban scraping:
realistic exposure for a small SG app is operational (IP bans, blocks) far more than legal —
which is why routing through a paid third-party scraper is the pragmatic move: it shifts the
IP-rotation/ban burden onto a vendor built to absorb it. Caption-first via oEmbed endpoints is
the lowest-risk tier (platform-provided endpoints, not scraping).

**Sources:** developers.tiktok.com/doc/embed-videos · developers.tiktok.com/doc/app-review-guidelines ·
roundproxies.com/blog/yt-dlp · wpmayor.com (Meta tokenless oEmbed reversal) ·
developers.facebook.com/docs/instagram-platform/oembed · github.com/yt-dlp/yt-dlp#17074 ·
github.com/mikf/gallery-dl#9555 · apify.com/pricing · apify.com/apify/instagram-scraper ·
apify.com/clockworks/tiktok-scraper · scrapecreators.com · ensembledata.com/pricing ·
brightdata.com/products/web-scraper · developers.google.com/youtube/v3/determine_quota_cost ·
en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn · calawyers.org (Ninth Circuit hiQ)
