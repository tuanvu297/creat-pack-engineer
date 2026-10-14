# Manus Connection Kit 0.1.1

Một adapter Manus API và MCP stdio dùng chung SQLite journal. Runtime: Python
3.10+ với thư viện chuẩn, không phải cài dependency ngoài. Windows được kiểm tra
trong pilot; Linux/macOS chưa nghiệm thu. Kit không mang account, key hoặc state.

Đọc HUMAN-GUIDE.md nếu cần tạo/nhập API key. AI đọc AI-INSTALL.md trước khi làm.
Đối chiếu SHA256 ZIP từ release receipt ở kênh tin cậy riêng trước khi giải nén.
Không tự chạy source/attachment chưa kiểm tra. MANIFEST.json liệt kê file/hash.

## Chạy cục bộ

Từ thư mục kit đã giải nén, thay `python` bằng Python đang có:

```text
python bin/manus-kit.py self-test
python -B -m unittest discover -s tests -v
python bin/manus-kit.py --state <private-state-outside-package> auth-health
python bin/manus-kit.py --state <private-state-outside-package> credits
```

self-test chỉ phát hiện runtime/key-presence, không gọi mạng hoặc chứng minh auth.
auth-health là GET user.me, credits là GET usage.availableCredits. Mọi output là
JSON; exit 0 là lệnh hoàn tất, exit 1 là FAIL_OR_BLOCKED, không phải toàn pilot PASS.

Controller trên host được chủ cho phép tạo grant trong state riêng:

```text
python bin/manus-kit.py --state <private-state> issue-grant --task-id <task-id> --worker-id <worker-id> --idempotency-key <key> --callback-target <callback-id> --authorization <owner-scope-reference> --ttl 600 --out <private-grant.json>
python bin/manus-kit.py --state <private-state> --grant <private-grant.json> create --prompt <bounded-prompt>
python bin/manus-kit.py --state <private-state> --grant <private-grant.json> read
python bin/manus-kit.py --state <private-state> --grant <private-grant.json> stop
python bin/manus-kit.py --state <private-state> journal-status
```

Mỗi grant tối đa 900 giây và một create theo identity/idempotency của controller.
Gia hạn bằng grant mới cùng identity để đọc/resume task cũ; không đổi key để vượt
UNCERTAIN. Nếu mất ACK/provider ID, dừng và đối soát provider, không submit lại.
Resume phải có reason, command key riêng và readback stopped hoặc ordinary question
messageAskUser/cascadeAskUser; không tự confirm connector/deploy/payment actions.

## MCP

Chạy `python bin/manus-kit.py --state <private-state> --grant <private-grant> mcp`.
config/mcp.example.json là cấu hình có placeholder. Có initialize/initialized,
tools/list/call, ping, JSON-lines stdio; stdout chỉ là JSON-RPC. 8 tools gồm auth,
credits, create, readback, resume, stop, journal-status, dispatch-status. Worker
không truyền grant/credential qua tool arguments; controller bind grant file ở host.
CLI và MCP gọi đúng cùng Adapter/Journal, không tạo runtime/state thứ hai.

## Evidence và boundaries

Journal lưu intent trước side effect. Cùng request hoàn tất trả cached ACK; khác
payload bị chặn. Timeout/response không xác định ghi UNCERTAIN và chặn blind retry.
Reply + stopped chưa là acceptance: phải background_jobs=false, newest reply sau
input và không thiếu trang; task rubric/independent QA là gate riêng. read cho phép
đối soát GET trên grant hết hạn nhưng đã xác minh signature/ownership; mutations
luôn cần grant còn hạn. API key được đọc từ process env hoặc Windows User env,
không in giá trị. Key, controller authority key, grants, DB/callback state ở ngoài kit.

Grant/dispatch authority là host controller đáng tin, không phải sandbox chống
người cùng OS user có quyền đọc state. Windows ACL cần khách cấu hình; chmod 0600
không được quảng cáo là Windows isolation. Kit không cài lịch chạy nền, không tự
publish/deploy/top-up hoặc kích hoạt native Work host không có binding.

docs/AGY-DISPATCH.md mô tả ACK→heartbeat→STALE→checkpoint→callback→AGY acceptance.
evidence/ ghi test/scan/provenance đúng scope; production, private repo license và
customer support terms chưa được chứng nhận/chốt. Đây là private pilot kit.

Nguồn provider: https://open.manus.im/docs/v2/task-lifecycle và
https://open.manus.im/docs/v2/authentication, đối chiếu 14/10/2026.
