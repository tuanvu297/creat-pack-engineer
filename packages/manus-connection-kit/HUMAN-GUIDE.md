# Hướng dẫn người dùng — Manus Connection Kit

Pilot hiện tại đã phát hiện MANUS_API_KEY ở binding riêng của host; không yêu cầu
chủ nhập lại. Người nhận kit chỉ làm phần cấu hình key nếu họ chưa có key của họ.

## 1. Mở kit và kiểm tra Python

1. Mở thư mục ZIP, so checksum với receipt nhận từ người phát hành qua kênh tin cậy.
2. Giải nén vào thư mục mới, không chép vào repo/state đang chạy.
3. Trong Explorer, bấm thanh địa chỉ, nhập `powershell`, Enter để mở terminal ở đó.
4. Gõ `python --version`, rồi `python bin/manus-kit.py self-test`.
5. Không nhập API key vào lệnh self-test, chat, ticket hoặc ảnh chụp màn hình.
6. Kết quả đúng: Python >=3.10 và JSON LOCAL_SELF_TEST=PASS, network_requests=0.
7. Nếu không có Python, cài Python từ https://www.python.org/downloads/ hoặc dùng
   runtime đã được quản trị viên cấp; mở lại terminal rồi lặp bước kiểm tra runtime.

## 2. API key của chính bạn

1. Mở trang chính thức https://open.manus.im/docs/v2/authentication; bấm liên kết
   **Manus Developers settings**, đăng nhập account Manus của bạn.
2. Bấm **Create API Key**, đặt tên `manus-connection-kit-pilot`, hoàn tất xác nhận
   mà giao diện yêu cầu. Đây là các nhãn được tài liệu official xác nhận 14/10/2026.
3. Sao chép key vào vùng nhập riêng ở bước 3 dưới đây. Không gửi key cho người bán/AI.
4. Không mua/nạp credit để vượt lỗi setup theo hướng dẫn này; thiếu quyền/quota phải
   được account owner quyết định riêng.
5. Sau cấu hình, auth-health phải cho AUTH_VERIFIED=true và user_id_sha256, không có
   giá trị key hoặc user ID đầy đủ.
6. Nếu trang/account không có quyền tạo key, dừng tại bước này và xin account admin
   cấp key riêng. Không dùng cookie hoặc mượn key của người phát hành.
7. Kit không giả screenshot hay nhãn nút account chưa quan sát; trang official là
   nguồn cho UI/key permissions hiện hành. Không chụp vùng chứa key để xin trợ giúp.

## 3. Nhập vào Windows User environment

1. Bấm Win+R, nhập `rundll32 sysdm.cpl,EditEnvironmentVariables`, Enter.
2. Trong vùng User variables của account đang dùng, bấm New (hoặc Edit nếu đã có).
3. Variable name: `MANUS_API_KEY`. Variable value: key của chính bạn, nhập ngay tại UI.
4. Không nhập key vào System variables nếu chỉ cần user này; không gửi giá trị vào chat.
5. Bấm OK ở hộp nhập, rồi OK đóng Environment Variables. Mở terminal mới tại kit.
6. Chạy `python bin/manus-kit.py auth-health`, rồi `python bin/manus-kit.py credits`.
7. Nếu key absent, kiểm tra tên biến và account Windows. Nếu HTTP401/403, kiểm tra
   trạng thái/key permissions trên Manus. Nếu expired, thay key ở UI riêng rồi chỉ
   chạy GET auth-health lại; không chạy create để thử auth.

macOS/Linux: quản trị viên/secret manager truyền MANUS_API_KEY vào process của kit.
Không đặt key trong .env ở thư mục kit hoặc trong cấu hình MCP được chia sẻ.

## 4. Cho AI chạy task nhỏ

1. Đọc AI-INSTALL.md cùng AI. Chọn private state nằm ngoài thư mục kit.
2. Chủ/controller quyết định task ID, worker ID, key idempotency, callback, scope và
   một task lite đã được phép. Controller tạo grant file riêng bằng command README.
3. AI bind grant file tại host, kiểm tra auth/credits, rồi create đúng một task.
4. Không tự tạo grant vượt quyền; không đổi idempotency khi timeout hoặc mất ACK.
5. Đúng: có provider_task_id; read cùng ID, không create task khác; journal trace được.
6. Nếu UNCERTAIN, giữ state và provider operation ID; đọc journal-status và read nếu
   đã có ID. Không bấm/gõ submit lại. Nếu thiếu ID, đối soát trên Manus với admin.
7. stop là ACK yêu cầu dừng, không đồng nghĩa background jobs đã hết. read lại và ghi
   trạng thái UNKNOWN khi còn thiếu proof; output/delivery/QA là ba bước khác nhau.
