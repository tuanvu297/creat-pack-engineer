# AGY Muse Alignment

Status: DESIGNED / IMPLEMENTING on branch `agy-muse-alignment-v0.1`.

Purpose: train Muse to understand AGY, ChatGPT and peer workers through observable contracts, examples, failures, evidence and evaluation. This project does **not** copy model weights or private chain-of-thought. It aligns task handling, tool use, handoff, QA and evidence so AGY can increasingly achieve **one prompt -> correct execution -> correct evidence -> minimal rework**.

## Success objective

Muse should become a first-class AGY worker, at parity tier with ChatGPT when both pass the Eligibility Gate. AGY chooses by observed competency, quota/reset/reserve, latency, cost, health, tool fit, retry risk and QA burden.

Primary metrics:
- one_prompt_success_rate
- instruction_fidelity
- task_class_accuracy
- route_selection_accuracy
- handoff_completeness
- peer_qa_accuracy
- unseen_transfer_accuracy
- false_pass_rate / false_fail_rate
- retry_count / rework_count
- latency / resource_efficiency

## Canonical sources

- AGY START HERE (Drive ID `10Ph_XvsgytAHsdECGDNkPY94l4EIuTat-4VWtbXrTsY`)
- AGY Decision Log (Drive ID `1TFSkLh7ZfAxHq-mYSN-HG2Dp1XJaG_JWcItASe_4tME`)
- AGY Three-AI Shared Workflow v1 (Drive ID `1S98IZWRhF5rDdthPO-y5ETb1shHRS9bz0f_J22yzcqc`)

Drive/runtime newer evidence wins over this repo when conflicts exist. This repo must be updated, not silently treated as newer canon.

## Read order

1. `START-HERE.md`
2. `contracts/AGY-CONTRACT.md`
3. `profiles/MUSE-ROLE.md`
4. `profiles/CHATGPT-OPERATING-PATTERNS.md`
5. `worker-graph/worker-graph.yaml`
6. `training/TEACH-PACK-001.md`
7. `evals/EVAL-PROTOCOL.md`
8. schemas under `schemas/`

## Safety / authority

No production mutation, publish, credential change, paid purchase or destructive action is authorized by this repository. Prompt delivery is not execution; health is not PASS; worker self-check is not sufficient QA. Preserve negative evidence.