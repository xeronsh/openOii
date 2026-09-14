"""Optimistic-concurrency helpers for the HTTP write paths.

The engine and this API both write `project` / `character` / `shot`. The
mapper-level version guard (see `Project.revision`) makes every SQLAlchemy
write a compare-and-set that bumps `revision` and rejects writes from a
session that read a stale row. The guard here surfaces the *client-visible*
part of that contract: an explicit `expected_revision` on an update payload
is checked against the persisted row before applying the change, and any
stale-write race that slips between check and flush becomes HTTP 409.
"""

from __future__ import annotations

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import Session as SQLModelSession  # noqa: F401  (typing only)

from app.exceptions import ConflictError

CONFLICT_CODE = "CONCURRENT_MODIFICATION"

# sqlalchemy.orm.exc.StaleDataError is the canonical home; it subclasses
# SQLAlchemyError, which is importable from sqlalchemy.exc.
try:
    from sqlalchemy.orm.exc import StaleDataError
except ImportError:  # pragma: no cover - older/newer layout fallback

    class StaleDataError(SQLAlchemyError):  # type: ignore[no-redef]
        pass


def assert_expected_revision(obj: object, expected_revision: int | None, *, entity: str) -> None:
    """Reject an edit that was drafted against an older revision (HTTP 409).

    `expected_revision=None` keeps the endpoint backwards compatible: the
    mapper-level guard still serialises the write, and the response carries
    the fresh revision for the next edit.
    """
    if expected_revision is None:
        return
    current = getattr(obj, "revision", None)
    if current != expected_revision:
        raise ConflictError(
            f"{entity} was modified concurrently; reload and retry",
            details={
                "entity": entity,
                "id": getattr(obj, "id", None),
                "expected_revision": expected_revision,
                "current_revision": current,
            },
            code=CONFLICT_CODE,
        )


async def commit_versioned(session: AsyncSession, obj: object, *, entity: str) -> None:
    """Commit a versioned entity, translating a lost CAS race into HTTP 409."""
    try:
        await session.commit()
    except StaleDataError as exc:
        await session.rollback()
        raise ConflictError(
            f"{entity} was modified concurrently; reload and retry",
            details={
                "entity": entity,
                "id": getattr(obj, "id", None),
            },
            code=CONFLICT_CODE,
        ) from exc
