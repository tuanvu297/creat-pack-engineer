# Explicit update and rollback

Versions use `0.2.0-ai.1` and `0.2.0-human.1`: SemVer prerelease identifiers
distinguish mode and iteration. Keep AI and Human install directories separate.
No silent auto-update policy is enabled. There is no network version checker;
the owner supplies a candidate release and trusted external checksum.

## AI Mode

Use a trusted Python 3.10+ runtime, and run the current installed
`bin/kit-manager.py` with `--install-root ABSOLUTE_INSTALL_ROOT` preceding the
subcommand. Always use the installer version already trusted on the machine.

- `check-version` reports the installed version without network requests.
- `check-version --candidate ABSOLUTE_EXTRACTED_KIT` compares verified local
  manifests. This checks integrity, not publisher identity.
- `update --zip ABSOLUTE_CONSUMER_ZIP --sha256 TRUSTED_EXTERNAL_SHA256` hashes
  the archive before parsing/execution, rejects unsafe entries, verifies the
  kit manifest, requires a strictly newer version in the same mode, copies into
  fresh staging and runs offline tests. Obtain the checksum independently via
  the owner's trusted release receipt. No signature is supplied in this pilot.
- Activation renames current code into backups/<backup ID>, activates staged
  code, tests again and records installation.json. On failure it restores the
  prior code automatically; failed code is retained separately for inspection.
- `rollback` restores the latest backup; `rollback --backup-id ID` chooses one.
  Rollback itself tests the candidate before and after activation and retains
  the displaced code as another backup.
- `uninstall` removes active code and its config receipt. User state and all
  backups remain; no user data or credentials are automatically purged.

Runtime/state: current/ holds immutable manifest-verified code. state/ is a
sibling outside that package and holds the preserved adapter journal. Backups
contain code only; update never replaces state or resets idempotency history.
The selected Python path is absolute and must remain available after install.
Updates are not concurrency-safe with an actively running MCP provider process:
stop the selected client's Manus connector before updating or uninstalling.
The installer serializes its own operations with an exclusive lock and fails
closed when another installer or stale lock is present. Following a crash,
verify no installer remains before removing the stale .install.lock; rerun the
operation to recover install-transaction.json. Never blindly delete a lock for
a running process. Pending provider tasks must be reconciled independently.

Crash recovery returns an uncommitted switch to the previous code; a committed
switch verifies its current package. Staging and backup paths are identified
only by restricted transaction IDs. An I/O failure may require local repair;
preserve state and report WHY_AI_COULD_NOT_DO_IT with the observed error.
Manifest hashes do not defend against another process with the same user's
permission rewriting code after validation; protect the user account and stop
concurrent code modification during maintenance.

## Easy Human Mode

The Windows launcher manages its bundled runtime and per-user executable
backup. Use the visible installer/launcher update, rollback and uninstall
actions documented in START-HERE for that mode. Do not use the AI ZIP updater
on a Human executable. The DPAPI local key and runtime state remain external.

Neither rollback mechanism is a provider task retry or journal rollback.
Neither mechanism resets prior provider acceptance or authorizes new tasks.
