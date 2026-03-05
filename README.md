# Friction

Friction est un moteur de desaccord pour le code AI-assisted: deux agents interpretent le meme requirement en isolation, puis l'UI met les divergences au centre de la decision.

## Status (v1.2)

- Phase 1: analyse dual-agent + divergences (CLI-first)
- Phase 2: plans d'implementation + arbitrage humain (CLI-first)
- Phase 3: workflow adversarial canonique (Agent A code, Agent B attaque le code final)
- Runtime configurable depuis l'UI:
  - Phase 1/2: x-agents (A/B/C/D) partages
  - Phase 3: Agent A CLI / Agent B CLI dedies
  - Modele CLI par agent (claude/codex/gemini/opencode)
  - Judge provider/model, host Ollama
- UI chat/settings refondue avec `assistant-ui` (thread + composer) et cartes metier conservees
- Persistance locale SQLite des sessions
- Export JSON dataset-compatible (opt-in) avec metadonnees de reproductibilite
- Mode legacy provider/API disponible via flag env (cache, transition)

## Stack

- Frontend: React + Vite + Tailwind
- Desktop: Tauri 2 (Rust)
- Storage local: SQLite (`~/.friction/sessions.db`)
- Git layer: `git worktree` + `git diff`

## Run

```bash
npm install
npm run dev
```

Desktop Tauri:

```bash
npm run tauri dev
```

Build desktop debug:

```bash
npm run tauri build -- --debug
```

Tests backend:

```bash
npm run test:backend
```

## CLI onboarding (sans `.env` obligatoire)

Par defaut, Friction se configure depuis l'app:

- Au premier lancement (ou apres `Reset runtime settings`), un ecran d'onboarding plein page bloque la phase 1.
- Vous devez confirmer Agent A/B (phase 1/2) uniquement quand les executables resolves sont trouvables et runtime-ready.
- Dans `Settings > Agents`, vous pouvez definir des commandes personnalisées par alias (`claude`, `codex`, `gemini`, `opencode`) via les champs `CLI command overrides`.
- Dans `Settings`, vous pouvez definir un modele par agent pour tous les CLIs (`agent_a`, `agent_b`, `agent_c`, `agent_d`, `phase3_agent_a`, `phase3_agent_b`).
- Les champs fallback avances `cli_models.<alias>` restent disponibles pour compatibilite.
- Le picker modele runtime utilise un inventaire multi-source:
  - `opencode`: listing live via `opencode models` (et `--refresh` en refresh force),
  - `codex`, `claude`, `gemini`: listing live via APIs provider quand les cles sont disponibles.
- Si le live listing est indisponible, l'UI bascule en fallback explicite (presets) avec raison visible.
- Le cache inventaire est stale-while-revalidate (`source=cache|live|fallback`) pour ouverture rapide de la modal.
- Les commandes peuvent etre un nom binaire (`codex`) ou un chemin absolu (`/opt/homebrew/bin/codex`).
- Timeout inventaire modeles configurable via `FRICTION_CLI_MODELS_HTTP_TIMEOUT_SECS` (default: `8` secondes).

Ordre de resolution des executables (deterministe):

1. Override runtime app (`cli_commands.<alias>`)
2. Valeur par defaut de l'alias (`claude`, `codex`, `gemini`, `opencode`)

Commande par defaut `opencode`: `opencode run --format json "<prompt>"`.
Si un modele est configure dans l'app, Friction applique `--model "<value>"` sur les CLIs supportes (`claude`, `codex`, `gemini`, `opencode`).
`/model` et `--model` servent a selectionner un modele pour l'execution; l'inventaire de modeles affichable en UI provient du pipeline live/cache/fallback ci-dessus.
Priorite modele (tous CLIs):
1. `agent_cli_models.<agent_id>`
2. fallback global legacy `cli_models.<alias>`
3. modele par defaut du profil CLI local

Le runtime phase 1/2 reste independant des selections dediees phase 3 (Agent A / Agent B).
Le payload IPC frontend utilise `snake_case`, et les commandes Tauri backend sont configurees avec `rename_all = "snake_case"` pour eviter toute derive de deserialisation.

`.env` reste optionnel pour les cles non-CLI (judge/provider/API), pas requis pour la resolution des commandes CLI.

### Codex en isolation Phase 1/2

- Pour `codex` en phase 1/2 (isolation stricte), Friction verifie d'abord:
  1. `OPENAI_API_KEY` non vide, ou
  2. un fichier host `auth.json` (`$CODEX_HOME/auth.json` sinon `$HOME/.codex/auth.json`).
- Si seul `auth.json` est present, Friction le bridge vers un `CODEX_HOME` temporaire par agent isole (sans copier `config.toml` ni state DB).
- Si aucune auth n'est disponible, Friction bloque avant execution (preflight strict) avec un message actionnable (`codex login` ou changement de CLI).

## Isolation d'execution

- Phase 1/2: isolation runtime stricte par agent CLI.
  - Chaque execution agent tourne dans un `cwd` temporaire unique.
  - `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` sont rediriges vers un espace temporaire isole.
  - Les dossiers temporaires d'isolation sont nettoyes automatiquement, succes ou erreur.
- Phase 3: isolation Git via `worktree` dedie par agent (comportement inchange).

Cette isolation Phase 1/2 cible l'independance d'analyse entre agents (prompts + contexte runtime), pas la generation de code collaborative.

Judge de confiance phase 3:

```bash
FRICTION_JUDGE_PROVIDER=haiku   # haiku | flash | ollama
FRICTION_JUDGE_MODEL=claude-3-5-haiku-latest
GEMINI_API_KEY=...              # requis pour flash
OLLAMA_HOST=http://localhost:11434
```

Mode legacy provider/API (transition uniquement):

```bash
FRICTION_ENABLE_LEGACY_PROVIDER_MODE=1
FRICTION_ARCHITECT_PROVIDER=anthropic
FRICTION_PRAGMATIST_PROVIDER=openai
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

## Troubleshooting CLI mismatch

Si l'UI affiche `gemini/codex` mais que le runtime diverge:

1. Verifier d'abord l'ecran onboarding CLI (first-run) et corriger Agent A/B.
2. Verifier les statuts onboarding Agent A/B dans `CLI command overrides`:
   - `resolved='...'`
   - `source=...` (`runtime:cli_commands.*`, `default:*`)
   - `path=...`
3. Si le backend recu differe de l'UI (`UI selected X, backend received Y`), la run est bloquee avant execution: c'est un signal de derive IPC/build stale, pas uniquement un quota provider.
4. En cas d'echec de run, consulter `Runtime diagnostics` pour:
   - CLI selectionne (UI attendu/backend recu)
   - commande resolue + source
   - chemin binaire detecte
   - modele resolu + source (`runtime:agent_cli_models.*`, `runtime:cli_models.*`, `default:*`)
   - readiness runtime (`runtimeReady`, `readinessSource`, `readinessReason`) pour les CLIs qui exigent une auth locale (notamment codex en phase 1/2)
   - note opencode: Friction force `XDG_STATE_HOME` vers un chemin ecriture controle par l'app pour eviter les erreurs `EACCES`.
   - note opencode: les lignes de logs d'initialisation sont ignorees, seul le flux JSON d'events est utilise.
5. Si besoin, ouvrir `Settings` (advanced runtime tuning) puis utiliser `Reset runtime settings` pour nettoyer les cles runtime persistées et relancer l'onboarding.

Pour `opencode`, l'auth locale reste requise cote utilisateur (session/credentials opencode valides).
Pour `codex` en phase 1/2, executer `codex login` si `runtimeReady=false` et `readinessSource=none`.

## Note Git diff

Le git diff de la phase 3 depend de l'execution en worktrees isoles (Agent A commit, Agent B review), pas du choix provider/API historique.

## Format de session

Le JSON exporte inclut:

- `metadata.schema_version` (ex: `friction.session.v1`)
- `metadata.app_version` (ex: `1.2.0`)
- `metadata.workflow_mode` (ex: `phase3-adversarial-single-code-v1`)
- `metadata.runtime.phase_agents` pour Phase 1/2
- `metadata.runtime.cli_models` (fallback modele par alias)
- `metadata.runtime.agent_cli_models` (override modele par agent)
- `metadata.runtime.phase3_agent_a_cli` / `metadata.runtime.phase3_reviewer_cli` pour Phase 3
- `metadata.runtime.judge`, `metadata.runtime.ollama_host`

Les anciens champs runtime (`architect/pragmatist`, `phase3_agent_a_cli`, `phase3_reviewer_cli`) restent lus pour compatibilite.

## Commandes backend Tauri disponibles

- `run_phase1(requirement, agent_a_cli?, agent_b_cli?, phase_agents?, runtime_config?)`
- `diagnose_phase12_cli(agent_a_cli?, agent_b_cli?, phase_agents?, runtime_config?)`
- `list_opencode_models(runtime_config?)`
- `run_phase2(requirement, clarifications, agent_a_cli?, agent_b_cli?, phase_agents?, runtime_config?)`
- `save_session(record)`
- `list_sessions(limit)`
- `load_session(id)`
- `export_consented_dataset(target_path?)`
- `create_worktrees(repo_path, base_branch?, session_id)`
- `diff_worktrees(repo_path, left_ref, right_ref)`
- `cleanup_worktrees(repo_path, session_id)`
- `run_phase3(repo_path, base_branch?, requirement, clarifications, decision, session_id?, judge_provider?, judge_model?, agent_a_cli?, agent_b_cli?, runtime_config?, auto_cleanup?)`

## Structure

```text
friction/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── agents/
│   │   ├── git/
│   │   ├── judge/
│   │   └── session/
│   ├── capabilities/default.json
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── components/
│   ├── pages/
│   └── lib/
├── packaging/
│   └── homebrew/friction.rb
├── scripts/
│   └── release/macos-sign-notarize.sh
└── README.md
```

## Distribution macOS

Homebrew formule template:

```bash
packaging/homebrew/friction.rb
```

Notarization helper:

```bash
scripts/release/macos-sign-notarize.sh
```

Si l'app non-notarisee est quarantined:

```bash
xattr -cr friction.app
```
