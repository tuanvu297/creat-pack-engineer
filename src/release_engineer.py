"""Read-only inspection and deterministic local release packaging. No network calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
import zipfile
from datetime import datetime, timezone

MAX_FILE = 20 * 1024 * 1024
MAX_TOTAL = 100 * 1024 * 1024
MAX_ENTRIES = 2000
EXCLUDED = {".git", "__pycache__", ".venv", "node_modules", ".state", "dist"}
LEVELS = ("INSTALL_TEST_PASS", "LOCAL_FUNCTION_PASS", "AUTH_VERIFIED",
          "LIVE_EXECUTION_PASS", "INTEGRATED_PASS")
SENSITIVE_NAME = re.compile(r"(^|/)(\.env($|\.(?!example$))|cookies[^/]*|credential[^/]*|secrets?(?:\.(?:env|json|toml|ya?ml|txt))?|password[^/]*|private[_-]?key[^/]*|id_rsa|id_ed25519)(/|$)|\.(p12|pfx|key)$", re.I)
RULES = {
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "known_token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{24,})\b"),
    "assigned_secret": re.compile(r"(?im)\b(?:api[_-]?key|access[_-]?token|password|hatch_sess|secret)\b[\"']?\s*[:=]\s*[\"']?([A-Za-z0-9_./+=-]{12,})"),
}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def canonical(obj):
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")

def safe_name(name):
    # Archive contract uses POSIX relative paths on every host, including Windows.
    if not name or "\\" in name or ":" in name or name.startswith("/") or "\x00" in name:
        raise ValueError("unsafe archive path")
    parts = name.split("/")
    reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
    if any(p in {"", ".", ".."} or p.endswith((" ", ".")) or
           p.split(".")[0].lower() in reserved or re.search(r'[<>"|?*\x00-\x1f]', p) for p in parts):
        raise ValueError("unsafe archive path")
    return str(PurePosixPath(name))

def screen(name, data):
    hits = []
    if SENSITIVE_NAME.search(name):
        hits.append({"file": name, "rule": "sensitive_filename"})
    text = data.decode("utf-8", errors="replace")
    for rule, pattern in RULES.items():
        for match in pattern.finditer(text):
            if rule == "assigned_secret":
                value = match.group(1)
                if value.upper() in {"YOUR_API_KEY", "EXAMPLE_VALUE", "REPLACE_WITH_SECRET", "SECRET_STORE_REF"}:
                    continue
                # Referencing an environment variable is not embedding its value.
                if value.startswith("process.env."):
                    continue
                # This exact deterministic test fixture is intentionally public.
                if (name == "agy-temporal-shadow/test/worker-ui.integration.test.ts" or
                        name.endswith("/agy-temporal-shadow/test/worker-ui.integration.test.ts")) and (
                        sha(value.encode("utf-8")) == "d95f39b47f6d9c40ed9a3ded47ce04a134f95d5aa5ba6c841528728218cdaf58"):
                    continue
            hits.append({"file": name, "line": text.count("\n", 0, match.start()) + 1, "rule": rule})
    return hits  # Values and snippets are deliberately omitted.

def snapshot(root):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("source must be a directory")
    files, seen, total = {}, set(), 0
    for current, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED)
        for d in dirs:
            p = Path(current) / d
            if p.is_symlink() or getattr(p, "is_junction", lambda: False)():
                raise ValueError("symlink/junction directory rejected")
        for name in sorted(names):
            if name.endswith(".pyc"):
                continue
            p = Path(current) / name
            if p.is_symlink() or not p.is_file() or not p.resolve().is_relative_to(root):
                raise ValueError("source path escape rejected")
            rel = safe_name(p.relative_to(root).as_posix())
            if rel.casefold() in seen:
                raise ValueError("case-colliding source paths")
            seen.add(rel.casefold())
            if p.stat().st_size > MAX_FILE:
                raise ValueError("file size limit exceeded")
            data = p.read_bytes()
            total += len(data)
            if len(data) > MAX_FILE or total > MAX_TOTAL or len(files) >= MAX_ENTRIES:
                raise ValueError("source size/count limit exceeded")
            if rel.lower().endswith(".zip"):
                raise ValueError("nested archive rejected; inspect separately")
            files[rel] = data
    return files

def inspect_zip(path):
    files, entries, seen, total, findings = {}, [], set(), 0, []
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > MAX_ENTRIES:
            raise ValueError("archive entry limit exceeded")
        for info in archive.infolist():
            name = safe_name(info.filename[:-1] if info.is_dir() else info.filename)
            if name.casefold() in seen:
                raise ValueError("duplicate/case-colliding archive paths")
            seen.add(name.casefold())
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode) or info.flag_bits & 1:
                raise ValueError("symlink or encrypted archive entry rejected")
            total += info.file_size
            if info.file_size > MAX_FILE or total > MAX_TOTAL:
                raise ValueError("archive size limit exceeded")
            if info.is_dir():
                continue
            if name.lower().endswith(".zip"):
                raise ValueError("nested archive rejected")
            data = archive.read(info)  # CRC is checked; never execute or extract.
            files[name] = data
            entries.append({"path": name, "size": len(data), "sha256": sha(data)})
            findings.extend(screen(name, data))
    return files, {"classification": "OBSERVED", "archive_sha256": sha(Path(path).read_bytes()),
                   "files": entries, "secret_scan": {"status": "FAIL" if findings else "PASS", "findings": findings,
                   "scope": "filename and decoded bytes; compressed PDF streams not decoded"},
                   "executed_input": False}

def verify_zip(path):
    files, inspection = inspect_zip(path)
    candidates = [n for n in files if n.endswith("/MANIFEST.json")]
    if len(candidates) != 1:
        raise ValueError("exactly one top-level manifest required")
    manifest_path = candidates[0]
    prefix, basename = manifest_path.split("/", 1)
    if basename != "MANIFEST.json":
        raise ValueError("manifest must be at package root")
    manifest = json.loads(files[manifest_path])
    required = {"package_name", "package_version", "purpose", "created_at", "runtime_requirements",
                "dependencies", "entrypoints", "input_contract", "output_contract", "files",
                "known_limits", "authentication_requirements", "test_status"}
    if not required.issubset(manifest):
        raise ValueError("manifest fields missing")
    records = manifest["files"]
    names = [safe_name(r["path"]) for r in records]
    if len(names) != len(set(n.casefold() for n in names)):
        raise ValueError("duplicate manifest entries")
    expected = {prefix + "/" + n for n in names}
    if set(files) != expected | {manifest_path}:
        raise ValueError("manifest inventory mismatch")
    for r in records:
        data = files[prefix + "/" + r["path"]]
        if sha(data) != r["sha256"] or len(data) != r["size"]:
            raise ValueError("manifest hash/size mismatch")
    for entry in manifest["entrypoints"]:
        if prefix + "/" + safe_name(entry) not in files:
            raise ValueError("entrypoint missing")
    if inspection["secret_scan"]["status"] != "PASS":
        raise ValueError("secret scan failed (values redacted)")
    return {"PACKAGE_BUILT": "PASS", "manifest_verified": True,
            "archive_sha256": inspection["archive_sha256"], "file_count": len(records),
            "test_status": manifest["test_status"],
            "test_claims_source": "manifest declarations; verify referenced evidence separately"}

def build(root, output):
    root, output = Path(root).resolve(strict=True), Path(output).resolve()
    if output == root or output.is_relative_to(root):
        raise ValueError("output must be outside source root")
    files = snapshot(root)
    if "MANIFEST.json" in files:
        raise ValueError("reserved root MANIFEST.json; remove stale generated manifest from staging")
    config = json.loads(files["config/package.json"])
    name, version = config["package_name"], config["package_version"]
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name) or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?", version):
        raise ValueError("invalid package name/version")
    if files.get("VERSION", b"").decode().strip() != version:
        raise ValueError("VERSION/config mismatch")
    for entry in config["entrypoints"]:
        if safe_name(entry) not in files:
            raise ValueError("entrypoint missing")
    findings = [h for n, data in files.items() for h in screen(n, data)]
    if findings:
        raise ValueError("secret scan failed: " + json.dumps(findings, ensure_ascii=False))
    manifest = dict(config)
    # Reproducible unless the caller deliberately changes SOURCE_DATE_EPOCH.
    manifest["created_at"] = datetime.fromtimestamp(int(os.environ.get("SOURCE_DATE_EPOCH", "0")), timezone.utc).isoformat()
    manifest["created_at_policy"] = "SOURCE_DATE_EPOCH or Unix epoch; real handoff time in external receipt"
    manifest["test_status"] = {"PACKAGE_BUILT": "PASS", **{k: "UNVERIFIED" for k in LEVELS}}
    manifest["declared_test_status"] = config.get("test_status", {})
    manifest["files"] = [{"path": n, "size": len(data), "sha256": sha(data)} for n, data in sorted(files.items())]
    prefix = name + "/"
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"{name}-{version}.zip"
    if destination.exists() or (output / "SHA256SUMS.txt").exists() or (output / "RELEASE-RECEIPT.json").exists():
        raise ValueError("release output exists; use a fresh output directory")
    fd, temp = tempfile.mkstemp(prefix=".release-", suffix=".zip", dir=output)
    os.close(fd)
    try:
        with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            contents = {**files, "MANIFEST.json": canonical(manifest)}
            for n, data in sorted(contents.items()):
                info = zipfile.ZipInfo(prefix + n, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = ((0o100755 if n.startswith("bin/") else 0o100644) << 16)
                archive.writestr(info, data)
        result = verify_zip(temp)
        # Hard-link commits atomically without clobbering a concurrent release.
        os.link(temp, destination)
        receipt = {**result, "package_name": name, "package_version": version,
                   "released_at": datetime.now(timezone.utc).isoformat(), "zip": destination.name,
                   "callback": {"mode": "local_receipt", "delivered_to_external_system": False},
                   "runtime": sys.version.split()[0], "secret_scan": "PASS_SIGNATURE_SCAN",
                   "commercial_ready": "UNVERIFIED", "known_limits": manifest["known_limits"]}
        with (output / "SHA256SUMS.txt").open("x", encoding="utf-8") as stream:
            stream.write(f"{result['archive_sha256']}  {destination.name}\n")
        with (output / "RELEASE-RECEIPT.json").open("xb") as stream:
            stream.write(canonical(receipt))
        return receipt
    finally:
        Path(temp).unlink(missing_ok=True)

def doctor(path):
    files, observed = inspect_zip(path)
    gaps = []
    if not any(n.endswith("/MANIFEST.json") for n in files):
        gaps.append("missing MANIFEST.json")
    if not any("/tests/" in n for n in files):
        gaps.append("no packaged test directory observed")
    if not any(n.endswith("/VERSION") for n in files):
        gaps.append("missing VERSION")
    verified = None
    if any(n.endswith("/MANIFEST.json") for n in files):
        try:
            verified = verify_zip(path)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            gaps.append("manifest verification failed")
    return {"application": "Release Assistant", "mode": "local_rules_no_model",
            "observed": observed, "verification": verified, "gaps": gaps,
            "recommendation": "REVIEW_REQUIRED" if gaps or observed["secret_scan"]["findings"] else "PACKAGE_STRUCTURE_VERIFIED",
            "live_execution": "UNVERIFIED"}

def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Creat Pack Release Assistant")
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("inspect", "verify", "doctor"):
        sub.add_parser(command).add_argument("zip")
    p = sub.add_parser("scan"); p.add_argument("root")
    p = sub.add_parser("build"); p.add_argument("root"); p.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            _, result = inspect_zip(args.zip)
        elif args.command == "verify":
            result = verify_zip(args.zip)
        elif args.command == "doctor":
            result = doctor(args.zip)
        elif args.command == "scan":
            files = snapshot(args.root)
            hits = [h for n, data in files.items() for h in screen(n, data)]
            result = {"status": "FAIL" if hits else "PASS", "files_scanned": len(files), "findings": hits}
        else:
            result = build(args.root, args.out)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if args.command in {"scan", "inspect"} and (result.get("status") == "FAIL" or result.get("secret_scan", {}).get("status") == "FAIL") else 0
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError):
        # Do not echo raw parser/provider messages or file contents containing secrets.
        print(json.dumps({"status": "FAIL", "command": args.command,
                          "error": "Input rejected or operation failed; inspect local input and documented limits."}))
        return 1

if __name__ == "__main__":
    raise SystemExit(main())

