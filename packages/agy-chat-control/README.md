# AGY chat control — bounded supplied-text bridge0.2.0

Owner describes a task in the existing AGY control chat. Control compiles one AGY_MISSION_V2 envelope and posts it through the existing private GitHub connector to issue2. The installed logical executor independently validates, queues, claims, ACKs and runs an isolated included-account Codex app-server worker. Result and evidence return to the durable inbox, targeting existing Engineer chat AI master01a13499-9300-72a3-8944-87f9b3fd2362. No new stored Work is created.

Supported task classes: supplied_text_analysis, task_compile and code_review of supplied text. This adapter is useful for summaries, plans, contracts and proposed corrections. It does not authorize arbitrary shell, liveCRM writes, provider/browser actions, deployment, global skills or weight training. Native AGY Core Work can execute separately authorized tasks through its actual tools; its own fresh ACK/output/QA remain required.

## Control contract

Use bin/compile_task.py locally or have control chat compile the exact fields from its recipe. The Owner does not paste commands into Work. Prefix AGY_MISSION_V2 newline strictJSON. Required fields: mission_id/task_id/target_executor/attempt/idempotency_key/objective/context/acceptance/owner_scope_ref/callback_target/QA_CONTRACT_VERSION/task_kind. Owner policy outside package fixes prefix, task classes, worker, callback, expiry and maximum task count. Same identity plus changed input is denied; pending/unknown external intent is never resubmitted.

Objective<=4000 chars; context<=16000;1..10 acceptance strings<=500; envelope<=22000 recommended and ingress<=24000. Result exactschema: task_id, summary, steps[], evidence[], limitations[], needs_owner_action. Aggregate result<=6000 serializedASCII chars; callback<=24000 before POST. Known secret signatures screened, finite coverage only. Do not submit secrets/customer data. Context is untrusted and does not expand tool authority.

## Runtime / install

Python>=3.11, stdlib only; installed signed-in Codex app-server, existing authorized private GitHub connector. Tested runtime/version and source hash in evidence. Existing auth reused without credential copy. Model context disables apps, configured and pluginMCPs/web and runs read-only with no environments. Startup verifies no model connector tools; unexpected model tool activity is rejected.

External private configuration and state must remain outside this source directory. Example is expired. Start scripts/start.ps1 with external -State/-Config/-Python; scripts/restart.ps1 performs deliberate retained-journal restart after safe stop. Process-start is not task ACK. No Windows service, login task, notification schedule or cloud deployment is installed.

## Truth, status and recovery

State: QUEUED→CLAIMED→ACKED→PLAN→RUNNING→CHECKPOINT→OUTPUT_RECEIVED/schema checked→callback exact GET delivery→AGY_REVIEW_REPORTED→actual independent native verification→AGY_ACCEPTED. Text schema success does not prove semantic correctness. Receiver must review task acceptance criteria and evidence; artifact/release tests need their own checks.

Read-only localhost status endpoint and bin/agy_queue.py --state STATE status. CLI requires emitted_at within15s plus actual PID liveness; a cached daemon_alive=true cannot certify current execution. Old0.1.1 cached status is kept as history and assessed separately. PID access unknown remains UNVERIFIED. Short signed grants bind task/worker/instance and expire; ACK before PLAN; watcher/stale handling; in-flight restart→UNCERTAIN. Callback uncertainty is reconciled by exact immutable GET only, never blindPOST.

Callback delivery to GitHub inbox is durable handoff. Native chat message delivery and independent AGY acceptance remain separate. Official desktop native messaging is used by the active engineering/AGY Work when available. A detached app-server cannot claim it can wake the cloud control or Engineer chat merely because issue2 was updated. Continuous native-chat wakeup/acceptance-verifier attachment remains EXTERNAL_LIMIT unless explicitly proven. When Owner returns to chat, read the durable result without re-executing it.

## Stop / rollback

Run bin/agy_queue.py --state STATE stop; wait for daemon shutdown. Keep private journal/signing key/evidence; restore previous source/config deliberately. Never replay acceptedA1/A2/CRM tasks, steal desktopwriter, hard-delete state or copy auth into package. This package leaves old release and other working sources unchanged.

QA1.1, D045 current maximum useful training, Muse parity after eligibility and D047 interoperability apply. Provider cards are scoped candidates; no global promotion without mutual-training/calibration and existing approval. High-risk changes require independent peer and deterministic QA. No fixed global onebatch/20%trainingcap is introduced here. Finite runtime policy is task-scoped dispatch authority, not global training policy.
