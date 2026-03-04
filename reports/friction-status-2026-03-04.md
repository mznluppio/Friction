# Friction - Rapport d'avancement
Date: 4 mars 2026
Auteur: Codex

## 1) Direction produit (confirmée)

Friction se positionne comme moteur de desaccord multi-agents:
- Phase 1/2: agents isoles qui interpretent/plannifient sans se contaminer.
- UI: comparaison des divergences et arbitrage humain.
- Phase 3: execution adversariale code/review sur worktrees Git.

Objectif prioritaire actuel: fiabilite runtime (CLI + modeles + diagnostics) et UX de pilotage (onboarding, model picker agent).

## 2) Ce qui a ete fait

### Backend / Runtime
- Ajout support CLI complet `opencode` (au meme niveau que `claude`, `codex`, `gemini`) sur Phase 1/2/3.
- Resolution deterministic des commandes CLI: `runtime override -> default alias`.
- Contrat IPC stabilise en `snake_case` avec `#[tauri::command(rename_all = "snake_case")]`.
- Commande diagnostics `diagnose_phase12_cli` enrichie:
  - CLI selectionne, commande resolue, source, path, famille,
  - modele resolu + source,
  - readiness runtime (`runtimeReady`, `requiresAuth`, `readinessSource`).
- Isolation stricte Phase 1/2:
  - `cwd` temporaire par agent,
  - `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` isoles.
- Phase 3 conserve l'isolation Git via worktrees (architecture preservee).
- Opencode:
  - invocation alignee sur `opencode run --format json`,
  - normalisation stream JSON pour ignorer les logs parasites.
- Codex en isolation:
  - preflight auth stricte,
  - bridge minimal de `auth.json` vers `CODEX_HOME` temporaire.
- Validation semantique anti-vide:
  - payload JSON partiel accepte,
  - payload semantiquement vide rejete en fail-fast.
- Inventaire modeles:
  - commande `list_cli_models` (live/cache/fallback),
  - cache stale-while-revalidate pour ouverture plus rapide.

### Frontend / UX
- Onboarding CLI dedie (gate stricte avant premier run), avec reset runtime.
- Parametrage modele par agent pour tous les CLIs (A/B/C/D + Phase3 A/B).
- Runtime diagnostics exposes dans l'UI en cas d'echec.
- Refonte chat vers `assistant-ui` + integration `ai-elements` du prompt input.
- Chips agents dans le prompt input (A/B/C/D, Phase3 A/B), ajout/suppression C/D.
- Modal de selection de modele multi-CLI (OpenCode, Claude Code, Codex, Gemini).

### Qualite / verification
- Build front OK (`npm run build`).
- Tests backend OK (`npm run test:backend`): 48 tests passes.

## 3) Ce qui a change recemment

- Passage d'une config CLI dependante `.env` vers une config principalement app-managed.
- Clarification explicite: `.env` reste optionnel pour clefs non-CLI.
- Passage d'un onboarding via modal settings vers un onboarding plein ecran.
- Passage d'un picker modele limite au CLI courant vers un picker multi-CLI par agent.
- Renforcement des erreurs actionnables (fin de "Unknown error" generique dans les cas couverts).

## 4) Ce qu'il reste a faire (priorise)

## P0 (bloquant UX/usage)
- Corriger la modal model selector encore instable visuellement:
  - fond transparent,
  - warning React `Function components cannot be given refs` autour de `PromptInputTextarea`.
- Finaliser le comportement exact demande:
  - clic sur AGENT X -> modal unique stable,
  - groupes `OpenCode / Claude Code / Codex / Gemini` clairs, avec modeles par groupe.
- Fiabiliser le cas `opencode` qui renvoie parfois payload vide selon modele (ex: `ollama/llama3.2`).

## P1 (fiabilite/perf)
- Accelerer et fiabiliser le listing live des modeles pour tous les CLIs:
  - meilleur probing par CLI,
  - cache TTL + invalidation plus fine,
  - message source/reason toujours explicite.
- Parfaire l'UX sidebar/style pour coller a la reference assistant-ui attendue.

## P2 (optimisation)
- Reducer la taille bundle front (warning chunk > 500 kB).
- Nettoyage CSS/composants legacy devenus redondants apres migration.

## 5) Risques et points d'attention

- Le "success partiel" (un agent vide, un agent rempli) peut biaiser la lecture si non bloque: deja traite en fail-fast semantique, a surveiller apres regressions UI.
- Les CLIs externes evoluent vite (flags, format output, auth): necessite tests de compatibilite continues.
- L'experience percue depend fortement de la qualite du listing modele (live vs fallback).

## 6) Plan de la prochaine iteration

1. Fix modal model selector (ref warning + fond + layering).
2. Verifier selection multi-CLI agent par agent bout-en-bout (UI -> runtime diagnostics -> execution).
3. Renforcer chemin `opencode` pour eviter les payloads vides non exploitables.
4. Polir sidebar assistant-ui pour converger vers la reference UX cible.
5. Re-run build + tests backend + smoke manuel phase1/phase3.

## 7) Etat global

- Direction produit: stable et claire.
- Fondations runtime: solides (isolation, diagnostics, tests).
- Principal gap restant: finition UX model picker + robustesse finale opencode en conditions reelles.
