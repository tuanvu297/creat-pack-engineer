# Gemini trên Steel — kết quả sửa kết nối

Ngày15/10/2026. Kỹ sư Creat Pack chịu trách nhiệm bàn giao.

**PARTIAL: đường Gemini khách đã chạy thật; tài khoản Google/Pro trên Steel
EXTERNAL_LIMIT.** Gateway thử cũ, runtime chat-control và Chrome được giữ nguyên.

Đã sửa lỗi nạp module Windows/CJS, chặn path alias/junction vào package, tách
origin của trang và tài nguyên, thêm chính xác `gemini.gstatic.com` để tải JS.
Mỗi invocation có adapter ACK/PID/lease trước PLAN; intent SQLite WAL/FULL
được ghi trước create/fill/send/release. ACK adapter không phải ACK từ model.
Tác vụ pending/unknown không tự gửi lại. Collect phải khớp SEND và nonce, chỉ
đọc phần trả lời model; không lấy prompt được echo làm output.

Quan sát thực tế:

- A1 tạo đúng1session, nối tiếp cùngID sau lỗi local; Gemini trang200 và UI
  đầy đủ sau sửa resource. Google từ chối đăng nhập “This browser or app may
  not be secure” trước khi nhập credential. Session hết hạn được xác nhận
  released; không FILL/SEND nào.
- A2 là pha thử khách riêng sau khi xác nhận A1 đóng; giới hạn5phút/1câu hỏi.
  Journal ghi1CREATE,1FILL,1SEND DONE. Gemini trả đúng nonce
  `AGY-STEEL-A2-731` và `SUM:42 (19+23)` trong vùng trả lời assistant.
- Bộ đọc đầu trả OUTPUT_NOT_VERIFIED vì có nhãn UI “Gemini said” và biểu thức
  trong prompt. Raw output/trạng thái đầu được giữ, việc chuẩn hóa/QA nằm ở
  bằng chứng riêng; không gửi lại câu hỏi để sửa định dạng.
- Cả2session đã được officialSDK GET xác nhận released, không lưu profile,
  không chuyển cookie từ Chrome, không bật proxy/CAPTCHA solver hay mua thêm.

Xem peer reports, LIVE-GUEST-RAW/JOURNAL, ảnh GUEST-LIVE-PROOF và
SESSION-RELEASE-READBACK. Kiểm tra unit/giải nén/hash nằm trong receipt phát
hành riêng. Local tests không chứng minh authenticated Google hoặc production.

Phạm vi sử dụng: host kỹ sư/worker đã có quyền gọi CLI có thể chạy một probe
khách với policy/credit/lease mới. Policy thử cũ không là quyền chạy vô hạn.
Chưa thay namespace `agy_browser` chỉ dành demo, chưa có đường cho mọi worker
tự gọi general Gemini tool, chưa có dịch vụ24/7 hoặc native callback wake mới.
Durable checkpoint, callback thật và AGY acceptance phải được ghi tách riêng.

Google/Pro, lưu phiên lâu dài, Google apps và model/quota tương đương tài khoản
Chrome đều chưa được chứng nhận. Tiếp tục dùng Chrome đã đăng nhập cho chức
năng tài khoản. Không tự gỡ chặn bảo mật Google, không giả lập cookie và không
đổi sang API có billing chưa xác minh. Mọi global promotion giữ gate hiện hành.
