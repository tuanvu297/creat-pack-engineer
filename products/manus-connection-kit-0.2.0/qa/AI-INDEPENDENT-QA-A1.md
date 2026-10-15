# AI independent QA — attempt 1
Status: REQUIRES_CORRECTION_AND_RETEST

Historical attempt retained; final corrected artifact requires a separate hash-bound retest.

- AI-F01 S2 AC02/AC03: Windows zipfile normalizes raw alternate separator in ZipInfo.filename before extraction validation; otherwise valid raw-backslash candidate accepted Expected: Reject alternate separators before any file write Correction: Validate ZipInfo.orig_filename and reject normalization mismatch Disposition: Producer implemented correction; frozen retest pending.

Evidence: AI-TEST-EVIDENCE-A1.json, AI-PATH-PROBE-A1.json, AI-SUPPLEMENTAL-A1.json, AI-ALTERNATE-SEPARATOR-FINDING-A1.json

No AUTH_VERIFIED, LIVE_EXECUTION_PASS, or INTEGRATED_PASS claimed.
