from __future__ import annotations

import io

import pytest
from PIL import Image

from app.services.image_composer import ImageComposer


def _make_image(width: int, height: int, color: tuple[int, int, int] = (255, 0, 0)) -> Image.Image:
    return Image.new("RGB", (width, height), color=color)


def test_resize_to_fit_keeps_original_when_small_enough():
    composer = ImageComposer(max_width=800, max_height=600)
    img = _make_image(400, 300)

    resized = composer._resize_to_fit(img, 800, 600)

    assert resized.size == (400, 300)


def test_resize_to_fit_scales_down_preserving_aspect_ratio():
    composer = ImageComposer(max_width=800, max_height=600)
    img = _make_image(1600, 900)

    resized = composer._resize_to_fit(img, 800, 600)

    assert resized.size == (800, 450)


@pytest.mark.asyncio
async def test_compose_character_reference_image_validates_inputs(monkeypatch):
    composer = ImageComposer(max_width=800, max_height=600)

    with pytest.raises(ValueError, match="No character images"):
        await composer.compose_character_reference_image([])


@pytest.mark.asyncio
async def test_compose_character_reference_image_raises_when_all_fail(monkeypatch):
    composer = ImageComposer(max_width=800, max_height=600)

    async def fake_download(url: str):
        raise RuntimeError("download failed")

    monkeypatch.setattr(composer, "_download_image", fake_download)

    with pytest.raises(RuntimeError, match="All character images failed"):
        await composer.compose_character_reference_image(["char1.png", "char2.png"])


@pytest.mark.asyncio
async def test_compose_character_reference_image_scales_down_when_too_wide(monkeypatch):
    composer = ImageComposer(max_width=300, max_height=300)
    chars = [_make_image(400, 200), _make_image(400, 200)]

    async def fake_download(url: str):
        return chars.pop(0)

    monkeypatch.setattr(composer, "_download_image", fake_download)

    result = await composer.compose_character_reference_image(["a.png", "b.png"])
    image = Image.open(io.BytesIO(result))

    assert image.width <= 300
    assert image.height <= 300


@pytest.mark.asyncio
async def test_compose_character_reference_image_uses_min_target_height_when_zero(monkeypatch):
    composer = ImageComposer(max_width=800, max_height=0)
    char = _make_image(100, 100)

    async def fake_download(url: str):
        return char

    monkeypatch.setattr(composer, "_download_image", fake_download)

    result = await composer.compose_character_reference_image(["char.png"])
    image = Image.open(io.BytesIO(result))

    assert image.height >= 1


def test_build_nine_grid_urls_layout_and_fallback():
    composer = ImageComposer()
    urls = composer._build_nine_grid_urls(
        current_image_url="cur.png",
        previous_image_url="prev.png",
        next_image_url=None,
        character_image_urls=["c0.png", "c1.png"],
    )

    assert len(urls) == 9
    assert urls[0] == "prev.png"
    assert urls[1] == "cur.png"
    assert urls[2] == "cur.png"  # next fallback
    assert urls[3] == "c0.png"
    assert urls[4] == "c1.png"
    assert urls[5] == "c0.png"  # cycle
    assert urls[8] == "cur.png"


@pytest.mark.asyncio
async def test_compose_nine_grid_reference_image_is_3x3(monkeypatch):
    composer = ImageComposer(max_width=1600, max_height=1600)
    colors = {
        "cur.png": (255, 0, 0),
        "prev.png": (0, 255, 0),
        "next.png": (0, 0, 255),
        "c0.png": (255, 255, 0),
    }

    async def fake_download(url: str):
        return _make_image(400, 300, colors.get(url, (128, 128, 128)))

    monkeypatch.setattr(composer, "_download_image", fake_download)

    result = await composer.compose_nine_grid_reference_image(
        current_image_url="cur.png",
        previous_image_url="prev.png",
        next_image_url="next.png",
        character_image_urls=["c0.png"],
        cell_size=200,
        gap=10,
    )
    image = Image.open(io.BytesIO(result))

    assert image.size == (200 * 3 + 10 * 2, 200 * 3 + 10 * 2)
    # center-top cell (current) should contain red-dominant pixels
    center_x = 200 + 10 + 100
    center_y = 100
    pixel = image.getpixel((center_x, center_y))
    assert pixel[0] > 200 and pixel[1] < 50 and pixel[2] < 50
