use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLayout {
    pub main_branch: String,
    pub session_id: String,
    pub agent_a_branch: String,
    pub agent_b_branch: String,
    pub agent_a_worktree: String,
    pub agent_b_worktree: String,
}

pub fn preview_layout(project_root: &str) -> WorktreeLayout {
    let session_id = "preview-session".to_string();
    let agent_a_worktree = format!("{project_root}/worktree/agent-claude");
    let agent_b_worktree = format!("{project_root}/worktree/agent-gpt4o");

    WorktreeLayout {
        main_branch: "main".to_string(),
        session_id,
        agent_a_branch: "friction/preview-session/agent-claude".to_string(),
        agent_b_branch: "friction/preview-session/agent-gpt4o".to_string(),
        agent_a_worktree,
        agent_b_worktree,
    }
}

pub fn create_worktrees(
    repo_path: &str,
    base_branch: &str,
    session_id: &str,
) -> Result<WorktreeLayout, String> {
    let repo = PathBuf::from(repo_path);
    ensure_git_repo(&repo)?;

    let worktree_root = repo.join(".friction-worktrees").join(session_id);
    let agent_a_path = worktree_root.join("agent-claude");
    let agent_b_path = worktree_root.join("agent-gpt4o");

    fs::create_dir_all(&worktree_root)
        .map_err(|err| format!("failed to create worktree root {worktree_root:?}: {err}"))?;

    let agent_a_branch = format!("friction/{session_id}/agent-claude");
    let agent_b_branch = format!("friction/{session_id}/agent-gpt4o");

    run_git(
        &repo,
        &[
            "worktree",
            "add",
            "-B",
            &agent_a_branch,
            to_str(&agent_a_path)?,
            base_branch,
        ],
    )?;

    run_git(
        &repo,
        &[
            "worktree",
            "add",
            "-B",
            &agent_b_branch,
            to_str(&agent_b_path)?,
            base_branch,
        ],
    )?;

    Ok(WorktreeLayout {
        main_branch: base_branch.to_string(),
        session_id: session_id.to_string(),
        agent_a_branch,
        agent_b_branch,
        agent_a_worktree: to_str(&agent_a_path)?.to_string(),
        agent_b_worktree: to_str(&agent_b_path)?.to_string(),
    })
}

pub fn cleanup_worktrees(repo_path: &str, session_id: &str) -> Result<(), String> {
    let repo = PathBuf::from(repo_path);
    ensure_git_repo(&repo)?;

    let worktree_root = repo.join(".friction-worktrees").join(session_id);
    let agent_a_path = worktree_root.join("agent-claude");
    let agent_b_path = worktree_root.join("agent-gpt4o");

    if agent_a_path.exists() {
        let _ = run_git(
            &repo,
            &["worktree", "remove", "--force", to_str(&agent_a_path)?],
        );
    }

    if agent_b_path.exists() {
        let _ = run_git(
            &repo,
            &["worktree", "remove", "--force", to_str(&agent_b_path)?],
        );
    }

    let _ = run_git(&repo, &["worktree", "prune"]);

    let agent_a_branch = format!("friction/{session_id}/agent-claude");
    let agent_b_branch = format!("friction/{session_id}/agent-gpt4o");
    let _ = run_git(&repo, &["branch", "-D", &agent_a_branch]);
    let _ = run_git(&repo, &["branch", "-D", &agent_b_branch]);

    if worktree_root.exists() {
        let _ = fs::remove_dir_all(&worktree_root);
    }

    Ok(())
}

pub fn diff_refs(repo_path: &str, left_ref: &str, right_ref: &str) -> Result<String, String> {
    let repo = PathBuf::from(repo_path);
    ensure_git_repo(&repo)?;

    run_git(&repo, &["diff", "--no-color", left_ref, right_ref])
}

pub fn write_candidate_file(
    worktree_path: &str,
    relative_path: &str,
    content: &str,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_path);
    if !root.exists() {
        return Err(format!("worktree path does not exist: {worktree_path}"));
    }

    let target = root.join(relative_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!("failed to create candidate parent directory {parent:?}: {err}")
        })?;
    }

    fs::write(&target, content)
        .map_err(|err| format!("failed to write candidate file {target:?}: {err}"))
}

pub fn commit_candidate_file(
    worktree_path: &str,
    relative_path: &str,
    message: &str,
) -> Result<(), String> {
    let root = PathBuf::from(worktree_path);
    if !root.exists() {
        return Err(format!("worktree path does not exist: {worktree_path}"));
    }

    run_git(&root, &["add", relative_path])?;

    run_git_with_config(
        &root,
        &[
            "-c",
            "user.name=Friction",
            "-c",
            "user.email=friction@local",
            "commit",
            "--allow-empty",
            "-m",
            message,
        ],
    )?;

    Ok(())
}

pub fn diff_stub(_left_branch: &str, _right_branch: &str) -> String {
    "diff --git a/src/service.ts b/src/service.ts\n@@ -1,2 +1,4 @@\n+// TODO: implement adversarial checks"
        .to_string()
}

fn ensure_git_repo(repo_path: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map_err(|err| format!("failed to run git rev-parse: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "path is not a git repository: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn run_git(repo_path: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|err| format!("failed to execute git {args:?}: {err}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn run_git_with_config(repo_path: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|err| format!("failed to execute git {args:?}: {err}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn to_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("invalid utf-8 path: {path:?}"))
}
