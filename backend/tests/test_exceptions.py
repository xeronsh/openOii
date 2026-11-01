from __future__ import annotations

from app.exceptions import (
    AppException,
    BusinessError,
    ConflictError,
    NotFoundError,
    PermissionError,
)


def test_app_exception_defaults():
    exc = AppException("boom")
    assert exc.message == "boom"
    assert exc.code == "APP_ERROR"
    assert exc.status_code == 500
    assert exc.details == {}
    assert str(exc) == "boom"


def test_app_exception_custom():
    details = {"field": "name"}
    exc = AppException("bad", code="BAD", status_code=418, details=details)
    assert exc.code == "BAD"
    assert exc.status_code == 418
    assert exc.details == details


def test_not_found_error():
    exc = NotFoundError("Project", 42)
    assert exc.status_code == 404
    assert exc.code == "NOT_FOUND"
    assert exc.message == "Project 不存在"
    assert exc.details == {"resource": "Project", "id": 42}


def test_not_found_error_string_id():
    exc = NotFoundError("Run", "abc-123")
    assert exc.details["id"] == "abc-123"


def test_conflict_error():
    exc = ConflictError("already exists")
    assert exc.status_code == 409
    assert exc.code == "CONFLICT"


def test_conflict_error_with_details():
    exc = ConflictError("conflict", details={"existing_id": 1})
    assert exc.details == {"existing_id": 1}


def test_permission_error():
    exc = PermissionError()
    assert exc.status_code == 403
    assert exc.code == "PERMISSION_DENIED"
    assert exc.message == "权限不足"


def test_permission_error_custom_message():
    exc = PermissionError("forbidden")
    assert exc.message == "forbidden"


def test_business_error():
    exc = BusinessError("not allowed")
    assert exc.status_code == 422
    assert exc.code == "BUSINESS_ERROR"


def test_business_error_custom_code():
    exc = BusinessError("not allowed", code="CUSTOM", details={"key": "val"})
    assert exc.code == "CUSTOM"
    assert exc.details == {"key": "val"}


def test_app_exception_is_base():
    assert issubclass(NotFoundError, AppException)
    assert issubclass(ConflictError, AppException)
    assert issubclass(PermissionError, AppException)
    assert issubclass(BusinessError, AppException)
