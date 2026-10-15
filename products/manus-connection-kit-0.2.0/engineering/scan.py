"""Finite scanner: report filenames/rules only, never matched credential bytes."""
from pathlib import Path
import re,hashlib,zipfile,io
DENIED=re.compile(r'(?i)(^|/)(?:\.env|auth\.json|credentials[^/]*|controller-authority\.key|[^/]*\.sqlite(?:-wal|-shm)?|[^/]*\.db|[^/]*grant[^/]*\.json|node_modules|__pycache__)(/|$)')
PATTERNS={
 'private_key':rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'github_token':rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b',
 'google_oauth':rb'\bya29\.[A-Za-z0-9_-]{25,}',
 'openai_key':rb'\bsk-(?:proj-)?[A-Za-z0-9_-]{35,}',
 'credential_assignment':rb'(?i)(?:MANUS_API_KEY|client_secret|access_token|refresh_token)\s*["\x27]?\s*[:=]\s*["\x27]([A-Za-z0-9_./+=-]{20,})["\x27]',
}
PLACEHOLDERS={b'REPLACE_WITH_SECRET',b'YOUR_MANUS_API_KEY',b'YOUR_API_KEY',b'SECRET_STORE_REF'}
def scan_items(items):
 findings=[];count=0;total=0
 for name,data in items:
  count+=1;total+=len(data)
  if DENIED.search(name):findings.append({'file':name,'rule':'excluded_runtime_or_private_filename'})
  for rule,pattern in PATTERNS.items():
   for m in re.finditer(pattern,data):
    if rule=='credential_assignment' and m[1] in PLACEHOLDERS:continue
    findings.append({'file':name,'rule':rule,'line':data[:m.start()].count(b'\n')+1})
 return {'status':'PASS_FINITE_SCAN' if not findings else 'FAIL','files_scanned':count,'bytes_scanned':total,'findings':findings,'coverage':'Filename denylist and byte signatures; decoded source/ZIP members scanned by caller. Frozen executable bytes checked but compressed PE payload needs build-source allowlist/provenance; not universal credential detection.'}
def tree(root):return [(p.relative_to(root).as_posix(),p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file()]
