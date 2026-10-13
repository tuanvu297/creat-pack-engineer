# Kết nối kỹ sư — hồ sơ 0.1.1 / S03 / 2026-10-13

**Scope:** bảng dưới là probe của bridge/chat này, không phải mọi route AGY.
Sau đó đã tạo repo PRIVATE `tuanvu297/creat-pack-engineer`; connector xác minh
quyền pull/push/admin. Bindings đích nằm trong config/storage.json.

**Hiện hành S03:** Work chính đã kết thúc bài thử và callback. Work, Gemini,
Muse, Manus đều VERIFIED_PASS: 28/28 thao tác, bốn session released, 72/72 test
runtime PASS. Hai MCP backend đã PASS qua launcher/stdio; Manus có actual API
auth/resource readback. Registry mới ghi browser_dispatch_verified=true cho
bốn lane. Phạm vi là LIVE_BOUNDED_PASS, chưa production tự chủ hoặc luôn chạy.

**Chat này:** không thấy namespace agy_browser/agy_manus trong danh mục tool
hiện hành. Direct chat → MCP exposure vẫn UNVERIFIED; chưa gọi được health
qua chính namespace ở đây. Có kết quả backend không tự chứng minh app đã nạp tool.

**GitHub/Drive:** snapshot S02 đã ghi/đọc lại và đối chiếu hash; ghi delta S03
riêng. Continuous sync vẫn UNVERIFIED. Số test toolkit local vẫn 23, tách biệt
với 72 test của runtime. Xem docs/RUNTIME-UPDATE-20261013-S03.md và
evidence/RUNTIME-UPDATE-20261013-S03.json.

**Bảng dưới là probe lịch sử S02 của bridge/chat**, giữ để đối chiếu. Bridge
supplied-text vẫn là route khác; không dùng trạng thái này phủ định gateway mới.

| Kết nối | Bằng chứng | Giới hạn |
| --- | --- | --- |
| Local code/test | Python 3.12.14, 23 test PASS | Chỉ các test local đã chạy |
| GitHub | tuanvu297 auth PASS; App All repositories | Ban đầu UI/API 0 repo; repo mới cần write/readback riêng |
| Drive | Đọc canonical AGY; tạo thư mục setup | File sync cần write/readback |
| Web/docs | Đã đọc nguồn chính thức và engineering VN | Không chứng minh mọi bài/claim đều mới |
| Daily research | Automation ACTIVE, 09:00 Asia/Saigon | Lượt chạy thực tế UNVERIFIED |
| Muse | Fresh identity/status PASS trong session GL | Read-only; chưa có send tool ở bridge |
| Gemini | Key/model cấu hình, bridge báo gemini-3.5-flash-lite | Inference/billing UNKNOWN; chưa gọi API |
| AGY dispatch | NO_SUPPORTED_ENDPOINT_CONFIGURED | Runtime integration UNVERIFIED |

Model Gemini ở bridge khác ghi chú GL; phải đối soát route trước dispatch,
không tự đổi model. Bridge không phát hiện Codex CLI không có nghĩa chat Codex
hiện tại không thể viết code; đó là hai execution surfaces khác nhau.

Giai đoạn kỹ sư cần local/code/test, GitHub, Drive, docs và versioned contract.
Live provider/dispatch/callback đến sau bằng eligibility + quota/billing + phép
thử thật. Cloud hosting/payment/CRM/social chưa cần trong scope hiện tại.
OAuth/session/secret giữ ngoài chat/repo/Drive/release. Không tự đổi quyền.
Làm mới inventory khi session/permission/route thay đổi trước action live.
