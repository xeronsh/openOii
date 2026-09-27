"""Small JSON-lines bridge for Engine-owned media helpers."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

from app.config import get_settings
from app.services.audio_service import AudioService
from app.services.character_bible import compute_face_embedding_from_bytes
from app.services.image_composer import ImageComposer
from app.services.tts_voices import get_voice_for_character

logger = logging.getLogger(__name__)


async def handle(request: object) -> object:
    if not isinstance(request, dict):
        raise ValueError("request must be an object")

    action = request.get("action")
    if action == "face_embedding":
        image = request.get("image")
        if not isinstance(image, str):
            return None
        return compute_face_embedding_from_bytes(base64.b64decode(image, validate=True))

    composer = ImageComposer()
    if action == "character_reference":
        urls = request.get("urls")
        if not isinstance(urls, list) or not urls:
            return None
        image = await composer.compose_character_reference_image(urls)
        return base64.b64encode(image).decode("ascii")

    if action == "nine_grid_reference":
        current = request.get("current")
        if not isinstance(current, str) or not current:
            raise ValueError("current image is required")
        image = await composer.compose_nine_grid_reference_image(
            current_image_url=current,
            previous_image_url=request.get("previous"),
            next_image_url=request.get("next"),
            character_image_urls=request.get("characters"),
        )
        return base64.b64encode(image).decode("ascii")

    if action == "process_audio":
        policy = request.get("settings")
        allowed = {
            "text_provider",
            "image_provider",
            "video_provider",
            "tts_enabled",
            "tts_default_voice",
            "tts_volume",
            "bgm_enabled",
            "bgm_volume",
            "bgm_directory",
        }
        updates = {
            key: value
            for key, value in policy.items()
            if key in allowed
        } if isinstance(policy, dict) else {}
        settings = get_settings().model_copy(update=updates)
        audio = AudioService(settings)

        dialogue = request.get("dialogue")
        tts_url = None
        if settings.tts_enabled and isinstance(dialogue, str) and dialogue.strip():
            speaker = request.get("speaker")
            voice = settings.tts_default_voice
            if isinstance(speaker, dict):
                voice = get_voice_for_character(
                    SimpleNamespace(
                        name=str(speaker.get("name") or ""),
                        description=speaker.get("description"),
                    )
                )
            tts_url = await audio.generate_tts(dialogue, voice=voice)

        scene = request.get("scene")
        expression = request.get("expression")
        genre = request.get("genre")
        bgm_url = audio.match_bgm(
            scene=scene if isinstance(scene, str) else None,
            expression=expression if isinstance(expression, str) else None,
            genre=genre if isinstance(genre, str) else None,
        )
        video_url = request.get("video_url")
        if not isinstance(video_url, str):
            raise ValueError("video_url is required")
        video_url = await audio.mix_audio_into_video(
            video_url,
            tts_path=tts_url,
            bgm_path=bgm_url,
            tts_volume=settings.tts_volume,
            bgm_volume=settings.bgm_volume,
        )
        return {
            "video_url": video_url,
            "tts_url": tts_url,
            "bgm_type": Path(urlsplit(bgm_url).path).stem if bgm_url else None,
        }

    raise ValueError(f"unknown action: {action}")


def main() -> None:
    for line in sys.stdin:
        try:
            result = asyncio.run(handle(json.loads(line)))
        except Exception as error:
            logger.exception("Engine media operation failed")
            result = {"error": str(error)}
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
