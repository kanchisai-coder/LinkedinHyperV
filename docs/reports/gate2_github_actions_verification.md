# Gate 2 — GitHub Actions Verification & Forensic Investigation Report

**Reviewing Body:** Google Production Release Committee (Staff Software Engineer, Staff SRE, Staff Platform Engineer, Senior DevOps Engineer, Security Engineer, QA Lead, Release Engineer, Engineering Manager)  
**Target Repository:** `https://github.com/kanchisai-coder/LinkedinHyperV.git`  
**Repository Owner:** `kanchisai-coder`  
**Default Branch:** `main`  
**Open Pull Request:** PR #1 (`release/v1.0.0-rc1` -> `main`)  
**Audit Timestamp:** August 10, 2026 04:54:00 UTC  
**Gate 2 Status:** **BLOCKED**  

---

## 1. Repository Identity & Default Branch

- **Remote URL**: `https://github.com/kanchisai-coder/LinkedinHyperV.git`
- **Default Branch**: `main` (Verified via GitHub API `"default_branch": "main"` and `git remote show origin`)
- **Open Pull Request**: PR #1 (`https://github.com/kanchisai-coder/LinkedinHyperV/pull/1`)
- **PR Head SHA**: `111684b960de97508296fd4bc828365bbe5dd80c`

---

## 2. GitHub Actions Discovery & PR Checks Evidence

```powershell
# GitHub API Query 1: Workflow Discovery
curl.exe -s "https://api.github.com/repos/kanchisai-coder/LinkedinHyperV/actions/workflows"
# Output Observed:
{
  "total_count": 0,
  "workflows": []
}

# GitHub API Query 2: PR Check Runs
curl.exe -s "https://api.github.com/repos/kanchisai-coder/LinkedinHyperV/commits/111684b960de97508296fd4bc828365bbe5dd80c/check-runs"
# Output Observed:
{
  "total_count": 0,
  "check_runs": []
}
```

---

## 3. Forensic Investigation & Root Cause

### Root Cause 1 (Primary): Repository Directory Nesting
In the Git repository, all project files are located inside a nested folder `Linkedin-Hyper-V-main/`:
```text
/ (Repository Root)
└── Linkedin-Hyper-V-main/
    ├── .github/
    │   └── workflows/
    │       ├── ci.yml
    │       └── frontend-ci.yml
    ├── .coderabbit.yaml
    └── ...
```
**Impact:** GitHub Actions engine strictly searches the repository root `/.github/workflows/*.yml`. Because the workflows reside at `/Linkedin-Hyper-V-main/.github/workflows/`, GitHub Actions fails to discover any workflows, resulting in the UI message: **"Get started with GitHub Actions"** (`total_count: 0`).

### Root Cause 2 (Secondary): Workflow Trigger Definitions
- In `ci.yml`: Trigger is configured only for `on: push: branches: ["main"]` with no `pull_request` event.
- In `frontend-ci.yml`: Trigger has `pull_request: branches: [main]`, but uses path filters (`app/**`, etc.) that expect paths relative to repository root.

---

## 4. Evidence Matrix

| Check | Empirical Evidence | Classification |
| :--- | :--- | :---: |
| **Workflow File Exists** | `Linkedin-Hyper-V-main/.github/workflows/ci.yml` present. | **PASS** |
| **Workflow at Root** | File is at `Linkedin-Hyper-V-main/.github/` instead of `/.github/`. | **BLOCKED** |
| **Workflow on Default Branch (`main`)** | Present inside nested folder on `origin/main`. | **PARTIALLY VERIFIED** |
| **Workflow on Release Branch** | Present inside nested folder on `origin/release/v1.0.0-rc1`. | **PARTIALLY VERIFIED** |
| **pull_request Trigger in ci.yml** | Only `on: push: branches: ["main"]` defined. | **BLOCKED** |
| **GitHub Actions Discovery** | GitHub API `/actions/workflows` returned `total_count: 0`. | **BLOCKED** |
| **PR Exists** | PR #1 (`release/v1.0.0-rc1` -> `main`) verified open. | **PASS** |
| **PR Checks Attached** | GitHub API `/check-runs` returned `total_count: 0`. | **BLOCKED** |
| **CI Execution** | No GitHub runner execution occurred. | **BLOCKED** |

---

## 5. Minimal Corrective Action Plan

To enable GitHub Actions and CodeRabbit discovery without disrupting application logic:
1. Promote `.github/workflows/` and `.coderabbit.yaml` to the Git repository root (or promote all files to root).
2. Add `pull_request` trigger to `ci.yml`:
   ```yaml
   on:
     push:
       branches: ["main"]
     pull_request:
       branches: ["main"]
   ```
3. Commit and push to `release/v1.0.0-rc1`.

---

## 6. Release Gate 2 Decision

```
====================================================================
GATE 2: BLOCKED
====================================================================
REASON: Workflows located inside nested folder Linkedin-Hyper-V-main/.github/
GitHub Actions requires /.github/workflows/ at repository root.
====================================================================
```
