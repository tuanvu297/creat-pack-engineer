# Creat Pack — lượt học 09:00 ngày 14/10/2026

TASK_ID: CREAT-PACK-LEARNING-20261014-0900. Vai trò ACTIVE_OWNER_LOCK.
Trạng thái: RESEARCH_COMPLETED / LOCAL_EXPERIMENTS_RECORDED / PROPOSALS_ONLY.
Subject: toolkit 0.1.0, source SHA256
`8b0ee64835516fa73c9244bc0fb0431284b36434cdd9917a4c752ca79799b043`.
Runtime thử: Python 3.12.14, Node v24.19.0, Windows. Không cài dependency mới.

## Bootstrap và phạm vi

Đã đọc role lock, engineer profile 0.1.2/S04, learned knowledge S03, source registry,
research/AGY references và bốn nguồn canonical trước nghiên cứu:

- START HERE: 10Ph_XvsgytAHsdECGDNkPY94l4EIuTat-4VWtbXrTsY, modified 2026-10-12T03:20:15.803Z.
- Decision Log: 1TFSkLh7ZfAxHq-mYSN-HG2Dp1XJaG_JWcItASe_4tME, modified 2026-10-12T03:20:03.285Z, tới D-044.
- Shared workflow/QA: 1S98IZWRhF5rDdthPO-y5ETb1shHRS9bz0f_J22yzcqc, modified 2026-10-11T23:18:55.728Z, QA v1.1.
- Worker V2 checkpoint: 1mFB9ugcXq9v0K9geDvO8K2-zgn3rWHvSLCAMmct7760, modified 2026-10-12T08:00:41.415Z.

Modified timestamps là metadata provider trả, không giả thành revision IDs.
Checkpoint canonical chứa lịch sử/route cũ; không dùng nó để phủ nhận hoặc mở rộng
bounded runtime evidence 13/10 được profile S04 tham chiếu. Lượt này không kiểm thử
AGY/provider, không thay canon, skill, production hay credential.

## CP-LRN-01 — Manifest JSON đọc thống nhất giữa các runtime

**Nguồn OBSERVED:** [Python JSON interoperability](https://docs.python.org/3.12/library/json.html#standard-compliance-and-interoperability),
tài liệu Python 3.12 (trang hiện hiển thị 3.12.15); publication date không có.
Kiểm tra 14/10/2026. Python mặc định nhận số không hữu hạn và lấy giá trị cuối khi
key lặp; tài liệu có hooks để đổi hành vi này. Đây là hành vi có sẵn, không gọi là
thay đổi Python mới trong ngày.

**Thí nghiệm OBSERVED:** ba ZIP hoàn toàn giả, chỉ đọc verify, không thực thi payload.
Toolkit hiện trả PACKAGE_BUILT=PASS cho baseline, manifest NaN và manifest key lặp.
Node JSON.parse nhận baseline và key lặp, từ chối NaN. Parser strict thử nghiệm nhận
baseline, từ chối NaN/key lặp. Key lặp chưa làm hai parser hiện có cho giá trị khác
nhau; việc từ chối là đề xuất tránh ambiguity, không phải claim Node đã từ chối.

**Áp dụng INFERRED:** thêm strict JSON ở manifest/config/task boundary; reject
NaN/Infinity và duplicate keys, serialize allow_nan=False; bổ sung type/schema
validation cho contract. Có ích cho Release Toolkit, worker envelopes và AI nhận ZIP.
Thêm regression bằng fixture âm và positive/placeholder controls vào pipeline;
không chỉ test parse thành công hoặc ZIP tạo được.

**Quyết định:** PROPOSE_FIX. Candidate parser controls LOCAL_EXPERIMENT_PASS;
toolkit chưa sửa, full regression/cross-platform/AGY integration UNVERIFIED.

## CP-LRN-02 — Kiểm tra provenance ngoài self-consistency

**Nguồn OBSERVED:** [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations),
GitHub Docs hiện hành, publication date/version không công bố; kiểm tra 14/10/2026.
Attestation liên kết artifact với source/build; bên nhận phải verify. Nó không tự
chứng minh artifact an toàn. Availability/permission/plan của repo private này
chưa được kiểm tra và không tạo workflow hay attestation trong lượt học.

**Thí nghiệm OBSERVED:** thay payload giả và tính lại inventory/hash trong manifest;
verify của toolkit vẫn PASS cấu trúc. So sánh với digest baseline được giữ riêng
từ chối replacement và nhận baseline. Đây là behavior đúng scope self-consistency,
không phải tìm được collision hay lỗi crypto; kẻ thay cả gói có thể thay hash bên trong.

**Áp dụng INFERRED:** ở receive/install contract, lưu expected ZIP digest lấy từ
trusted release receipt/channel riêng rồi đối chiếu trước dùng. Publisher identity,
source commit/build provenance là gate riêng. Khi account/workflow đủ điều kiện mới
cân nhắc signed attestation, không tự mua plan hay cấp quyền.

**Quyết định:** PROPOSE_RECEIVE_GATE. Local pinned-digest control PASS trong fixture;
signature/publisher verification, CI attestation và runtime integration UNVERIFIED.

## CP-LRN-03 — Bổ sung coverage trường OAuth client_secret

**Nguồn OBSERVED:** [RFC 6749 §2.3.1](https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1),
IETF OAuth 2.0, October 2012, đã đọc field definition. Chỉ dùng để xác định ý nghĩa
tên trường; không coi đây là hướng dẫn OAuth bảo mật đầy đủ hiện hành.
[GitHub secret scanning changelog 13/10/2026](https://github.blog/changelog/2026-10-13-secret-scanning-blocks-anthropic-keys-by-default-adds-salesforce/)
công bố coverage mới cho Salesforce/Anthropic/Cloudsmith. Không suy rằng scanner
local có cùng detector hoặc push protection đã bật trên repo private này.

**Thí nghiệm OBSERVED:** giá trị giả sinh trong bộ nhớ, không in/lưu giá trị.
Scanner hiện phát hiện generic `secret`, bỏ sót cùng dữ liệu dưới `client_secret`,
và không flag placeholder. Stored evidence chỉ có tên case, bool và rule/line.
Không phát hiện credential thật trong lượt học.

**Áp dụng INFERRED:** mở rộng context-aware field detection và placeholder allowlist;
đo false positives/false negatives bằng gold fixtures. Cập nhật corpus provider
theo tài liệu format thực, không tự đoán regex từ tên secret type.

**Quyết định:** PROPOSE_FIX / COVERAGE_GAP_REPRODUCED; chưa sửa scanner production,
chưa chứng minh full-provider coverage.

## Nguồn quốc tế và Việt Nam đã đối chiếu

- Astral uv và Python Packaging User Guide được mở; không thấy yêu cầu hợp lý để
  thêm uv/dependency vào toolkit hiện dùng thư viện chuẩn. Không benchmark hay nâng version.
- [Viblo Engineering — CI/CD, PHAM HIEU, 29/02/2024](https://engineering.viblo.asia/p/ci-cd-trong-phat-trien-va-van-hanh-du-an-o-viblo-5OXLAA8aLGr)
  là bài gốc của đội vận hành: test gates trước build/registry và GitOps delivery.
  Dùng làm tham chiếu thiết kế regression gate cho các đề xuất trên. Bài cũ, không
  gọi là tin mới hoặc bằng chứng CI của Creat Pack đã được cài.
- Viblo index đang hiển thị posts năm 2024. FPT blog index truy cập được nhưng phần
  fetched không cung cấp bài kỹ thuật có ngày/claim đủ để nhận một proposal riêng.
- GitHub Changelog được đọc với cập nhật 13/10. Chỉ detector coverage liên quan được
  chọn làm tín hiệu; không tự đổi model, GitHub App permission hoặc account setting.

## Evidence, giới hạn và bước kế tiếp

Evidence tái hiện: [RESULT.json](2026-10-14-0900-contract-security/RESULT.json),
[SECRET-COVERAGE.json](2026-10-14-0900-contract-security/SECRET-COVERAGE.json),
scripts và bootstrap receipts trong thư mục cùng tên. Original fixtures nằm riêng
tại D:/Codex/creat-pack-research/20261014-0900, không đưa ZIP thử vào source/release.
Scripts là witnesses Windows của lượt thử, dùng paths đã ghi; sao chép vào thư mục
trống trước khi chạy lại vì cố ý không overwrite fixtures. Không là portable tool mới.

Không ghi INSTALL_TEST_PASS/AUTH_VERIFIED/LIVE_EXECUTION_PASS/INTEGRATED_PASS cho
release mới. Product release NOT_BUILT. MUTUAL_TRAINING/QA_ALIGNMENT/AGY DAILY_CYCLE
UNVERIFIED_NOT_RUN; không promote global skill. Next: sửa hẹp strict JSON và scanner
coverage trong task code riêng, chạy regression phù hợp rồi mới đưa vào release.

Note/evidence mới được lưu GitHub + Drive theo storage binding và readback; receipt
đồng bộ riêng ghi commit, ID/hash thật sau khi các thao tác hoàn tất.
