"""Export installed skill names/descriptions only; never copy credentials or bodies."""
import json
import re
from pathlib import Path

ROOTS = [
    Path('C:/Users/ADMIN/.codex/skills/.system'),
    Path('C:/Users/ADMIN/.codex/plugins/cache/created-by-me-remote'),
    Path('C:/Users/ADMIN/.codex/plugins/cache/openai-bundled'),
    Path('C:/Users/ADMIN/.codex/plugins/cache/openai-curated-remote'),
    Path('C:/Users/ADMIN/.codex/plugins/cache/openai-primary-runtime'),
]


def main():
    out = Path(__file__).resolve().parents[1] / 'inventory'
    out.mkdir(exist_ok=True)
    entries, errors = [], []
    for root in ROOTS:
        if not root.is_dir():
            errors.append({'source': root.name, 'status': 'ROOT_UNAVAILABLE'})
            continue
        for p in sorted(root.rglob('SKILL.md')):
            try:
                text = p.read_text(encoding='utf-8-sig')
                if not text.startswith('---'):
                    continue
                header = text.split('---', 2)[1]
                fields = {}
                for key in ('name', 'description'):
                    m = re.search(r'^' + key + r':\s*(.+)$', header, re.M)
                    fields[key] = m[1].strip().strip('"\'') if m else None
                if fields['name'] and fields['description']:
                    entries.append({**fields, 'source_package': root.name,
                                    'source_relative_path': p.relative_to(root).as_posix(),
                                    'transfer': 'METADATA_ONLY',
                                    'muse_installation': 'NOT_ASSERTED'})
            except (OSError, UnicodeError, IndexError):
                errors.append({'source': p.name, 'status': 'READ_FAILED'})
    result = {'scope': 'Readable installed skill metadata, not all user/account skills or Muse grants',
              'collected_on': '2026-10-26', 'skills': entries, 'limitations': errors}
    (out / 'skill-catalog.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'skill_records': len(entries), 'read_limits': len(errors)}))


if __name__ == '__main__':
    main()
