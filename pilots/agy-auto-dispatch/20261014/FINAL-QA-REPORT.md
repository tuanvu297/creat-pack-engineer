# AGY auto-dispatch — bàn giao bounded remediation

Kết quả: VERIFIED_PASS_SCOPED cho FRESH_HUMAN_CONTROL_CHAT_BOUNDED_AUTO_DISPATCH. AGY-DISPATCH-GAP-001 vẫn OPEN vì chưa triển khai bộ xác minh native acceptance thường trực và chưa mở rộng sang mission lập trình bất kỳ. Full unattended production acceptance: EXTERNAL_LIMIT / UNVERIFIED.

## Kiến trúc đã chọn

Owner AGY RUN tại control chat → control chat tạo envelope → GitHub issue2 inbox → daemon Python độc lập → SQLite/WAL → logical executor AGY-PRIMARY-PERSISTENT → Codex app-server stdio, context ephemeral cô lập → callback GET readback → AGY review độc lập → trusted host native receipt → AGY_ACCEPTED.

AGY Core — Work chính giữ vai trò giám sát. Desktop đang giữ active writer của thread; daemon không chiếm lock hoặc giả vờ kích hoạt thread đó. Dùng stdio chính thức vì managed daemon control socket hiện không khả dụng. Không tạo stored Work mới. Stable executor binding gồm logical worker, host PID/instance, journal ngoài package và primary monitor thread ID; ephemeral provider context có thể đổi khi restart.

## Mã nguồn, dịch vụ và cài/start

Source: D:/Codex/agy-auto-dispatch, bản0.1.1. src/queue_store.py quản lý queue/grant/journal/idempotency; src/appserver_client.py quản lý transport, quota và tool isolation; src/daemon.py quản lý ingress, watcher, callback và status. bin/agy_queue.py và scripts/start.ps1/restart.ps1 là entrypoints. Private runtime configuration và state ở D:/Codex/agy-auto-dispatch-state, không nằm trong ZIP.

Runtime đã thử: Python3.12.14, standard library, không pip dependency; Codex0.162.0-alpha.17.2 signed-in ChatGPT; GitHub connector hiện có. ZIP giải nén mới, gọi entrypoint help và55/55 tests PASS. Sử dụng external config như README; config ví dụ hết hạn có chủ ý. Start wrapper chạy process nền ẩn; process-start không được tính là executor ACK.

Daemon đang cài theo dạng process nền cục bộ, không Windows service/boot task/cloud deployment. Status: http://127.0.0.1:8788/status. Queue/store: D:/Codex/agy-auto-dispatch-state/live-A1/queue.sqlite, WAL/FULL. Không sửa synced sources, global Codex config/auth hay runtime của mission khác.

## Recovery, security và rollback

Claim atomically; signed lease45s và instance fence; ACK PID thực trước PLAN; watcher1s, stale heartbeat15s → STALE. Immutable external intent được ghi trước provider turn/callback POST. PENDING/UNCERTAIN không blind retry. Restart giữ task đã accepted, đánh dấu in-flight UNCERTAIN; callback uncertainty chỉ GET-reconcile đúng payload đã lưu, không POST lại. Parent đã safe-stop/restart0.1.1, A1 retained và không replay.

Rollback: gọi bin/agy_queue.py --state STATE stop; đợi daemon_alive=false; giữ nguyên journal/evidence để reconciliation. Dùng restart.ps1 khi khởi động lại có chủ ý. Không xóa state/key hoặc force-kill desktop. Máy shutdown thì process dừng; boot persistence chưa được cài.

Secret signature scan toàn bộ tên/bytes release:0 findings. Không xuất DB/key/grant signature/cookie/token/runtime config/raw transcript. Model context có0 connector tools; authenticated connector context riêng. Chỉ account included route sau fresh quota check; monetary cost UNKNOWN; không mua/top-up hoặc paid API key.

## Pilot và evidence

A1 là delegated control-chat pilot, source0.1.0, result42, native independent accepted; giữ checkpoint cũ.

A2 được khởi tạo từ tin nhắn human AGY run e358bf7b-5b11-4ab9-9463-5e1bdaccd245 tại AGY Dispatch Result Watch. Control chat tự chọn nonce AGY-0c815fc122e95273 và inputs6580/-9370. Executor PID19824 ACK thực, fresh grant G-3996ac448bec4da7afc6f680837c9e77 trước PLAN. Real provider turn01a13a94-dc58-7962-80bf-541db07a1735 trả -2790 đúng rubric. Source0.1.1 snapshot79c45cf1b380f4271ba2b2236c303e701b990baaac9e6a1a504492bba16043e1.

Mission comment6169380605, verified callback6169384363, independent AGY review6169402072; actual reviewer message9ff1cd4f-debb-4bbf-a1b3-0b95d7f3949d được đọc lại qua native read_thread. Parent trusted host lưu receipt rồi journal đạt AGY_ACCEPTED. A2 có1 MODEL_TURN và1 CALLBACK_POST; A1+A2 tổng2 mỗi loại, không mutation retry. Owner không phải copy lệnh sang Work. Bước xác minh native receipt cuối vẫn do host của phiên engineering thực hiện; không được gọi là daemon tự động hoàn toàn.

55/55 local tests và55/55 fresh-extraction tests; peer A3 PASS_LOCAL_SCOPED. Hai build ZIP có SHA256 giống nhau; manifest inventory được xác minh, self-hash exclusion được ZIP checksum bao phủ.

## Handoff và giới hạn

ZIP SHA256:6cc3671d62dfd599bdb6e011c7d6114d8063a02f377aebe8de0488fc4ab43d14. GitHub draftPR5: https://github.com/tuanvu297/creat-pack-engineer/pull/5. Source/evidence release28/28 files readback đúng bytes tại commita9256a642f20a0194a5bc43db27985c71fd25c85. Drive ZIP: https://drive.google.com/file/d/1cfg9LBe6D4_9jdNU1p7luhYYd7I3L8HY/view, downloaded53113bytes và SHA256 trùng.

ZIP và report trong ZIP đã frozen trước A2 hoàn tất, nên các claim UNVERIFIED ở snapshot đó là trạng thái lịch sử, không bị sửa ngược. Supplemental FINAL-RELEASE-QA-A2.json và evidence bundle nâng LIVE_EXECUTION_PASS/INTEGRATED_PASS đúng hash/source/scope A2. Các claim chưa được A2 chứng minh vẫn UNVERIFIED.

Chỉ task class codex_nonce_sum và hai identity bounded được phép. Slot A2 đã dùng; lệnh AGY RUN tương lai không tự có quyền tạo arbitrary mission. General mission compiler, authorization policy và continuous independent native verifier còn cần triển khai/test. Không auto-promote skill/canon, không merge PR hoặc production deploy. Host HMAC không chống người dùng cùng account cố tình sửa private state. App-server alpha compatibility, cross-platform và uptime dài hạn chưa được kiểm chứng.
