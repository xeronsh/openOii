"""图片拼接服务 - 用于图生视频"""

from __future__ import annotations

import io
import logging

import httpx
from PIL import Image

from app.services.file_cleaner import get_local_path, is_local_file
from app.services.face_cropper import (
    compose_face_reference_strip,
    is_face_cropping_available,
)

logger = logging.getLogger(__name__)


class ImageComposer:
    """图片拼接器 - 将分镜图和角色图拼接成参考图"""

    def __init__(self, max_width: int = 1920, max_height: int = 1080):
        self.max_width = max_width
        self.max_height = max_height

    async def _download_image(self, url: str) -> Image.Image:
        """下载图片"""
        if is_local_file(url):
            local_path = get_local_path(url)
            if local_path and local_path.exists():
                return Image.open(local_path).convert("RGB")
            raise FileNotFoundError(f"Local image not found: {local_path}")
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=30.0)
            response.raise_for_status()
            return Image.open(io.BytesIO(response.content)).convert("RGB")

    def _resize_to_fit(self, img: Image.Image, max_width: int, max_height: int) -> Image.Image:
        """等比例缩放图片以适应指定尺寸"""
        ratio = min(max_width / img.width, max_height / img.height)
        if ratio < 1:
            new_size = (int(img.width * ratio), int(img.height * ratio))
            return img.resize(new_size, Image.Resampling.LANCZOS)
        return img

    def _fit_into_cell(
        self,
        img: Image.Image,
        cell_size: int,
        *,
        bg: tuple[int, int, int] = (24, 24, 27),
    ) -> Image.Image:
        """Letterbox an image into a square cell."""
        cell = Image.new("RGB", (cell_size, cell_size), color=bg)
        fitted = self._resize_to_fit(img, cell_size, cell_size)
        x = (cell_size - fitted.width) // 2
        y = (cell_size - fitted.height) // 2
        cell.paste(fitted, (x, y))
        return cell

    def _build_nine_grid_urls(
        self,
        *,
        current_image_url: str,
        previous_image_url: str | None = None,
        next_image_url: str | None = None,
        character_image_urls: list[str] | None = None,
    ) -> list[str]:
        """Fill a 3×3 board for I2V consistency.

        Layout (reading order):
        [prev] [current] [next]
        [char0] [char1] [char2]
        [char3] [char4] [current]

        Missing neighbors fall back to current. Character slots cycle available
        character refs, then current, so the board is never empty.
        """
        current = current_image_url
        prev = previous_image_url or current
        nxt = next_image_url or current
        chars = [url for url in (character_image_urls or []) if url]

        def char_at(i: int) -> str:
            if chars:
                return chars[i % len(chars)]
            return current

        return [
            prev,
            current,
            nxt,
            char_at(0),
            char_at(1),
            char_at(2),
            char_at(3),
            char_at(4),
            current,
        ]

    async def compose_nine_grid_reference_image(
        self,
        *,
        current_image_url: str,
        previous_image_url: str | None = None,
        next_image_url: str | None = None,
        character_image_urls: list[str] | None = None,
        cell_size: int = 512,
        gap: int = 8,
        bg: tuple[int, int, int] = (18, 18, 20),
    ) -> bytes:
        """Compose a 3×3 storyboard reference board for video generation.

        Center/top-middle is the current first frame; neighbors + character
        panels surround it so I2V models can lock identity and continuity.
        """
        if not current_image_url:
            raise ValueError("current_image_url is required for nine-grid reference")

        cell_size = max(128, int(cell_size))
        gap = max(0, int(gap))
        urls = self._build_nine_grid_urls(
            current_image_url=current_image_url,
            previous_image_url=previous_image_url,
            next_image_url=next_image_url,
            character_image_urls=character_image_urls,
        )

        cells: list[Image.Image] = []
        for url in urls:
            try:
                img = await self._download_image(url)
            except Exception as e:
                # Hard fallback: solid cell keeps board geometry stable.
                logger.warning("Grid cell download failed, using a blank cell for %.80s: %s", url, e)
                img = Image.new("RGB", (cell_size, cell_size), color=(40, 40, 48))
            cells.append(self._fit_into_cell(img, cell_size))

        board_w = cell_size * 3 + gap * 2
        board_h = cell_size * 3 + gap * 2
        # Keep under configured max dimensions while preserving square cells.
        max_side = max(1, min(self.max_width, self.max_height))
        if board_w > max_side:
            scale = max_side / board_w
            cell_size = max(64, int(cell_size * scale))
            gap = max(0, int(gap * scale))
            cells = [self._fit_into_cell(c, cell_size) for c in cells]
            board_w = cell_size * 3 + gap * 2
            board_h = cell_size * 3 + gap * 2

        canvas = Image.new("RGB", (board_w, board_h), color=bg)
        for idx, cell in enumerate(cells):
            row, col = divmod(idx, 3)
            x = col * (cell_size + gap)
            y = row * (cell_size + gap)
            canvas.paste(cell, (x, y))

        buffer = io.BytesIO()
        canvas.save(buffer, format="PNG")
        return buffer.getvalue()

    async def compose_character_reference_image(
        self,
        character_image_urls: list[str],
    ) -> bytes:
        """拼接角色参考图：优先裁剪面部区域，fallback 到全身图拼接。

        面部裁剪模式（InsightFace 可用时）：
        ┌────────┬────────┬────────┐
        │  脸1   │  脸2   │  脸3   │
        └────────┴────────┴────────┘
        面部占满参考图，模型能清晰识别五官特征。

        Fallback 模式：
        ┌─────────┬─────────┬─────┐
        │ 角色1   │ 角色2   │ ... │
        └─────────┴─────────┴─────┘

        Args:
            character_image_urls: 角色图片 URL 列表

        Returns:
            拼接后的图片字节流（PNG 格式）
        """
        if not character_image_urls:
            raise ValueError("No character images provided for composing reference image")

        # 下载角色图
        char_imgs: list[Image.Image] = []
        char_img_bytes: list[bytes] = []
        for url in character_image_urls:
            try:
                img = await self._download_image(url)
                char_imgs.append(img)
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                char_img_bytes.append(buf.getvalue())
            except Exception as e:
                logger.warning("Character reference download failed, skipping %.80s: %s", url, e)
                continue

        if not char_imgs:
            raise RuntimeError("All character images failed to download")

        # 优先尝试面部裁剪模式
        if is_face_cropping_available():
            try:
                face_strip = compose_face_reference_strip(
                    char_img_bytes,
                    expand_ratio=1.8,
                    face_size=256,
                    max_width=self.max_width,
                )
                if face_strip is not None:
                    logger.info(
                        "Composed face reference strip from %d character images",
                        len(char_img_bytes),
                    )
                    return face_strip
                logger.info("No faces detected, falling back to full-body composition")
            except Exception as e:
                logger.warning("Face cropping failed, falling back to full-body: %s", e)

        # Fallback：原有全身图拼接逻辑
        target_height = int(self.max_height * 0.3)
        if target_height <= 0:
            target_height = max(1, min(self.max_height, 256))

        resized: list[Image.Image] = []
        for img in char_imgs:
            ratio = target_height / img.height
            new_w = max(1, int(img.width * ratio))
            resized.append(img.resize((new_w, target_height), Image.Resampling.LANCZOS))

        total_width = sum(i.width for i in resized)
        if total_width > self.max_width:
            ratio = self.max_width / total_width
            new_resized: list[Image.Image] = []
            for img in resized:
                new_w = max(1, int(img.width * ratio))
                new_h = max(1, int(img.height * ratio))
                new_resized.append(img.resize((new_w, new_h), Image.Resampling.LANCZOS))
            resized = new_resized
            total_width = sum(i.width for i in resized)

        height = max(i.height for i in resized)
        canvas = Image.new("RGB", (total_width, height), color=(255, 255, 255))

        x_pos = 0
        for img in resized:
            y_pos = (height - img.height) // 2
            canvas.paste(img, (x_pos, y_pos))
            x_pos += img.width

        buffer = io.BytesIO()
        canvas.save(buffer, format="PNG")
        return buffer.getvalue()
