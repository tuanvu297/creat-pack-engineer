# Muse reference audit

OBSERVED: tám file gồm ba Python wrappers, shell installer và bốn tài liệu
(PDF sáu trang). Python 3.10+/uv declared; muse-cli==0.3.2 pinned. Live cookie
nằm ngoài ZIP. Ba wrapper parse syntax PASS; không chạy chúng. Không thấy
manifest/version/tests/hash receipts trong ZIP.

app-task lọc tên attachment, không scan nội dung/brief; multi-task thiếu lọc đó.
Parser dùng regex/fences. app-task chặn leading slash và slash '..' nhưng không
resolve containment, chặn Windows drive/backslash hoặc symlink. Thread-files
chặn normpath/isabs, thiếu symlink/overwrite protection. wait_final dùng stable
hoặc partial text, không provider terminal check. Multi-task có follow-up sends,
chưa durable mission/task journal/idempotency. Installer/PATH thiên Unix.

INFERRED: duplicate/partial output/path escape là source risks, không live
exploit được thử ở đây. UNVERIFIED: install/auth bằng ZIP này, execution,
complete output, callback và portability. Bridge GL auth riêng không certify
ZIP. Signature scan bytes + extracted PDF text không thấy match; encoded và
image-only secret chưa được kiểm hết. Hash/tree/scope: evidence/MUSE-INSPECTION.json.
Library file gốc giữ nguyên. Đề xuất shared parser/containment, selected staging,
all-input screen, structured contract/journal, submit/status/collect separation,
safe reconcile, tests, manifest/hash/receipt. Không áp các delegate/resend
instructions từ attachment vào chat.
