"""视频拼接服务

使用 ffmpeg 将多个视频片段拼接成一个完整视频。
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import uuid
from pathlib import Path

from app.services.file_cleaner import get_local_path
from app.services.remote_video import MAX_VIDEO_BYTES, download_video_async

logger = logging.getLogger(__name__)

# 输出目录（相对于 backend 目录）
OUTPUT_DIR = Path(__file__).parent.parent / "static" / "videos"
MAX_MERGE_VIDEOS = 100
MAX_MERGE_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024


class VideoMergerService:
    """视频拼接服务

    使用 ffmpeg 的 concat demuxer 拼接多个视频文件。
    """

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

    async def merge_videos(
        self,
        video_urls: list[str],
        output_filename: str | None = None,
    ) -> str:
        """拼接多个视频

        Args:
            video_urls: 视频 URL 列表
            output_filename: 输出文件名（不含扩展名），默认自动生成

        Returns:
            拼接后视频的本地路径（相对于 static 目录）
        """
        if not video_urls:
            raise ValueError("No video URLs provided")
        if len(video_urls) > MAX_MERGE_VIDEOS:
            raise ValueError(f"At most {MAX_MERGE_VIDEOS} videos may be merged")

        # 生成输出文件名
        if not output_filename:
            output_filename = f"merged_{uuid.uuid4().hex[:8]}"

        if (Path(output_filename).name != output_filename or output_filename in {".", ".."}
                or "/" in output_filename or "\\" in output_filename):
            raise ValueError("Invalid output filename")
        output_path = self.output_dir / f"{output_filename}.mp4"

        if len(video_urls) == 1:
            with tempfile.TemporaryDirectory(dir=self.output_dir) as temp_dir:
                staged_path = Path(temp_dir) / "video.mp4"
                await self.download_video(video_urls[0], staged_path)
                os.link(staged_path, output_path)
            logger.info("Single video normalized to local output: %s", output_path)
            return f"/static/videos/{output_filename}.mp4"

        # 创建临时目录存放下载的视频；放在输出目录下，保证最终 os.link 不跨文件系统
        with tempfile.TemporaryDirectory(dir=self.output_dir) as temp_dir:
            temp_path = Path(temp_dir)
            downloaded_files: list[Path] = []

            # Sequential downloads bound concurrency to one and enforce an exact aggregate cap.
            logger.info("Downloading %s videos...", len(video_urls))
            remaining_bytes = MAX_MERGE_DOWNLOAD_BYTES
            for i, url in enumerate(video_urls):
                # 从 URL 推断扩展名，默认 mp4
                ext = ".mp4"
                if "." in url.split("/")[-1].split("?")[0]:
                    ext = "." + url.split("/")[-1].split("?")[0].split(".")[-1]

                dest = temp_path / f"video_{i:03d}{ext}"
                downloaded_files.append(dest)
                local_path = get_local_path(url)
                max_bytes = min(MAX_VIDEO_BYTES, remaining_bytes)
                if local_path is None:
                    await download_video_async(url, dest, max_bytes)
                else:
                    await self.download_video(url, dest, max_bytes)
                remaining_bytes -= dest.stat().st_size
                if remaining_bytes < 0:
                    raise ValueError("Merged videos exceed total download size limit")
            logger.info("All %s videos downloaded", len(video_urls))

            # 创建 ffmpeg concat 文件列表
            concat_file = temp_path / "concat.txt"
            staged_output = temp_path / "merged.mp4"
            concat_lines = []
            for video_file in downloaded_files:
                escaped_path = str(video_file).replace("'", "'\\''")
                concat_lines.append(f"file '{escaped_path}'\n")
            await asyncio.to_thread(concat_file.write_text, "".join(concat_lines))

            # 使用 ffmpeg 拼接视频
            # -f concat: 使用 concat demuxer
            # -safe 0: 允许绝对路径
            # -c copy: 直接复制流，不重新编码（快速）
            # 如果视频格式不一致，需要重新编码
            cmd = [
                "ffmpeg",
                "-f", "concat",
                "-safe", "0",
                "-i", str(concat_file),
                "-c", "copy",  # 尝试直接复制
                str(staged_output),
            ]

            logger.info(f"Running ffmpeg: {' '.join(cmd)}")

            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                _stdout, stderr = await process.communicate()
            except asyncio.CancelledError:
                await _stop_process(process)
                raise

            if process.returncode != 0:
                # 如果直接复制失败，尝试重新编码
                staged_output.unlink(missing_ok=True)
                logger.warning(f"ffmpeg copy failed, trying re-encode: {stderr.decode()}")

                cmd_reencode = [
                    "ffmpeg",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", str(concat_file),
                    "-c:v", "libx264",
                    "-preset", "fast",
                    "-crf", "23",
                    "-c:a", "aac",
                    "-b:a", "128k",
                    "-movflags", "+faststart",
                    str(staged_output),
                ]

                logger.info(f"Running ffmpeg (re-encode): {' '.join(cmd_reencode)}")

                process = await asyncio.create_subprocess_exec(
                    *cmd_reencode,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    _stdout, stderr = await process.communicate()
                except asyncio.CancelledError:
                    await _stop_process(process)
                    raise

                if process.returncode != 0:
                    raise RuntimeError(f"ffmpeg failed: {stderr.decode()}")

            os.link(staged_output, output_path)
            logger.info("Video merged successfully: %s", output_path)

        # 返回相对路径（用于构建 URL）
        return f"/static/videos/{output_filename}.mp4"


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.communicate(), timeout=5)
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()


# 全局单例
_merger_service: VideoMergerService | None = None


def get_video_merger_service() -> VideoMergerService:
    """获取视频拼接服务单例"""
    global _merger_service
    if _merger_service is None:
        _merger_service = VideoMergerService()
    return _merger_service
