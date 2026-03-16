# Changelog wClock v5.0

## [5.0] - 2026-03-16

### Added
- Temperature range slider label above dual-range sliders
- Panel resize handles (8 directions: nw, ne, sw, se, n, s, e, w)
- Invest banner HTML version (alternative to canvas)
- Week change display (7 days) in investment banner
- TGLD@ gold ticker display in banner
- Asset bars with percentage visualization

### Fixed
- Duplicate `$header` variable declaration in lib.js causing SyntaxError
- Port configuration (10405 instead of 8004)
- Temperature label updates dynamically with slider values

### Changed
- CSS redesign for seconds panel
- Larger moon phase display (21vh)
- Updated wind direction compass size (10vw)
- Resize handles visible in edit-mode with orange color
- Invest banner: removed debug console.logs, improved error handling

### Infrastructure
- Git repository initialized
- Docker port mapping: 10405:5000

---

## [4.x] - Previous versions
See project history for earlier changes.
