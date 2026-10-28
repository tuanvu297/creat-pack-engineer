#!/usr/bin/env python3
import json, hashlib, os, re, shutil, subprocess, sys, zipfile
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist" / "claude-bundle"
STAGE = OUT / "creat-pack-platform"
ZIP = OUT / "Creat-Pack-Claude-Repo-20261028.zip"

EXCLUDE_PARTS = {".git", ".github", "dist", "__pycache__", ".pytest_cache", ".venv", "venv", "node_modules"}
EXCLUDE_PATTERNS = [re.compile(r"manus", re.I), re.compile(r"(^|[-_/])mck($|[-_/])", re.I)]
SENSITIVE_NAME = re.compile(r"(^|[._-])(token|secret|password|credential|cookie|session|private[-_]?key)([._-]|$)", re.I)
SENSITIVE_CONTENT = [
    re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*['\"][^'\"]{8,}['\"]"),
]

ASSETS = [
    ("release-toolkit","PACKAGE_NOW"),("ai-adapter-starter","PACKAGE_NOW"),("release-assistant-cli-doctor","PACKAGE_NOW"),
    ("ai-release-packaging-skill","PACKAGE_NOW"),("release-qa-evidence-templates","PACKAGE_NOW"),
    ("agy-worker-engine","NEEDS_REFACTOR"),("agy-resource-manager","NEEDS_REFACTOR"),("agy-learning-engine","NEEDS_REFACTOR"),
    ("canonical-task-worker-qa-contracts","NEEDS_REFACTOR"),("browser-gateway-runtime","NEEDS_REFACTOR"),
    ("browser-mcp-extensions","NEEDS_REFACTOR"),("runtime-router-adapters-benchmark","NEEDS_REFACTOR"),
    ("muse-cli-windows-transport","NEEDS_REFACTOR"),("muse-handover-reference","HISTORICAL_EVIDENCE"),
    ("gl-agency-control","NEEDS_REFACTOR"),("lume-production-mcp","NEEDS_REFACTOR"),("tts-audio-audition","NEEDS_REFACTOR"),
    ("gl-content-video-scripts","NEEDS_REFACTOR"),("media-technical-inspector","PACKAGE_NOW"),
    ("media-probe-contact-sheet-recovery","NEEDS_REFACTOR"),("lume-planning-continuity-retry-playbooks","PACKAGE_NOW"),
    ("proprietary-character-reference-assets","INTERNAL_ONLY"),("vietnamese-podcast-voice-skill","PACKAGE_NOW"),
    ("state-coordination-registry","NEEDS_REFACTOR"),("global-ai-coordinator-apps-script","NEEDS_REFACTOR"),
    ("gl-crm-telegram-automation","NEEDS_REFACTOR"),("commission-audit-data","INTERNAL_ONLY"),
    ("worker-learning-skills-education-framework","PACKAGE_NOW"),("claude-migration-harness-gold-tests","NEEDS_REFACTOR"),
    ("private-agy-corpus-handover","INTERNAL_ONLY"),("research-automation-recurring-prompts","HISTORICAL_EVIDENCE"),
    ("portable-site-build-helper","NEEDS_REFACTOR"),("reactivation-agent-blueprint","HISTORICAL_EVIDENCE"),
    ("customer-crm-documents","INTERNAL_ONLY"),("superseded-duplicate-retired-content","DROP_FROM_RELEASE"),
    ("live-auth-plugin-state","INTERNAL_ONLY")
]

def excluded(rel: Path):
    if any(p in EXCLUDE_PARTS for p in rel.parts): return True
    s = rel.as_posix()
    return any(p.search(s) for p in EXCLUDE_PATTERNS)

def sha256(path: Path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')

def main():
    if OUT.exists(): shutil.rmtree(OUT)
    STAGE.mkdir(parents=True)
    copied=[]; skipped=[]; findings=[]
    for p in ROOT.rglob('*'):
        if not p.is_file(): continue
        rel=p.relative_to(ROOT)
        if excluded(rel):
            skipped.append(rel.as_posix()); continue
        if SENSITIVE_NAME.search(p.name) and p.name not in {"SECRET-SCAN.json"}:
            skipped.append(rel.as_posix()); findings.append({"path":rel.as_posix(),"reason":"sensitive_filename_excluded"}); continue
        try:
            data=p.read_bytes()
            if len(data) < 2_000_000:
                text=data.decode('utf-8', errors='ignore')
                if any(rx.search(text) for rx in SENSITIVE_CONTENT):
                    skipped.append(rel.as_posix()); findings.append({"path":rel.as_posix(),"reason":"possible_live_secret_excluded"}); continue
        except Exception:
            pass
        dst=STAGE/rel; dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(p,dst); copied.append(rel.as_posix())

    assets=[{"asset_id":a,"classification":c,"source_status":"IN_REPO_OR_KNOWN" if a in {"release-toolkit","ai-adapter-starter","ai-release-packaging-skill","muse-handover-reference","research-automation-recurring-prompts"} else "SOURCE_TO_RECONCILE","package_state":"DISCOVERED","note":"Manus excluded by owner instruction."} for a,c in ASSETS]
    claude_dir=STAGE/"CLAUDE"
    write(claude_dir/"START-HERE.md", """# CLAUDE START HERE\n\nThis bundle is a non-production consolidation snapshot for Claude.\n\nOwner instruction: Manus / MCK is intentionally excluded.\n\nRead in order:\n1. `CLAUDE/ASSET-CATALOG.json`\n2. `CLAUDE/CLAUDE-TASKS.md`\n3. `README.md` and `docs/`\n4. Existing source/tests/templates/skills\n\nRules:\n- Do not invent missing source.\n- UNKNOWN/UNVERIFIED stays that way until tested.\n- Do not add credentials or live runtime state.\n- Preserve historical failures and provenance.\n- Package/release work is non-destructive unless owner explicitly approves otherwise.\n""")
    write(claude_dir/"CLAUDE-TASKS.md", """# Claude packaging tasks\n\n- Inspect all included source and tests.\n- Reclassify catalog entries only with evidence.\n- Normalize PACKAGE_NOW items first.\n- Refactor NEEDS_REFACTOR items incrementally; do not fabricate implementation.\n- Keep INTERNAL_ONLY out of distributable releases.\n- Preserve HISTORICAL_EVIDENCE without promoting it to current PASS.\n- Run tests before and after material refactors.\n- Add manifest, SHA-256, clean-install/self-test, secret scan and QA receipts per package.\n- Never commit credentials, tokens, cookies, live DBs or customer/private runtime state.\n- Report PASS / FAIL / BLOCKED / UNVERIFIED separately.\n""")
    write(claude_dir/"ASSET-CATALOG.json", json.dumps({"schema_version":"1.0.0","generated_at":datetime.now(timezone.utc).isoformat(),"owner_exclusions":["manus","mck"],"assets":assets},indent=2,ensure_ascii=False)+"\n")

    # Test current included code using repo's existing unittest suite if present.
    test={"command":"python -m unittest discover -s tests -v","status":"UNVERIFIED","returncode":None}
    if (STAGE/"tests").exists():
        proc=subprocess.run([sys.executable,"-m","unittest","discover","-s","tests","-v"],cwd=STAGE,text=True,capture_output=True)
        test.update(status="PASS" if proc.returncode==0 else "FAIL",returncode=proc.returncode,stdout_tail=proc.stdout[-6000:],stderr_tail=proc.stderr[-6000:])
    write(claude_dir/"TEST-RECEIPT.json", json.dumps(test,indent=2,ensure_ascii=False)+"\n")
    security={"status":"PASS_FINITE_SCOPE" if not findings else "PASS_WITH_EXCLUSIONS","scope":"filename + finite content signature scan during bundle build","excluded_findings":findings,"excluded_count":len(findings),"note":"Finite scan cannot prove absence of every possible secret format."}
    write(claude_dir/"SECURITY-RECEIPT.json", json.dumps(security,indent=2,ensure_ascii=False)+"\n")

    files=[]
    for p in sorted(STAGE.rglob('*')):
        if p.is_file(): files.append({"path":p.relative_to(STAGE).as_posix(),"size":p.stat().st_size,"sha256":sha256(p)})
    manifest={"schema_version":"1.0.0","bundle":"creat-pack-platform","generated_at":datetime.now(timezone.utc).isoformat(),"source_repo":"tuanvu297/creat-pack-engineer","source_branch":"packaging/claude-drive-bundle","manus_excluded":True,"files":files,"skipped_paths":skipped}
    write(STAGE/"MANIFEST.json",json.dumps(manifest,indent=2,ensure_ascii=False)+"\n")

    # Refresh manifest to include itself is intentionally avoided; outer checksum covers archive.
    with zipfile.ZipFile(ZIP,'w',zipfile.ZIP_DEFLATED) as z:
        for p in sorted(STAGE.rglob('*')):
            if p.is_file(): z.write(p, Path("creat-pack-platform")/p.relative_to(STAGE))
    digest=sha256(ZIP)
    write(OUT/"Creat-Pack-Claude-Repo-20261028.sha256", f"{digest}  {ZIP.name}\n")
    receipt={"status":"PACKAGE_BUILT","archive":ZIP.name,"archive_sha256":digest,"source_repo":"tuanvu297/creat-pack-engineer","manus_excluded":True,"test_status":test["status"],"security_status":security["status"],"live_execution":"UNVERIFIED","integrated_pass":"UNVERIFIED","production_ready":"UNVERIFIED"}
    write(OUT/"PACKAGE-RECEIPT.json",json.dumps(receipt,indent=2)+"\n")
    print(json.dumps(receipt,indent=2))

if __name__ == '__main__': main()
