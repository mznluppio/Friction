use serde::Deserialize;
use std::env;

#[derive(Debug, Deserialize)]
struct JudgeConfidenceOutput {
    confidence_score: f32,
}

pub async fn evaluate_confidence(
    requirement: &str,
    diff: &str,
    code_a: &str,
    attack_report_json: &str,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<f32, String> {
    let provider = resolve_provider(provider_override);

    if provider == "mock" {
        return Ok(mock_confidence(diff, attack_report_json));
    }

    let response = call_judge_cli(
        &provider,
        requirement,
        diff,
        code_a,
        attack_report_json,
        model_override,
    )
    .await?;

    parse_confidence_output(&response)
}

fn resolve_provider(provider_override: Option<&str>) -> String {
    let source = provider_override
        .map(str::to_string)
        .or_else(|| env::var("FRICTION_JUDGE_PROVIDER").ok())
        .unwrap_or_else(|| "claude".to_string())
        .to_lowercase();

    match source.as_str() {
        "haiku" | "anthropic" | "claude" => "claude".to_string(),
        "flash" | "gemini" => "gemini".to_string(),
        "opencode" => "opencode".to_string(),
        "openai" | "codex" => "codex".to_string(),
        "mock" => "mock".to_string(),
        other => other.to_string(),
    }
}

async fn call_judge_cli(
    cli: &str,
    requirement: &str,
    diff: &str,
    code_a: &str,
    attack_report_json: &str,
    model_override: Option<&str>,
) -> Result<String, String> {
    use crate::agents;

    let prompt = format!(
        "{}\n\n{}",
        judge_system_prompt(),
        judge_user_prompt(requirement, diff, code_a, attack_report_json)
    );

    // Use runtime_config from env if available (stub for now, as evaluate_confidence doesn't receive it)
    let runtime_config = None;

    let model = model_override
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("FRICTION_JUDGE_MODEL").ok());

    agents::run_agent_cli(
        cli,
        model.as_deref(),
        &prompt,
        ".",
        None,
        &format!("Judge {} evaluation", cli),
        runtime_config,
        agents::CliExecutionIsolationMode::SharedWorktree,
        None,
        None,
    )
    .await
}

fn parse_confidence_output(raw: &str) -> Result<f32, String> {
    let parsed = extract_json(raw).unwrap_or_else(|| raw.trim().to_string());
    let output: JudgeConfidenceOutput = serde_json::from_str(&parsed).map_err(|err| {
        format!(
            "judge JSON parse failed: {err}. Raw: {}",
            truncate(raw, 320)
        )
    })?;

    Ok(output.confidence_score.clamp(0.0, 1.0))
}

fn judge_system_prompt() -> &'static str {
    "You are an expert, unsparing technical Judge evaluating adversarial AI code. \
    Your ONLY goal is to score the risk and confidence in the provided implementation. \
    Ignore superficial differences (formatting, variable naming) entirely. Focus explicitly on fundamental clashes in strategy, architecture, security, and edge-case handling. \
    Return strictly valid JSON with one field: `confidence_score` (0.0 to 1.0, where 0.0 means the code is catastrophically flawed, and 1.0 means it is impeccably robust)."
}

fn judge_user_prompt(
    requirement: &str,
    diff: &str,
    code_a: &str,
    attack_report_json: &str,
) -> String {
    format!(
        r#"Return STRICT JSON with this schema:
{{
  "confidence_score": 0.0
}}

Evaluate confidence in the production readiness of Agent A's code after considering the original requirement, the git diff, and the adversarial attack findings from Agent B.
CRITICAL: Lower the confidence score significantly ONLY for severe architectural, strategic, or security vulnerabilities. Do NOT lower the score for stylistic choices, variable naming, or formatting differences.

Requirement:
{requirement}

Git diff:
{diff}

Code under test (Agent A):
{code_a}

Agent B attack report JSON:
{attack_report_json}
"#
    )
}

fn mock_confidence(diff: &str, attack_report_json: &str) -> f32 {
    if diff.trim().is_empty() {
        return 0.31;
    }

    let lowered = attack_report_json.to_lowercase();
    if lowered.contains("\"severity\":\"high\"") || lowered.contains("\"severity\": \"high\"") {
        return 0.62;
    }

    0.78
}

fn extract_json(raw: &str) -> Option<String> {
    let trimmed = raw.trim();

    if trimmed.starts_with("```") {
        let without_prefix = trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim();
        let without_suffix = without_prefix.trim_end_matches("```").trim();
        if without_suffix.starts_with('{') && without_suffix.ends_with('}') {
            return Some(without_suffix.to_string());
        }
    }

    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }

    Some(trimmed[start..=end].to_string())
}

fn truncate(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }

    let mut output = String::new();
    for ch in value.chars().take(max_len) {
        output.push(ch);
    }
    output.push_str("...");
    output
}
