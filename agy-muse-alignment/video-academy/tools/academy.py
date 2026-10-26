"""Offline AGY training helpers. No network, provider dispatch, auth or grants."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl

MAX_JSON = 2 * 1024 * 1024
IDENTITY = ('tenant_id', 'workspace_id', 'project_id', 'controller_job_id',
            'task_id', 'attempt', 'idempotency_key')
SECRET_KEYS = {'api_key', 'apikey', 'access_token', 'refresh_token', 'password',
               'cookie', 'authorization', 'client_secret', 'private_key'}
DENIED = {'publish', 'purchase', 'new_paid_usage', 'delete_data', 'change_canon',
          'raw_secret_export', 'arbitrary_shell', 'raw_sql', 'arbitrary_http'}


def read_json(path):
    p = Path(path)
    if p.stat().st_size > MAX_JSON:
        raise ValueError('JSON_TOO_LARGE')
    return json.loads(p.read_text(encoding='utf-8-sig'))


def secret_findings(value, path='$'):
    """Report locations only, never echo suspicious values."""
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            field = str(key).lower().replace('-', '_')
            if field in SECRET_KEYS and child not in (None, '', False):
                found.append(path + '.' + str(key))
            if field.endswith('_secret_ref') and child and not str(child).startswith('secretref://'):
                found.append(path + '.' + str(key))
            found += secret_findings(child, path + '.' + str(key))
    elif isinstance(value, list):
        for i, child in enumerate(value):
            found += secret_findings(child, f'{path}[{i}]')
    elif isinstance(value, str):
        if re.search(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', value):
            found.append(path)
        if value.startswith(('https://', 'http://')):
            url = urlsplit(value)
            if url.username or url.password or any(k.lower() in SECRET_KEYS or k.lower() in {'token', 'key', 'signature'} for k, _ in parse_qsl(url.query)):
                found.append(path)
    return sorted(set(found))


def validate_identity(obj):
    errors = []
    for key in IDENTITY:
        val = obj.get(key)
        if key == 'attempt':
            if type(val) is not int or val < 1:
                errors.append('INVALID_' + key.upper())
        elif not isinstance(val, str) or not val.strip() or len(val) > 4096:
            errors.append('INVALID_' + key.upper())
    return errors


def compile_brief(brief, policy):
    if not isinstance(brief, dict) or not isinstance(policy, dict):
        raise ValueError('OBJECT_REQUIRED')
    errors = validate_identity(brief)
    if secret_findings(brief):
        errors.append('SECRET_PAYLOAD_DENIED')
    task_class = brief.get('task_class')
    if task_class not in policy.get('allowed_task_classes', []):
        errors.append('TASK_CLASS_DENIED')
    tools = brief.get('allowed_tools')
    if not isinstance(tools, list) or not all(isinstance(t, str) and t and t not in DENIED for t in tools):
        errors.append('TOOL_SCOPE_DENIED')
    criteria = brief.get('acceptance_criteria')
    if not isinstance(criteria, list) or not criteria or not all(isinstance(c, str) and c.strip() for c in criteria):
        errors.append('ACCEPTANCE_REQUIRED')
    if not isinstance(brief.get('objective'), str) or not brief['objective'].strip():
        errors.append('OBJECTIVE_REQUIRED')
    if errors:
        return {'validation': 'INVALID', 'errors': sorted(set(errors)), 'dispatch_performed': False}
    # Intentionally exclude untrusted extra fields, credentials and claimed grants.
    job = {key: brief[key] for key in IDENTITY}
    job.update(task_class=task_class, objective=brief['objective'], worker='Muse',
               planner='Gemini', executor_runtime=brief.get('executor_runtime'),
               allowed_tools=tools, acceptance_criteria=criteria,
               approved_reference_ids=brief.get('approved_reference_ids', []),
               retry={'max_retries': min(2, policy.get('max_retries', 0)),
                      'uncertain': 'RECONCILE_SAME_OPERATION'},
               forbidden_actions=sorted(DENIED),
               source_versions=brief.get('source_versions', []))
    blockers = []
    if policy.get('current_execution_enabled') is not True:
        blockers.append('EXECUTION_NOT_ACTIVATED')
    if not job['executor_runtime']:
        blockers.append('EXECUTOR_BINDING_MISSING')
    # Caller-provided flags never establish server-side auth or a provider grant.
    blockers += ['SERVER_AUTH_NOT_VERIFIED', 'COST_AUTHORITY_NOT_VERIFIED',
                 'WORKER_ACK_NOT_VERIFIED', 'CALLBACK_BINDING_NOT_VERIFIED']
    return {'validation': 'CONTRACT_COMPILED', 'job': job,
            'readiness': 'BLOCKED', 'blockers': blockers,
            'dispatch_performed': False, 'rights_granted': False}


def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def contained_artifact(root, name):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name:
        raise ValueError('ARTIFACT_PATH_DENIED')
    rel = Path(name)
    if rel.is_absolute() or '..' in rel.parts:
        raise ValueError('ARTIFACT_PATH_DENIED')
    base = Path(root).resolve()
    candidate = base / rel
    if any(p.is_symlink() for p in [candidate, *candidate.parents] if p != base):
        raise ValueError('ARTIFACT_SYMLINK_DENIED')
    resolved = candidate.resolve()
    if not resolved.is_relative_to(base) or not resolved.is_file():
        raise ValueError('ARTIFACT_MISSING_OR_OUTSIDE_SCOPE')
    return resolved


def check_receipt(job, receipt, artifacts_root=None):
    if not isinstance(job, dict) or not isinstance(receipt, dict):
        raise ValueError('OBJECT_REQUIRED')
    errors = validate_identity(job) + validate_identity(receipt)
    if secret_findings(receipt):
        errors.append('SECRET_PAYLOAD_DENIED')
    for key in IDENTITY:
        if receipt.get(key) != job.get(key):
            errors.append('IDENTITY_MISMATCH_' + key.upper())
    if job.get('worker') != 'Muse' or receipt.get('worker') != 'Muse':
        errors.append('WORKER_MISMATCH')
    if not job.get('executor_runtime') or receipt.get('executor_runtime') != job.get('executor_runtime'):
        errors.append('EXECUTOR_MISMATCH')
    status = receipt.get('status')
    if status not in {'ACKED', 'RUNNING', 'COMPLETE', 'FAIL', 'BLOCKED', 'UNKNOWN'}:
        errors.append('INVALID_STATUS')
    if status in {'ACKED', 'RUNNING', 'COMPLETE'} and not receipt.get('operation_id'):
        errors.append('OPERATION_ID_REQUIRED')
    measured = []
    if status == 'COMPLETE':
        artifacts = receipt.get('artifacts')
        if not isinstance(artifacts, list) or not artifacts:
            errors.append('ARTIFACT_REQUIRED')
            artifacts = []
        for artifact in artifacts:
            if not isinstance(artifact, dict) or not re.fullmatch(r'[a-f0-9]{64}', str(artifact.get('sha256', ''))):
                errors.append('ARTIFACT_HASH_REQUIRED')
                continue
            if artifacts_root is None:
                errors.append('ARTIFACT_BYTES_UNVERIFIED')
                continue
            try:
                file = contained_artifact(artifacts_root, artifact.get('path'))
                digest = sha256_file(file)
                if digest != artifact['sha256']:
                    errors.append('ARTIFACT_HASH_MISMATCH')
                else:
                    measured.append({'path': artifact['path'], 'sha256': digest, 'bytes': file.stat().st_size})
            except (ValueError, OSError) as exc:
                errors.append(str(exc) if isinstance(exc, ValueError) else 'ARTIFACT_READ_ERROR')
        qa = receipt.get('qa')
        if not isinstance(qa, dict):
            errors.append('QA_REQUIRED')
        else:
            if qa.get('reviewer') in (None, '', 'Muse'):
                errors.append('INDEPENDENT_REVIEW_REQUIRED')
            if not isinstance(qa.get('evidence_refs'), list) or not qa['evidence_refs']:
                errors.append('QA_EVIDENCE_REQUIRED')
            if job.get('task_class') in {'VIDEO_PRODUCTION', 'VIDEO_QA'}:
                for criterion in ('full_motion', 'audio', 'identity_continuity'):
                    if qa.get(criterion) != 'PASS':
                        errors.append('QA_UNVERIFIED_' + criterion.upper())
    return {'validation': 'INVALID' if errors else 'CONTRACT_VALID',
            'errors': sorted(set(errors)), 'local_artifact_checks': measured,
            'production_acceptance': False, 'provider_authenticity_verified': False,
            'note': 'Offline structural/hash check only; perceptual QA and server/provider authenticity remain external evidence.'}


def doctor(root):
    root = Path(root).resolve()
    errors = []
    json_count = 0
    for p in root.rglob('*.json'):
        if {'dist', '__pycache__'} & set(p.relative_to(root).parts):
            continue
        try:
            value = read_json(p)
            json_count += 1
            if secret_findings(value):
                errors.append('SECRET_FIELD:' + p.relative_to(root).as_posix())
        except (ValueError, OSError):
            errors.append('INVALID_JSON:' + p.relative_to(root).as_posix())
    plugin = root / 'plugin'
    manifest = read_json(plugin / 'plugin.json')
    if manifest.get('$schema') != 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json':
        errors.append('PLUGIN_SCHEMA')
    if manifest.get('name') != 'agy-muse-video-academy':
        errors.append('PLUGIN_NAME')
    interface = manifest.get('extensions', {}).get('com.openai', {}).get('interface', {})
    if len(interface.get('shortDescription', '')) > 30:
        errors.append('SUBTITLE_TOO_LONG')
    skill_names = []
    for p in sorted((plugin / 'skills').glob('*/SKILL.md')):
        content = p.read_text(encoding='utf-8')
        match = re.match(r'^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n', content)
        if not match or match[1] != p.parent.name:
            errors.append('INVALID_SKILL:' + p.parent.name)
        else:
            # All generated frontmatter descriptions are JSON strings, a YAML subset.
            try:
                if not isinstance(json.loads(match[2]), str):
                    errors.append('INVALID_DESCRIPTION:' + p.parent.name)
            except ValueError:
                errors.append('INVALID_DESCRIPTION:' + p.parent.name)
            skill_names.append(match[1])
        for ref in re.findall(r'\.\./\.\./knowledge/[A-Za-z0-9_-]+\.md', content):
            target = (p.parent / ref).resolve()
            if not target.is_relative_to(plugin) or not target.is_file():
                errors.append('MISSING_REFERENCE:' + ref)
    if len(skill_names) != 5 or len(set(skill_names)) != len(skill_names):
        errors.append('SKILL_INVENTORY')
    for p in plugin.rglob('*'):
        if p.is_symlink():
            errors.append('SYMLINK_DENIED')
    return {'validation': 'INVALID' if errors else 'PACKAGE_STRUCTURE_VALID',
            'errors': errors, 'json_files': json_count, 'skills': skill_names,
            'live_muse_connection': False, 'learning_mastery_verified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    d = commands.add_parser('doctor'); d.add_argument('root')
    c = commands.add_parser('compile'); c.add_argument('brief'); c.add_argument('--policy', required=True); c.add_argument('--out')
    r = commands.add_parser('check-receipt'); r.add_argument('--job', required=True); r.add_argument('--receipt', required=True); r.add_argument('--artifacts-root')
    args = parser.parse_args()
    try:
        if args.command == 'doctor':
            result = doctor(args.root)
        elif args.command == 'compile':
            result = compile_brief(read_json(args.brief), read_json(args.policy))
        else:
            result = check_receipt(read_json(args.job), read_json(args.receipt), args.artifacts_root)
        output = json.dumps(result, ensure_ascii=False, indent=2)
        if getattr(args, 'out', None):
            p = Path(args.out)
            with p.open('x', encoding='utf-8') as f:
                f.write(output + '\n')
        print(output)
        return 2 if result['validation'] == 'INVALID' else 0
    except (ValueError, KeyError, TypeError, OSError):
        print(json.dumps({'validation': 'INVALID', 'error': 'INPUT_OR_FILE_CONTRACT_ERROR', 'secret_values_echoed': False}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
