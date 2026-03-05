#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod git;
mod judge;
mod session;

use session::store::{DatasetExportResult, SessionSummary};
use session::{
    AttackReportItem, Divergence, DivergenceAgentValue, NamedAgentPlan, NamedAgentResponse,
    Phase1Output, Phase2Output, Phase3Output, SessionRecord,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
#[cfg(not(test))]
use tauri::Emitter;
use uuid::Uuid;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpencodeModelsOutput {
    models: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CliModelsOutput {
    models: Vec<String>,
    source: String,
    reason: Option<String>,
    stale: bool,
    last_updated_at: Option<String>,
    provider_mode: Option<String>,
}

fn normalized(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn severity_from_disagreement(score: f32) -> String {
    if score < 0.34 {
        "low".to_string()
    } else if score < 0.67 {
        "medium".to_string()
    } else {
        "high".to_string()
    }
}

fn unique_items_pair(left: &[String], right: &[String]) -> (Vec<String>, Vec<String>) {
    let right_norm: HashSet<String> = right.iter().map(|item| normalized(item)).collect();
    let left_norm: HashSet<String> = left.iter().map(|item| normalized(item)).collect();

    let unique_a = left
        .iter()
        .filter(|item| !right_norm.contains(&normalized(item)))
        .cloned()
        .collect::<Vec<_>>();
    let unique_b = right
        .iter()
        .filter(|item| !left_norm.contains(&normalized(item)))
        .cloned()
        .collect::<Vec<_>>();

    (unique_a, unique_b)
}

fn compare_string_consensus(
    field: &str,
    values: &[(String, String, String)],
) -> Option<Divergence> {
    if values.len() < 2 {
        return None;
    }

    let mut clusters: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, (_, _, text)) in values.iter().enumerate() {
        let norm = normalized(text);
        if let Some((_, members)) = clusters.iter_mut().find(|(key, _)| *key == norm) {
            members.push(index);
        } else {
            clusters.push((norm, vec![index]));
        }
    }

    let (_, consensus_cluster) = clusters
        .iter()
        .max_by_key(|(_, members)| members.len())
        .expect("at least one cluster should exist");
    let consensus_count = consensus_cluster.len();
    let disagreement_score = 1.0 - (consensus_count as f32 / values.len() as f32);

    if disagreement_score <= f32::EPSILON {
        return None;
    }

    let consensus_indexes: HashSet<usize> = consensus_cluster.iter().copied().collect();
    let mut outlier_agent_ids = Vec::new();
    let agent_values = values
        .iter()
        .enumerate()
        .map(|(index, (agent_id, label, text))| {
            let distance = if consensus_indexes.contains(&index) {
                0.0
            } else {
                1.0
            };
            if distance >= 0.5 {
                outlier_agent_ids.push(agent_id.clone());
            }

            DivergenceAgentValue {
                agent_id: agent_id.clone(),
                label: label.clone(),
                kind: "text".to_string(),
                text: Some(text.clone()),
                items: None,
                distance,
            }
        })
        .collect::<Vec<_>>();

    Some(Divergence {
        field: field.to_string(),
        unique_a: None,
        unique_b: None,
        a: values.first().map(|(_, _, text)| text.clone()),
        b: values.get(1).map(|(_, _, text)| text.clone()),
        mode: Some("consensus".to_string()),
        consensus_text: consensus_cluster
            .first()
            .map(|index| values[*index].2.clone()),
        consensus_items: None,
        agent_values: Some(agent_values),
        outlier_agent_ids: Some(outlier_agent_ids),
        disagreement_score: Some(disagreement_score),
        severity: severity_from_disagreement(disagreement_score),
    })
}

fn jaccard_distance(agent_items: &HashSet<String>, consensus_items: &HashSet<String>) -> f32 {
    if agent_items.is_empty() && consensus_items.is_empty() {
        return 0.0;
    }

    let intersection = agent_items.intersection(consensus_items).count() as f32;
    let union = agent_items.union(consensus_items).count() as f32;
    if union <= f32::EPSILON {
        0.0
    } else {
        1.0 - (intersection / union)
    }
}

fn compare_list_consensus(
    field: &str,
    values: &[(String, String, Vec<String>)],
) -> Option<Divergence> {
    if values.len() < 2 {
        return None;
    }

    let mut frequency = HashMap::<String, usize>::new();
    let mut canonical = HashMap::<String, String>::new();

    for (_, _, items) in values.iter() {
        let mut seen = HashSet::new();
        for item in items {
            let key = normalized(item);
            if key.is_empty() || !seen.insert(key.clone()) {
                continue;
            }
            *frequency.entry(key.clone()).or_insert(0) += 1;
            canonical.entry(key).or_insert_with(|| item.clone());
        }
    }

    let threshold = (values.len() as f32 * 0.5).ceil() as usize;
    let mut consensus_keys = frequency
        .iter()
        .filter_map(|(key, count)| {
            if *count >= threshold {
                Some(key.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    consensus_keys.sort_by(|left, right| {
        frequency
            .get(right)
            .unwrap_or(&0)
            .cmp(frequency.get(left).unwrap_or(&0))
            .then_with(|| left.cmp(right))
    });

    let consensus_set = consensus_keys.iter().cloned().collect::<HashSet<_>>();
    let consensus_items = consensus_keys
        .iter()
        .filter_map(|key| canonical.get(key))
        .cloned()
        .collect::<Vec<_>>();

    let mut disagreement_total = 0.0_f32;
    let mut outlier_agent_ids = Vec::new();
    let agent_values = values
        .iter()
        .map(|(agent_id, label, items)| {
            let normalized_items = items
                .iter()
                .map(|item| normalized(item))
                .filter(|item| !item.is_empty())
                .collect::<HashSet<_>>();

            let distance = jaccard_distance(&normalized_items, &consensus_set);
            disagreement_total += distance;
            if distance >= 0.5 {
                outlier_agent_ids.push(agent_id.clone());
            }

            DivergenceAgentValue {
                agent_id: agent_id.clone(),
                label: label.clone(),
                kind: "list".to_string(),
                text: None,
                items: Some(items.clone()),
                distance,
            }
        })
        .collect::<Vec<_>>();

    let disagreement_score = disagreement_total / values.len() as f32;
    let (unique_a, unique_b) = values
        .first()
        .zip(values.get(1))
        .map(|(first, second)| unique_items_pair(&first.2, &second.2))
        .unwrap_or_else(|| (Vec::new(), Vec::new()));

    if disagreement_score <= f32::EPSILON && unique_a.is_empty() && unique_b.is_empty() {
        return None;
    }

    Some(Divergence {
        field: field.to_string(),
        unique_a: Some(unique_a),
        unique_b: Some(unique_b),
        a: None,
        b: None,
        mode: Some("consensus".to_string()),
        consensus_text: None,
        consensus_items: Some(consensus_items),
        agent_values: Some(agent_values),
        outlier_agent_ids: Some(outlier_agent_ids),
        disagreement_score: Some(disagreement_score),
        severity: severity_from_disagreement(disagreement_score),
    })
}

fn build_phase1_divergences(responses: &[NamedAgentResponse]) -> Vec<Divergence> {
    if responses.len() < 2 {
        return Vec::new();
    }

    let mut divergences = Vec::new();
    let interpretation_values = responses
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.label.clone(),
                item.response.interpretation.clone(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(div) = compare_string_consensus("interpretation", &interpretation_values) {
        divergences.push(div);
    }

    let assumptions_values = responses
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.label.clone(),
                item.response.assumptions.clone(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(div) = compare_list_consensus("assumptions", &assumptions_values) {
        divergences.push(div);
    }

    let risks_values = responses
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.label.clone(),
                item.response.risks.clone(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(div) = compare_list_consensus("risks", &risks_values) {
        divergences.push(div);
    }

    let questions_values = responses
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.label.clone(),
                item.response.questions.clone(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(div) = compare_list_consensus("questions", &questions_values) {
        divergences.push(div);
    }

    let approach_values = responses
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.label.clone(),
                item.response.approach.clone(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(div) = compare_string_consensus("approach", &approach_values) {
        divergences.push(div);
    }

    divergences
}

fn build_phase2_divergences(plans: &[NamedAgentPlan]) -> Vec<Divergence> {
    if plans.len() < 2 {
        return Vec::new();
    }

    let mut divergences = Vec::new();
    let stack_values = plans
        .iter()
        .map(|item| (item.id.clone(), item.label.clone(), item.plan.stack.clone()))
        .collect::<Vec<_>>();
    if let Some(div) = compare_list_consensus("stack", &stack_values) {
        divergences.push(div);
    }

    let architecture_values = plans
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.label.clone(),
                item.plan.architecture.clone(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(div) = compare_string_consensus("architecture", &architecture_values) {
        divergences.push(div);
    }

    let tradeoffs_values = plans
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.label.clone(),
                item.plan.tradeoffs.clone(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(div) = compare_list_consensus("tradeoffs", &tradeoffs_values) {
        divergences.push(div);
    }

    let warnings_values = plans
        .iter()
        .map(|item| {
            (
                item.id.clone(),
                item.label.clone(),
                item.plan.warnings.clone(),
            )
        })
        .collect::<Vec<_>>();
    if let Some(div) = compare_list_consensus("warnings", &warnings_values) {
        divergences.push(div);
    }

    divergences
}

fn legacy_pair_divergence_string(field: &str, left: &str, right: &str) -> Option<Divergence> {
    if normalized(left) == normalized(right) {
        return None;
    }

    Some(Divergence {
        field: field.to_string(),
        unique_a: None,
        unique_b: None,
        a: Some(left.to_string()),
        b: Some(right.to_string()),
        mode: Some("pair".to_string()),
        consensus_text: None,
        consensus_items: None,
        agent_values: None,
        outlier_agent_ids: None,
        disagreement_score: None,
        severity: "medium".to_string(),
    })
}

fn legacy_pair_divergence_list(
    field: &str,
    left: &[String],
    right: &[String],
) -> Option<Divergence> {
    let (unique_a, unique_b) = unique_items_pair(left, right);
    if unique_a.is_empty() && unique_b.is_empty() {
        return None;
    }

    Some(Divergence {
        field: field.to_string(),
        unique_a: Some(unique_a),
        unique_b: Some(unique_b),
        a: None,
        b: None,
        mode: Some("pair".to_string()),
        consensus_text: None,
        consensus_items: None,
        agent_values: None,
        outlier_agent_ids: None,
        disagreement_score: None,
        severity: "medium".to_string(),
    })
}

fn require_dual_responses(
    responses: &[NamedAgentResponse],
) -> Result<(session::AgentResponse, session::AgentResponse), String> {
    let first = responses
        .first()
        .ok_or_else(|| "phase1 requires at least 2 agent responses".to_string())?;
    let second = responses
        .get(1)
        .ok_or_else(|| "phase1 requires at least 2 agent responses".to_string())?;
    Ok((first.response.clone(), second.response.clone()))
}

fn require_dual_plans(
    plans: &[NamedAgentPlan],
) -> Result<(session::AgentPlan, session::AgentPlan), String> {
    let first = plans
        .first()
        .ok_or_else(|| "phase2 requires at least 2 agent plans".to_string())?;
    let second = plans
        .get(1)
        .ok_or_else(|| "phase2 requires at least 2 agent plans".to_string())?;
    Ok((first.plan.clone(), second.plan.clone()))
}

async fn run_phase1_impl(
    requirement: String,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    phase_agents: Option<Vec<agents::PhaseAgentInput>>,
    runtime_config: Option<agents::RuntimeConfigInput>,
    phase12_run_context: Option<agents::Phase12CliRunContext>,
) -> Result<Phase1Output, String> {
    if requirement.trim().is_empty() {
        return Err("Requirement cannot be empty".to_string());
    }

    let has_explicit_cli_selection = phase_agents.is_some()
        || agent_a_cli
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
        || agent_b_cli
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();

    let resolved_phase_agents = agents::resolve_phase_agents(
        phase_agents.as_deref(),
        agent_a_cli.as_deref(),
        agent_b_cli.as_deref(),
    )?;

    if let Some(context) = phase12_run_context.as_ref() {
        agents::emit_phase12_run_started(context);
    }

    let legacy_mode = agents::legacy_provider_mode_enabled() && !has_explicit_cli_selection;
    let (arch, prag, agent_responses) = if legacy_mode {
        if resolved_phase_agents.len() != 2 {
            return Err(
                "Legacy provider mode only supports 2 agents. Disable FRICTION_ENABLE_LEGACY_PROVIDER_MODE for x-agent CLI mode."
                    .to_string(),
            );
        }
        let (arch, prag) = agents::analyze_dual(&requirement, runtime_config.as_ref())
            .await
            .map_err(|err| {
                if let Some(context) = phase12_run_context.as_ref() {
                    agents::emit_phase12_run_failed(context, err.clone());
                }
                err
            })?;
        let responses = vec![
            NamedAgentResponse {
                id: resolved_phase_agents[0].id.clone(),
                label: resolved_phase_agents[0].label.clone(),
                cli: resolved_phase_agents[0].cli.clone(),
                response: arch.clone(),
            },
            NamedAgentResponse {
                id: resolved_phase_agents[1].id.clone(),
                label: resolved_phase_agents[1].label.clone(),
                cli: resolved_phase_agents[1].cli.clone(),
                response: prag.clone(),
            },
        ];
        (arch, prag, responses)
    } else {
        let responses = agents::analyze_multi_via_cli(
            &requirement,
            &resolved_phase_agents,
            runtime_config.as_ref(),
            phase12_run_context.as_ref(),
        )
        .await
        .map_err(|err| {
            if let Some(context) = phase12_run_context.as_ref() {
                agents::emit_phase12_run_failed(context, err.clone());
            }
            err
        })?;
        let (arch, prag) = require_dual_responses(&responses)?;
        (arch, prag, responses)
    };

    let divergences = if legacy_mode {
        let mut items = Vec::new();
        if let Some(div) = legacy_pair_divergence_string(
            "interpretation",
            &arch.interpretation,
            &prag.interpretation,
        ) {
            items.push(div);
        }
        if let Some(div) =
            legacy_pair_divergence_list("assumptions", &arch.assumptions, &prag.assumptions)
        {
            items.push(div);
        }
        if let Some(div) = legacy_pair_divergence_list("risks", &arch.risks, &prag.risks) {
            items.push(div);
        }
        if let Some(div) =
            legacy_pair_divergence_list("questions", &arch.questions, &prag.questions)
        {
            items.push(div);
        }
        if let Some(div) = legacy_pair_divergence_string("approach", &arch.approach, &prag.approach)
        {
            items.push(div);
        }
        items
    } else {
        build_phase1_divergences(&agent_responses)
    };

    if let Some(context) = phase12_run_context.as_ref() {
        agents::emit_phase12_run_finished(context);
    }

    Ok(Phase1Output {
        architect: arch,
        pragmatist: prag,
        agent_responses,
        divergences,
        human_clarifications: String::new(),
    })
}

#[cfg(not(test))]
#[tauri::command(rename_all = "snake_case")]
async fn run_phase1(
    window: tauri::Window,
    requirement: String,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    phase_agents: Option<Vec<agents::PhaseAgentInput>>,
    runtime_config: Option<agents::RuntimeConfigInput>,
    stream_request_id: Option<String>,
) -> Result<Phase1Output, String> {
    let phase12_run_context = stream_request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|request_id| {
            let command_window = window.clone();
            let emitter: agents::CliCommandLogEmitter =
                std::sync::Arc::new(move |event: agents::CliCommandLogEvent| {
                    let _ = command_window.emit(agents::CLI_COMMAND_LOG_EVENT_NAME, event);
                });
            let legacy_window = window.clone();
            let legacy_phase12_emitter: agents::Phase12CliLogEmitter =
                std::sync::Arc::new(move |event: agents::Phase12CliLogEvent| {
                    let _ = legacy_window.emit(agents::PHASE12_CLI_LOG_EVENT_NAME, event);
                });
            agents::Phase12CliRunContext {
                request_id: request_id.to_string(),
                phase: 1,
                emitter,
                legacy_phase12_emitter: Some(legacy_phase12_emitter),
            }
        });
    run_phase1_impl(
        requirement,
        agent_a_cli,
        agent_b_cli,
        phase_agents,
        runtime_config,
        phase12_run_context,
    )
    .await
}

#[cfg(test)]
async fn run_phase1(
    requirement: String,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    phase_agents: Option<Vec<agents::PhaseAgentInput>>,
    runtime_config: Option<agents::RuntimeConfigInput>,
) -> Result<Phase1Output, String> {
    run_phase1_impl(
        requirement,
        agent_a_cli,
        agent_b_cli,
        phase_agents,
        runtime_config,
        None,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
fn diagnose_phase12_cli(
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    phase_agents: Option<Vec<agents::PhaseAgentInput>>,
    runtime_config: Option<agents::RuntimeConfigInput>,
) -> Result<agents::Phase12CliDiagnosticsOutput, String> {
    let resolved_phase_agents = agents::resolve_phase_agents(
        phase_agents.as_deref(),
        agent_a_cli.as_deref(),
        agent_b_cli.as_deref(),
    )?;
    agents::diagnose_phase_agents_cli(&resolved_phase_agents, runtime_config.as_ref())
}

#[tauri::command(rename_all = "snake_case")]
async fn list_opencode_models(
    runtime_config: Option<agents::RuntimeConfigInput>,
) -> Result<OpencodeModelsOutput, String> {
    let models = agents::list_opencode_models(runtime_config.as_ref()).await?;
    Ok(OpencodeModelsOutput { models })
}

#[tauri::command(rename_all = "snake_case")]
async fn list_cli_models(
    cli_alias: String,
    runtime_config: Option<agents::RuntimeConfigInput>,
    force_refresh: Option<bool>,
) -> Result<CliModelsOutput, String> {
    let output = agents::list_cli_models(
        &cli_alias,
        runtime_config.as_ref(),
        force_refresh.unwrap_or(false),
    )
    .await?;
    Ok(CliModelsOutput {
        models: output.models,
        source: output.source,
        reason: output.reason,
        stale: output.stale,
        last_updated_at: output.last_updated_at,
        provider_mode: output.provider_mode,
    })
}

async fn run_phase2_impl(
    requirement: String,
    clarifications: String,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    phase_agents: Option<Vec<agents::PhaseAgentInput>>,
    runtime_config: Option<agents::RuntimeConfigInput>,
    phase12_run_context: Option<agents::Phase12CliRunContext>,
) -> Result<Phase2Output, String> {
    if requirement.trim().is_empty() {
        return Err("Requirement cannot be empty".to_string());
    }

    let has_explicit_cli_selection = phase_agents.is_some()
        || agent_a_cli
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
        || agent_b_cli
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();

    let resolved_phase_agents = agents::resolve_phase_agents(
        phase_agents.as_deref(),
        agent_a_cli.as_deref(),
        agent_b_cli.as_deref(),
    )?;

    if let Some(context) = phase12_run_context.as_ref() {
        agents::emit_phase12_run_started(context);
    }

    let legacy_mode = agents::legacy_provider_mode_enabled() && !has_explicit_cli_selection;
    let (arch, prag, agent_plans) = if legacy_mode {
        if resolved_phase_agents.len() != 2 {
            return Err(
                "Legacy provider mode only supports 2 agents. Disable FRICTION_ENABLE_LEGACY_PROVIDER_MODE for x-agent CLI mode."
                    .to_string(),
            );
        }
        let (arch, prag) =
            agents::plan_dual(&requirement, &clarifications, runtime_config.as_ref())
                .await
                .map_err(|err| {
                    if let Some(context) = phase12_run_context.as_ref() {
                        agents::emit_phase12_run_failed(context, err.clone());
                    }
                    err
                })?;
        let plans = vec![
            NamedAgentPlan {
                id: resolved_phase_agents[0].id.clone(),
                label: resolved_phase_agents[0].label.clone(),
                cli: resolved_phase_agents[0].cli.clone(),
                plan: arch.clone(),
            },
            NamedAgentPlan {
                id: resolved_phase_agents[1].id.clone(),
                label: resolved_phase_agents[1].label.clone(),
                cli: resolved_phase_agents[1].cli.clone(),
                plan: prag.clone(),
            },
        ];
        (arch, prag, plans)
    } else {
        let plans = agents::plan_multi_via_cli(
            &requirement,
            &clarifications,
            &resolved_phase_agents,
            runtime_config.as_ref(),
            phase12_run_context.as_ref(),
        )
        .await
        .map_err(|err| {
            if let Some(context) = phase12_run_context.as_ref() {
                agents::emit_phase12_run_failed(context, err.clone());
            }
            err
        })?;
        let (arch, prag) = require_dual_plans(&plans)?;
        (arch, prag, plans)
    };

    let divergences = if legacy_mode {
        let mut items = Vec::new();
        if let Some(div) = legacy_pair_divergence_list("stack", &arch.stack, &prag.stack) {
            items.push(div);
        }
        if let Some(div) =
            legacy_pair_divergence_string("architecture", &arch.architecture, &prag.architecture)
        {
            items.push(div);
        }
        if let Some(div) =
            legacy_pair_divergence_list("tradeoffs", &arch.tradeoffs, &prag.tradeoffs)
        {
            items.push(div);
        }
        if let Some(div) = legacy_pair_divergence_list("warnings", &arch.warnings, &prag.warnings) {
            items.push(div);
        }
        items
    } else {
        build_phase2_divergences(&agent_plans)
    };

    if let Some(context) = phase12_run_context.as_ref() {
        agents::emit_phase12_run_finished(context);
    }

    Ok(Phase2Output {
        architect: arch,
        pragmatist: prag,
        agent_plans,
        divergences,
        human_decision: String::new(),
        human_decision_structured: None,
    })
}

#[cfg(not(test))]
#[tauri::command(rename_all = "snake_case")]
async fn run_phase2(
    window: tauri::Window,
    requirement: String,
    clarifications: String,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    phase_agents: Option<Vec<agents::PhaseAgentInput>>,
    runtime_config: Option<agents::RuntimeConfigInput>,
    stream_request_id: Option<String>,
) -> Result<Phase2Output, String> {
    let phase12_run_context = stream_request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|request_id| {
            let command_window = window.clone();
            let emitter: agents::CliCommandLogEmitter =
                std::sync::Arc::new(move |event: agents::CliCommandLogEvent| {
                    let _ = command_window.emit(agents::CLI_COMMAND_LOG_EVENT_NAME, event);
                });
            let legacy_window = window.clone();
            let legacy_phase12_emitter: agents::Phase12CliLogEmitter =
                std::sync::Arc::new(move |event: agents::Phase12CliLogEvent| {
                    let _ = legacy_window.emit(agents::PHASE12_CLI_LOG_EVENT_NAME, event);
                });
            agents::Phase12CliRunContext {
                request_id: request_id.to_string(),
                phase: 2,
                emitter,
                legacy_phase12_emitter: Some(legacy_phase12_emitter),
            }
        });
    run_phase2_impl(
        requirement,
        clarifications,
        agent_a_cli,
        agent_b_cli,
        phase_agents,
        runtime_config,
        phase12_run_context,
    )
    .await
}

#[cfg(test)]
async fn run_phase2(
    requirement: String,
    clarifications: String,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    phase_agents: Option<Vec<agents::PhaseAgentInput>>,
    runtime_config: Option<agents::RuntimeConfigInput>,
) -> Result<Phase2Output, String> {
    run_phase2_impl(
        requirement,
        clarifications,
        agent_a_cli,
        agent_b_cli,
        phase_agents,
        runtime_config,
        None,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
fn save_session(record: SessionRecord) -> Result<String, String> {
    session::store::save_session(&record)
}

#[tauri::command(rename_all = "snake_case")]
fn list_sessions(limit: Option<u32>) -> Result<Vec<SessionSummary>, String> {
    let safe_limit = limit.unwrap_or(20).clamp(1, 200) as usize;
    session::store::list_sessions(safe_limit)
}

#[tauri::command(rename_all = "snake_case")]
fn load_session(id: String) -> Result<Option<SessionRecord>, String> {
    session::store::load_session(&id)
}

#[tauri::command(rename_all = "snake_case")]
fn export_consented_dataset(target_path: Option<String>) -> Result<DatasetExportResult, String> {
    session::store::export_consented_dataset(target_path)
}

#[tauri::command(rename_all = "snake_case")]
fn preview_worktrees(project_root: String) -> git::WorktreeLayout {
    git::preview_layout(&project_root)
}

#[tauri::command(rename_all = "snake_case")]
fn create_worktrees(
    repo_path: String,
    base_branch: Option<String>,
    session_id: String,
) -> Result<git::WorktreeLayout, String> {
    git::create_worktrees(
        &repo_path,
        base_branch.as_deref().unwrap_or("main"),
        &session_id,
    )
}

#[tauri::command(rename_all = "snake_case")]
fn cleanup_worktrees(repo_path: String, session_id: String) -> Result<(), String> {
    git::cleanup_worktrees(&repo_path, &session_id)
}

#[tauri::command(rename_all = "snake_case")]
fn diff_worktrees(
    repo_path: String,
    left_ref: String,
    right_ref: String,
) -> Result<String, String> {
    git::diff_refs(&repo_path, &left_ref, &right_ref)
}

async fn run_phase3_impl(
    repo_path: String,
    base_branch: Option<String>,
    requirement: String,
    clarifications: String,
    decision: String,
    session_id: Option<String>,
    judge_provider: Option<String>,
    judge_model: Option<String>,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    runtime_config: Option<agents::RuntimeConfigInput>,
    auto_cleanup: Option<bool>,
    phase12_run_context: Option<agents::Phase12CliRunContext>,
) -> Result<Phase3Output, String> {
    if repo_path.trim().is_empty() {
        if let Some(context) = phase12_run_context.as_ref() {
            agents::emit_phase12_run_failed(context, "repo_path cannot be empty".to_string());
        }
        return Err("repo_path cannot be empty".to_string());
    }
    if requirement.trim().is_empty() {
        if let Some(context) = phase12_run_context.as_ref() {
            agents::emit_phase12_run_failed(context, "requirement cannot be empty".to_string());
        }
        return Err("requirement cannot be empty".to_string());
    }

    if let Some(context) = phase12_run_context.as_ref() {
        agents::emit_phase12_run_started(context);
    }

    let resolved_session_id = session_id.unwrap_or_else(|| format!("s{}", Uuid::new_v4().simple()));
    let base = base_branch.unwrap_or_else(|| "main".to_string());
    let should_cleanup = auto_cleanup.unwrap_or(true);

    let layout = git::create_worktrees(&repo_path, &base, &resolved_session_id).map_err(|err| {
        if let Some(context) = phase12_run_context.as_ref() {
            agents::emit_phase12_run_failed(context, err.clone());
        }
        err
    })?;
    let execution = async {
        let resolved_agent_a_cli = agents::resolve_agent_a_cli(agent_a_cli.as_deref())?;
        let code_a = agents::generate_candidate_via_cli(
            &resolved_agent_a_cli,
            &requirement,
            &clarifications,
            &decision,
            &layout.agent_a_worktree,
            runtime_config.as_ref(),
            phase12_run_context.as_ref(),
        )
        .await?;

        let candidate_path = ".friction/generated/candidate.ts";
        git::write_candidate_file(&layout.agent_a_worktree, candidate_path, &code_a)?;

        git::commit_candidate_file(
            &layout.agent_a_worktree,
            candidate_path,
            &format!("friction: agent-{resolved_agent_a_cli} phase3 candidate"),
        )?;

        let resolved_reviewer_cli = agents::resolve_reviewer_cli(agent_b_cli.as_deref())?;
        let (attack_report, reviewer_payload) = agents::generate_attack_report_via_cli(
            &resolved_reviewer_cli,
            &requirement,
            &code_a,
            &layout.agent_b_worktree,
            runtime_config.as_ref(),
            phase12_run_context.as_ref(),
        )
        .await?;

        let diff = git::diff_refs(&repo_path, &layout.agent_b_branch, &layout.agent_a_branch)?;
        let attack_report_json = serde_json::to_string(&attack_report).map_err(|err| {
            format!("failed to serialize attack report for confidence scoring: {err}")
        })?;
        let confidence_score = judge::evaluate_confidence(
            &requirement,
            &diff,
            &code_a,
            &attack_report_json,
            judge_provider.as_deref(),
            judge_model.as_deref(),
        )
        .await?;
        let (adr_path, adr_markdown) = write_adr_markdown(
            &repo_path,
            &resolved_session_id,
            &requirement,
            &clarifications,
            &decision,
            &attack_report,
            confidence_score,
        )?;

        Ok::<Phase3Output, String>(Phase3Output {
            code_a,
            code_b: reviewer_payload,
            git_diff: diff,
            attack_report,
            confidence_score,
            session_id: resolved_session_id.clone(),
            agent_a_branch: layout.agent_a_branch.clone(),
            agent_b_branch: layout.agent_b_branch.clone(),
            adr_path: Some(adr_path),
            adr_markdown: Some(adr_markdown),
        })
    }
    .await;

    if should_cleanup {
        let _ = git::cleanup_worktrees(&repo_path, &resolved_session_id);
    }

    match execution {
        Ok(result) => {
            if let Some(context) = phase12_run_context.as_ref() {
                agents::emit_phase12_run_finished(context);
            }
            Ok(result)
        }
        Err(err) => {
            if let Some(context) = phase12_run_context.as_ref() {
                agents::emit_phase12_run_failed(context, err.clone());
            }
            Err(err)
        }
    }
}

#[cfg(not(test))]
#[tauri::command(rename_all = "snake_case")]
async fn run_phase3(
    window: tauri::Window,
    repo_path: String,
    base_branch: Option<String>,
    requirement: String,
    clarifications: String,
    decision: String,
    session_id: Option<String>,
    judge_provider: Option<String>,
    judge_model: Option<String>,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    runtime_config: Option<agents::RuntimeConfigInput>,
    auto_cleanup: Option<bool>,
    stream_request_id: Option<String>,
) -> Result<Phase3Output, String> {
    let phase12_run_context = stream_request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|request_id| {
            let command_window = window.clone();
            let emitter: agents::CliCommandLogEmitter =
                std::sync::Arc::new(move |event: agents::CliCommandLogEvent| {
                    let _ = command_window.emit(agents::CLI_COMMAND_LOG_EVENT_NAME, event);
                });
            agents::Phase12CliRunContext {
                request_id: request_id.to_string(),
                phase: 3,
                emitter,
                legacy_phase12_emitter: None,
            }
        });
    run_phase3_impl(
        repo_path,
        base_branch,
        requirement,
        clarifications,
        decision,
        session_id,
        judge_provider,
        judge_model,
        agent_a_cli,
        agent_b_cli,
        runtime_config,
        auto_cleanup,
        phase12_run_context,
    )
    .await
}

#[cfg(test)]
async fn run_phase3(
    repo_path: String,
    base_branch: Option<String>,
    requirement: String,
    clarifications: String,
    decision: String,
    session_id: Option<String>,
    judge_provider: Option<String>,
    judge_model: Option<String>,
    agent_a_cli: Option<String>,
    agent_b_cli: Option<String>,
    runtime_config: Option<agents::RuntimeConfigInput>,
    auto_cleanup: Option<bool>,
) -> Result<Phase3Output, String> {
    run_phase3_impl(
        repo_path,
        base_branch,
        requirement,
        clarifications,
        decision,
        session_id,
        judge_provider,
        judge_model,
        agent_a_cli,
        agent_b_cli,
        runtime_config,
        auto_cleanup,
        None,
    )
    .await
}

fn write_adr_markdown(
    repo_path: &str,
    session_id: &str,
    requirement: &str,
    clarifications: &str,
    decision: &str,
    attack_report: &[AttackReportItem],
    confidence_score: f32,
) -> Result<(String, String), String> {
    let short_requirement = requirement
        .split_whitespace()
        .take(12)
        .collect::<Vec<_>>()
        .join(" ");
    let adr_title = if short_requirement.is_empty() {
        format!("ADR-{session_id}")
    } else {
        format!("ADR-{session_id}: {short_requirement}")
    };

    let findings = if attack_report.is_empty() {
        "- No adversarial findings were reported.".to_string()
    } else {
        attack_report
            .iter()
            .map(|item| format!("- [{}] {} — {}", item.severity, item.title, item.detail))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let markdown = format!(
        "# {adr_title}\n\n## Context\n- Session ID: `{session_id}`\n- Requirement: {requirement}\n- Clarifications: {clarifications}\n\n## Decision\n{decision}\n\n## Alternatives Considered\n- Architect-first path: prioritize robustness and explicit validation.\n- Pragmatist-first path: prioritize speed and minimal implementation scope.\n- Hybrid path: keep strict validation on critical paths, simplify non-critical layers.\n\n## Consequences\n- Confidence score: {confidence_score:.2}\n- Adversarial findings:\n{findings}\n"
    );

    let adr_path = PathBuf::from(repo_path)
        .join(".friction")
        .join("adr")
        .join(format!("ADR-{session_id}.md"));
    if let Some(parent) = adr_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create ADR directory {:?}: {err}", parent))?;
    }
    fs::write(&adr_path, &markdown)
        .map_err(|err| format!("failed to write ADR file {:?}: {err}", adr_path))?;

    Ok((adr_path.to_string_lossy().to_string(), markdown))
}

#[tauri::command(rename_all = "snake_case")]
fn preview_diff() -> String {
    git::diff_stub("agent-claude", "agent-gpt4o")
}

#[cfg(not(test))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_phase1,
            diagnose_phase12_cli,
            list_opencode_models,
            list_cli_models,
            run_phase2,
            save_session,
            list_sessions,
            load_session,
            export_consented_dataset,
            preview_worktrees,
            create_worktrees,
            cleanup_worktrees,
            diff_worktrees,
            run_phase3,
            preview_diff
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(not(test))]
fn main() {
    run();
}

#[cfg(test)]
fn main() {}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::collections::HashSet;
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn run_git(repo: &Path, args: &[&str]) -> Result<(), String> {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .map_err(|err| format!("failed to run git {:?}: {err}", args))?;

        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    fn init_temp_repo() -> Result<PathBuf, String> {
        let root = std::env::temp_dir().join(format!("friction-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root)
            .map_err(|err| format!("failed to create temp repo dir {:?}: {err}", root))?;

        let init_main = run_git(&root, &["init", "-b", "main"]);
        if init_main.is_err() {
            run_git(&root, &["init"])?;
            run_git(&root, &["checkout", "-b", "main"])?;
        }

        fs::write(root.join("README.md"), "friction test repo\n")
            .map_err(|err| format!("failed to write readme: {err}"))?;

        run_git(&root, &["add", "README.md"])?;
        run_git(
            &root,
            &[
                "-c",
                "user.name=FrictionTests",
                "-c",
                "user.email=tests@friction.local",
                "commit",
                "-m",
                "init",
            ],
        )?;

        Ok(root)
    }

    fn force_mock_env() {
        std::env::set_var("FRICTION_ARCHITECT_PROVIDER", "mock");
        std::env::set_var("FRICTION_PRAGMATIST_PROVIDER", "mock");
    }

    struct EnvVarGuard {
        key: &'static str,
        old: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let old = env::var(key).ok();
            env::set_var(key, value);
            Self { key, old }
        }

        fn unset(key: &'static str) -> Self {
            let old = env::var(key).ok();
            env::remove_var(key);
            Self { key, old }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.old {
                env::set_var(self.key, previous);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    fn make_script(dir: &Path, name: &str, content: &str) -> Result<PathBuf, String> {
        let path = dir.join(name);
        fs::write(&path, content)
            .map_err(|err| format!("failed to write script {:?}: {err}", path))?;

        let status = Command::new("chmod")
            .arg("+x")
            .arg(&path)
            .status()
            .map_err(|err| format!("failed to chmod script {:?}: {err}", path))?;
        if !status.success() {
            return Err(format!("chmod failed for script {:?}", path));
        }

        Ok(path)
    }

    fn setup_fake_phase12_clis() -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
        let root = std::env::temp_dir().join(format!("friction-cli-phase12-{}", Uuid::new_v4()));
        fs::create_dir_all(&root)
            .map_err(|err| format!("failed to create fake cli dir {:?}: {err}", root))?;

        let claude_script = r#"#!/usr/bin/env bash
set -euo pipefail
prompt=""
model=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p)
      shift
      prompt="${1:-}"
      ;;
    --model)
      shift
      model="${1:-}"
      ;;
  esac
  shift || true
done
if [[ -n "${FRICTION_EXPECTED_CLAUDE_MODEL:-}" && "$model" != "$FRICTION_EXPECTED_CLAUDE_MODEL" ]]; then
  echo "claude usage error: expected model '$FRICTION_EXPECTED_CLAUDE_MODEL' but got '$model'" >&2
  exit 2
fi
if [[ "$prompt" == *'"stack"'* || "$prompt" == *'Clarifications du client'* ]]; then
cat <<'JSON'
{"stack":["typescript","tauri"],"phases":[{"name":"phase","duration":"1d","tasks":["task-a","task-b"]}],"architecture":"cli-first architecture","tradeoffs":["speed vs rigor"],"warnings":["watch timeouts"]}
JSON
else
cat <<'JSON'
{"interpretation":"cli-first interpretation","assumptions":["a1","a2"],"risks":["r1","r2"],"questions":["q1","q2"],"approach":"ship with strict validation"}
JSON
fi
"#;
        let codex_script = r#"#!/usr/bin/env bash
set -euo pipefail
output=""
model=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "-o" && $((i+1)) -lt ${#args[@]} ]]; then
    output="${args[$((i+1))]}"
  fi
  if [[ "${args[$i]}" == "--model" && $((i+1)) -lt ${#args[@]} ]]; then
    model="${args[$((i+1))]}"
  fi
done
if [[ -n "${FRICTION_EXPECTED_CODEX_MODEL:-}" && "$model" != "$FRICTION_EXPECTED_CODEX_MODEL" ]]; then
  echo "codex usage error: expected model '$FRICTION_EXPECTED_CODEX_MODEL' but got '$model'" >&2
  exit 2
fi
prompt="${args[$((${#args[@]}-1))]}"
if [[ "$prompt" == *'"stack"'* || "$prompt" == *'Clarifications du client'* ]]; then
  payload='{"stack":["rust","sqlite"],"phases":[{"name":"phase","duration":"2d","tasks":["task-c","task-d"]}],"architecture":"cli-first alt architecture","tradeoffs":["cost vs latency"],"warnings":["ensure rollback"]}'
else
  payload='{"interpretation":"cli-first interpretation codex","assumptions":["b1","b2"],"risks":["rb1","rb2"],"questions":["qb1","qb2"],"approach":"pragmatic path"}'
fi
if [[ -n "$output" ]]; then
  printf '%s\n' "$payload" > "$output"
else
  printf '%s\n' "$payload"
fi
"#;
        let gemini_script = r#"#!/usr/bin/env bash
set -euo pipefail
prompt=""
model=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p)
      shift
      prompt="${1:-}"
      ;;
    --model)
      shift
      model="${1:-}"
      ;;
  esac
  shift || true
done
if [[ -n "${FRICTION_EXPECTED_GEMINI_MODEL:-}" && "$model" != "$FRICTION_EXPECTED_GEMINI_MODEL" ]]; then
  echo "gemini usage error: expected model '$FRICTION_EXPECTED_GEMINI_MODEL' but got '$model'" >&2
  exit 2
fi
if [[ "$prompt" == *'"stack"'* || "$prompt" == *'Clarifications du client'* ]]; then
cat <<'JSON'
{"stack":["node","react"],"phases":[{"name":"phase","duration":"3d","tasks":["task-e","task-f"]}],"architecture":"gemini architecture","tradeoffs":["simplicity vs completeness"],"warnings":["monitor errors"]}
JSON
else
cat <<'JSON'
{"interpretation":"gemini interpretation","assumptions":["g1","g2"],"risks":["gr1","gr2"],"questions":["gq1","gq2"],"approach":"balanced path"}
JSON
fi
"#;

        let claude_path = make_script(&root, "fake-claude", claude_script)?;
        let codex_path = make_script(&root, "fake-codex", codex_script)?;
        let gemini_path = make_script(&root, "fake-gemini", gemini_script)?;

        Ok((root, claude_path, codex_path, gemini_path))
    }

    fn setup_fake_phase3_clis(
        codex_payload: &str,
        gemini_payload: &str,
    ) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
        let root = std::env::temp_dir().join(format!("friction-cli-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root)
            .map_err(|err| format!("failed to create fake cli dir {:?}: {err}", root))?;

        let claude_script = r#"#!/usr/bin/env bash
set -euo pipefail
prompt=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-p" ]]; then
    shift
    prompt="${1:-}"
  fi
  shift || true
done
if [[ "$prompt" == *'attack_report'* || "$prompt" == *'Return STRICT JSON'* ]]; then
cat <<'JSON'
{"attack_report":[{"severity":"medium","title":"Claude reviewer finding","detail":"Missing explicit error taxonomy in one failure branch."}]}
JSON
else
cat <<'TS'
type Input = { payload: string };

export function execute_candidate(input: Input) {
  if (!input.payload || input.payload.trim().length < 3) {
    throw new Error("invalid payload");
  }
  return { status: "ok", message: "candidate generated" };
}
TS
fi
"#;
        let codex_script = format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
cat <<'JSON'
{codex_payload}
JSON
"#
        );
        let gemini_script = format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
cat <<'JSON'
{gemini_payload}
JSON
"#
        );

        let claude_path = make_script(&root, "fake-claude", claude_script)?;
        let codex_path = make_script(&root, "fake-codex", &codex_script)?;
        let gemini_path = make_script(&root, "fake-gemini", &gemini_script)?;

        Ok((root, claude_path, codex_path, gemini_path))
    }

    fn setup_fake_opencode_cli(
        analysis_payload: &str,
        plan_payload: &str,
        attack_payload: &str,
    ) -> Result<(PathBuf, PathBuf), String> {
        let root = std::env::temp_dir().join(format!("friction-opencode-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root)
            .map_err(|err| format!("failed to create fake opencode dir {:?}: {err}", root))?;

        let script = format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${{1:-}}" != "run" ]]; then
  echo "opencode usage error: expected subcommand 'run'" >&2
  exit 2
fi
shift

format=""
model=""
prompt_parts=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --format)
      shift
      format="${{1:-}}"
      ;;
    --format=*)
      format="${{1#*=}}"
      ;;
    --model)
      shift
      model="${{1:-}}"
      ;;
    --model=*)
      model="${{1#*=}}"
      ;;
    --*)
      ;;
    *)
      prompt_parts+=("$1")
      ;;
  esac
  shift || true
done

if [[ "$format" != "json" ]]; then
  echo "opencode usage error: expected --format json" >&2
  exit 2
fi

if [[ -n "${{FRICTION_EXPECTED_OPENCODE_MODEL:-}}" && "$model" != "$FRICTION_EXPECTED_OPENCODE_MODEL" ]]; then
  echo "opencode usage error: expected model '$FRICTION_EXPECTED_OPENCODE_MODEL' but got '$model'" >&2
  exit 2
fi

prompt="${{prompt_parts[*]}}"
if [[ "$prompt" == *'attack_report'* || "$prompt" == *'Return STRICT JSON'* ]]; then
  payload='{attack_payload}'
elif [[ "$prompt" == *'"stack"'* || "$prompt" == *'Clarifications du client'* ]]; then
  payload='{plan_payload}'
else
  payload='{analysis_payload}'
fi

echo "Performing one time database migration, may take a few minutes..."
echo "sqlite-migration:done"
echo '{{"type":"step_start","part":{{"type":"step-start"}}}}'
printf '{{"type":"text","part":{{"text":%s}}}}\n' "$payload"
echo '{{"type":"step_finish","part":{{"type":"step-finish","reason":"stop"}}}}'
"#
        );
        let opencode_path = make_script(&root, "fake-opencode", &script)?;
        Ok((root, opencode_path))
    }

    fn setup_fake_opencode_models_cli(lines: &[&str]) -> Result<(PathBuf, PathBuf), String> {
        let root =
            std::env::temp_dir().join(format!("friction-opencode-models-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).map_err(|err| {
            format!(
                "failed to create fake opencode models dir {:?}: {err}",
                root
            )
        })?;
        let payload = lines.join("\\n");
        let script = format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${{1:-}}" == "models" ]]; then
  printf "%b\n" "{payload}"
  exit 0
fi
echo "unexpected command: $*" >&2
exit 2
"#
        );
        let opencode_path = make_script(&root, "fake-opencode-models", &script)?;
        Ok((root, opencode_path))
    }

    fn runtime_cli_config(commands: &[(&str, String)]) -> agents::RuntimeConfigInput {
        agents::RuntimeConfigInput {
            architect: None,
            pragmatist: None,
            ollama_host: None,
            cli_models: None,
            agent_cli_models: None,
            cli_commands: Some(
                commands
                    .iter()
                    .map(|(alias, command)| (alias.to_string(), command.clone()))
                    .collect(),
            ),
        }
    }

    fn runtime_cli_config_from_paths(
        claude_path: &Path,
        codex_path: &Path,
        gemini_path: &Path,
    ) -> agents::RuntimeConfigInput {
        runtime_cli_config(&[
            ("claude", claude_path.to_string_lossy().to_string()),
            ("codex", codex_path.to_string_lossy().to_string()),
            ("gemini", gemini_path.to_string_lossy().to_string()),
        ])
    }

    fn list_phase12_isolation_dirs() -> HashSet<PathBuf> {
        let temp_root = env::temp_dir();
        fs::read_dir(&temp_root)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.flatten())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with("friction-phase12-isolation-"))
                    .unwrap_or(false)
            })
            .collect()
    }

    #[tokio::test]
    #[serial]
    async fn phase1_phase2_cli_first_flow() {
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _claude_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::set("OPENAI_API_KEY", "test-openai-key");
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let requirement = "API auth B2C avec MFA, audit trail et reset password";
        let clarifications = "Stack imposée: React+Node. SLA 99.9%. Journalisation obligatoire des opérations sensibles.";

        let phase1 = run_phase1(
            requirement.to_string(),
            Some("claude".to_string()),
            Some("codex".to_string()),
            None,
            Some(runtime_config.clone()),
        )
        .await
        .expect("phase1 should succeed");
        assert!(!phase1.divergences.is_empty());
        assert!(!phase1.architect.questions.is_empty());

        let phase2 = run_phase2(
            requirement.to_string(),
            clarifications.to_string(),
            Some("gemini".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase2 should succeed");
        assert!(!phase2.divergences.is_empty());
        assert!(!phase2.architect.stack.is_empty());

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_phase2_support_x_agents_cli_mode() {
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _claude_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::set("OPENAI_API_KEY", "test-openai-key");
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let phase_agents = vec![
            agents::PhaseAgentInput {
                id: "agent_a".to_string(),
                label: "Agent A · Architect".to_string(),
                cli: "claude".to_string(),
            },
            agents::PhaseAgentInput {
                id: "agent_b".to_string(),
                label: "Agent B · Pragmatist".to_string(),
                cli: "codex".to_string(),
            },
            agents::PhaseAgentInput {
                id: "agent_c".to_string(),
                label: "Agent C · Challenger".to_string(),
                cli: "gemini".to_string(),
            },
        ];

        let phase1 = run_phase1(
            "Offline-first collaborative memory layer".to_string(),
            None,
            None,
            Some(phase_agents.clone()),
            Some(runtime_config.clone()),
        )
        .await
        .expect("phase1 should succeed in x-agent mode");
        assert_eq!(phase1.agent_responses.len(), 3);
        assert_eq!(phase1.agent_responses[2].id, "agent_c");
        assert!(!phase1.agent_responses[2].response.questions.is_empty());

        let phase2 = run_phase2(
            "Offline-first collaborative memory layer".to_string(),
            "Must run on a single laptop first.".to_string(),
            None,
            None,
            Some(phase_agents),
            Some(runtime_config),
        )
        .await
        .expect("phase2 should succeed in x-agent mode");
        assert_eq!(phase2.agent_plans.len(), 3);
        assert_eq!(phase2.agent_plans[2].label, "Agent C · Challenger");

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_respects_first_agent_cli_selection() {
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _claude_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::set("OPENAI_API_KEY", "test-openai-key");
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let phase_agents = vec![
            agents::PhaseAgentInput {
                id: "agent_a".to_string(),
                label: "Agent A · Architect".to_string(),
                cli: "codex".to_string(),
            },
            agents::PhaseAgentInput {
                id: "agent_b".to_string(),
                label: "Agent B · Pragmatist".to_string(),
                cli: "gemini".to_string(),
            },
        ];

        let phase1 = run_phase1(
            "Offline-first memory server".to_string(),
            None,
            None,
            Some(phase_agents),
            Some(runtime_config),
        )
        .await
        .expect("phase1 should succeed");

        assert_eq!(phase1.agent_responses[0].cli, "codex");
        assert!(
            phase1.architect.interpretation.contains("codex"),
            "Agent A response should come from codex CLI, got: {}",
            phase1.architect.interpretation
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_respects_agent_cli_arguments_without_phase_agents() {
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _claude_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::set("OPENAI_API_KEY", "test-openai-key");
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let phase1 = run_phase1(
            "Cross-agent memory hub".to_string(),
            Some("gemini".to_string()),
            Some("codex".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should succeed");

        assert_eq!(phase1.agent_responses[0].cli, "gemini");
        assert_eq!(phase1.agent_responses[1].cli, "codex");
        assert!(
            phase1.architect.interpretation.contains("gemini"),
            "Agent A response should come from gemini CLI, got: {}",
            phase1.architect.interpretation
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[test]
    #[serial]
    fn diagnose_phase12_cli_reports_resolution_details() {
        let (cli_root, _claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let mut runtime_config = runtime_cli_config(&[
            ("codex", codex_path.to_string_lossy().to_string()),
            ("gemini", gemini_path.to_string_lossy().to_string()),
        ]);
        runtime_config.cli_models = Some(std::collections::HashMap::from([(
            "codex".to_string(),
            "gpt-5-codex".to_string(),
        )]));
        runtime_config.agent_cli_models = Some(std::collections::HashMap::from([(
            "agent_a".to_string(),
            "gpt-5.3-codex".to_string(),
        )]));

        let diagnostics = diagnose_phase12_cli(
            None,
            None,
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "codex".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "gemini".to_string(),
                },
            ]),
            Some(runtime_config),
        )
        .expect("diagnostics should succeed");

        assert_eq!(diagnostics.agents.len(), 2);
        assert_eq!(diagnostics.agents[0].selected_cli, "codex");
        assert_eq!(
            diagnostics.agents[0].resolved_command,
            codex_path.to_string_lossy().to_string()
        );
        assert_eq!(
            diagnostics.agents[0].resolved_command_source,
            "runtime:cli_commands.codex"
        );
        assert_eq!(diagnostics.agents[0].resolved_family, "codex");
        assert_eq!(
            diagnostics.agents[0].resolved_model.as_deref(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            diagnostics.agents[0].resolved_model_source.as_deref(),
            Some("runtime:agent_cli_models.agent_a")
        );
        assert!(
            diagnostics.agents[0].resolved_binary_path.is_some(),
            "expected binary path for codex to be resolved"
        );
        assert_eq!(diagnostics.agents[1].resolved_model, None);
        assert_eq!(
            diagnostics.agents[1].resolved_model_source.as_deref(),
            Some("default:gemini")
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[test]
    #[serial]
    fn diagnose_phase12_cli_detects_family_mismatch_from_runtime_override() {
        let (cli_root, claude_path, _codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let runtime_config = runtime_cli_config(&[
            ("codex", claude_path.to_string_lossy().to_string()),
            ("gemini", gemini_path.to_string_lossy().to_string()),
        ]);

        let diagnostics = diagnose_phase12_cli(
            None,
            None,
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "codex".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "gemini".to_string(),
                },
            ]),
            Some(runtime_config),
        )
        .expect("diagnostics should succeed");

        assert_eq!(diagnostics.agents[0].selected_cli, "codex");
        assert_eq!(
            diagnostics.agents[0].resolved_command,
            claude_path.to_string_lossy().to_string()
        );
        assert_eq!(
            diagnostics.agents[0].resolved_command_source,
            "runtime:cli_commands.codex"
        );
        assert_eq!(diagnostics.agents[0].resolved_family, "claude");

        let _ = fs::remove_dir_all(cli_root);
    }

    #[test]
    #[serial]
    fn diagnose_phase12_cli_prefers_runtime_cli_override_even_when_env_is_set() {
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", claude_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );

        let runtime_config = agents::RuntimeConfigInput {
            architect: None,
            pragmatist: None,
            ollama_host: None,
            cli_models: None,
            agent_cli_models: None,
            cli_commands: Some(std::collections::HashMap::from([
                (
                    "codex".to_string(),
                    codex_path.to_string_lossy().to_string(),
                ),
                (
                    "gemini".to_string(),
                    gemini_path.to_string_lossy().to_string(),
                ),
            ])),
        };

        let diagnostics = diagnose_phase12_cli(
            None,
            None,
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "codex".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "gemini".to_string(),
                },
            ]),
            Some(runtime_config),
        )
        .expect("diagnostics should succeed");

        assert_eq!(diagnostics.agents[0].selected_cli, "codex");
        assert_eq!(
            diagnostics.agents[0].resolved_command,
            codex_path.to_string_lossy().to_string()
        );
        assert_eq!(
            diagnostics.agents[0].resolved_command_source,
            "runtime:cli_commands.codex"
        );
        assert_eq!(diagnostics.agents[0].resolved_family, "codex");

        let _ = fs::remove_dir_all(cli_root);
    }

    #[test]
    #[serial]
    fn diagnose_phase12_cli_falls_back_to_default_when_no_runtime_override() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _codex_cli = EnvVarGuard::set("FRICTION_CODEX_CLI", "/tmp/custom-codex");
        let _phase3_codex_cli = EnvVarGuard::set("FRICTION_PHASE3_CODEX_CLI", "/tmp/legacy-codex");
        let _gemini_cli = EnvVarGuard::set("FRICTION_GEMINI_CLI", "/tmp/custom-gemini");
        let _phase3_gemini_cli =
            EnvVarGuard::set("FRICTION_PHASE3_GEMINI_CLI", "/tmp/legacy-gemini");

        let diagnostics = diagnose_phase12_cli(
            None,
            None,
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "codex".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "gemini".to_string(),
                },
            ]),
            None,
        )
        .expect("diagnostics should succeed");

        assert_eq!(diagnostics.agents[0].resolved_command, "codex");
        assert_eq!(
            diagnostics.agents[0].resolved_command_source,
            "default:codex"
        );
        assert_eq!(diagnostics.agents[1].resolved_command, "gemini");
        assert_eq!(
            diagnostics.agents[1].resolved_command_source,
            "default:gemini"
        );
    }

    #[test]
    #[serial]
    fn diagnose_phase12_cli_codex_reports_not_ready_without_auth() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::unset("OPENAI_API_KEY");
        let _codex_home = EnvVarGuard::unset("CODEX_HOME");
        let temp_home =
            std::env::temp_dir().join(format!("friction-codex-home-missing-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_home).expect("temp home for missing codex auth should exist");
        let _home = EnvVarGuard::set("HOME", temp_home.to_string_lossy().as_ref());
        let (cli_root, _claude_path, codex_path, _gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let runtime_config =
            runtime_cli_config(&[("codex", codex_path.to_string_lossy().to_string())]);

        let diagnostics = diagnose_phase12_cli(
            None,
            None,
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "codex".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "gemini".to_string(),
                },
            ]),
            Some(runtime_config),
        )
        .expect("diagnostics should succeed");

        assert!(!diagnostics.agents[0].runtime_ready);
        assert_eq!(diagnostics.agents[0].readiness_source, "none");
        assert!(diagnostics.agents[0].requires_auth);
        assert!(diagnostics.agents[0]
            .readiness_reason
            .as_deref()
            .unwrap_or_default()
            .contains("Codex auth missing in isolated runtime"));
        assert!(!diagnostics.agents[1].runtime_ready);
        assert!(diagnostics.agents[1].requires_auth);
        assert!(diagnostics.agents[1]
            .readiness_reason
            .as_deref()
            .unwrap_or_default()
            .contains("Gemini auth missing in strict phase1/2 isolation"));

        let _ = fs::remove_dir_all(temp_home);
        let _ = fs::remove_dir_all(cli_root);
    }

    #[test]
    #[serial]
    fn diagnose_phase12_cli_codex_reports_ready_with_host_auth_file() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::unset("OPENAI_API_KEY");
        let _codex_home = EnvVarGuard::unset("CODEX_HOME");
        let temp_home =
            std::env::temp_dir().join(format!("friction-codex-home-auth-{}", Uuid::new_v4()));
        let codex_home_dir = temp_home.join(".codex");
        fs::create_dir_all(&codex_home_dir).expect("temp codex home should exist");
        fs::write(codex_home_dir.join("auth.json"), "{\"token\":\"x\"}")
            .expect("auth.json should be created");
        let _home = EnvVarGuard::set("HOME", temp_home.to_string_lossy().as_ref());
        let (cli_root, _claude_path, codex_path, _gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let runtime_config =
            runtime_cli_config(&[("codex", codex_path.to_string_lossy().to_string())]);

        let diagnostics = diagnose_phase12_cli(
            None,
            None,
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "codex".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "gemini".to_string(),
                },
            ]),
            Some(runtime_config),
        )
        .expect("diagnostics should succeed");

        assert!(diagnostics.agents[0].runtime_ready);
        assert_eq!(diagnostics.agents[0].readiness_source, "codex_auth_file");
        assert_eq!(diagnostics.agents[0].readiness_reason, None);
        assert!(diagnostics.agents[0].requires_auth);

        let _ = fs::remove_dir_all(temp_home);
        let _ = fs::remove_dir_all(cli_root);
    }

    #[test]
    #[serial]
    fn diagnose_phase12_cli_reports_opencode_runtime_override() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let (cli_root, opencode_path) = setup_fake_opencode_cli(
            r#"{"interpretation":"opencode interpretation","assumptions":["o1","o2"],"risks":["or1","or2"],"questions":["oq1","oq2"],"approach":"opencode path"}"#,
            r#"{"stack":["opencode","tauri"],"phases":[{"name":"phase","duration":"1d","tasks":["task-op-a","task-op-b"]}],"architecture":"opencode planner architecture","tradeoffs":["cost vs speed"],"warnings":["watch opencode constraints"]}"#,
            r#"{"attack_report":[{"severity":"medium","title":"OpenCode reviewer finding","detail":"Missing explicit retry policy in one branch."}]}"#,
        )
        .expect("fake opencode cli should be created");
        let runtime_config =
            runtime_cli_config(&[("opencode", opencode_path.to_string_lossy().to_string())]);

        let diagnostics = diagnose_phase12_cli(
            None,
            None,
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "opencode".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "opencode".to_string(),
                },
            ]),
            Some(runtime_config),
        )
        .expect("diagnostics should succeed for opencode override");

        assert_eq!(diagnostics.agents[0].selected_cli, "opencode");
        assert_eq!(
            diagnostics.agents[0].resolved_command,
            opencode_path.to_string_lossy().to_string()
        );
        assert_eq!(
            diagnostics.agents[0].resolved_command_source,
            "runtime:cli_commands.opencode"
        );
        assert_eq!(diagnostics.agents[0].resolved_family, "opencode");
        assert!(
            diagnostics.agents[0].resolved_binary_path.is_some(),
            "expected binary path for opencode override to be resolved"
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[test]
    #[serial]
    fn diagnose_phase12_cli_falls_back_to_default_for_opencode() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");

        let diagnostics = diagnose_phase12_cli(
            None,
            None,
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "opencode".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "codex".to_string(),
                },
            ]),
            None,
        )
        .expect("diagnostics should succeed");

        assert_eq!(diagnostics.agents[0].resolved_command, "opencode");
        assert_eq!(
            diagnostics.agents[0].resolved_command_source,
            "default:opencode"
        );
    }

    #[tokio::test]
    #[serial]
    async fn list_opencode_models_returns_cli_models() {
        let (cli_root, opencode_path) = setup_fake_opencode_models_cli(&[
            "opencode/gpt-5-nano",
            "opencode/trinity-large-preview-free",
            "not-a-model-line",
        ])
        .expect("fake opencode models cli should be created");
        let runtime_config =
            runtime_cli_config(&[("opencode", opencode_path.to_string_lossy().to_string())]);

        let payload = list_opencode_models(Some(runtime_config))
            .await
            .expect("list_opencode_models should succeed");
        assert_eq!(payload.models.len(), 2);
        assert_eq!(payload.models[0], "opencode/gpt-5-nano");
        assert_eq!(payload.models[1], "opencode/trinity-large-preview-free");

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn list_opencode_models_retries_with_isolated_env_when_config_is_invalid() {
        let root = std::env::temp_dir().join(format!(
            "friction-opencode-models-isolated-retry-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temp dir for opencode retry test");
        let script = make_script(
            &root,
            "fake-opencode-models-retry",
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "models" ]]; then
  echo "unexpected command: $*" >&2
  exit 2
fi
if [[ "${XDG_STATE_HOME:-}" == *"friction-phase12-isolation-"* ]]; then
  echo "opencode/local-llama3.2"
  exit 0
fi
echo "Error: Config file at /Users/test/.config/opencode/opencode.json is not valid JSON(C)" >&2
exit 1
"#,
        )
        .expect("fake opencode models retry script should be created");

        let runtime_config =
            runtime_cli_config(&[("opencode", script.to_string_lossy().to_string())]);
        let payload = list_opencode_models(Some(runtime_config))
            .await
            .expect("list_opencode_models should retry with isolated env");

        assert_eq!(payload.models, vec!["opencode/local-llama3.2"]);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn list_cli_models_returns_live_models_for_opencode() {
        let (cli_root, opencode_path) =
            setup_fake_opencode_models_cli(&["opencode/gpt-5-nano", "opencode/minimax-m2.5-free"])
                .expect("fake opencode models cli should be created");
        let runtime_config =
            runtime_cli_config(&[("opencode", opencode_path.to_string_lossy().to_string())]);

        let payload = list_cli_models("opencode".to_string(), Some(runtime_config), None)
            .await
            .expect("list_cli_models should succeed for opencode");

        assert_eq!(payload.source, "live");
        assert_eq!(payload.reason, None);
        assert_eq!(
            payload.models,
            vec![
                "opencode/gpt-5-nano".to_string(),
                "opencode/minimax-m2.5-free".to_string()
            ]
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn list_cli_models_returns_cache_on_second_call_for_same_alias_and_command() {
        let (cli_root, opencode_path) = setup_fake_opencode_models_cli(&["opencode/gpt-5-nano"])
            .expect("fake opencode models cli should be created");
        let runtime_config =
            runtime_cli_config(&[("opencode", opencode_path.to_string_lossy().to_string())]);

        let first = list_cli_models("opencode".to_string(), Some(runtime_config.clone()), None)
            .await
            .expect("first list_cli_models call should succeed");
        assert_eq!(first.source, "live");
        assert!(!first.stale);

        let second = list_cli_models("opencode".to_string(), Some(runtime_config), None)
            .await
            .expect("second list_cli_models call should succeed");
        assert_eq!(second.source, "cache");
        assert!(!second.stale);
        assert_eq!(second.models, vec!["opencode/gpt-5-nano".to_string()]);

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn list_cli_models_preserves_cached_live_models_when_refresh_falls_back() {
        let root = std::env::temp_dir().join(format!(
            "friction-opencode-models-preserve-live-cache-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temp dir for live cache preservation test");
        let fail_marker = root.join("fallback-after-first-call.marker");
        let script = make_script(
            &root,
            "fake-opencode-models-preserve-live-cache",
            &format!(
                r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${{1:-}}" != "models" ]]; then
  echo "unexpected command: $*" >&2
  exit 2
fi
if [[ -f "{}" ]]; then
  echo "transient upstream failure" >&2
  exit 1
fi
touch "{}"
echo "opencode/gpt-5-nano"
"#,
                fail_marker.to_string_lossy(),
                fail_marker.to_string_lossy(),
            ),
        )
        .expect("fake opencode cache preservation script should be created");
        let runtime_config =
            runtime_cli_config(&[("opencode", script.to_string_lossy().to_string())]);

        let first = list_cli_models("opencode".to_string(), Some(runtime_config.clone()), None)
            .await
            .expect("first opencode listing should succeed");
        assert_eq!(first.source, "live");
        assert_eq!(first.models, vec!["opencode/gpt-5-nano".to_string()]);

        let second = list_cli_models("opencode".to_string(), Some(runtime_config), Some(true))
            .await
            .expect("forced refresh fallback should preserve cached live models");
        assert_eq!(second.source, "cache");
        assert!(second.stale);
        assert_eq!(second.models, vec!["opencode/gpt-5-nano".to_string()]);
        assert!(
            second
                .reason
                .unwrap_or_default()
                .contains("served cached live inventory"),
            "expected reason to explain cached-live preservation"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn list_cli_models_returns_fallback_for_codex_when_live_listing_unavailable() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::unset("OPENAI_API_KEY");
        let _codex_home = EnvVarGuard::unset("CODEX_HOME");
        let temp_home =
            std::env::temp_dir().join(format!("friction-codex-fallback-home-{}", Uuid::new_v4()));
        fs::create_dir_all(temp_home.join(".codex"))
            .expect("temp codex home for fallback should be created");
        let _home = EnvVarGuard::set("HOME", temp_home.to_string_lossy().as_ref());

        let root =
            std::env::temp_dir().join(format!("friction-codex-models-fallback-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for codex fallback listing test");
        let codex_script = make_script(
            &root,
            "fake-codex-models-fallback",
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "models" ]]; then
  echo "error: unknown command models" >&2
  exit 1
fi
if [[ "${1:-}" == "exec" && "${2:-}" == "--help" ]]; then
  echo "Usage: codex exec [OPTIONS]" >&2
  exit 0
fi
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: codex [OPTIONS]"
  exit 0
fi
echo "unexpected command: $*" >&2
exit 2
"#,
        )
        .expect("fake codex fallback script should be created");
        let runtime_config =
            runtime_cli_config(&[("codex", codex_script.to_string_lossy().to_string())]);

        let payload = list_cli_models("codex".to_string(), Some(runtime_config), None)
            .await
            .expect("list_cli_models should succeed for codex fallback");

        assert_eq!(payload.source, "fallback");
        assert!(
            payload
                .reason
                .unwrap_or_default()
                .contains("credentials missing"),
            "expected fallback reason to mention missing credentials"
        );
        assert_eq!(
            payload.models,
            vec![
                "gpt-5-codex".to_string(),
                "gpt-5.3-codex".to_string(),
                "o4-mini".to_string()
            ]
        );

        let _ = fs::remove_dir_all(temp_home);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn list_cli_models_uses_codex_local_cache_before_provider_api() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::unset("OPENAI_API_KEY");
        let _codex_home = EnvVarGuard::unset("CODEX_HOME");

        let temp_home = std::env::temp_dir().join(format!(
            "friction-codex-local-cache-home-{}",
            Uuid::new_v4()
        ));
        let codex_home = temp_home.join(".codex");
        fs::create_dir_all(&codex_home).expect("temp codex home should be created");
        fs::write(
            codex_home.join("models_cache.json"),
            r#"{
  "fetched_at":"2026-03-05T00:00:00Z",
  "models":[
    {"slug":"gpt-5-codex"},
    {"slug":"gpt-5.3-codex"},
    {"slug":"o4-mini"}
  ]
}"#,
        )
        .expect("codex models cache should be written");
        let _home = EnvVarGuard::set("HOME", temp_home.to_string_lossy().as_ref());

        let root =
            std::env::temp_dir().join(format!("friction-codex-local-cache-cli-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for codex local cache cli test");
        let codex_script = make_script(
            &root,
            "fake-codex-local-cache",
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: codex [OPTIONS]"
  exit 0
fi
echo "unexpected command: $*" >&2
exit 2
"#,
        )
        .expect("fake codex local cache script should be created");
        let runtime_config =
            runtime_cli_config(&[("codex", codex_script.to_string_lossy().to_string())]);

        let payload = list_cli_models("codex".to_string(), Some(runtime_config), Some(true))
            .await
            .expect("list_cli_models should return local codex cache");

        assert_eq!(payload.source, "live");
        assert_eq!(payload.reason, None);
        assert_eq!(payload.provider_mode.as_deref(), Some("codex-local-cache"));
        assert_eq!(
            payload.models,
            vec![
                "gpt-5-codex".to_string(),
                "gpt-5.3-codex".to_string(),
                "o4-mini".to_string()
            ]
        );

        let _ = fs::remove_dir_all(temp_home);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn list_cli_models_uses_gemini_local_usage_before_provider_api() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _gemini_api_key = EnvVarGuard::unset("GEMINI_API_KEY");
        let _google_api_key = EnvVarGuard::unset("GOOGLE_API_KEY");
        let _google_gen_api_key = EnvVarGuard::unset("GOOGLE_GENERATIVE_AI_API_KEY");
        let _vertex_flag = EnvVarGuard::unset("GOOGLE_GENAI_USE_VERTEXAI");
        let _vertex_project = EnvVarGuard::unset("GOOGLE_CLOUD_PROJECT");

        let temp_home = std::env::temp_dir().join(format!(
            "friction-gemini-local-usage-home-{}",
            Uuid::new_v4()
        ));
        let chats_dir = temp_home
            .join(".gemini")
            .join("tmp")
            .join("friction")
            .join("chats");
        fs::create_dir_all(&chats_dir).expect("temp gemini chats dir should be created");
        fs::write(
            chats_dir.join("session-2026-03-05T11-00-test.json"),
            r#"{
  "turns": [
    { "model": "gemini-3-flash-preview", "text": "a" },
    { "meta": { "model": "gemini-2.5-pro" } }
  ]
}"#,
        )
        .expect("gemini local usage file should be written");
        let _home = EnvVarGuard::set("HOME", temp_home.to_string_lossy().as_ref());

        let (cli_root, _claude_path, _codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let runtime_config =
            runtime_cli_config(&[("gemini", gemini_path.to_string_lossy().to_string())]);

        let payload = list_cli_models("gemini".to_string(), Some(runtime_config), Some(true))
            .await
            .expect("list_cli_models should return gemini local usage");

        assert_eq!(payload.source, "live");
        assert_eq!(payload.reason, None);
        assert_eq!(payload.provider_mode.as_deref(), Some("gemini-local-usage"));
        assert_eq!(
            payload.models,
            vec![
                "gemini-2.5-pro".to_string(),
                "gemini-3-flash-preview".to_string()
            ]
        );

        let _ = fs::remove_dir_all(temp_home);
        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_runtime_cli_override_precedence_over_env() {
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::set("OPENAI_API_KEY", "test-openai-key");
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", claude_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );

        let runtime_config = agents::RuntimeConfigInput {
            architect: None,
            pragmatist: None,
            ollama_host: None,
            cli_models: None,
            agent_cli_models: None,
            cli_commands: Some(std::collections::HashMap::from([
                (
                    "codex".to_string(),
                    codex_path.to_string_lossy().to_string(),
                ),
                (
                    "gemini".to_string(),
                    gemini_path.to_string_lossy().to_string(),
                ),
            ])),
        };

        let phase1 = run_phase1(
            "Cross-agent memory hub".to_string(),
            Some("codex".to_string()),
            Some("gemini".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should succeed");

        assert_eq!(phase1.agent_responses[0].cli, "codex");
        assert!(
            phase1.architect.interpretation.contains("codex"),
            "Agent A response should come from runtime codex override, got: {}",
            phase1.architect.interpretation
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_runs_with_opencode_cli_selection() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let (cli_root, opencode_path) = setup_fake_opencode_cli(
            r#"{"interpretation":"opencode interpretation","assumptions":["o1","o2"],"risks":["or1","or2"],"questions":["oq1","oq2"],"approach":"opencode path"}"#,
            r#"{"stack":["opencode","tauri"],"phases":[{"name":"phase","duration":"1d","tasks":["task-op-a","task-op-b"]}],"architecture":"opencode planner architecture","tradeoffs":["cost vs speed"],"warnings":["watch opencode constraints"]}"#,
            r#"{"attack_report":[{"severity":"medium","title":"OpenCode reviewer finding","detail":"Missing explicit retry policy in one branch."}]}"#,
        )
        .expect("fake opencode cli should be created");
        let runtime_config =
            runtime_cli_config(&[("opencode", opencode_path.to_string_lossy().to_string())]);

        let phase1 = run_phase1(
            "Cross-agent memory hub".to_string(),
            Some("opencode".to_string()),
            Some("opencode".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should succeed with opencode");

        assert_eq!(phase1.agent_responses[0].cli, "opencode");
        assert!(
            phase1.architect.interpretation.contains("opencode"),
            "Agent A response should come from opencode CLI, got: {}",
            phase1.architect.interpretation
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_passes_opencode_model_override_from_runtime_config() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _expected_model =
            EnvVarGuard::set("FRICTION_EXPECTED_OPENCODE_MODEL", "openai/gpt-5-codex");
        let (cli_root, opencode_path) = setup_fake_opencode_cli(
            r#"{"interpretation":"opencode interpretation","assumptions":["o1","o2"],"risks":["or1","or2"],"questions":["oq1","oq2"],"approach":"opencode path"}"#,
            r#"{"stack":["opencode","tauri"],"phases":[{"name":"phase","duration":"1d","tasks":["task-op-a","task-op-b"]}],"architecture":"opencode planner architecture","tradeoffs":["cost vs speed"],"warnings":["watch opencode constraints"]}"#,
            r#"{"attack_report":[{"severity":"medium","title":"OpenCode reviewer finding","detail":"Missing explicit retry policy in one branch."}]}"#,
        )
        .expect("fake opencode cli should be created");
        let mut runtime_config =
            runtime_cli_config(&[("opencode", opencode_path.to_string_lossy().to_string())]);
        runtime_config.cli_models = Some(std::collections::HashMap::from([(
            "opencode".to_string(),
            "openai/gpt-5-codex".to_string(),
        )]));

        let phase1 = run_phase1(
            "Cross-agent memory hub".to_string(),
            Some("opencode".to_string()),
            Some("opencode".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should pass opencode model override");

        assert_eq!(phase1.agent_responses[0].cli, "opencode");
        assert!(
            phase1.architect.interpretation.contains("opencode"),
            "Agent A response should come from opencode CLI, got: {}",
            phase1.architect.interpretation
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_passes_claude_model_override_from_runtime_config() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _expected_model =
            EnvVarGuard::set("FRICTION_EXPECTED_CLAUDE_MODEL", "claude-sonnet-4-5");
        let _openai_key = EnvVarGuard::set("OPENAI_API_KEY", "test-openai-key");
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");

        let mut runtime_config =
            runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);
        runtime_config.cli_models = Some(std::collections::HashMap::from([(
            "claude".to_string(),
            "claude-sonnet-4-5".to_string(),
        )]));

        let phase1 = run_phase1(
            "Cross-agent memory hub".to_string(),
            Some("claude".to_string()),
            Some("codex".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should pass claude model override");

        assert_eq!(phase1.agent_responses[0].cli, "claude");
        assert!(
            phase1
                .architect
                .interpretation
                .contains("cli-first interpretation"),
            "Agent A response should come from claude CLI"
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_passes_codex_model_override_from_runtime_config() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _expected_model = EnvVarGuard::set("FRICTION_EXPECTED_CODEX_MODEL", "gpt-5-codex");
        let _openai_key = EnvVarGuard::set("OPENAI_API_KEY", "test-openai-key");
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");

        let mut runtime_config =
            runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);
        runtime_config.cli_models = Some(std::collections::HashMap::from([(
            "codex".to_string(),
            "gpt-5-codex".to_string(),
        )]));

        let phase1 = run_phase1(
            "Cross-agent memory hub".to_string(),
            Some("codex".to_string()),
            Some("gemini".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should pass codex model override");

        assert_eq!(phase1.agent_responses[0].cli, "codex");
        assert!(
            phase1.architect.interpretation.contains("codex"),
            "Agent A response should come from codex CLI"
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_passes_gemini_model_override_from_runtime_config() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _expected_model =
            EnvVarGuard::set("FRICTION_EXPECTED_GEMINI_MODEL", "gemini-2.5-flash");
        let _openai_key = EnvVarGuard::set("OPENAI_API_KEY", "test-openai-key");
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");

        let mut runtime_config =
            runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);
        runtime_config.cli_models = Some(std::collections::HashMap::from([(
            "gemini".to_string(),
            "gemini-2.5-flash".to_string(),
        )]));

        let phase1 = run_phase1(
            "Cross-agent memory hub".to_string(),
            Some("gemini".to_string()),
            Some("codex".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should pass gemini model override");

        assert_eq!(phase1.agent_responses[0].cli, "gemini");
        assert!(
            phase1.architect.interpretation.contains("gemini"),
            "Agent A response should come from gemini CLI"
        );

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_supports_agent_scoped_opencode_models() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let root =
            std::env::temp_dir().join(format!("friction-opencode-agent-models-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for opencode per-agent models");
        let opencode_script = make_script(
            &root,
            "fake-opencode-agent-models",
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "run" ]]; then
  echo "expected run subcommand" >&2
  exit 2
fi
shift
model=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --format)
      shift
      ;;
    --model)
      shift
      model="${1:-}"
      ;;
    --*)
      ;;
    *)
      ;;
  esac
  shift || true
done
if [[ -z "$model" ]]; then
  model="__default__"
fi
printf '{"interpretation":"%s","assumptions":["a"],"risks":["r"],"questions":["q"],"approach":"%s"}\n' "$model" "$model"
"#,
        )
        .expect("opencode per-agent model script should be created");

        let mut runtime_config =
            runtime_cli_config(&[("opencode", opencode_script.to_string_lossy().to_string())]);
        runtime_config.agent_cli_models = Some(std::collections::HashMap::from([
            ("agent_a".to_string(), "opencode/model-a".to_string()),
            ("agent_b".to_string(), "opencode/model-b".to_string()),
        ]));

        let phase1 = run_phase1(
            "Per-agent OpenCode model mapping".to_string(),
            Some("opencode".to_string()),
            Some("opencode".to_string()),
            Some(vec![
                agents::PhaseAgentInput {
                    id: "agent_a".to_string(),
                    label: "Agent A".to_string(),
                    cli: "opencode".to_string(),
                },
                agents::PhaseAgentInput {
                    id: "agent_b".to_string(),
                    label: "Agent B".to_string(),
                    cli: "opencode".to_string(),
                },
            ]),
            Some(runtime_config),
        )
        .await
        .expect("phase1 should support per-agent opencode models");

        assert_eq!(phase1.architect.interpretation, "opencode/model-a");
        assert_eq!(phase1.pragmatist.interpretation, "opencode/model-b");

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_tolerates_missing_response_fields_from_cli_json() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let root = std::env::temp_dir().join(format!(
            "friction-opencode-missing-fields-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temp dir for missing fields test");
        let opencode_script = make_script(
            &root,
            "fake-opencode-missing-fields",
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "run" ]]; then
  echo "expected run subcommand" >&2
  exit 2
fi
echo '{"type":"text","part":{"text":{"interpretation":"partial","assumptions":["a1"],"questions":["q1"],"approach":"partial approach"}}}'
"#,
        )
        .expect("opencode missing fields script should be created");

        let runtime_config =
            runtime_cli_config(&[("opencode", opencode_script.to_string_lossy().to_string())]);
        let phase1 = run_phase1(
            "Missing fields should not fail parsing".to_string(),
            Some("opencode".to_string()),
            Some("opencode".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should tolerate missing fields");

        assert_eq!(phase1.architect.interpretation, "partial");
        assert_eq!(phase1.architect.assumptions, vec!["a1"]);
        assert!(phase1.architect.risks.is_empty());
        assert_eq!(phase1.architect.questions, vec!["q1"]);
        assert_eq!(phase1.architect.approach, "partial approach");

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_opencode_parser_handles_mixed_logs_and_json_events() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let root =
            std::env::temp_dir().join(format!("friction-opencode-stream-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for opencode stream parser test");
        let opencode_script = make_script(
            &root,
            "fake-opencode-stream",
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "run" ]]; then
  echo "expected run subcommand" >&2
  exit 2
fi
shift
if [[ "${1:-}" != "--format" || "${2:-}" != "json" ]]; then
  echo "expected --format json" >&2
  exit 2
fi
echo "Performing one time database migration..."
echo "sqlite-migration:done"
echo "non-json-log-line"
echo '{"type":"step_start","part":{"type":"step-start"}}'
echo '{"type":"text","part":{"text":{"interpretation":"stream interpretation","assumptions":["s1","s2"],"risks":["sr1","sr2"],"questions":["sq1","sq2"],"approach":"stream path"}}}'
echo '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}'
"#,
        )
        .expect("opencode stream script should be created");

        let runtime_config =
            runtime_cli_config(&[("opencode", opencode_script.to_string_lossy().to_string())]);

        let phase1 = run_phase1(
            "Stream parser check".to_string(),
            Some("opencode".to_string()),
            Some("opencode".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should parse opencode streamed json output");

        assert_eq!(phase1.architect.interpretation, "stream interpretation");
        assert_eq!(phase1.architect.assumptions, vec!["s1", "s2"]);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_strict_isolation_uses_distinct_cwd_and_home_per_agent() {
        let root =
            std::env::temp_dir().join(format!("friction-phase12-iso-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for strict isolation test should be created");
        let isolated_script = make_script(
            &root,
            "fake-isolated-claude",
            r#"#!/usr/bin/env bash
set -euo pipefail
state="missing"
if [[ -f "agent-state.txt" ]]; then
  state="present"
fi
printf 'ok\n' > "agent-state.txt"
printf '{"interpretation":"%s","assumptions":["%s","state:%s"],"risks":["r"],"questions":["q"],"approach":"p"}\n' "$PWD" "$HOME" "$state"
"#,
        )
        .expect("strict isolation script should be created");

        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let runtime_config =
            runtime_cli_config(&[("claude", isolated_script.to_string_lossy().to_string())]);

        let phase1 = run_phase1(
            "Strict isolation check".to_string(),
            Some("claude".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should succeed with strict isolation script");

        assert_eq!(phase1.agent_responses.len(), 2);
        let cwd_a = &phase1.agent_responses[0].response.interpretation;
        let cwd_b = &phase1.agent_responses[1].response.interpretation;
        assert_ne!(cwd_a, cwd_b, "phase1 agents should not share the same cwd");

        let home_a = phase1.agent_responses[0].response.assumptions[0].clone();
        let home_b = phase1.agent_responses[1].response.assumptions[0].clone();
        let state_a = phase1.agent_responses[0].response.assumptions[1].clone();
        let state_b = phase1.agent_responses[1].response.assumptions[1].clone();
        let user_home = env::var("HOME").unwrap_or_default();

        assert_ne!(
            home_a, user_home,
            "phase1 strict isolation should not expose user HOME for agent A"
        );
        assert_ne!(
            home_b, user_home,
            "phase1 strict isolation should not expose user HOME for agent B"
        );
        assert_eq!(
            state_a, "state:missing",
            "agent A should start from a clean isolated cwd"
        );
        assert_eq!(
            state_b, "state:missing",
            "agent B should start from a clean isolated cwd"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_codex_strict_isolation_bridges_auth_file_into_isolated_codex_home() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::unset("OPENAI_API_KEY");
        let _codex_home = EnvVarGuard::unset("CODEX_HOME");
        let home_root =
            std::env::temp_dir().join(format!("friction-codex-bridge-home-{}", Uuid::new_v4()));
        fs::create_dir_all(home_root.join(".codex")).expect("temp codex home should be created");
        fs::write(
            home_root.join(".codex").join("auth.json"),
            "{\"token\":\"bridge\"}",
        )
        .expect("temp auth.json should be created");
        let _home = EnvVarGuard::set("HOME", home_root.to_string_lossy().as_ref());

        let root =
            std::env::temp_dir().join(format!("friction-codex-bridge-cli-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for codex bridge test");
        let marker = root.join("bridge-marker.txt");
        let codex_script = make_script(
            &root,
            "fake-codex-bridge",
            &format!(
                r#"#!/usr/bin/env bash
set -euo pipefail
output=""
args=("$@")
for ((i=0; i<${{#args[@]}}; i++)); do
  if [[ "${{args[$i]}}" == "-o" && $((i+1)) -lt ${{#args[@]}} ]]; then
    output="${{args[$((i+1))]}}"
  fi
done
if [[ -z "${{CODEX_HOME:-}}" ]]; then
  echo "missing CODEX_HOME" >&2
  exit 1
fi
if [[ ! -f "${{CODEX_HOME}}/auth.json" ]]; then
  echo "missing bridged auth.json" >&2
  exit 1
fi
if [[ -f "${{CODEX_HOME}}/config.toml" ]]; then
  echo "unexpected config.toml bridged" >&2
  exit 1
fi
printf 'bridged\n' > "{}"
payload='{{"interpretation":"codex bridge ready","assumptions":["b1","b2"],"risks":["r1","r2"],"questions":["q1","q2"],"approach":"bridge"}}'
if [[ -n "$output" ]]; then
  printf '%s\n' "$payload" > "$output"
else
  printf '%s\n' "$payload"
fi
"#,
                marker.to_string_lossy()
            ),
        )
        .expect("fake codex bridge script should be created");
        let runtime_config =
            runtime_cli_config(&[("codex", codex_script.to_string_lossy().to_string())]);

        let phase1 = run_phase1(
            "Codex strict bridge".to_string(),
            Some("codex".to_string()),
            Some("codex".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should bridge codex auth into isolated CODEX_HOME");

        assert_eq!(phase1.architect.interpretation, "codex bridge ready");
        assert!(
            marker.exists(),
            "codex bridge marker should exist when script was executed with bridged auth"
        );

        let _ = fs::remove_dir_all(home_root);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_gemini_strict_isolation_bridges_auth_config_into_isolated_home() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _gemini_api_key = EnvVarGuard::unset("GEMINI_API_KEY");
        let _google_api_key = EnvVarGuard::unset("GOOGLE_API_KEY");
        let _google_gen_api_key = EnvVarGuard::unset("GOOGLE_GENERATIVE_AI_API_KEY");
        let _gemini_home = EnvVarGuard::unset("GEMINI_HOME");

        let home_root =
            std::env::temp_dir().join(format!("friction-gemini-bridge-home-{}", Uuid::new_v4()));
        let gemini_home = home_root.join(".gemini");
        fs::create_dir_all(&gemini_home).expect("temp gemini home should be created");
        fs::write(
            gemini_home.join("settings.json"),
            r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#,
        )
        .expect("temp gemini settings should be created");
        fs::write(
            gemini_home.join("oauth_creds.json"),
            r#"{"access_token":"fake","expiry_date":9999999999999}"#,
        )
        .expect("temp gemini oauth creds should be created");
        let _home = EnvVarGuard::set("HOME", home_root.to_string_lossy().as_ref());

        let root =
            std::env::temp_dir().join(format!("friction-gemini-bridge-cli-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for gemini bridge test");
        let marker = root.join("gemini-bridge-marker.txt");
        let gemini_script = make_script(
            &root,
            "fake-gemini-bridge",
            &format!(
                r#"#!/usr/bin/env bash
set -euo pipefail
if [[ ! -f "${{HOME}}/.gemini/settings.json" ]]; then
  echo "Please set an Auth method in your $HOME/.gemini/settings.json" >&2
  exit 41
fi
if [[ ! -f "${{HOME}}/.gemini/oauth_creds.json" ]]; then
  echo "missing oauth creds in isolated gemini home" >&2
  exit 41
fi
printf 'bridged\n' > "{}"
payload='{{"interpretation":"gemini bridge ready","assumptions":["g1","g2"],"risks":["r1","r2"],"questions":["q1","q2"],"approach":"bridge"}}'
printf '%s\n' "$payload"
"#,
                marker.to_string_lossy()
            ),
        )
        .expect("fake gemini bridge script should be created");
        let runtime_config =
            runtime_cli_config(&[("gemini", gemini_script.to_string_lossy().to_string())]);

        let phase1 = run_phase1(
            "Gemini strict bridge".to_string(),
            Some("gemini".to_string()),
            Some("gemini".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should bridge gemini auth config into isolated HOME");

        assert_eq!(phase1.architect.interpretation, "gemini bridge ready");
        assert!(
            marker.exists(),
            "gemini bridge marker should exist when script executed with bridged auth config"
        );

        let _ = fs::remove_dir_all(home_root);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_codex_strict_isolation_fails_fast_when_auth_is_missing() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _openai_key = EnvVarGuard::unset("OPENAI_API_KEY");
        let _codex_home = EnvVarGuard::unset("CODEX_HOME");
        let home_root =
            std::env::temp_dir().join(format!("friction-codex-missing-home-{}", Uuid::new_v4()));
        fs::create_dir_all(&home_root).expect("temp home for codex missing auth should be created");
        let _home = EnvVarGuard::set("HOME", home_root.to_string_lossy().as_ref());

        let root =
            std::env::temp_dir().join(format!("friction-codex-missing-cli-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for codex fail-fast test");
        let marker = root.join("should-not-run.txt");
        let codex_script = make_script(
            &root,
            "fake-codex-should-not-run",
            &format!(
                r#"#!/usr/bin/env bash
set -euo pipefail
printf 'ran\n' > "{}"
payload='{{"interpretation":"unexpected","assumptions":["a"],"risks":["r"],"questions":["q"],"approach":"p"}}'
printf '%s\n' "$payload"
"#,
                marker.to_string_lossy()
            ),
        )
        .expect("fake codex fail-fast script should be created");
        let runtime_config =
            runtime_cli_config(&[("codex", codex_script.to_string_lossy().to_string())]);

        let err = run_phase1(
            "Codex strict missing auth".to_string(),
            Some("codex".to_string()),
            Some("codex".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect_err("phase1 should fail fast before executing codex without auth");

        assert!(
            err.contains("Codex auth missing in isolated runtime"),
            "expected codex auth readiness error, got: {err}"
        );
        assert!(
            !err.contains("401 Unauthorized"),
            "fail-fast should happen before codex retries unauthorized requests, got: {err}"
        );
        assert!(
            !marker.exists(),
            "codex script should not execute when auth readiness preflight fails"
        );

        let _ = fs::remove_dir_all(home_root);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_strict_isolation_cleans_temp_dirs_on_failure() {
        let root =
            std::env::temp_dir().join(format!("friction-phase12-iso-fail-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for strict isolation failure test");
        let failing_script = make_script(
            &root,
            "fake-failing-claude",
            r#"#!/usr/bin/env bash
set -euo pipefail
printf 'leak-check\n' > "$HOME/would-leak.txt"
echo "forced failure for cleanup test" >&2
exit 42
"#,
        )
        .expect("failing strict isolation script should be created");

        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let runtime_config =
            runtime_cli_config(&[("claude", failing_script.to_string_lossy().to_string())]);
        let before = list_phase12_isolation_dirs();

        let err = run_phase1(
            "Strict isolation cleanup check".to_string(),
            Some("claude".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect_err("phase1 should fail for cleanup verification");
        assert!(
            err.contains("failed with exit code 42"),
            "unexpected failure message: {err}"
        );

        let after = list_phase12_isolation_dirs();
        let leaked: Vec<_> = after.difference(&before).cloned().collect();
        assert!(
            leaked.is_empty(),
            "strict isolation temp directories should be cleaned up, leaked: {:?}",
            leaked
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn phase1_divergence_consensus_outlier_for_three_agents() {
        let responses = vec![
            NamedAgentResponse {
                id: "agent_a".to_string(),
                label: "Agent A".to_string(),
                cli: "claude".to_string(),
                response: session::AgentResponse {
                    interpretation: "Build a local MCP server with sqlite persistence".to_string(),
                    assumptions: vec!["single machine".to_string()],
                    risks: vec!["format drift".to_string()],
                    questions: vec!["need sync?".to_string()],
                    approach: "Start with a minimal toolset".to_string(),
                },
            },
            NamedAgentResponse {
                id: "agent_b".to_string(),
                label: "Agent B".to_string(),
                cli: "codex".to_string(),
                response: session::AgentResponse {
                    interpretation: "Build a local MCP server with sqlite persistence".to_string(),
                    assumptions: vec!["single machine".to_string()],
                    risks: vec!["format drift".to_string()],
                    questions: vec!["need sync?".to_string()],
                    approach: "Start with a minimal toolset".to_string(),
                },
            },
            NamedAgentResponse {
                id: "agent_c".to_string(),
                label: "Agent C".to_string(),
                cli: "gemini".to_string(),
                response: session::AgentResponse {
                    interpretation: "Use cloud sync first then add local cache".to_string(),
                    assumptions: vec!["cloud allowed".to_string()],
                    risks: vec!["latency".to_string()],
                    questions: vec!["offline required?".to_string()],
                    approach: "Prioritize cross-device sync".to_string(),
                },
            },
        ];

        let divergences = build_phase1_divergences(&responses);
        let interpretation = divergences
            .iter()
            .find(|item| item.field == "interpretation")
            .expect("interpretation divergence should exist");

        assert_eq!(interpretation.mode.as_deref(), Some("consensus"));
        assert_eq!(
            interpretation.consensus_text.as_deref(),
            Some("Build a local MCP server with sqlite persistence")
        );
        assert_eq!(
            interpretation.outlier_agent_ids.as_ref().map(|v| v.len()),
            Some(1)
        );
        assert_eq!(
            interpretation
                .outlier_agent_ids
                .as_ref()
                .expect("outlier ids should exist")[0],
            "agent_c"
        );
        assert_eq!(interpretation.severity, "low");
        let score = interpretation
            .disagreement_score
            .expect("disagreement score should exist");
        assert!(score > 0.32 && score < 0.34, "unexpected score: {score}");
    }

    #[test]
    fn phase2_list_divergence_consensus_items_and_distances() {
        let plans = vec![
            NamedAgentPlan {
                id: "agent_a".to_string(),
                label: "Agent A".to_string(),
                cli: "claude".to_string(),
                plan: session::AgentPlan {
                    stack: vec!["rust".to_string(), "tauri".to_string()],
                    phases: vec![],
                    architecture: "local app".to_string(),
                    tradeoffs: vec!["speed".to_string()],
                    warnings: vec!["monitor".to_string()],
                },
            },
            NamedAgentPlan {
                id: "agent_b".to_string(),
                label: "Agent B".to_string(),
                cli: "codex".to_string(),
                plan: session::AgentPlan {
                    stack: vec!["rust".to_string(), "tauri".to_string()],
                    phases: vec![],
                    architecture: "local app".to_string(),
                    tradeoffs: vec!["speed".to_string()],
                    warnings: vec!["monitor".to_string()],
                },
            },
            NamedAgentPlan {
                id: "agent_c".to_string(),
                label: "Agent C".to_string(),
                cli: "gemini".to_string(),
                plan: session::AgentPlan {
                    stack: vec!["rust".to_string(), "react".to_string()],
                    phases: vec![],
                    architecture: "local app".to_string(),
                    tradeoffs: vec!["speed".to_string()],
                    warnings: vec!["monitor".to_string()],
                },
            },
            NamedAgentPlan {
                id: "agent_d".to_string(),
                label: "Agent D".to_string(),
                cli: "claude".to_string(),
                plan: session::AgentPlan {
                    stack: vec!["go".to_string(), "k8s".to_string()],
                    phases: vec![],
                    architecture: "local app".to_string(),
                    tradeoffs: vec!["speed".to_string()],
                    warnings: vec!["monitor".to_string()],
                },
            },
        ];

        let divergences = build_phase2_divergences(&plans);
        let stack = divergences
            .iter()
            .find(|item| item.field == "stack")
            .expect("stack divergence should exist");

        assert_eq!(stack.mode.as_deref(), Some("consensus"));
        assert!(stack
            .consensus_items
            .as_ref()
            .expect("consensus items")
            .contains(&"rust".to_string()));
        assert!(stack
            .consensus_items
            .as_ref()
            .expect("consensus items")
            .contains(&"tauri".to_string()));
        assert_eq!(stack.severity, "medium");

        let outliers = stack
            .outlier_agent_ids
            .as_ref()
            .expect("outlier ids should exist");
        assert_eq!(outliers.len(), 2);
        assert!(outliers.contains(&"agent_c".to_string()));
        assert!(outliers.contains(&"agent_d".to_string()));

        let values = stack
            .agent_values
            .as_ref()
            .expect("agent values should exist");
        assert_eq!(values.len(), 4);
        let c_distance = values
            .iter()
            .find(|value| value.agent_id == "agent_c")
            .expect("agent c value")
            .distance;
        let d_distance = values
            .iter()
            .find(|value| value.agent_id == "agent_d")
            .expect("agent d value")
            .distance;
        assert!(c_distance >= 0.6);
        assert!(d_distance >= 0.99);
    }

    #[test]
    fn divergence_severity_thresholds_are_mapped() {
        assert_eq!(severity_from_disagreement(0.0), "low");
        assert_eq!(severity_from_disagreement(0.33), "low");
        assert_eq!(severity_from_disagreement(0.34), "medium");
        assert_eq!(severity_from_disagreement(0.66), "medium");
        assert_eq!(severity_from_disagreement(0.67), "high");
        assert_eq!(severity_from_disagreement(1.0), "high");
    }

    #[tokio::test]
    #[serial]
    async fn phase1_phase2_legacy_provider_mode_still_works() {
        force_mock_env();
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "1");

        let requirement = "API auth B2C avec MFA, audit trail et reset password";
        let clarifications = "Stack imposée: React+Node. SLA 99.9%. Journalisation obligatoire des opérations sensibles.";

        let phase1 = run_phase1(requirement.to_string(), None, None, None, None)
            .await
            .expect("legacy phase1 should succeed");
        assert!(!phase1.divergences.is_empty());

        let phase2 = run_phase2(
            requirement.to_string(),
            clarifications.to_string(),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("legacy phase2 should succeed");
        assert!(!phase2.divergences.is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn explicit_cli_selection_overrides_legacy_provider_mode() {
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase12_clis().expect("fake phase1/2 cli scripts should be created");
        let _claude_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "1");
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let phase_agents = vec![
            agents::PhaseAgentInput {
                id: "agent_a".to_string(),
                label: "Agent A".to_string(),
                cli: "claude".to_string(),
            },
            agents::PhaseAgentInput {
                id: "agent_b".to_string(),
                label: "Agent B".to_string(),
                cli: "codex".to_string(),
            },
            agents::PhaseAgentInput {
                id: "agent_c".to_string(),
                label: "Agent C".to_string(),
                cli: "gemini".to_string(),
            },
        ];

        let phase1 = run_phase1(
            "Legacy override with explicit CLI selection".to_string(),
            None,
            None,
            Some(phase_agents.clone()),
            Some(runtime_config.clone()),
        )
        .await
        .expect("phase1 should use CLI mode even if legacy flag is enabled");
        assert_eq!(phase1.agent_responses.len(), 3);

        let phase2 = run_phase2(
            "Legacy override with explicit CLI selection".to_string(),
            "Need a plan".to_string(),
            None,
            None,
            Some(phase_agents),
            Some(runtime_config),
        )
        .await
        .expect("phase2 should use CLI mode even if legacy flag is enabled");
        assert_eq!(phase2.agent_plans.len(), 3);

        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_fails_fast_when_cli_is_missing() {
        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let runtime_config = runtime_cli_config(&[("claude", "/missing/claude-cli".to_string())]);

        let err = run_phase1(
            "API auth B2C".to_string(),
            Some("claude".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect_err("phase1 should fail when selected CLI is missing");

        assert!(err.contains("not found"), "unexpected error message: {err}");
        assert!(
            err.contains("selected CLI 'claude'"),
            "missing CLI alias in error message: {err}"
        );
        assert!(
            err.contains("/missing/claude-cli"),
            "missing resolved command in error message: {err}"
        );
    }

    #[tokio::test]
    #[serial]
    async fn phase1_fails_when_cli_json_is_invalid() {
        let root = std::env::temp_dir().join(format!("friction-cli-invalid-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for invalid cli should be created");
        let invalid_script = make_script(
            &root,
            "fake-invalid-claude",
            "#!/usr/bin/env bash\nset -euo pipefail\necho 'not-json'\n",
        )
        .expect("invalid script should be created");

        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let runtime_config =
            runtime_cli_config(&[("claude", invalid_script.to_string_lossy().to_string())]);

        let err = run_phase1(
            "Notification service".to_string(),
            Some("claude".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect_err("phase1 should fail on invalid JSON");

        assert!(
            err.contains("JSON invalid"),
            "unexpected error message: {err}"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_fails_when_cli_json_is_semantically_empty() {
        let root =
            std::env::temp_dir().join(format!("friction-cli-empty-phase1-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for empty phase1 cli should be created");
        let empty_script = make_script(
            &root,
            "fake-empty-claude-phase1",
            "#!/usr/bin/env bash\nset -euo pipefail\necho '{}'\n",
        )
        .expect("empty phase1 script should be created");

        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let runtime_config =
            runtime_cli_config(&[("claude", empty_script.to_string_lossy().to_string())]);

        let err = run_phase1(
            "Semantic empty response".to_string(),
            Some("claude".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect_err("phase1 should fail on semantically empty JSON payload");

        assert!(
            err.contains("Failed to locate any valid JSON object")
                || err.contains("missing_expected_keys"),
            "unexpected error message: {err}"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase2_fails_when_cli_plan_is_semantically_empty() {
        let root =
            std::env::temp_dir().join(format!("friction-cli-empty-phase2-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for empty phase2 cli should be created");
        let empty_script = make_script(
            &root,
            "fake-empty-claude-phase2",
            "#!/usr/bin/env bash\nset -euo pipefail\necho '{}'\n",
        )
        .expect("empty phase2 script should be created");

        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let runtime_config =
            runtime_cli_config(&[("claude", empty_script.to_string_lossy().to_string())]);

        let err = run_phase2(
            "Semantic empty plan".to_string(),
            "Needs a concrete implementation plan".to_string(),
            Some("claude".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect_err("phase2 should fail on semantically empty plan payload");

        assert!(
            err.contains("Failed to locate any valid JSON object")
                || err.contains("missing_expected_keys"),
            "unexpected error message: {err}"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_fails_when_cli_times_out() {
        let root = std::env::temp_dir().join(format!("friction-cli-timeout-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for timeout cli should be created");
        let slow_script = make_script(
            &root,
            "fake-slow-claude",
            "#!/usr/bin/env bash\nset -euo pipefail\nsleep 2\necho '{\"interpretation\":\"ok\",\"assumptions\":[\"a\"],\"risks\":[\"r\"],\"questions\":[\"q\"],\"approach\":\"p\"}'\n",
        )
        .expect("slow script should be created");

        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _timeout = EnvVarGuard::set("FRICTION_PHASE3_CLI_TIMEOUT_SECS", "1");
        let runtime_config =
            runtime_cli_config(&[("claude", slow_script.to_string_lossy().to_string())]);

        let err = run_phase1(
            "Slow service".to_string(),
            Some("claude".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect_err("phase1 should fail when cli exceeds timeout");

        assert!(err.contains("timed out"), "unexpected error message: {err}");

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase1_recovers_when_cli_times_out_after_emitting_output() {
        let root =
            std::env::temp_dir().join(format!("friction-cli-timeout-recover-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir for timeout-recover cli should be created");
        let eager_script = make_script(
            &root,
            "fake-timeout-recover-claude",
            "#!/usr/bin/env bash\nset -euo pipefail\necho '{\"interpretation\":\"ok\",\"assumptions\":[\"a\"],\"risks\":[\"r\"],\"questions\":[\"q\"],\"approach\":\"p\"}'\nsleep 2\n",
        )
        .expect("timeout-recover script should be created");

        let _legacy_mode = EnvVarGuard::set("FRICTION_ENABLE_LEGACY_PROVIDER_MODE", "0");
        let _timeout = EnvVarGuard::set("FRICTION_PHASE3_CLI_TIMEOUT_SECS", "1");
        let runtime_config =
            runtime_cli_config(&[("claude", eager_script.to_string_lossy().to_string())]);

        let phase1 = run_phase1(
            "Timeout with early output".to_string(),
            Some("claude".to_string()),
            Some("claude".to_string()),
            None,
            Some(runtime_config),
        )
        .await
        .expect("phase1 should recover timeout when output already exists");

        assert_eq!(phase1.agent_responses.len(), 2);
        assert_eq!(phase1.agent_responses[0].response.interpretation, "ok");
        assert_eq!(phase1.agent_responses[1].response.interpretation, "ok");

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[serial]
    async fn phase3_smoke_adversarial_single_code() {
        let repo = init_temp_repo().expect("temp git repo should be created");
        let repo_path = repo.to_string_lossy().to_string();
        let (cli_root, claude_path, codex_path, gemini_path) = setup_fake_phase3_clis(
            r#"{"attack_report":[{"severity":"high","title":"Missing auth edge case","detail":"No guard when payload is empty string with spaces."}]}"#,
            r#"{"attack_report":[{"severity":"medium","title":"Timeout handling gap","detail":"No explicit timeout strategy for downstream calls."}]}"#,
        )
        .expect("fake cli scripts should be created");
        let _a_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let result = run_phase3(
            repo_path.clone(),
            Some("main".to_string()),
            "Service notifications avec retries et observabilité".to_string(),
            "Doit gérer erreurs réseau, timeout et fallback".to_string(),
            "Choisir robustesse avant optimisation".to_string(),
            None,
            Some("mock".to_string()),
            None,
            Some("claude".to_string()),
            Some("codex".to_string()),
            Some(runtime_config),
            Some(true),
        )
        .await
        .expect("phase3 should succeed");

        assert!(!result.code_a.trim().is_empty());
        assert!(result.code_b.contains("attack_report"));
        assert!(!result.attack_report.is_empty());
        assert!(!result.git_diff.trim().is_empty());
        assert!(!result.agent_a_branch.trim().is_empty());
        assert!(result.agent_b_branch.contains("/agent-gpt4o"));
        assert!(result.adr_path.is_some());
        assert!(result.adr_markdown.is_some());

        let adr_path = result.adr_path.as_ref().expect("adr path");
        assert!(
            PathBuf::from(adr_path).exists(),
            "ADR file should exist on disk"
        );

        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase3_smoke_with_claude_reviewer_cli() {
        let repo = init_temp_repo().expect("temp git repo should be created");
        let repo_path = repo.to_string_lossy().to_string();
        let (cli_root, claude_path, codex_path, gemini_path) = setup_fake_phase3_clis(
            r#"{"attack_report":[{"severity":"low","title":"Minor naming inconsistency","detail":"Variable names are inconsistent but non-blocking."}]}"#,
            r#"{"attack_report":[{"severity":"medium","title":"Unhandled retry exhaustion","detail":"No terminal failure event after max retries."}]}"#,
        )
        .expect("fake cli scripts should be created");
        let _a_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let result = run_phase3(
            repo_path.clone(),
            Some("main".to_string()),
            "Service de paiement avec retries idempotents".to_string(),
            "Doit journaliser chaque échec".to_string(),
            "Prioriser robustesse et observabilité".to_string(),
            None,
            Some("mock".to_string()),
            None,
            Some("claude".to_string()),
            Some("claude".to_string()),
            Some(runtime_config),
            Some(true),
        )
        .await
        .expect("phase3 with claude reviewer should succeed");

        assert_eq!(result.attack_report[0].severity, "medium");
        assert!(result.code_b.contains("attack_report"));

        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase3_smoke_with_gemini_reviewer_cli() {
        let repo = init_temp_repo().expect("temp git repo should be created");
        let repo_path = repo.to_string_lossy().to_string();
        let (cli_root, claude_path, codex_path, gemini_path) = setup_fake_phase3_clis(
            r#"{"attack_report":[{"severity":"low","title":"Minor naming inconsistency","detail":"Variable names are inconsistent but non-blocking."}]}"#,
            r#"{"attack_report":[{"severity":"medium","title":"Unhandled retry exhaustion","detail":"No terminal failure event after max retries."}]}"#,
        )
        .expect("fake cli scripts should be created");
        let _a_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let result = run_phase3(
            repo_path.clone(),
            Some("main".to_string()),
            "Service de paiement avec retries idempotents".to_string(),
            "Doit journaliser chaque échec".to_string(),
            "Prioriser robustesse et observabilité".to_string(),
            None,
            Some("mock".to_string()),
            None,
            Some("claude".to_string()),
            Some("gemini".to_string()),
            Some(runtime_config),
            Some(true),
        )
        .await
        .expect("phase3 with gemini reviewer should succeed");

        assert_eq!(result.attack_report[0].severity, "medium");
        assert!(result.code_b.contains("attack_report"));

        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase3_smoke_with_opencode_reviewer_cli() {
        let repo = init_temp_repo().expect("temp git repo should be created");
        let repo_path = repo.to_string_lossy().to_string();
        let (cli_root, claude_path, _codex_path, _gemini_path) = setup_fake_phase3_clis(
            r#"{"attack_report":[{"severity":"low","title":"Minor naming inconsistency","detail":"Variable names are inconsistent but non-blocking."}]}"#,
            r#"{"attack_report":[{"severity":"medium","title":"Unhandled retry exhaustion","detail":"No terminal failure event after max retries."}]}"#,
        )
        .expect("fake cli scripts should be created");
        let (opencode_root, opencode_path) = setup_fake_opencode_cli(
            r#"{"interpretation":"opencode interpretation","assumptions":["o1","o2"],"risks":["or1","or2"],"questions":["oq1","oq2"],"approach":"opencode path"}"#,
            r#"{"stack":["opencode","tauri"],"phases":[{"name":"phase","duration":"1d","tasks":["task-op-a","task-op-b"]}],"architecture":"opencode planner architecture","tradeoffs":["cost vs speed"],"warnings":["watch opencode constraints"]}"#,
            r#"{"attack_report":[{"severity":"high","title":"OpenCode attack report","detail":"Missing timeout handling on downstream call."}]}"#,
        )
        .expect("fake opencode cli should be created");

        let runtime_config = runtime_cli_config(&[
            ("claude", claude_path.to_string_lossy().to_string()),
            ("opencode", opencode_path.to_string_lossy().to_string()),
        ]);

        let result = run_phase3(
            repo_path.clone(),
            Some("main".to_string()),
            "Service de paiement avec retries idempotents".to_string(),
            "Doit journaliser chaque échec".to_string(),
            "Prioriser robustesse et observabilité".to_string(),
            None,
            Some("mock".to_string()),
            None,
            Some("claude".to_string()),
            Some("opencode".to_string()),
            Some(runtime_config),
            Some(true),
        )
        .await
        .expect("phase3 with opencode reviewer should succeed");

        assert_eq!(result.attack_report[0].title, "OpenCode attack report");
        assert_eq!(result.attack_report[0].severity, "high");
        assert!(result.code_b.contains("attack_report"));

        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(cli_root);
        let _ = fs::remove_dir_all(opencode_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase3_opencode_reviewer_uses_writable_xdg_state_home_override() {
        let repo = init_temp_repo().expect("temp git repo should be created");
        let repo_path = repo.to_string_lossy().to_string();
        let (cli_root, claude_path, _codex_path, _gemini_path) = setup_fake_phase3_clis(
            r#"{"attack_report":[{"severity":"low","title":"unused","detail":"unused"}]}"#,
            r#"{"attack_report":[{"severity":"low","title":"unused","detail":"unused"}]}"#,
        )
        .expect("fake cli scripts should be created");

        let opencode_root =
            std::env::temp_dir().join(format!("friction-opencode-state-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&opencode_root).expect("temp dir for opencode state test");
        let opencode_script = make_script(
            &opencode_root,
            "fake-opencode-state",
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "run" ]]; then
  echo "expected run subcommand" >&2
  exit 2
fi
shift
if [[ "${1:-}" != "--format" || "${2:-}" != "json" ]]; then
  echo "expected --format json" >&2
  exit 2
fi
if [[ -z "${XDG_STATE_HOME:-}" ]]; then
  echo "XDG_STATE_HOME missing" >&2
  exit 3
fi
mkdir -p "$XDG_STATE_HOME/opencode"
touch "$XDG_STATE_HOME/opencode/probe.txt"
echo '{"type":"step_start","part":{"type":"step-start"}}'
printf '{"type":"text","part":{"text":{"attack_report":[{"severity":"medium","title":"state-home","detail":"%s"}]}}}\n' "$XDG_STATE_HOME"
echo '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}'
"#,
        )
        .expect("opencode state test script should be created");

        let _state_home = EnvVarGuard::set("XDG_STATE_HOME", "/dev/null/opencode-denied");
        let runtime_config = runtime_cli_config(&[
            ("claude", claude_path.to_string_lossy().to_string()),
            ("opencode", opencode_script.to_string_lossy().to_string()),
        ]);

        let result = run_phase3(
            repo_path.clone(),
            Some("main".to_string()),
            "Service de paiement avec retries idempotents".to_string(),
            "Doit journaliser chaque échec".to_string(),
            "Prioriser robustesse et observabilité".to_string(),
            None,
            Some("mock".to_string()),
            None,
            Some("claude".to_string()),
            Some("opencode".to_string()),
            Some(runtime_config),
            Some(true),
        )
        .await
        .expect("phase3 should override XDG_STATE_HOME for opencode reviewer");

        let state_path = &result.attack_report[0].detail;
        assert!(
            state_path.contains("/.friction/opencode-state"),
            "expected shared worktree opencode state path, got: {state_path}"
        );
        assert!(
            !state_path.contains("/dev/null/opencode-denied"),
            "expected XDG_STATE_HOME override, got: {state_path}"
        );

        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(cli_root);
        let _ = fs::remove_dir_all(opencode_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase3_runtime_cli_override_applies_to_reviewer_resolution() {
        let repo = init_temp_repo().expect("temp git repo should be created");
        let repo_path = repo.to_string_lossy().to_string();
        let (cli_root, claude_path, codex_path, gemini_path) = setup_fake_phase3_clis(
            r#"{"attack_report":[{"severity":"low","title":"codex payload","detail":"codex path used"}]}"#,
            r#"{"attack_report":[{"severity":"high","title":"gemini payload","detail":"runtime override used"}]}"#,
        )
        .expect("fake cli scripts should be created");
        let _a_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );

        let runtime_config = agents::RuntimeConfigInput {
            architect: None,
            pragmatist: None,
            ollama_host: None,
            cli_models: None,
            agent_cli_models: None,
            cli_commands: Some(std::collections::HashMap::from([
                (
                    "claude".to_string(),
                    claude_path.to_string_lossy().to_string(),
                ),
                (
                    "codex".to_string(),
                    gemini_path.to_string_lossy().to_string(),
                ),
            ])),
        };

        let result = run_phase3(
            repo_path.clone(),
            Some("main".to_string()),
            "Service de paiement avec retries idempotents".to_string(),
            "Doit journaliser chaque échec".to_string(),
            "Prioriser robustesse et observabilité".to_string(),
            None,
            Some("mock".to_string()),
            None,
            Some("claude".to_string()),
            Some("codex".to_string()),
            Some(runtime_config),
            Some(true),
        )
        .await
        .expect("phase3 should succeed with runtime override");

        assert_eq!(result.attack_report.len(), 1);
        assert_eq!(result.attack_report[0].title, "gemini payload");
        assert_eq!(result.attack_report[0].severity, "high");

        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(cli_root);
    }

    #[tokio::test]
    #[serial]
    async fn phase3_fails_fast_when_agent_a_cli_missing() {
        let repo = init_temp_repo().expect("temp git repo should be created");
        let repo_path = repo.to_string_lossy().to_string();
        let runtime_config = runtime_cli_config(&[("claude", "/missing/claude-cli".to_string())]);

        let err = run_phase3(
            repo_path.clone(),
            Some("main".to_string()),
            "API auth B2C".to_string(),
            "Ajouter audit".to_string(),
            "Choix architecte".to_string(),
            None,
            Some("mock".to_string()),
            None,
            Some("claude".to_string()),
            Some("codex".to_string()),
            Some(runtime_config),
            Some(true),
        )
        .await
        .expect_err("phase3 should fail when Agent A CLI is missing");

        assert!(err.contains("not found"), "unexpected error message: {err}");

        let _ = fs::remove_dir_all(repo);
    }

    #[tokio::test]
    #[serial]
    async fn phase3_fails_when_attack_report_json_is_invalid() {
        let repo = init_temp_repo().expect("temp git repo should be created");
        let repo_path = repo.to_string_lossy().to_string();
        let (cli_root, claude_path, codex_path, gemini_path) =
            setup_fake_phase3_clis("not-json", "not-json")
                .expect("fake cli scripts should be created");
        let _a_cli = EnvVarGuard::set(
            "FRICTION_CLAUDE_CLI",
            claude_path.to_string_lossy().as_ref(),
        );
        let _codex_cli =
            EnvVarGuard::set("FRICTION_CODEX_CLI", codex_path.to_string_lossy().as_ref());
        let _gemini_cli = EnvVarGuard::set(
            "FRICTION_GEMINI_CLI",
            gemini_path.to_string_lossy().as_ref(),
        );
        let runtime_config = runtime_cli_config_from_paths(&claude_path, &codex_path, &gemini_path);

        let err = run_phase3(
            repo_path.clone(),
            Some("main".to_string()),
            "Notification service".to_string(),
            "Gérer fallback".to_string(),
            "Choisir simplicité".to_string(),
            None,
            Some("mock".to_string()),
            None,
            Some("claude".to_string()),
            Some("codex".to_string()),
            Some(runtime_config),
            Some(true),
        )
        .await
        .expect_err("phase3 should fail on invalid attack report JSON");

        assert!(
            err.contains("invalid attack report JSON"),
            "unexpected error message: {err}"
        );

        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(cli_root);
    }
}
