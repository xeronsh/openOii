from __future__ import annotations

from typing import Any


class AppException(Exception):
    """应用基础异常类"""

    def __init__(
        self,
        message: str,
        code: str = "APP_ERROR",
        status_code: int = 500,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class ValidationError(AppException):
    """验证错误 (400)"""

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            message=message,
            code="VALIDATION_ERROR",
            status_code=400,
            details=details,
        )


class NotFoundError(AppException):
    """资源不存在 (404)"""

    def __init__(self, resource: str, resource_id: int | str) -> None:
        super().__init__(
            message=f"{resource} 不存在",
            code="NOT_FOUND",
            status_code=404,
            details={"resource": resource, "id": resource_id},
        )


class ConflictError(AppException):
    """冲突错误 (409)"""

    def __init__(
        self,
        message: str,
        details: dict[str, Any] | None = None,
        *,
        code: str = "CONFLICT",
    ) -> None:
        super().__init__(
            message=message,
            code=code,
            status_code=409,
            details=details,
        )


class PermissionError(AppException):
    """权限错误 (403)"""

    def __init__(self, message: str = "权限不足") -> None:
        super().__init__(
            message=message,
            code="PERMISSION_DENIED",
            status_code=403,
        )


class BusinessError(AppException):
    """业务逻辑错误 (422)"""

    def __init__(
        self,
        message: str,
        code: str = "BUSINESS_ERROR",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            message=message,
            code=code,
            status_code=422,
            details=details,
        )
