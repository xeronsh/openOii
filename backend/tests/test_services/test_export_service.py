"""导出服务单元测试"""
from __future__ import annotations

import pytest
from app.schemas.export import ExportResponse, ExportCompletedEventData


class TestExportSchemas:
    """导出 Schema 测试"""

    def test_export_response_processing(self):
        resp = ExportResponse(
            export_id="abc123",
            project_id=1,
            format="pdf",
            status="processing",
        )
        assert resp.status == "processing"
        assert resp.download_url is None

    def test_export_response_completed(self):
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
        data = ExportCompletedEventData(
            export_id="abc123",
            format="pdf",
            download_url="/static/exports/test.pdf",
            status="completed",
        )
        assert data.status == "completed"
        assert data.error is None

    def test_export_completed_event_data_failed(self):
        data = ExportCompletedEventData(
            export_id="abc123",
            format="webtoon",
            status="failed",
            error="Download failed",
        )
        assert data.status == "failed"
        assert data.error == "Download failed"


class TestFontUtils:
    """字体工具测试"""

    def test_get_chinese_font_path_system(self):
        from app.services.font_utils import get_chinese_font_path
        # Reset cache
        import app.services.font_utils as fu
        fu._cached_font_path = None

        path = get_chinese_font_path()
        # 系统有 Noto Sans CJK，应该能找到
        assert isinstance(path, str)

    def test_get_reportlab_font_name(self):
        from app.services.font_utils import get_reportlab_font_name
        import app.services.font_utils as fu
        fu._cached_font_path = None

        name = get_reportlab_font_name()
        assert isinstance(name, str)
        assert len(name) > 0

    def test_get_pillow_font_path(self):
        from app.services.font_utils import get_pillow_font_path
        import app.services.font_utils as fu
        fu._cached_font_path = None

        path = get_pillow_font_path()
        assert isinstance(path, str)


class TestExportService:
    """导出服务测试"""

    @pytest.fixture
    def service(self):
        from app.services.export_service import ExportService
        return ExportService()

    def test_export_service_init(self, service):
        assert service._http_client is None

    @pytest.mark.asyncio
    async def test_export_webtoon_requires_shots(self, service):
        from app.models.project import Project

        project = Project(id=1, title="Empty Project", style="anime")

        with pytest.raises(ValueError, match="没有可导出的分镜"):
            await service.export_webtoon(project, [])

    @pytest.mark.asyncio
    async def test_download_image_empty_url(self, service):
        result = await service._download_image("")
        assert result is None

    @pytest.mark.asyncio
    async def test_download_image_none_url(self, service):
        result = await service._download_image(None)
        assert result is None

    @pytest.mark.asyncio
    async def test_download_image_invalid_url(self, service):
        result = await service._download_image("not-a-url")
        assert result is None

    def test_load_pil_image_invalid(self, service):
        result = service._load_pil_image(b"not-an-image")
        assert result is None
