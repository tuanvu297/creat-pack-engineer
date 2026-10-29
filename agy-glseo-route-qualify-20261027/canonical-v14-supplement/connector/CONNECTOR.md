# AGY Worker (canonical gateway)

- `custom.agy-worker` connects Muse to the canonical AGY gateway as one bounded worker. It authenticates with the registered `api_key` credential in the bearer header and calls only the gateway host the owner registers at connect time.

- The helper is `~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py`. It implements the worker side of the canonical worker-surface contract and nothing else.

- Status is a prepared candidate, not connected. No credential has been registered, and every command below is untested against the live gateway. Local evidence exists and is labelled as such in the qualification report. Do not present any command as working live until the owner completes the connection gate and a first health call succeeds.

- This connector is the canonical route. The older `custom.agy-runtime` connector targets the gateway-shadow contract and must not be connected, because the shadow plane is not the authority.

## Connect

- The connection is registered with `credentials.request_api_access` and these details. Reuse them to reconnect:

```json
{
  "provider": "agy-worker",
  "auth_scheme": "api_key",
  "placement": "bearer_header",
  "api_hosts": ["agy-temporal-staging-staging.up.railway.app"]
}
```

- Set `AGY_WORKER_GATEWAY_URL` to the gateway https origin before the first command. The scope defaults to tenant `gl`, workspace `legacy-workspace`, project `GL_QUALIFICATION`. Override with `AGY_WORKER_TENANT`, `AGY_WORKER_WORKSPACE` and `AGY_WORKER_PROJECT` only inside an approved task that names a different scope.

- Before the first change in a conversation, prove access with a harmless read:

```text
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py health
```

## Credentials

- The registered connection holds the credential. Helpers import `/opt/muse/skills/custom-connector-setup/bin/dynamic_credentials.py`, which returns an `hsurr:` surrogate and places it where the provider reads the key. Muse swaps in the real credential only on an approved request to a registered host.

- Never put a key, token, password or cookie in this doc, a helper, a command argument, an environment variable or a log. Never ask the user to paste one in chat.

- Keep redirects disabled on authenticated requests.

- On a 401 or 403, check the request first. Confirm that the helper attached the credential, that the host is registered and that the placement and scopes match.

- Only when a request that carried the credential is still rejected, call `credentials.request_api_access` with the details above and `"reconnect": true`.

## Check gateway health

- Read the gateway health and confirm it reports READY with the Postgres authority before any worker action. This call reads data only.

```text
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py health
```

- The helper refuses to continue when the answer does not confirm `EXISTING_POSTGRES_D049`.

## Arrive

- Announce this worker's presence in the configured scope. Arrival is a qualification opt-in, not a general presence endpoint. It succeeds only while a live grant window covers this worker in this scope. It stamps presence and projects the project's own provisioned permissions and quota cap into the worker profile. It never sets the worker status, never grants quota and never registers a new worker.

```text
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py arrive
```

- A worker the control plane has not provisioned is refused with `WORKER_NOT_PROVISIONED`. Outside a granted window, or after cleanup, arrival is refused with `ARRIVAL_NOT_GRANTED` or `ARRIVAL_REFUSED` and changes nothing. There is no register command and no self-provisioning.

## Claim one task

- Claim at most one lease for this worker. Save the full JSON answer verbatim as the lease file for the follow-up commands, and treat that file as a credential.

```text
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py claim
```

- An answer with status `EMPTY` means no task was leased. Never treat it as a claim.

## Acknowledge, heartbeat, checkpoint and readback

- Acknowledge a lease, renew it with heartbeat while work runs, write checkpoints, and read task and callback state back. Each command takes the lease identity from the lease file.

```text
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py ack --lease-file <lease.json>
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py heartbeat --lease-file <lease.json>
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py checkpoint --lease-file <lease.json> --external-id <operation-id> --state-file <state.json>
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py readback --lease-file <lease.json>
```

- Readback is the recovery tool. After any uncertain outcome, read the task back before deciding anything. Readback shows the task state and the latest callback state for tasks this worker participates in.

## Submit a result

- Submit the result with its evidence reference. The answer records the callback in the outbox as PENDING. Delivery is performed by the control plane's server-side dispatcher, and QA is a separate reviewer action that this worker never performs on its own work.

```text
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py result --lease-file <lease.json> --result-file <result.json> --external-operation-id <operation-id>
```

- Submitting the same result again with identical content returns the recorded callback exactly once. Different content under the same attempt is a conflict and is rejected.

## Recover from errors

- A gateway 5xx or a transport failure on a POST is reported as UNCERTAIN with exit code 3. The gateway may have committed the action, so reconcile before any retry and never resend the same action blindly.

- When a claim response is lost, recover the lease with the owner-issued run id from the assignment. Recovery is read-only. It returns this worker's own live lease for that run, and the output can be saved as the lease file to continue with the same attempt. It never claims a new lease and never extends the old one.

```text
python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py recover --run-id <owner-run-id>
```

- A run this worker holds nothing under answers `NOT_FOUND` or `NO_ACTIVE_LEASE` with no task data. An expired lease fails closed with `LEASE_EXPIRED`. Recovery never revives a lease. Never invent lease values.

- When a lease file exists, read the task back with readback before deciding anything.

- A rejected request is reported as BLOCKED with exit code 2 and the gateway's error code. Fix the named cause instead of retrying.

## Limits

- The helper has no create-task, callback-send, QA verdict, admin, deploy or publish command. It cannot act for any worker other than the one its token identifies, and it cannot act for Gemini.

- No operation in this doc has been run against a live gateway. Local loopback evidence against the real gateway code on a local Postgres is recorded in the qualification report and is labelled local, not live.

## Related skills

- Use `muse.skill_search` to find other skills and `muse.connector_search` to find other connectors.
