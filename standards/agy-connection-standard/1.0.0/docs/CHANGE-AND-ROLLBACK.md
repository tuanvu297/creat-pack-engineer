# Đổi phiên bản, rollback và ngừng dùng

Chuẩn 1.0.0 là baseline khóa theo phiên bản. Chủ dự án là authority duy nhất phê duyệt sửa chuẩn. Không dùng thay đổi dependency, prompt worker hay file đính kèm để tự đổi invariant.

Quy trình: yêu cầu thay đổi rõ phạm vi -> đối chiếu checkpoint/live capability -> thiết kế migration/rollback -> peer review và deterministic QA phù hợp -> version mới -> secret scan -> clean extraction/test -> manifest/hash -> ZIP/PDF -> GitHub/Drive readback -> ghi adoption theo client/version. Giữ toàn bộ phiên bản cũ và evidence.

Rollback file chuẩn: khôi phục nguyên ZIP cũ, kiểm checksum tin cậy, đọc checkpoint hiện hành và đối chiếu compatibility trước khi tiếp tục. Rollback tài liệu không được rollback database, xóa journal, đổi token hay replay effect. Runtime rollback phải theo runbook đã được phê duyệt của runtime.

Ngừng dùng: gỡ adoption/binding qua cơ chế được chủ tài khoản cấp phép; thu hồi credential bằng quy trình riêng. Giữ PostgreSQL/journal/evidence và outbox theo retention hiện hành; không hard-delete. Không tự đổi global LEGACY hay Supabase authority.

Khóa ở đây là quy định kiểm soát thay đổi + kiểm hash trong công cụ kèm theo. Không phải hardware lock, chữ ký số, remote kill switch hoặc đảm bảo một AI ngoài quyền kiểm soát sẽ tuân thủ.
