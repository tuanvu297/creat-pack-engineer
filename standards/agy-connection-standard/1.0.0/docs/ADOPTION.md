# Áp dụng chuẩn cho AI hoặc thiết bị mới

Chủ dự án đã yêu cầu chuẩn hóa quy trình kết nối; lệnh này không chứng minh mọi AI đã nhận/cài chuẩn. Mỗi client cần hồ sơ adoption riêng.

1. Cấp file chuẩn đã kiểm checksum. Đọc VERSION, policy.lock.json, PDF/Markdown và checkpoint mới nhất.
2. Ghi client/workspace/device, WORKER, EXECUTOR_RUNTIME, version/hash đã đọc, thời điểm và người cấp quyền. Không lưu secret.
3. Kiểm công cụ thực sự được expose. Có plugin/skill không đồng nghĩa executor callable. Native thiếu binding -> BLOCKED_PRODUCT_BINDING.
4. Xác thực live bằng route được phép, kiểm tenant/workspace/project/action scope, quota/budget và health. Khai báo trong JSON không thay thế auth server-side.
5. Dùng test-only identity mới theo hợp đồng runtime. Lưu INTENT/payload hash trước dispatch. Nếu runtime chỉ cho mission cố định, ghi giới hạn, không sửa bypass.
6. Kiểm ACK bền vững, dừng phụ thuộc chat đầu, đọc cùng operation từ client độc lập, result/QA/callback và negative tests. Không replay operation đã ACCEPTED/UNCERTAIN.
7. Lưu QA/evidence ở GitHub/Drive, readback, rồi đánh dấu adoption PASS đúng client/version/scope. Chưa thử giữ UNVERIFIED.

Mẫu chỉ dẫn cho AI nhận bộ chuẩn:

“Đọc bản AGY-CONNECTION-STANDARD 1.0.0 và kiểm hash qua doctor. Áp dụng các invariant được chủ dự án phê duyệt trong phạm vi nhiệm vụ được giao. Bootstrap từ checkpoint dùng chung mới nhất, nêu WORKER và EXECUTOR_RUNTIME, kiểm route/auth/budget thực tế. Trước effect ghi dự đoán kết quả/rủi ro và intent/identity/hash. Không dispatch nếu native binding thiếu; không Work executor fallback; không replay ACCEPTED/UNCERTAIN. Ghi kết quả/bằng chứng/QA/callback và readback đúng target. File chuẩn không cấp credential, quyền production hay ngân sách mới. Báo rõ đã đọc chuẩn, đã kiểm toàn vẹn, đã auth và đã thực thi là các mức khác nhau.”

Không tự ghi đè system prompt, tài khoản, global skill hoặc policy của AI khác. Client phải có cơ chế nạp chuẩn được chủ tài khoản cho phép. Bản phát hành này chứng nhận file quy trình/offline guard, không chứng nhận kết nối của client mới.
