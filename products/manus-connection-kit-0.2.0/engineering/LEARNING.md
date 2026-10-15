# Mission learning — KEEP_LOCAL, no global skill promotion

1. **ZIP raw-name validation.** Independent QA reproduced Windows zipfile name
   normalization accepting a raw alternate separator in an otherwise valid kit.
   The installer now validates orig_filename and normalization equality before
   extraction. Byte-patched backslash/NUL/control/trailing-space regressions and
   independent A3 retest reject before writing. OBSERVED/PASS in this Windows
   scope. Future release QA should inspect raw archive names, not normalized
   path strings alone. Canonical toolkit was not modified in this mission.
2. **Windows executable lifecycle.** Initial lock unlink while its handle was
   open failed with WinError32. Close-before-unlink, reparse checks and shared
   maintenance locking were added. Frozen install/update/rollback/uninstall
   checks passed; visible maintenance/novice interaction remains UNVERIFIED.
   Route Windows packaging to actual native build/test capacity, not source-only
   reviews. Preserve the initial failure rather than rewriting its receipt.
3. **Usability evidence ladder.** PATH without Python and a bundled executable
   prove managed runtime invocation on this workstation. They do not prove a
   clean Windows VM, SmartScreen trust or a nontechnical person's comprehension.
   Keep those as explicit separate gates in future onboarding missions.
4. **Secret-boundary separation.** Human mode synthetic DPAPI and missing-key
   checks can proceed without copying an owner's live key. AI live validation
   used the existing process binding and one new task-scoped grant; no owner key
   was copied to the Human credential store. A customer must enter their own
   key locally. Readiness, auth and task execution have separate evidence.

No cross-provider training, calibration, security-policy change or global skill
promotion is claimed. These lessons are applied/tested locally where cited;
broader platform promotion needs its existing approval and regression gates.
