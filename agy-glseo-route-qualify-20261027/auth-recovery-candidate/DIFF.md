# Precise diff — custom.agy-worker → custom.agy-worker-qual

Generated from the accepted connector (~/workspace/custom-connectors/custom.agy-worker)
and the candidate clone (~/workspace/custom-connectors/custom.agy-worker-qual).
Only connector id / provider slug / credential binding / display label / candidate
status note / the candidate's own helper paths differ. All request, host, scope,
lease and recovery logic is byte-identical.

## connector.yaml

```diff
--- custom.agy-worker/connector.yaml
+++ custom.agy-worker-qual/connector.yaml
@@ -1,5 +1,5 @@
-id: "custom.agy-worker"
-title: "AGY Worker (canonical gateway)"
+id: "custom.agy-worker-qual"
+title: "AGY Worker Qual (canonical gateway)"
 description: "Use the canonical AGY gateway as Muse, a bounded worker that arrives, claims, acknowledges, heartbeats, checkpoints, submits results and reads back state on the existing Postgres ledger (EXISTING_POSTGRES_D049)."
 include_in_prompt: false
 require_auth: true
```

## bin/agy_worker.py

```diff
--- custom.agy-worker/bin/agy_worker.py
+++ custom.agy-worker-qual/bin/agy_worker.py
@@ -1,8 +1,8 @@
 #!/usr/bin/env python3
-"""AGY canonical worker helper for Muse (custom.agy-worker).
+"""AGY canonical worker helper for Muse (custom.agy-worker-qual).
 
 CANDIDATE, NOT CONNECTED. This helper is inert until the owner
-completes the connection gate: a registered custom.agy-worker
+completes the connection gate: a registered custom.agy-worker-qual
 credential must exist (the worker identity token the control plane
 issued for Muse, entered once by the owner through Muse's secure
 connection page — never in chat, never in a file, never in an
@@ -40,7 +40,7 @@
 sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
 from dynamic_credentials import add_surrogate_to_request, read_json_response  # noqa: E402
 
-CREDENTIAL = "custom.agy-worker"
+CREDENTIAL = "custom.agy-worker-qual"
 LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
 
 
@@ -159,7 +159,7 @@
 
 
 def main():
-    parser = argparse.ArgumentParser(description="AGY canonical worker helper (custom.agy-worker)")
+    parser = argparse.ArgumentParser(description="AGY canonical worker helper (custom.agy-worker-qual)")
     sub = parser.add_subparsers(dest="command", required=True)
     sub.add_parser("health")
     sub.add_parser("arrive")
```

## CONNECTOR.md

```diff
--- custom.agy-worker/CONNECTOR.md
+++ custom.agy-worker-qual/CONNECTOR.md
@@ -1,8 +1,10 @@
-# AGY Worker (canonical gateway)
+# AGY Worker Qual (canonical gateway)
 
-- `custom.agy-worker` connects Muse to the canonical AGY gateway as one bounded worker. It authenticates with the registered `api_key` credential in the bearer header and calls only the gateway host the owner registers at connect time.
+- CANDIDATE — auth-recovery alias of `custom.agy-worker`, prepared because the original provider's hosted connection capture is blocked on the platform side (see the task's platform bug report). NOT connected, and NOT approved for connection: the owner must first approve this exact new connection name. It differs from `custom.agy-worker` only in connector id, provider slug, credential binding and label — same gateway host, same worker identity and scope, same owner-issued worker key, same api_key/bearer_header placement, same helper logic. A new provider name is not proven to fix the platform save failure.
 
-- The helper is `~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py`. It implements the worker side of the canonical worker-surface contract and nothing else.
+- `custom.agy-worker-qual` connects Muse to the canonical AGY gateway as one bounded worker. It authenticates with the registered `api_key` credential in the bearer header and calls only the gateway host the owner registers at connect time.
+
+- The helper is `~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py`. It implements the worker side of the canonical worker-surface contract and nothing else.
 
 - Status is a prepared candidate, not connected. No credential has been registered, and every command below is untested against the live gateway. Local evidence exists and is labelled as such in the qualification report. Do not present any command as working live until the owner completes the connection gate and a first health call succeeds.
 
@@ -14,7 +16,7 @@
 
 ```json
 {
-  "provider": "agy-worker",
+  "provider": "agy-worker-qual",
   "auth_scheme": "api_key",
   "placement": "bearer_header",
   "api_hosts": ["agy-temporal-staging-staging.up.railway.app"]
@@ -26,7 +28,7 @@
 - Before the first change in a conversation, prove access with a harmless read:
 
 ```text
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py health
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py health
 ```
 
 ## Credentials
@@ -46,7 +48,7 @@
 - Read the gateway health and confirm it reports READY with the Postgres authority before any worker action. This call reads data only.
 
 ```text
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py health
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py health
 ```
 
 - The helper refuses to continue when the answer does not confirm `EXISTING_POSTGRES_D049`.
@@ -56,7 +58,7 @@
 - Announce this worker's presence in the configured scope. Arrival is a qualification opt-in, not a general presence endpoint. It succeeds only while a live grant window covers this worker in this scope. It stamps presence and projects the project's own provisioned permissions and quota cap into the worker profile. It never sets the worker status, never grants quota and never registers a new worker.
 
 ```text
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py arrive
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py arrive
 ```
 
 - A worker the control plane has not provisioned is refused with `WORKER_NOT_PROVISIONED`. Outside a granted window, or after cleanup, arrival is refused with `ARRIVAL_NOT_GRANTED` or `ARRIVAL_REFUSED` and changes nothing. There is no register command and no self-provisioning.
@@ -66,7 +68,7 @@
 - Claim at most one lease for this worker. Save the full JSON answer verbatim as the lease file for the follow-up commands, and treat that file as a credential.
 
 ```text
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py claim
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py claim
 ```
 
 - An answer with status `EMPTY` means no task was leased. Never treat it as a claim.
@@ -76,10 +78,10 @@
 - Acknowledge a lease, renew it with heartbeat while work runs, write checkpoints, and read task and callback state back. Each command takes the lease identity from the lease file.
 
 ```text
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py ack --lease-file <lease.json>
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py heartbeat --lease-file <lease.json>
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py checkpoint --lease-file <lease.json> --external-id <operation-id> --state-file <state.json>
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py readback --lease-file <lease.json>
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py ack --lease-file <lease.json>
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py heartbeat --lease-file <lease.json>
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py checkpoint --lease-file <lease.json> --external-id <operation-id> --state-file <state.json>
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py readback --lease-file <lease.json>
 ```
 
 - Readback is the recovery tool. After any uncertain outcome, read the task back before deciding anything. Readback shows the task state and the latest callback state for tasks this worker participates in.
@@ -89,7 +91,7 @@
 - Submit the result with its evidence reference. The answer records the callback in the outbox as PENDING. Delivery is performed by the control plane's server-side dispatcher, and QA is a separate reviewer action that this worker never performs on its own work.
 
 ```text
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py result --lease-file <lease.json> --result-file <result.json> --external-operation-id <operation-id>
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py result --lease-file <lease.json> --result-file <result.json> --external-operation-id <operation-id>
 ```
 
 - Submitting the same result again with identical content returns the recorded callback exactly once. Different content under the same attempt is a conflict and is rejected.
@@ -101,7 +103,7 @@
 - When a claim response is lost, recover the lease with the owner-issued run id from the assignment. Recovery is read-only. It returns this worker's own live lease for that run, and the output can be saved as the lease file to continue with the same attempt. It never claims a new lease and never extends the old one.
 
 ```text
-python3 ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py recover --run-id <owner-run-id>
+python3 ~/workspace/custom-connectors/custom.agy-worker-qual/bin/agy_worker.py recover --run-id <owner-run-id>
 ```
 
 - A run this worker holds nothing under answers `NOT_FOUND` or `NO_ACTIVE_LEASE` with no task data. An expired lease fails closed with `LEASE_EXPIRED`. Recovery never revives a lease. Never invent lease values.
```
