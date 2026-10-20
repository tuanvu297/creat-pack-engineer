# Ánh xạ hợp đồng

Envelope chuẩn dùng snake_case để lưu hồ sơ liên hệ thống. Đây không phải payload được gửi nguyên trạng cho gateway đang chạy. Adapter phải chuyển đổi có kiểm soát, giữ nguyên identity và source.

| Thao tác chuẩn | Hợp đồng REST đã quan sát | Quy tắc |
|---|---|---|
| Bootstrap | POST /v1/agy/bootstrap hoặc current_state | Auth trước; scoped project; đọc checkpoint hiện hành |
| DISPATCH | POST /v1/agy/dispatch | Lưu INTENT/hash trước; gửi một lần; timeout phải đọc/reconcile |
| STATUS / RESULT | POST /v1/agy/task_status hoặc get_run | Cùng envelope gốc, workflow/run/operation; không tạo dispatch |
| CALLBACK | POST /v1/agy/callback_status | Đọc từng callback theo identity, trạng thái và thời điểm |
| RECONCILE | POST /v1/agy/reconcile | Có quyền write; không đồng nghĩa cho phép replay |
| STOP | POST /v1/agy/stop | Giữ accepted operation và dữ liệu; remote cancel không được suy đoán |

Runtime mission hiện dùng tenantId/workspaceId/projectId cùng mission_id/task_id/attempt/idempotency_key; nguồn: source_ref; worker: executor_worker_id; qa_contract_version=1.1; mode=TEMPORAL_SHADOW. Native command lane hiện chỉ cho mission AGY-TEMPORAL-20261018 và fixed verification command. Không dùng envelope chuẩn để vượt allowlist đó. Phiên bản này không cung cấp converter/live adapter để tránh biến dữ liệu mẫu thành tác vụ thật.

Native MCP đề xuất tối thiểu bootstrap, dispatch, task_status/get_result, callback_status, reconcile và safe_stop. Không expose r11_control, journal init, SQL, deployment hay arbitrary command. QA dùng reviewer identity độc lập. Thiết kế/auth/workspace binding vẫn chưa triển khai; trạng thái native giữ BLOCKED_PRODUCT_BINDING.
