"""UUID version 7 (RFC 9562): time-ordered IDs, same scheme as apps/api/src/core/ids.ts."""

import os
import time
import uuid


def uuid7(now_ms: int | None = None) -> uuid.UUID:
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    raw = bytearray(ms.to_bytes(6, "big") + os.urandom(10))
    raw[6] = (raw[6] & 0x0F) | 0x70  # version 7
    raw[8] = (raw[8] & 0x3F) | 0x80  # RFC 4122 variant
    return uuid.UUID(bytes=bytes(raw))
