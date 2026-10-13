# Kho kiến thức kỹ sư — snapshot 2026-10-13

Không cần chờ runtime xong mới ghi. Ghi ngay bài học/thiết kế/lỗi/bằng chứng;
thêm checkpoint khi runtime đạt milestone. Chỉ chứng nhận production/runtime
hoặc promote skill khi acceptance tương ứng PASS.

## Phạm vi

41 chat không archived được liệt kê: chat hiện tại, 39 chat đã đọc recent turns,
một chat không trả nội dung. Thường đọc hai turn gần nhất; Work chính đọc bốn,
control-plane chat đọc ba. Đây không phải full account export. Older turns,
attachments và archived chats chưa đọc hết. Coverage: evidence/WORK-SOURCE-INDEX.json.
Không sao chép raw transcript, dữ liệu khách hàng/cá nhân, secret hay runtime DB.

## Bài học

| ID | Bài học áp dụng | Nguồn | Mức kiểm chứng |
| --- | --- | --- | --- |
| LE-001 | Tách worker reasoning, adapter, gateway và browser infrastructure. Relay có giới hạn không chứng minh tự chủ liên tục. | AGY Core — Work chính; Thảo luận worker extension | OBSERVED báo cáo/artifact; không live-test lại tại đây |
| LE-002 | waiting chưa chắc là failure/owner-input. Đọc actual messages/detail/background state; tiếp tục cùng provider ID, không create lại. | Manus recovery callback A2 | OBSERVED artifact một create/một continuation/stopped/background=false |
| LE-003 | Explicit selector cardinality trước khi chấm worker. Mẫu nhỏ/spec thiếu không chứng minh model ranking tổng quát. | Benchmark A1 và control-plane acceptance | OBSERVED report; KEEP_LOCAL_CANDIDATE |
| LE-004 | Health, ACK, metadata, sample review và full artifact acceptance là các tầng riêng. Giữ negative evidence. | AGY Route Repair Callback; Muse ZIP | OBSERVED scope nguồn; không certify media ở đây |
| LE-005 | Dedupe theo identity nghiệp vụ đã chốt, không theo tên/tiền giống nhau. Dùng fixture giả. | Phân tích lỗi GL Automation; Audit GL Spa Telegram Thu flow | OBSERVED owner correction; không global hóa domain fact |
| LE-006 | Handover/package PASS không chứng minh receiving agent hiểu hoặc runtime integrated. | AGY → Claude — Báo cáo chuyển giao | OBSERVED report; receiving behavior UNVERIFIED |
| LE-007 | Fallback không đóng route gốc. Retry chỉ khi state/session/permission/adapter thay đổi thực chất. | AGY Skill Sync; D-040/D-044 | OBSERVED policy; eligibility cần fresh check |
| LE-008 | Research là proposal cho experiment; consensus không thay ground truth/calibration. Nạp context liên quan. | Agency Intelligence Scan; shared QA v1.1 | Candidate; daily calibration UNVERIFIED |
| LE-009 | Commit/hash/Drive ID và readback hai kho mới chứng minh snapshot đồng bộ. | Source-of-truth work; setup hiện tại | Quy trình; continuous sync UNVERIFIED |

## Runtime ảnh hưởng bản ghi

Giữ riêng truth (OBSERVED/INFERRED/UNVERIFIED), implementation
(DESIGNED/IMPLEMENTING/TESTED/PASS/INTEGRATED) và acceptance scope.
Cùng AI có auth PASS ở một route và send chưa có ở route khác.

Benchmark A1 ghi Gemini/Muse bounded relay, Manus lúc đó EXTERNAL_LIMIT.
Manus A2 recovery mới hơn ghi text ACK đúng trên cùng task và terminal readback;
delivery vẫn DURABLE_OUTBOX_AWAITING_AGY_INGESTION. Fresh all-AI ops registry ghi
bốn transport_proof PASS nhưng browser_dispatch_verified=false, acceptance pending.
Giữ cả bằng chứng cũ và delta mới. Work chính đang hoạt động, nguồn có thể tiến
tiếp sau snapshot này. Không ghi global INTEGRATED/PRODUCTION PASS.

Local source paths/hashes: evidence/RUNTIME-SOURCE-SNAPSHOT.json. Không sửa hoặc
chạy lại code, test, task hay runtime state của Work chính trong lượt đọc này.
Report được đọc không phải phép thử độc lập mới.

## Cập nhật

Candidate v0.1 được ghi ngay; khi có evidence mới thêm checkpoint/delta và
supersedes relation, giữ scope cũ. Không overwrite FAIL/UNKNOWN lịch sử thành
PASS. Khi đóng milestone, tạo snapshot/hash và readback GitHub/Drive. Trước
production, refresh state và chạy acceptance; global skill promotion vẫn qua
mutual-training/calibration + LearningEngine approval hiện hành.
