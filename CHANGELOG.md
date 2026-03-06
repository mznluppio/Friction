# Changelog

All notable changes to Friction will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-03-06

### Initial public release

#### Added
- **Dual-agent Phase 1**: Two isolated CLI agents (Agent A · Architect, Agent B · Pragmatist) independently analyze the same requirement and produce structured interpretations.
- **Divergence scoring**: Jaccard-distance-based algorithm highlights where agents disagree (interpretation, assumptions, risks, approach) with `low` / `medium` / `high` severity tags.
- **Multi-agent consensus mode**: Up to 4 agents (A/B/C/D) with consensus clustering across responses.
- **Phase 2 planning**: Each agent proposes an independent implementation plan; divergences are surfaced on strategy, tradeoffs, risks, and next steps.
- **Friction inbox**: Human-in-the-loop resolution UI — pick Agent A, Agent B, or Hybrid for each top disagreement before moving to the brief.
- **Execution brief**: Auto-synthesized action brief based on human resolutions, ready for Phase 3.
- **Phase 3 adversarial**: Agent A writes code in an isolated Git worktree; Agent B attacks it. Produces `git diff`, attack report, and a confidence score via a Trust Judge (haiku / flash / ollama).
- **Local-first persistence**: All sessions stored in SQLite at `~/.friction/sessions.db`. No cloud telemetry.
- **Bring Your Own CLI (BYOCLI)**: Supports `claude`, `codex`, `gemini`, and `opencode` out of the box, with custom command path overrides.
- **CLI strict isolation**: Each agent runs with its own `cwd`, `HOME`, and config directory to prevent cross-contamination.
- **First-run onboarding**: Guided CLI setup screen with live diagnostics.
- **Settings dialog**: Full runtime configuration (agents, models, judge, Phase 3 overrides).
- **Runtime Diagnostics panel**: Debug CLI path resolution, binary readiness, and model detection.
- **Session drawer**: Browse, resume, and export previous sessions.
- **Dataset export**: Opt-in JSONL export of consented sessions for research/fine-tuning.
- **Dark / Light theme**.
- **macOS notarization helper**: `scripts/release/macos-sign-notarize.sh`.
- **Homebrew formula**: `packaging/homebrew/friction.rb`.

---

<!-- Add new versions above this line -->
