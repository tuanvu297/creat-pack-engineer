# Creat Pack — AI Release Engineer 0.1.0

Ưu tiên hiện tại: hồ sơ kỹ sư và kho kiến thức theo AGY. Bắt đầu với
docs/ENGINEER-PROFILE.md, docs/LEARNED-KNOWLEDGE.md và docs/CONNECTIONS.md.
Các công cụ dưới đây là nền tảng hỗ trợ, chưa là ba sản phẩm thương mại.

Hồ sơ đã cập nhật 0.1.1/S03 sau runtime LIVE_BOUNDED_PASS; toolkit vẫn 0.1.0.
Xem docs/RUNTIME-UPDATE-20261013-S03.md để phân biệt backend PASS, namespace
exposure chưa xác minh và production chưa nghiệm thu.

Nền tảng phát triển repo, tool và phần mềm cho AI, có ba phần sử dụng được:

1. **Release Toolkit:** inspect/scan/build/verify ZIP, manifest và SHA-256.
2. **AI Adapter Starter:** worker mẫu chạy cục bộ, journal và chống chạy trùng.
3. **Release Assistant:** ứng dụng CLI `doctor` đọc ZIP và báo khoảng trống QA.

Skill `ai-release-engineer` hướng dẫn phát triển, đóng gói, nghiên cứu và chuẩn bị
bàn giao thương mại. Bản này là nền tảng 0.1.0; provider AI trực tiếp, giao diện
web, giấy phép khách hàng và giá bán chưa được triển khai/chốt.

## Chạy ngay

Python 3.10+; không cần thư viện bên ngoài, API key hay cookie. Đường dẫn dưới đây
là ví dụ khi terminal đang ở thư mục repo. Thay `python` bằng `python3` trên máy
chỉ có lệnh đó. Không yêu cầu cài vào hệ thống.

```text
python bin/release.py --help
python bin/release.py inspect <input.zip>
python bin/release.py doctor <input.zip>
python bin/release.py scan .
python -m unittest discover -s tests -v
python bin/release.py build . --out ../creat-pack-release-0.1.0
python bin/release.py verify ../creat-pack-release-0.1.0/ai-release-engineer-0.1.0.zip
python templates/ai-adapter/worker.py examples/task.json --state ../creat-pack-demo-state
```

Gọi worker lần nữa với cùng task trả receipt đã lưu. Đổi payload hoặc key trên
cùng mission/task bị từ chối. `UNCERTAIN` yêu cầu đối soát, không gửi lại mù.
Lệnh PowerShell `bin/release.ps1` và shell `bin/release.sh` chuyển tiếp tham số.
Nếu PowerShell policy không cho chạy wrapper, gọi entrypoint Python trực tiếp.

## Contract và output

CLI nhận đường dẫn source/ZIP và trả JSON. Exit 0 là thao tác đã hoàn tất; exit 1
là từ chối/thất bại, không phải PASS cho toàn sản phẩm. `doctor` là báo cáo nên
có thể exit 0 kèm REVIEW_REQUIRED. Worker dùng exit 3 cho outcome chưa xác nhận.

Build snapshot source, quét secret, tạo ZIP trong thư mục output riêng, kiểm tra
inventory/hash rồi tạo SHA256SUMS.txt và RELEASE-RECEIPT.json. Không tự chạy code
hoặc test của một repo đầu vào. Output phải nằm ngoài source; không ghi đè release
có sẵn. `MANIFEST.json` trong ZIP không tự hash chính nó, được hash ZIP bao phủ.
Thời gian nội bộ lấy SOURCE_DATE_EPOCH (mặc định Unix epoch) để tái lập byte;
receipt ngoài ZIP ghi thời điểm bàn giao thật.

Inspector không giải nén hay chạy input. Chặn traversal, path tuyệt đối, dấu
phân cách Windows, tên reserved, symlink, case collision, ZIP lồng và quá giới
hạn: 20 MiB/tệp, 100 MiB/package, 2.000 entries. Builder bỏ .git, cache, virtualenv,
node_modules, dist và .state. Đây là allowlist nghiệp vụ tối thiểu; hãy dùng
staging chọn lọc cho repo khách hàng thay vì giả định mọi tệp còn lại được bán.

## Kiểm chứng và bảo mật

Xem evidence/TEST-RESULT.json, evidence/TESTS.txt và docs/MUSE-REVIEW.md. Manifest
của builder luôn để các tầng execution của input ở UNVERIFIED; khai báo input
chỉ nằm trong declared_test_status. Receipt QA ngoài release có hash ZIP gắn
với các test của chính release này.

Secret scan phát hiện tên credential phổ biến, private key, token signature và
assignment. Chỉ ghi filename/line/rule, không ghi giá trị. Kết quả là
PASS_SIGNATURE_SCAN, không bảo đảm tìm mọi secret; chưa giải mã các stream PDF.
Không đóng gói auth sống. State worker phải ở thư mục riêng, có quyền truy cập
phù hợp; local lock không thay thế database cho nhiều host.

## Skill và học liên tục

Skill ứng viên ở skills/ai-release-engineer, đã structural validation. Chưa
promote thành global AGY skill vì mutual-training/calibration chưa xác minh.
Khi được chấp nhận cài, chép cả thư mục vào ~/.codex/skills, kiểm tra xung đột
và chạy quick_validate của skill-creator nếu có.

Theo dõi nguồn hằng ngày 09:00 Asia/Saigon qua automation của chat. Danh sách
nguồn ở config/research-sources.json. Không cần scheduler để dùng repo; đọc
research/ và references/research.md để chuyển nghiên cứu thành thí nghiệm,
bằng chứng và bản cập nhật skill. Automation có thể cần ứng dụng/host sẵn sàng;
việc tạo lịch không chứng minh một lượt theo dõi đã chạy thành công.

## Thương mại hóa

Xem docs/PRODUCTS.md và RIGHTS.md. Ba hướng có chung nền tảng nhưng mỗi sản phẩm
cần acceptance riêng. Không phát hành public hoặc cam kết tính năng live trước
khi có bằng chứng. Đây là repo local; chưa được đẩy GitHub hay bán.
