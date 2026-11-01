from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import urlsplit, urlunsplit

from pydantic import PlainSerializer


def utcnow() -> datetime:
    """Return current UTC time as naive datetime."""
    return datetime.now(UTC).replace(tzinfo=None)


def as_naive_utc(value: datetime) -> datetime:
    """Naive UTC for arithmetic between backend and engine timestamps.

    The backend stores naive UTC; the engine writes ISO-8601 with a trailing Z,
    which reads back tz-aware. Mixing the two in a subtraction raises TypeError.
    """
    if value.tzinfo is None:
        return value
    return value.astimezone(UTC).replace(tzinfo=None)


def _iso_utc(value: datetime) -> str:
    aware = value if value.tzinfo else value.replace(tzinfo=UTC)
    return aware.isoformat().replace("+00:00", "Z")


# Naive UTC rows must leave the API with a "Z": the browser reads an
# offset-less ISO string as local time and shows it hours off.
UtcDatetime = Annotated[datetime, PlainSerializer(_iso_utc, return_type=str, when_used="json")]


def redact_credentials(conn_str: str) -> str:
    """去掉连接串中的账号口令，避免凭据进入日志。"""
    parts = urlsplit(conn_str)
    if not parts.hostname:
        return conn_str
    netloc = parts.hostname
    if parts.username:
        netloc = f"{parts.username}:***@{netloc}"
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
