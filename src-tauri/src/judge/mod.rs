use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::Value;
use std::env;

#[derive(Debug, Deserialize)]
struct JudgeConfidenceOutput {
    confidence_score: f32,
}

enum JudgeProvider {
    Mock,
    Haiku,
    Flash,
    Ollama,
}

pub async fn evaluate_confidence(
    requirement: &str,
    diff: &str,
    code_a: &str,
    attack_report_json: &str,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<f32, String> {
    let provider = resolve_provider(provider_override)?;

    match provider {
        JudgeProvider::Mock => Ok(mock_confidence(diff, attack_report_json)),
        JudgeProvider::Haiku => {
            let response = call_anthropic(
                requirement,
                diff,
                code_a,
                attack_report_json,
                model_override,
            )
            .await?;
            parse_confidence_output(&response)
        }
        JudgeProvider::Flash => {
            let response = call_gemini_flash(
                requirement,
                diff,
                code_a,
                attack_report_json,
                model_override,
            )
            .await?;
            parse_confidence_output(&response)
        }
        JudgeProvider::Ollama => {
            let response = call_ollama(
                requirement,
                diff,
                code_a,
                attack_report_json,
                model_override,
            )
            .await?;
            parse_confidence_output(&response)
        }
    }
}

fn resolve_provider(provider_override: Option<&str>) -> Result<JudgeProvider, String> {
    let source = provider_override
        .map(str::to_string)
        .or_else(|| env::var("FRICTION_JUDGE_PROVIDER").ok())
        .unwrap_or_else(|| "haiku".to_string())
        .to_lowercase();

    match source.as_str() {
        "mock" => Ok(JudgeProvider::Mock),
        "haiku" => Ok(JudgeProvider::Haiku),
        "flash" => Ok(JudgeProvider::Flash),
        "ollama" => Ok(JudgeProvider::Ollama),
        unsupported => Err(format!(
            "Unsupported judge provider '{unsupported}'. Use haiku|flash|ollama"
        )),
    }
}

async fn call_anthropic(
    requirement: &str,
    diff: &str,
    code_a: &str,
    attack_report_json: &str,
    model_override: Option<&str>,
) -> Result<String, String> {
    let api_key = env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "ANTHROPIC_API_KEY is required for judge provider 'haiku'".to_string())?;

    let model = model_override
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("FRICTION_JUDGE_MODEL").ok())
        .unwrap_or_else(|| "claude-3-5-haiku-latest".to_string());
    let client = reqwest::Client::new();

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header(CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": 500,
            "temperature": 0,
            "system": judge_system_prompt(),
            "messages": [
              {
                "role": "user",
                "content": judge_user_prompt(requirement, diff, code_a, attack_report_json)
              }
            ]
        }))
        .send()
        .await
        .map_err(|err| format!("judge haiku request failed: {err}"))?;

    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("judge haiku decode failed: {err}"))?;

    if !status.is_success() {
        return Err(format!("judge haiku error ({status}): {payload}"));
    }

    let text = payload
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    if text.trim().is_empty() {
        return Err("judge haiku returned empty content".to_string());
    }

    Ok(text)
}

async fn call_gemini_flash(
    requirement: &str,
    diff: &str,
    code_a: &str,
    attack_report_json: &str,
    model_override: Option<&str>,
) -> Result<String, String> {
    let api_key = env::var("GEMINI_API_KEY")
        .or_else(|_| env::var("GOOGLE_API_KEY"))
        .map_err(|_| {
            "GEMINI_API_KEY or GOOGLE_API_KEY is required for judge provider 'flash'".to_string()
        })?;

    let model = model_override
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("FRICTION_JUDGE_MODEL").ok())
        .unwrap_or_else(|| "gemini-2.0-flash".to_string());
    let endpoint = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    );

    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({
            "contents": [
              {
                "role": "user",
                "parts": [
                  {"text": format!("{}\n\n{}", judge_system_prompt(), judge_user_prompt(requirement, diff, code_a, attack_report_json))}
                ]
              }
            ],
            "generationConfig": {
              "temperature": 0,
              "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|err| format!("judge flash request failed: {err}"))?;

    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("judge flash decode failed: {err}"))?;

    if !status.is_success() {
        return Err(format!("judge flash error ({status}): {payload}"));
    }

    let text = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .and_then(|parts| parts.first())
        .and_then(|part| part.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if text.trim().is_empty() {
        return Err("judge flash returned empty content".to_string());
    }

    Ok(text)
}

async fn call_ollama(
    requirement: &str,
    diff: &str,
    code_a: &str,
    attack_report_json: &str,
    model_override: Option<&str>,
) -> Result<String, String> {
    let host = env::var("OLLAMA_HOST")
        .or_else(|_| env::var("FRICTION_OLLAMA_HOST"))
        .unwrap_or_else(|_| "http://localhost:11434".to_string());
    let model = model_override
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("FRICTION_JUDGE_MODEL").ok())
        .unwrap_or_else(|| "llama3.1:8b".to_string());
    let endpoint = format!("{}/api/chat", host.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({
            "model": model,
            "stream": false,
            "messages": [
              {"role": "system", "content": judge_system_prompt()},
              {"role": "user", "content": judge_user_prompt(requirement, diff, code_a, attack_report_json)}
            ]
        }))
        .send()
        .await
        .map_err(|err| format!("judge ollama request failed: {err}"))?;

    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("judge ollama decode failed: {err}"))?;

    if !status.is_success() {
        return Err(format!("judge ollama error ({status}): {payload}"));
    }

    let text = payload
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if text.trim().is_empty() {
        return Err("judge ollama returned empty content".to_string());
    }

    Ok(text)
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
    "You are a cheap confidence scorer for adversarial code review. Return only valid JSON with one field: confidence_score (0.0 to 1.0)."
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

Evaluate confidence in production readiness after considering requirement, git diff, and attack findings.
Lower confidence for severe or numerous unresolved risks.

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
