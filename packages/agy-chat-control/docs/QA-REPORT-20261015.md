# Kết quả kỹ sư — 15/10/2026

**PARTIAL / PASS theo phạm vi đã kiểm chứng.** Có đường giao việc văn bản chạy
thật và bộ adapter có contract; chưa đạt tự động mọi thao tác ChatGPT hoặc
tự đánh thức chat kỹ sư liên tục khi không có host.

| Hạng mục | Truth | Kết quả / bằng chứng |
|---|---|---|
| Chat → queue → executor → callback → AGY | OBSERVED | P1 AGY_ACCEPTED; source snapshot `f1b97de69fcc3371bc327098e7ca4f7a488c2d626180a1938b6ed939fe118869` |
| ACK trước PLAN, grant 45 giây, heartbeat | OBSERVED | Peer-LIVE-P1: ACK→delivery 21.534s; heartbeat trước delivery 0.752s |
| Callback durable | OBSERVED | issue2 comment6187178328, exact GET khớp; riêng với review6187184522 và native readback |
| Restart/recovery | OBSERVED | PID16612 dừng, PID24260 fresh; journal còn đúng1modelturn+1callback, P1 vẫn accepted |
| Native AGY Work | OBSERVED | Worker nhận việc thật qua existing Work, ACK và output; không tạo Work mới |
| Manus / Muse | OBSERVED | Fresh task/thread, output thật; corrective3/3 phán định + kế hoạch lô đúng |
| Gemini | OBSERVED | Chrome3/Flash G1 trả JSON thật;3/3 phán định,11records→3lô/cuối1 |
| Handoff mẫu Manus/Muse | OBSERVED FAIL | Mẫu sửa của kỹ sư đặt expiry trước issued_at; không chạy child action, không đổ lỗi worker |
| Handoff mẫu Gemini | OBSERVED FAIL | Backoff chung thiếu reconcile cùng operation; schema trong prompt cũng viết tắt; không nhận làm quyền thực thi |
| Compiler mới | LOCAL CANDIDATE | Dynamic expiry ≤deadline; strict validate hiện tại, phải validate lại trước gửi; không gọi mạng/cấp credential |
| Chạy nền Steel cho Gemini | UNVERIFIED | Tài liệu có khả năng; route hiện chỉ example.com, chưa tạo phiên/chuyển auth |
| Native chat wake liên tục | EXTERNAL_LIMIT | Durable inbox không tự chứng minh native delivery hoặc AGY acceptance |
| Owner-only UX bản0.2.0 | UNVERIFIED | P1 do kỹ sư được Owner ủy quyền yêu cầu control chat compile; chưa phải lệnh mới do Owner tự gửi |

`evidence/TEST-RESULT.json` ghi 78 runtime tests +16 interop +6 compiler trong
staging mới. Manifest/hash và kiểm tra cài từ ZIP được ghi riêng trong receipt
bên ngoài gói; không suy PASS toàn hệ thống từ việc tạo ZIP. Xem thêm independent
peer reports, ROOT-ROUTE-DELTA và Gemini ROOT-EVALUATION; các card lịch sử giữ
nguyên checkpoint cũ, không dùng nó phủ nhận delta mới.

Kiến trúc: control chat là giao diện; daemon cục bộ qua Codex app-server làm
logical executor. SQLite WAL/FULL ngoài package lưu queue/intents/journal.
Các wrapper start/restart chạy process ẩn; read-only localhost status cần cả
PID sống và timestamp mới. Policy thử hiện tại24h/max10 nhiệm vụ văn bản,
không phải giới hạn học toàn AGY. Chưa cài service khởi động cùng Windows.

Không mở quyền shell/CRM/production/publish từ text task. Không sao chép auth,
runtime DB hoặc credential vào release. Candidate training là hướng dẫn ngữ cảnh,
chưa phải weight training, sáu chiều mutual-training hay global promotion.

Rollback: yêu cầu stop qua queue CLI, đợi process dừng; giữ private journal/key,
chọn lại source/config được duyệt. Không xóa lịch sử hoặc replay nhiệm vụ đã ACK,
pending hay accepted. Bản0.1.1 cũ vẫn được giữ; cached status cũ không chứng minh
process còn chạy. Chưa đổi source/canon đồng bộ, quyền hay lịch tự động.
