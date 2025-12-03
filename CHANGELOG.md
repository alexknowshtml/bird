# Changelog

## Unreleased

### Added
- `whoami` command works with both GraphQL cookies and Sweetistics API keys.
- Firefox cookie extraction (`--firefox-profile`) alongside existing Chrome/env/CLI credential paths.
- Sweetistics client `getCurrentUser` with POST→GET fallback for deployments that disallow POST.
- Colorized help banner and example block; `pnpm bird` builds then runs the CLI; no subcommand shows help.
- JSON5 config files (`~/.config/bird/config.json5`, `./.birdrc.json5`) for defaults like engine and browser profile.
- Config toggles to disable cookie sources (`allowChrome`, `allowFirefox`) and default transport now `graphql` with Firefox as preferred cookie source.

### Changed
- Default option resolution now honors config files (project then global) before env/CLI overrides.

### Changed
- `whoami` now prefers Sweetistics when an API key is present; otherwise uses Twitter cookies.

### Fixed
- Fallback to scraping the authenticated settings page when Twitter account APIs return 404, so `whoami` still resolves the user.
