"""Offline candidate compiler; workflow metadata never grants provider authority."""
import copy
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'provider-interop'))
from interop_contract import ContractError, compile_prompt, instant, validate_task


def prepare(template, *, expected_callback, deadline, ttl_seconds=600, now=None):
    """Derive a bounded lease from current time and validate before returning.

    The actual sender must validate_task again immediately before its one send,
    and independently obtain a real provider grant. This module never sends.
    """
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or type(ttl_seconds) is not int or not 1 <= ttl_seconds <= 900:
        raise ContractError('INVALID_WORKFLOW_TTL')
    end = min(now + timedelta(seconds=ttl_seconds), instant(deadline))
    if end <= now:
        raise ContractError('MISSION_DEADLINE_EXPIRED')
    task = copy.deepcopy(template)
    task['lease'] = {'owner': task['worker_id'], 'issued_at': now.isoformat(),
                     'expires_at': end.isoformat(), 'max_submissions': 1}
    validate_task(task, expected_callback=expected_callback, now=now)
    return task, compile_prompt(task, expected_callback=expected_callback, now=now)
