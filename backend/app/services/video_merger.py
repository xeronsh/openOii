"""Copy or download a clip to a local file (used by audio muxing).

Merging clips into the final video happens in the engine.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.services.file_cleaner import get_local_path
from app.services.remote_video import MAX_VIDEO_BYTES, download_video_async

logger = logging.getLogger(__name__)

# 输出目录（相对于 backend 目录）
OUTPUT_DIR = Path(__file__).parent.parent / "static" / "videos"


class VideoMergerService:
    """Fetches clips to local files."""

    def __init__(self, output_dir: Path | None = None):
        """初始化视频拼接服务

        Args:
            output_dir: 输出目录，默认为 backend/app/static/videos
        """
        self.output_dir = output_dir or OUTPUT_DIR
        self.output_dir.mkdir(parents=True, exist_ok=True)
    async def close(self) -> None:
        return None

    async def download_video(
        self, url: str, dest_path: Path, max_bytes: int = MAX_VIDEO_BYTES
    ) -> None:
        """下载或复制视频文件

        Args:
            url: 视频 URL 或本地 /static/... 路径
            dest_path: 目标路径
        """
        local_path = get_local_path(url)
        if local_path is not None:
            if not local_path.is_file():
                raise FileNotFoundError(f"Local video file not found: {local_path}")
            created = False
            try:
                with local_path.open("rb") as source, dest_path.open("xb") as destination:
                    created = True
                    size = 0
                    while chunk := source.read(64 * 1024):
                        size += len(chunk)
                        if size > max_bytes:
                            raise ValueError("Video exceeds download size limit")
                        destination.write(chunk)
            except BaseException:
                if created:
                    dest_path.unlink(missing_ok=True)
                raise
            logger.info("Copied local video %s to %s", local_path, dest_path)
            return

        await download_video_async(url, dest_path, max_bytes)
        logger.info("Downloaded remote video")

# 全局单例
_merger_service: VideoMergerService | None = None


def get_video_merger_service() -> VideoMergerService:
    """获取视频拼接服务单例"""
    global _merger_service
    if _merger_service is None:
        _merger_service = VideoMergerService()
    return _merger_service
