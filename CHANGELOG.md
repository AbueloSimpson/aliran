# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project scaffold: `panel/`, `broadcaster/`, `client/` structure.
- Documentation under `docs/` (getting-started, concepts, architecture with sequence
  diagrams, security model, operator guide, configuration, content management, client
  build, user management, reference, FAQ/troubleshooting, legal/compliance) + ADRs.
- `ROADMAP.md` (alpha → 1.0 milestones + optional modules) and a publishable MkDocs
  Material site config (`mkdocs.yml`).
- Repository metadata: README, LICENSE (MIT), SECURITY, CONTRIBUTING, Code of Conduct.

### To do (see docs/ and per-package READMEs)
- Panel: signed Hyperbee (accounts + catalog), OPRF login, sessions/devices, assets drive.
- Broadcaster: ingest → ffmpeg/packager → encrypted Hyperdrive → Hyperswarm.
- Client: Bare worklet backend + React Native (phone + TV) OTT UI.
- Optional: multi-DRM, geo-locking, VOD.
