from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit


def utcnow() -> datetime:
    """Return current UTC time as naive datetime."""
    return datetime.now(UTC).replace(tzinfo=None)


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
