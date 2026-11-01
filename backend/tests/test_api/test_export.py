"""导出 API 路由测试"""
from __future__ import annotations

import pytest


class TestExportSchemas:
    """导出 Schema 测试（不需要数据库）"""

    def test_export_response_processing(self):
        from app.schemas.export import ExportResponse
        resp = ExportResponse(
            export_id="abc123",
            project_id=1,
            format="pdf",
            status="processing",
        )
        assert resp.status == "processing"
        assert resp.download_url is None
        assert resp.project_id == 1

    def test_export_response_completed(self):
        from app.schemas.export import ExportResponse
        resp = ExportResponse(
            export_id="abc123",
            project_id=1,
            format="webtoon",
            status="completed",
            download_url="/static/exports/test.png",
        )
        assert resp.status == "completed"
        assert resp.download_url == "/static/exports/test.png"

    def test_export_completed_event_data(self):
        from app.schemas.export import ExportCompletedEventData
        data = ExportCompletedEventData(
            export_id="abc123",
            format="pdf",
            download_url="/static/exports/test.pdf",
            status="completed",
        )
        assert data.status == "completed"
        assert data.error is None

    def test_export_completed_event_data_failed(self):
        from app.schemas.export import ExportCompletedEventData
        data = ExportCompletedEventData(
            export_id="abc123",
            format="webtoon",
            status="failed",
            error="Download failed",
        )
        assert data.status == "failed"
        assert data.error == "Download failed"


class TestExportRouterRegistered:
    """导出路由注册测试"""

    def test_export_routes_exist(self):
        """验证导出路由已注册在 api_router 中"""
        from app.api.v1.router import api_router
        routes = [r.path for r in api_router.routes]
        # 导出路由前缀是 /projects（因为 router 在 projects prefix 下注册）
        export_routes = [r for r in routes if "export" in r]
        assert len(export_routes) >= 3, f"Expected export routes, got: {routes}"

    def test_ws_event_type_includes_export_completed(self):
        """验证 WsEventType 包含 export_completed"""
        from app.schemas.ws import WsEventType
        # WsEventType 是 Literal 类型，检查其值
        import typing
        args = typing.get_args(WsEventType)
        assert "export_completed" in args

    def test_ws_manager_has_export_completed_handler(self):
        """验证 ConnectionManager 包含 export_completed 事件处理"""
        from app.ws.manager import _EVENT_DATA_MODELS
        assert "export_completed" in _EVENT_DATA_MODELS


class TestExportStatusOwnership:
    """导出状态必须绑定项目，避免跨项目按 export_id 查询。"""

    @pytest.mark.asyncio
    async def test_export_status_rejects_wrong_project_id(self, async_client, test_session):
        from app.api.v1.routes import export as export_routes
        from app.schemas.export import ExportResponse
        from tests.factories import create_project

        project = await create_project(test_session, title="Owner")
        other_project = await create_project(test_session, title="Other")
        assert project.id is not None
        assert other_project.id is not None
        export_resp = ExportResponse(
            export_id="owned123",
            project_id=project.id,
            format="pdf",
            status="processing",
        )
        await export_routes._store_export_status(export_resp)

        ok = await async_client.get(f"/api/v1/projects/{project.id}/export/owned123/status")
        assert ok.status_code == 200
        assert ok.json()["project_id"] == project.id

        wrong = await async_client.get(
            f"/api/v1/projects/{other_project.id}/export/owned123/status"
        )
        assert wrong.status_code == 404

    @pytest.mark.asyncio
    async def test_append_project_export_preserves_existing_urls(self, test_session):
        from app.api.v1.routes.export import _append_project_export
        from tests.factories import create_project

        project = await create_project(test_session, title="Export Owner")
        assert project.id is not None

        await _append_project_export(test_session, project.id, "/static/exports/a.pdf")
        await _append_project_export(test_session, project.id, "/static/exports/b.png")
        await _append_project_export(test_session, project.id, "/static/exports/a.pdf")

        await test_session.refresh(project)
        assert project.exports == ["/static/exports/a.pdf", "/static/exports/b.png"]
