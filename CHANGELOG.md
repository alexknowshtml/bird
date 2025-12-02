# Changelog

All notable changes to this project will be documented in this file.

## 0.1.1 — 2025-12-02
- Updated `CreateTweet` GraphQL query ID to `TAJw1rBsjAtdNgTdlo2oeg` (was `znCVAd692dKBq9MgkEhKPQ`)
- Added new required feature flags for December 2025 X API:
  - `premium_content_api_read_enabled`
  - `responsive_web_grok_*` flags (analyze, share, translate, imagine)
  - `profile_label_improvements_pcf_label_in_post_enabled`
  - `responsive_web_jetfuel_frame`
- Source: [fa0311/TwitterInternalAPIDocument](https://github.com/fa0311/TwitterInternalAPIDocument)

## 0.1.0 — 2025-11-28
- Initial release of `bird`, a CLI for posting tweets and replies via the Twitter/X GraphQL API.
- Supports posting tweets, replying to existing tweets by ID or URL, and reading tweet details.
- Credential resolution priority: CLI flags, environment variables (`AUTH_TOKEN`, `CT0`, fallbacks `TWITTER_AUTH_TOKEN`, `TWITTER_CT0`), then macOS Chrome cookies.
- Includes credential check command and human-friendly output for tweet metadata.
- Bundled TypeScript sources, Vitest coverage, and Biome lint/format configuration.
