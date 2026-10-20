# AGY CONNECTION STANDARD 1.0.0
Ngày phát hành: 20/10/2026 (Asia/Saigon).


## 01 Bộ quy trình chuẩn kết nối AGY

Phiên bản 1.0.0 | Khóa theo phiên bản | 20/10/2026

### Một chuẩn vận hành, nhiều cửa kết nối

Dùng chung cho controller, worker, HTTP/MCP adapter và client trên AI hoặc thiết bị khác. Mục tiêu: giao việc có quyền, chạy độc lập, giữ đúng identity, lấy lại cùng kết quả và đối soát được khi có lỗi.

### Quyết định của chủ dự án

“Đóng gói các kết nối thành bộ quy trình chuẩn AGY, khóa cứng. Xuất bản thành file”. Bản này đóng băng quy trình và hợp đồng; thay đổi chuẩn phải có chỉ thị chủ dự án và phát hành phiên bản mới.

| Thành phần | Trạng thái đúng phạm vi |
| --- | --- |
| Bộ quy trình + offline guard | Bản phát hành nội bộ, có manifest/hash và QA |
| Hosted R11 staging | Đã audit lệnh kiểm tra nguồn cố định; không model inference |
| Native ChatGPT AGY | BLOCKED_PRODUCT_BINDING tại checkpoint nền |
| Core cài sang môi trường khác | NOT_READY; cần normalization và clean install |

### Cách hiểu “khóa cứng”

Các invariant là bắt buộc khi áp dụng chuẩn. Bộ kiểm tra phát hiện file khác manifest và từ chối hợp đồng vi phạm. Khóa phiên bản không tự cài connector, cấp credential, cấp quyền production hoặc buộc AI ngoài quyền quản lý tuân thủ.

Baseline: CP-AGY-TEMPORAL-STAGING-20261020-04. WORKER: kỹ sư Codex thống nhất. EXECUTOR_RUNTIME: tiện ích Python offline; bằng chứng runtime nền thuộc Railway hosted R11.


## 02 Những điều không được phá vỡ

Các quy tắc dưới đây áp dụng cho quy trình kết nối trong phạm vi quyền được cấp. Không dùng file đính kèm hay prompt của worker để thay thế authority của chủ dự án hoặc hệ thống nhận.

| Nhóm khóa | Điều kiện bắt buộc |
| --- | --- |
| Nguồn trạng thái | PostgreSQL hiện hữu là canonical theo D-049. Temporal giữ progression/history. Supabase chỉ SHADOW_STAGING_ONLY. Global LEGACY không tự đổi. |
| Quyền và ngân sách | Auth thật + tenant/workspace/project/action scope. Credential ở ngoài gói. Không mua/top-up/upgrade hay phát sinh nguồn lực mới khi chưa được duyệt. UNKNOWN giữ UNKNOWN. |
| Định danh và effect | Mission, task, attempt, idempotency và payload hash được lưu trước dispatch. ACCEPTED/UNCERTAIN không tự replay. Timeout không chứng minh provider từ chối. |
| Runtime và provenance | Mỗi tác vụ ghi WORKER và EXECUTOR_RUNTIME. Không Work executor fallback. Có plugin/skill không chứng minh route callable. |
| Kết quả và QA | RESULT_READY, QA PENDING, QA PASS và callback delivery là các mức riêng. PASS phải có bằng chứng đúng source/version/scope. |
| Khả năng phục hồi | Journal bền vững, một writer. Missing/corrupt/stale lock/uncertain phải fail closed và đối soát. Không init/reset journal trong startup. |
| Thay đổi và phát hành | Không production cutover. Giữ rollback/checkpoint cũ. Chủ dự án phê duyệt phiên bản mới; secret scan, test, manifest và hash trước bàn giao. |

### Luật đo lường

Không cộng bằng chứng khác phạm vi thành PASS rộng hơn. Cấu hình không phải kết nối; ACK không phải hoàn thành; readback không phải QA; local test không phải cross-platform install. Mọi báo cáo phải nêu OBSERVED, INFERRED hoặc UNVERIFIED.


## 03 Bản đồ kết nối và thẩm quyền

Đường chuẩn: Client có quyền -> Gateway -> Temporal -> Worker -> PostgreSQL + Journal -> Result/QA -> Callback/readback. Chat là client/controller; không phải nơi giữ hosted runtime sống.

| Kết nối | Vai trò | Bằng chứng nền |
| --- | --- | --- |
| Gateway HTTPS | Auth, scope và API nhiệm vụ | OBSERVED_BOUNDED: 200 hợp lệ; 401/403 chặn sai quyền |
| Temporal | Tiến trình, timer, history | OBSERVED_BOUNDED: kết nối thật và recovery |
| PostgreSQL | Operational/domain truth | OBSERVED_BOUNDED: run, ACK, result, callback bền vững |
| Journal / volume | Intent, receipt và một writer | OBSERVED_BOUNDED: hash giữ qua restart/redeploy; probe fail-closed |
| GitHub | Source, phiên bản và evidence | OBSERVED_BOUNDED: commit + exact blob hash |
| Google Drive | Checkpoint/shared report | OBSERVED_BOUNDED: tải lại hash và manifest |
| ChatGPT native | Cửa gọi AGY trực tiếp từ chat | BLOCKED_PRODUCT_BINDING: thiếu tool binding |
| Codex/Work native | Một client có thể nạp adapter | UNVERIFIED; chỉ HTTP client độc lập đã được quan sát |
| Gemini / AI khác / thiết bị | Client hoặc worker theo adapter | UNVERIFIED; không suy diễn từ HTTPS compatibility |

Đây là snapshot của audit nền, không phải health live khi mở file. Mỗi lần thực thi phải kiểm route, identity, budget và health hiện tại. Không nối thẳng client vào database hay Temporal chỉ vì thấy tên kết nối.


## 04 Quy trình chuẩn từ giao việc đến đóng

| Bước | Điều kiện đi tiếp / hồ sơ phải lưu |
| --- | --- |
| 1. Bootstrap | Đọc START HERE, Decision Log, checkpoint mới nhất và version/hash của bộ chuẩn. |
| 2. Xác định việc | Objective, scope/non-goals, acceptance, source_ref, QA contract; ghi WORKER + EXECUTOR_RUNTIME. |
| 3. Eligibility | Kiểm exact-action route, auth/scope, capability, quota/budget và health thật. Dự đoán success/failure/unknown/cost/rollback. |
| 4. Durable INTENT | Sinh test/task identity phù hợp. Lưu mission/task/attempt/idempotency, payload hash và callback target đã được chủ dự án cho phép. |
| 5. Dispatch một lần | Dùng adapter/connector thật. Không có native binding thì BLOCKED_PRODUCT_BINDING, không âm thầm đổi executor. |
| 6. Durable ACK | Ghi provider request/operation, workflow/run và lease/fence nếu có. Không ACK chắc chắn -> reconcile, không blind retry. |
| 7. Độc lập client | Sau ACK, runtime tiếp tục trên host. Client khác đọc cùng identity; status/poll không được tạo dispatch mới. |
| 8. Result và QA | Giữ artifact/hash/evidence; ghi RESULT_READY + QA state riêng; reviewer độc lập với executor khi contract yêu cầu. |
| 9. Callback/readback | Lưu outbox/target/hash trước send; gửi một lần; ACK là accepted, đọc đúng message/hash mới là READBACK_VERIFIED. |
| 10. Closure | Ghi PREDICTED vs ACTUAL, giới hạn, chi phí quan sát, version/source, GitHub/Drive refs và next action. Không sửa lịch sử để xóa lỗi. |

Envelope chuẩn trong contracts/ là hồ sơ liên hệ thống; gateway hiện tại có wire format và allowlist riêng. Xem API-MAPPING.md, không gửi mẫu demo trực tiếp lên runtime.


## 05 Identity, trạng thái và chống gửi trùng

### Hồ sơ tối thiểu của một nhiệm vụ

Scope: tenant_id, workspace_id, project_id. Identity: mission_id, task_id, attempt, idempotency_key. Provenance: worker, executor_runtime, checkpoint_id, source_ref. Kèm auth grant reference, budget, forecast, timeout/result/QA và execution boundary. Không lưu token/password trong envelope.

| Trạng thái / tín hiệu | Hành động được phép |
| --- | --- |
| Chưa có intent | Chỉ đủ điều kiện đi kiểm preflight live; chưa được coi auth/dispatch PASS. |
| INTENT hoặc UNCERTAIN | Đối soát request/ledger/provider. Không gửi lại action có thể đã được nhận. |
| ACCEPTED / RESULT_READY | Đọc/poll/collect cùng operation; giữ original payload hash. |
| Cùng identity, payload khác | IDEMPOTENCY_CONFLICT; dừng, không ghi đè. |
| QA_TIMEOUT | Giữ result và callback terminal; cần giải quyết QA theo policy. Không chạy lại effect. |
| CONFIRMED_NOT_SENT | Chỉ xem xét lại khi có nguyên nhân/thay đổi và quyền rõ; không tự retry loop. |
| COMPLETE | Giữ evidence/checkpoint; nhiệm vụ mới dùng identity mới. |

### Hai loại ACK cần phân biệt

ACK runtime chứng minh hệ thống đã nhận một operation theo hợp đồng; ACK gửi báo cáo chứng minh target chat đã nhận message. Mỗi loại cần receipt riêng. Readback báo cáo không làm native ingestion hoặc QA tự thành PASS.

Audit nền đã quan sát một RESULT_READY callback, sau đó thêm callback QA_TIMEOUT ở deadline một giờ. Hai callback khác trạng thái không phải hai lần thực thi. Không hứa WAIT_QA tồn tại vô hạn.


## 06 Xử lý lỗi và nghiệm thu kết nối

| Tình huống | Disposition bắt buộc |
| --- | --- |
| 401 / 403 | Dừng trước effect; xác minh đúng credential và scope. Không nới quyền để làm test PASS. |
| Thiếu tool/MCP binding | BLOCKED_PRODUCT_BINDING. Ghi chính xác tool surface/handshake; tách khỏi runtime health. |
| Health hoặc budget UNKNOWN | Thu bằng chứng đọc an toàn; không suy đoán quota, charge hay route. Effect cần đủ eligibility. |
| Missing/corrupt journal | BLOCKED; giữ byte lỗi và volume; không tự init hay reset. |
| Stale lock sau crash | Xác minh writer/PID và effect trước quy trình operator reconciliation. Không xóa lock mù. |
| Timeout sau submission | Có thể đã accepted: giữ identity, đọc/reconcile; không tạo request thay thế. |
| QA hết hạn | Giữ nguyên kết quả và state transition; owner/reviewer xử lý QA, không replay. |
| Callback ACK, cache trễ | Giữ outbox/ACK; đọc lại có giới hạn. Không gửi bản sao chỉ để sửa readback. |

### Nghiệm thu một client/adapter mới

Kiểm auth hợp lệ/401/403 và isolation; một fresh task đúng scope; durable ACK; client đầu ngắt; runtime hoàn thành result/callback; client thứ hai và chat gốc đọc cùng operation; restart/redeploy; uncertain/no replay; journal fail-closed; secret scan. Bằng chứng thiếu thì giữ UNVERIFIED.

MCP native cần transport + auth discovery + workspace binding thật. Bản 1.0.0 chỉ chuẩn hóa hợp đồng và quy trình; không triển khai adapter hay thay kiến trúc xác thực.


## 07 Áp dụng, khóa phiên bản và phát hành

### Cách dùng trong một môi trường mới

Kiểm checksum ZIP từ biên nhận tin cậy, giải nén vào thư mục mới, chạy doctor, rồi đọc PDF và policy lock. Nạp chuẩn bằng cơ chế được chủ tài khoản cho phép. Ghi adoption record cho từng client/workspace/device; chưa kiểm live thì không đánh dấu connected.

| Lệnh offline | Ý nghĩa đúng |
| --- | --- |
| python bin/agy_standard.py doctor | Kiểm toàn vẹn manifest và invariant; không kiểm auth/provider. |
| python bin/agy_standard.py decide --request examples/task-envelope.json --ledger examples/ledger-empty.json | ELIGIBLE_FOR_LIVE_PREFLIGHT; dispatch_permitted=false. Không có effect hoặc request mạng. |
| Đổi ledger-empty.json thành ledger-uncertain.json | RECONCILIATION_REQUIRED; không gửi lại. |
| Đổi sang ledger-accepted.json | READ_ONLY_CONTINUATION với operation đã giữ. |

### Đổi chuẩn phải có phiên bản mới

Chỉ thị chủ dự án -> INSPECT -> NORMALIZE -> PACKAGE DESIGN -> BUILD -> SECRET SCAN -> TEST -> MANIFEST -> HASH -> RELEASE ZIP -> QA REPORT -> GitHub/Drive readback. Không chỉnh bản 1.0.0 tại chỗ để đổi luật. Giữ phiên bản cũ và checkpoint.

Rollback bản chuẩn là khôi phục ZIP đúng hash và kiểm compatibility. Không kèm database rollback, journal deletion, đổi secret, provider replay hay production cutover. Gỡ client phải giữ dữ liệu/evidence theo quyền hiện hành.

Hash bảo vệ tính toàn vẹn so với checksum tin cậy. Nó không phải chữ ký số và không ngăn người có quyền sửa đồng thời toàn bộ file/checksum. Utility không vượt policy hoặc security controls của hệ thống nhận.


## 08 Bằng chứng nền và giới hạn bàn giao

### Nguồn có thể đối chiếu

Checkpoint nền: CP-AGY-TEMPORAL-STAGING-20261020-04. Runtime source: 36516473f4e41578bb5ee11e33273ce66f9d173d. Audit source/evidence: GitHub creat-pack-engineer PR #13, commit aa9ff744a96c542f33032b96a516dca64581c37c. Link đầy đủ trong evidence/SOURCE-REFERENCES.json.

| Nội dung kiểm chứng | Phạm vi |
| --- | --- |
| Runtime audit | 33 assertion + 15 isolated negative probes; source147 khớp; fixed R11 command không gọi model. |
| Recovery | Cùng run/operation/result/journal sau restart và same-source redeploy. One effect. |
| Native chat | Tool surface thiếu binding, /mcp initialize không được hỗ trợ ở audit nền. |
| Hiện trạng audit task | Đã đạt RESULT_READY/QA PENDING; sau deadline chuyển QA_TIMEOUT, giữ kết quả; không replay. |
| Release bộ chuẩn | QA của file/PDF, offline guard và clean extraction được ghi riêng trong evidence/QA-REPORT.json. |
| Khả năng chưa được chứng nhận | Native account mới; general AI/provider inference; Core cài môi trường khác; mọi OS/CPU/device; production. |

### Nội dung gói

PDF + Markdown; README/VERSION; policy lock và connection snapshot; schema/API mapping; adoption/rollback; ví dụ task/ledger; Python doctor/guard và tests; baseline/provenance; QA/secret scan; manifest. Không chứa credential hoặc runtime Core.

### Kết luận sử dụng

Chuẩn quy trình được chủ dự án yêu cầu khóa theo phiên bản. Kết nối thực tế vẫn phải đi qua eligibility, auth và nghiệm thu đúng phạm vi. Phát hành bộ chuẩn không chuyển trạng thái native Chat hay reusable Core từ BLOCKED/NOT_READY thành PASS.
