# Cập nhật runtime — hồ sơ kỹ sư 0.1.1 / S03

Đã đối chiếu fresh Work chính, chat control plane, các JSON local runtime và
gói evidence trên Drive. Không chạy lại provider task, không sửa runtime/config
hay lấy secret. Toolkit vẫn phiên bản 0.1.0; đây là cập nhật hồ sơ/kiến thức.

| Thành phần | S02 trước đây | S03 đã thấy |
| --- | --- | --- |
| Work, Gemini, Muse, Manus | Bốn transport có proof, fresh browser acceptance pending | Bốn lane VERIFIED_PASS, mỗi lane bảy thao tác |
| Browser runtime | browser_dispatch_verified=false trong snapshot | true cho bốn lane; 28/28 commands và bốn session released |
| Runtime regression | Chưa ghi full round mới | 72/72 Node tests PASS, type/syntax/TOML checks PASS |
| agy_browser backend | Namespace/configured launcher chưa đối chiếu ở đây | stdio PASS, server 0.2.0; bảy browser tools |
| agy_manus backend | Chỉ text recovery smoke mới được đọc | stdio + actual API PASS, server 0.1.0; auth/resource readback |
| Callback | Outbox pending trong artifact cũ | Redelivery receipt đúng target, DELIVERED_TO_AGY_CONTROL_PLANE |
| Chat → MCP namespace | Chưa xác minh | Vẫn chưa thấy agy_browser/agy_manus trong catalog chat này |
| Production tự chủ | UNVERIFIED | Vẫn UNVERIFIED; không suy từ bounded PASS |

Runtime chỉ nghiệm thu provider-origin command relay qua gateway chung tới
public demo pages, với lease/state/evidence/idempotency riêng. Không chứng minh
provider tự điều khiển browser liên tục hoặc unattended production dài hạn.
Registry còn giữ chuỗi acceptance_pending từ pha chuẩn bị; các field
seven_operations, browser_dispatch_verified và mode hiện ghi bounded acceptance.

Receipt giao callback chứng minh transport chấp nhận đúng target, không tự
chứng minh người đọc hoặc QA acceptance. Chat control plane mới mô tả bounded
PASS và gate namespace còn lại; giữ hai lớp bằng chứng riêng.

START HERE/Decision Log đọc lại vẫn có modified timestamp 12/10, cũ hơn runtime
evidence 13/10. Giữ policy/canon của chúng, dùng delta runtime mới cho factual
state. Không sửa các tài liệu canon hay hồ sơ dự án khác trong lượt này.

Bài học bổ sung: backend/MCP stdio/app tool exposure/production là bốn gate
khác nhau. Callback phải có delivery receipt trước kết luận hoàn tất; delivery
và QA acceptance phải ghi riêng. Đây là distillation từ nguồn đã quan sát,
không phải global skill promotion hoặc daily calibration PASS.

Nguồn: [Work chính](codex://threads/01a130a2-0a5b-7833-a489-d19c00dcc7db),
[gói runtime evidence](https://drive.google.com/file/d/1h9_nXt0alTgmfKrYWAE2SusPVID313Er/view).
ZIP 12.221.026 bytes, SHA256
`a00512900d9ea88d9710f79bd7fb9b95d3632f68b5b24ef5f51f390392acb859`;
download từ Drive khớp bản local. File hashes/scope ở
evidence/RUNTIME-UPDATE-20261013-S03.json. Test runtime là source evidence được
đọc và đối chiếu tính nhất quán, chưa độc lập chạy lại trong repo kỹ sư.

Đối với kỹ sư: có thể biên soạn task/QA packet cho các lane đã được bounded
test qua AGY. Trước task thật phải kiểm route đang gọi được, fresh authorization,
quota/cost và acceptance; không dùng balance lịch sử hoặc replay round A1.
Namespace exposure sẽ được đóng khi app/catalog thực tế có tool và read-only
response. Skill chuyên nghiệp vẫn là ứng viên cho tới calibration/promotion.
