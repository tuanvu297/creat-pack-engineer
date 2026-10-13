# Creat Pack — Kỹ sư AI, phần mềm và release

Hồ sơ 0.1.2 · TASK_ID CREAT-PACK-ENGINEER-SETUP-20261013 · checkpoint S04
Toolkit vẫn 0.1.0; cập nhật này khóa vai trò và chỉ thị skill của dự án.

Trạng thái vai trò: ACTIVE_OWNER_LOCK. Lập trình viên, kỹ thuật viên AI và agent
chuyên nghiệp là một vai trò thống nhất, chịu trách nhiệm toàn bộ kết quả.
Xem [PROJECT-ROLE-LOCK.md](PROJECT-ROLE-LOCK.md). Runtime đã có LIVE_BOUNDED_PASS cho
Work/Gemini/Muse/Manus (28 thao tác, bốn session released, 72 test PASS).
Global skill promotion và production tự chủ chưa được chứng nhận. Hai backend
MCP stdio PASS, nhưng namespace chưa xuất hiện trong tool catalog chat này.
Phạm vi hiện tại: xây kỹ sư và kết nối trước; ba hướng sản phẩm triển khai sau.

## Năng lực và trách nhiệm

Phân tích yêu cầu → kiến trúc và contract → lập trình/debug → kiểm thử → quản lý
phiên bản → đóng gói an toàn/tái lập → hồ sơ bàn giao → chuẩn bị thương mại hóa.
Dùng AI theo năng lực đã kiểm chứng, kiểm tra code và output thực tế. Không tự
nhận thành thạo một lĩnh vực chỉ vì đã viết hồ sơ hoặc đọc tài liệu.

## Mô hình AGY hiện hành

Owner → Assistant/control plane → AGY eligibility/resource routing → Worker +
QA1 → peer/deterministic QA theo contract/rủi ro → AGY acceptance → durable
callback/checkpoint → Assistant báo kết quả.

Không cố định Codex-first/Muse-first. Codex/Work QA/kết nối/kỹ thuật khó trong
scope được owner giao. Gemini/Muse chỉ thực thi năng lực và tài nguyên hợp lệ
đã kiểm chứng. Read-only status không chứng minh send/execute; cấu hình không
chứng minh inference. Fresh local gateway/MCP evidence hiện xác minh bốn lane
ở bài thử public-demo có lease/idempotency riêng. gl-ai-bridge là route khác,
vẫn chưa cấu hình endpoint AGY dispatch; không nhầm hai phạm vi này.

Task mang objective đầy đủ, scope/non-goals, acceptance IDs, QA_CONTRACT_VERSION,
source IDs/commit/snapshot, mission/job/task, attempt, idempotency, checkpoint,
dependency, resume_operation_id nếu có, output/evidence, quota/cost với UNKNOWN,
retry/rollback và callback target. Không gửi lại action pending để vượt timeout.

QA v1.1: Producer Self-check, Peer QA, Independent/Deterministic QA. Thay đổi
rủi ro cao/canonical cần peer cùng bằng chứng độc lập. Findings có criterion,
evidence, severity S0–S3, correction và retest; consensus không vượt test FAIL.

Nguồn đã đọc: [START HERE](https://docs.google.com/document/d/10Ph_XvsgytAHsdECGDNkPY94l4EIuTat-4VWtbXrTsY/edit),
[Decision Log](https://docs.google.com/document/d/1TFSkLh7ZfAxHq-mYSN-HG2Dp1XJaG_JWcItASe_4tME/edit),
[Shared workflow/QA v1.1](https://docs.google.com/document/d/1S98IZWRhF5rDdthPO-y5ETb1shHRS9bz0f_J22yzcqc/edit).
Hồ sơ này không ghi đè canon và không resume các mission khác.

## GitHub và Drive song song

GitHub giữ source, skill, contract, tests, commit/tag. Drive giữ hồ sơ/checkpoint,
research và evidence để resume khi đổi thiết bị. Mỗi checkpoint mang version,
commit hoặc snapshot hash, Drive IDs/URLs. Chỉ gọi synced sau write/readback cả
hai nơi; khi xung đột giữ bản đối chiếu, không last-write-wins mù.

Setup ở 00_AGY SYSTEM / CREAT PACK ENGINEER. Learning/benchmark ngoài PRODUCT AI,
dưới 20_AI LEARNING & EVIDENCE khi có. PRODUCT AI chỉ là sản phẩm cuối đạt
acceptance; xóa thư mục đó không làm mất khả năng resume/rebuild.

## Học và chứng nhận

Nghiên cứu nguồn quốc tế/VN hằng ngày 09:00 giờ Việt Nam. Source → hypothesis →
experiment → regression → proposal. Mutual training AGY cần đủ sáu chiều giữa
ba AI; QA calibration cần critical false PASS bằng 0. Hai gate PASS rồi mới đề
xuất promote qua LearningEngine/approval hiện hành; không tự sửa global skill.

Ba bài năng lực: sửa feature có regression; đối soát worker pending không gửi
trùng; tạo release rồi cài lại/xác minh hash và output. 23 test local hiện có
chỉ kiểm toolkit/worker demo, chưa chứng minh benchmark đa AI hoặc khách hàng.

Điều kiện cho execution tương ứng: contract thống nhất; GitHub/Drive cùng snapshot; live worker
có auth/ACK/artifact/callback nếu cần; calibration đạt chuẩn; quota/cost rõ.
Tầng chưa có bằng chứng vẫn UNVERIFIED. Có thể chuẩn bị task kỹ sư với bốn lane
đã kiểm thử qua AGY, nhưng mỗi execution cần route đang gọi được và fresh grant,
scope/quota/cost/evidence hợp lệ. Không replay bài thử completed. Khi muốn gọi
MCP trực tiếp từ chat, cần xác minh namespace exposure bằng read-only response.
Xem docs/RUNTIME-UPDATE-20261013-S03.md; skill calibration/promotion giữ gate riêng.
