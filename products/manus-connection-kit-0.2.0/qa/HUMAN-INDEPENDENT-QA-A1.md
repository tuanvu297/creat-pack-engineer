# HUMAN independent QA — attempt 1
Status: SOURCE_PREFLIGHT_REQUIRES_CORRECTION_AND_FROZEN_RETEST

Historical attempt retained; final corrected artifact requires a separate hash-bound retest.

- H-F01 S1 AC04: Windows installer deletes install.lock inside its open handle scope; PermissionError WinError32 Expected: Clean install exits PASS with lock removed Correction: Close lock before final unlink Disposition: Producer source correction done; frozen independent retest pending.
- H-F02 S1 AC02/AC05: Original root resolved before link check; descendant/reparse paths not consistently checked Expected: Reject original path reparse points and managed child aliases Correction: Ancestor lstat before resolve; reparse checks descendants and DPAPI path Disposition: Producer correction done; independent source review confirms new no_links use.
- H-F03 S1 AC03: Original updates and rollback lacked mandatory differing-binary checksum/post-test/backup verification Expected: Trusted explicit checksum, candidate and post-switch selftest, backup verification and restoration on failure Correction: Add checksum gate, pre/post tests and verified rollback Disposition: Producer correction done; independent retest pending.
- H-F04 S1 AC02/AC04: Human default root occupied parent of AI install; AI-first setup made human destination unowned Expected: Both modes use distinct mode directories Correction: Human .../ManusConnectionKit/human Disposition: Producer source corrected.

Evidence: HUMAN-PREFLIGHT-A1.json

No AUTH_VERIFIED, LIVE_EXECUTION_PASS, or INTEGRATED_PASS claimed.
