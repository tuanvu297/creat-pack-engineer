# Chạy nền, Chrome và Steel

Quan sát ngày 15/10/2026. Chạy nền mô tả nơi thực thi; nó không tự chứng minh
đã giao việc, đã có kết quả hay đã được AGY nghiệm thu.

| Đường chạy | Hiện trạng đã quan sát | Điều kiện hoạt động |
|---|---|---|
| Codex executor cục bộ | P1 thực chạy, được AGY chấp nhận trong phạm vi supplied-text; restart không replay | Máy thức, mạng và phiên/quota hợp lệ; khởi động thủ công sau shutdown |
| Manus API | Tác vụ mới đã ACK và trả kết quả thật | Grant mới, quyền và tài nguyên hợp lệ; API không cần thao tác Chrome |
| Muse CLI | Tác vụ mới đã trả kết quả thật | Runtime và auth riêng; không suy diễn quyền ghi từ bridge chỉ đọc |
| Gemini trên Chrome | G1 đã trả JSON thật qua Chrome được kết nối | Chrome và kết nối trình duyệt khả dụng; phiên đăng nhập hiện tại |
| Steel | Khả năng chạy nền có trong tài liệu; AGY Gemini trên Steel chưa kiểm chứng | Phiên/profile riêng, phạm vi website được duyệt, tài nguyên và đăng nhập hợp lệ |

Steel là trình duyệt từ xa. Tài liệu chính thức hỗ trợ headless và viewer để
giám sát hoặc tiếp quản. Profile có thể giữ dữ liệu phiên; `persistProfile`
không mặc định bật, phải đợi profile READY trước khi tái sử dụng. Đăng nhập ở
Chrome máy anh không chứng minh đã đăng nhập trên Steel. Profile có thể chứa
cookie và credential: không đặt trong ZIP, GitHub, evidence hoặc chat.

Nguồn chính thức (đọc 2026-10-15):
- https://docs.steel.dev/overview/sessions-api/configuration
- https://docs.steel.dev/overview/profiles-api/overview

Adapter Steel hiện kiểm tra chỉ cho phép example.com; chưa mở quyền Gemini,
chưa chuyển cookie/profile, chưa tạo phiên Steel mới trong lượt này. Nên giữ
API/CLI cho công việc phù hợp, Chrome cho phiên web đang dùng, rồi kiểm chứng
Steel bằng một pilot riêng sau khi binding/auth/phạm vi được xác nhận.

Luồng mong muốn: chat nhận yêu cầu → kiểm tra phạm vi và tài nguyên → journal
và queue → worker ACK → chạy/heartbeat → thu output → callback → QA riêng.
Kết quả về chat kỹ sư khi host đang hoạt động có tuyến nhắn tin thật. Daemon
hiện có durable inbox nhưng chưa có bằng chứng tự đánh thức chat kỹ sư liên
tục khi không có host xử lý: EXTERNAL_LIMIT. Không bắt Owner copy lệnh sang Work.

Ví dụ yêu cầu hiện phù hợp: “AGY RUN: đọc đoạn sau, chia kế hoạch tối đa 5 mục
mỗi lô, nêu điểm chưa biết và trả kết quả về chat kỹ sư.” Việc chạy code, xử lý
file thật, website hoặc dữ liệu sản xuất cần adapter/quyền/test tương ứng;
không suy rộng quyền từ một lần trả lời văn bản thành quyền thực thi.
