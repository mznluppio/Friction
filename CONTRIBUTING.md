# Contributing to Friction

Thanks for your interest in contributing! Friction is a desktop app built with Tauri 2 (Rust) + React 18.

## Prerequisites

- Node.js v20+
- Rust v1.77+ (`rustup update`)
- Tauri CLI prerequisites → [tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/)
- One or more supported AI CLI tools installed: `claude`, `codex`, `gemini`, or `opencode`

## Development Setup

```bash
git clone https://github.com/friction-labs/friction.git
cd friction
npm install

# Run in dev mode (opens app window with hot-reload)
npm run tauri dev
```

## Project Structure

```
src/                  # React frontend
  App.tsx             # Main app logic & state
  components/         # UI components
  lib/                # Orchestrator, types, utilities
src-tauri/src/        # Rust backend
  main.rs             # Tauri commands
  agents/             # CLI isolation & execution
  git/                # Worktree management
  judge/              # LLM trust judge
  session/            # SQLite persistence
```

## Making Changes

1. **Fork** the repository
2. Create a branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Run backend tests: `npm run test:backend`
5. Ensure TypeScript compiles: `npm run build`
6. Open a Pull Request against `main`

## Backend Tests (Rust)

```bash
npm run test:backend
# or directly:
cargo test --manifest-path src-tauri/Cargo.toml
```

## Code Style

- **Rust**: Follow `rustfmt` defaults. Run `cargo fmt` before committing.
- **TypeScript**: No formatter enforced yet — keep consistent with surrounding code.
- **Commits**: Conventional commits preferred (`feat:`, `fix:`, `docs:`, `chore:`)

## Adding a New CLI Agent

CLI agents are resolved in `src-tauri/src/agents/mod.rs`. To add a new CLI:

1. Add the alias to `AgentCli` type in `src/lib/types.ts`
2. Add detection logic in the Rust agent resolver
3. Add it to `AGENT_CLI_OPTIONS` in `src/App.tsx`
4. Update the onboarding screen in `src/components/OnboardingCliSetupScreen.tsx`

## Reporting Issues

Please open a [GitHub Issue](https://github.com/friction-labs/friction/issues) with:
- Your OS and version
- Which CLI agents you're using
- The full error message or Runtime Diagnostics output (Settings → Agents → Diagnostics)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
