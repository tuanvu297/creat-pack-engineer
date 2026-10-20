# Bộ quy trình chuẩn kết nối AGY 1.0.0

Trạng thái: OWNER_LOCKED_VERSIONED_STANDARD. Phát hành nội bộ theo chỉ thị chủ dự án ngày 20/10/2026.

Đọc AGY-CONNECTION-STANDARD-1.0.0.pdf để vận hành. Chuẩn bắt buộc giữ identity/idempotency, auth/scope, durable ACK, runtime độc lập, QA/callback, đối soát không replay và bằng chứng đúng phạm vi. policy.lock.json, manifest SHA-256 và bộ kiểm tra offline phát hiện sai khác trong bản được phát hành.

## Dùng nhanh

1. So SHA-256 của ZIP với file .sha256 đi kèm hoặc biên nhận đã lưu tin cậy.
2. Giải nén vào thư mục mới. Không ghép thêm token, .env thật hoặc lịch sử tác vụ vào gói.
3. Chạy Python 3.10 trở lên: python bin/agy_standard.py doctor
4. Thử hợp đồng offline: python bin/agy_standard.py decide --request examples/task-envelope.json --ledger examples/ledger-empty.json
5. Thử uncertainty: python bin/agy_standard.py decide --request examples/task-envelope.json --ledger examples/ledger-uncertain.json
6. Đọc docs/ADOPTION.md để áp dụng cho một AI/client mới; kiểm auth/capability thật trước bất kỳ tác vụ nào.

Doctor PASS chỉ chứng minh toàn vẹn bản chuẩn và invariant local. ELIGIBLE_FOR_LIVE_PREFLIGHT không cấp quyền dispatch. Mọi output của utility đều có dispatch_permitted=false hoặc scope offline. Utility không gọi mạng, không cài MCP, không chứa runtime Core và không triển khai dịch vụ.

## Khóa phiên bản

Không sửa file của bản 1.0.0 để thay luật. Chỉ chủ dự án cho phép đổi chuẩn; tạo phiên bản mới, test lại, manifest/hash mới và checkpoint mới. Không xóa bản cũ. Kiểm hash phát hiện thay đổi so với checksum tin cậy; đây không phải chữ ký số hay bảo vệ tuyệt đối trước người có quyền sửa cả file lẫn checksum.

## Trạng thái vận hành cần giữ đúng

Hosted fixed R11 verification đã được audit trong phạm vi staging, không có model inference. Native ChatGPT AGY connector còn BLOCKED_PRODUCT_BINDING. Runtime Core dùng cho môi trường/AI/thiết bị khác vẫn NOT_READY. RESULT_READY/QA PENDING là điểm đã quan sát; sau deadline QA một giờ, operation audit đã BLOCKED/QA_TIMEOUT nhưng giữ kết quả. Không tự replay để xóa blocker.

Không production cutover, không Supabase promotion, không thay global LEGACY, không Work executor fallback. Snapshot trong evidence/config là bằng chứng lịch sử, không phải kiểm tra live tại thời điểm người nhận mở file.

## Thành phần

PDF và bản Markdown; policy lock; connection snapshot; schema/envelope và API mapping; quy trình áp dụng/khôi phục/đổi phiên bản; ví dụ ledger; doctor/offline guard; test; QA report; manifest và nguồn chứng cứ. Python utility chỉ dùng standard library. Không bundle font, dependency runtime Core hay credential. Quyền phân phối công khai/thương mại chưa được xác lập bởi gói này.
