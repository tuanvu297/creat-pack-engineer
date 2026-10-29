# AGY Runtime (gateway-shadow worker)

- `custom.agy-runtime` connects Muse to the AGY Runtime gateway as one bounded worker. It authenticates with the registered `api_key` credential in the bearer header and calls only the gateway host the owner registers at connect time.

- The helper is `~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py`. It implements the worker side of the gateway contract and nothing else.

- Status is prepared, not connected. No credential has been registered, no gateway host is known yet, and every command below is untested against a live gateway. Do not present any of them as working until the owner completes the connection gate and a first health call succeeds.

## Connect

- The connection is registered with `credentials.request_api_access` and these details. Reuse them to reconnect:

```json
{
  "provider": "agy-runtime",
  "auth_scheme": "api_key",
  "placement": "bearer_header",
  "api_hosts": ["<the public https host of the AGY gateway, supplied by the control plane at the owner gate>"]
}
```

- Set `AGY_RUNTIME_GATEWAY_URL` to the gateway https origin and `AGY_RUNTIME_WORKER_ID` to the worker ID the gateway issued for Muse before the first command. The gateway private Railway hostname is not reachable from Muse, so the control plane must expose an https endpoint or an agreed private network route first.

- Before the first change in a conversation, prove access with a harmless read:

```text
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py health
```

## Credentials

- The registered connection holds the credential. Helpers import `/opt/muse/skills/custom-connector-setup/bin/dynamic_credentials.py`, which returns an `hsurr:` surrogate and places it where the provider reads the key. Muse swaps in the real credential only on an approved request to a registered host.

- Never put a key, token, password or cookie in this doc, a helper, a command argument, an environment variable or a log. Never ask the user to paste one in chat.

- Keep redirects disabled on authenticated requests.

- On a 401 or 403, check the request first. Confirm that the helper attached the credential, that the host is registered and that the placement and scopes match.

- Only when a request that carried the credential is still rejected, call `credentials.request_api_access` with the details above and `"reconnect": true`.

## Check gateway health

- Read the gateway health and confirm it reports the Postgres authority before any worker action. This call reads data only.

```text
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py health
```

- The helper refuses to continue when the answer does not confirm `EXISTING_POSTGRES_D049`.

## Register this worker

- Register the configured worker ID with the capabilities the owner approved. This changes gateway state, so run it only inside an approved task.

```text
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py register --capabilities text,planning,qa
```

- The helper always registers provider `MUSE` with role `WORKER` and the fixed permission set read, analyze, planning, qa.

## Claim one task

- Claim at most one lease for this worker. Save the full JSON answer as the lease file for the follow up commands, and keep its idempotency key and attempt ID unchanged.

```text
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py claim --lease-seconds 120
```

- An answer with status `EMPTY` means no task was leased. Never treat it as a claim.

## Acknowledge, heartbeat and checkpoint

- Acknowledge a lease, renew it with heartbeat while work runs, and write checkpoints from state files. Each command checks that the lease belongs to the configured worker before sending anything.

```text
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py ack --lease-file <lease.json>
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py heartbeat --lease-file <lease.json> --lease-seconds 120
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py checkpoint --lease-file <lease.json> --version 1 --state-file <state.json>
```

## Submit a result and send the callback

- Submit the result with its evidence reference, then send the RESULT_READY callback for the same lease. The callback payload keeps QA as PENDING because this worker never grades its own work.

```text
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py result --lease-file <lease.json> --result-status RESULT_READY --output-file <output.json> --external-operation-id <operation-id>
python3 ~/workspace/custom-connectors/custom.agy-runtime/bin/agy_runtime.py callback --lease-file <lease.json> --callback-id <callback-id>
```

## Recover from errors

- A gateway 5xx or a transport failure on a POST is reported as UNCERTAIN with exit code 3. The gateway may have committed the action, so read the gateway state for that task before any retry and never resend the same action blindly.

- A rejected request is reported as BLOCKED with exit code 2. Fix the named cause instead of retrying.

- A stale or foreign lease is refused locally with LEASE_WORKER_MISMATCH or LEASE_FILE_INVALID. Reconcile through the gateway instead of editing the lease file.

## Limits

- The helper has no create-task, QA verdict, admin, deploy or publish command. It cannot act for any worker other than the configured one, and it cannot act for Gemini.

- The gateway worker boundary in the runtime source rejects attempt numbers above 1 without reconciliation, non-zero task cost, and permissions outside read, analyze, planning and qa. Publish class work stays outside this connector.

- No operation in this doc has been run against a live gateway. The local unit tests for the contract live with the qualification artifacts and are labelled as mocked transport tests.

## Related skills

- Use `muse.skill_search` to find other skills and `muse.connector_search` to find other connectors.
