"""角色圣经服务 — 维护角色视觉参考、人脸 embedding 和视觉描述。

为每个角色提供：
- visual_notes 自动生成（LLM 从 description 提取关键视觉特征）
- face_embedding 计算（InsightFace）
- 角色圣经文本合并（description + visual_notes → bible）
- 余弦相似度查找（检测重复/冲突角色）
"""

from __future__ import annotations

import json
import logging
import math
from typing import TYPE_CHECKING

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.face_cropper import detect_faces, is_face_cropping_available

if TYPE_CHECKING:
    from app.models.project import Character
    from app.services.llm import LLMService

logger = logging.getLogger(__name__)


def build_character_bible(character: Character) -> str:
    """将角色的 visual_notes + description 合并为一段"角色圣经"文本。

    Args:
        character: Character 对象

    Returns:
        合并后的圣经文本
    """
    parts: list[str] = []

    if character.description:
        parts.append(character.description)

    if character.visual_notes:
        parts.append(f"Visual notes: {character.visual_notes}")

    if not parts:
        return character.name

    return " | ".join(parts)


async def compute_face_embedding(image_url: str) -> list[float] | None:
    """下载角色图片，调用 face_cropper.detect_faces() 提取 embedding。

    Args:
        image_url: 角色图片 URL

    Returns:
        512 维 embedding 向量列表，无法提取则返回 None
    """
    if not is_face_cropping_available():
        logger.info("InsightFace not available, skipping embedding computation")
        return None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(image_url)
            response.raise_for_status()
            image_bytes = response.content
    except Exception as e:
        logger.warning("Failed to download image for embedding: %s", e)
        return None

    return compute_face_embedding_from_bytes(image_bytes)


def compute_face_embedding_from_bytes(image_bytes: bytes) -> list[float] | None:
    """Extract the highest-confidence face embedding from image bytes."""
    if not is_face_cropping_available():
        return None

    faces = detect_faces(image_bytes)
    if not faces:
        logger.info("No face detected in image")
        return None

    # Use the best-scoring face
    best_face = max(faces, key=lambda f: f["det_score"])
    embedding = best_face["embedding"]

    # Convert numpy array to list[float]
    if hasattr(embedding, "tolist"):
        embedding = embedding.tolist()

    return embedding  # type: ignore[no-any-return]


async def find_similar_characters(
    embedding: list[float],
    project_id: int,
    session: AsyncSession,
    *,
    threshold: float = 0.7,
    exclude_id: int | None = None,
) -> list[tuple[Character, float]]:
    """在项目内基于 embedding 余弦相似度查找相似角色。

    Args:
        embedding: 查询 embedding 向量
        project_id: 项目 ID
        session: 数据库 session
        threshold: 相似度阈值（0-1）
        exclude_id: 排除的角色 ID（通常是自身）

    Returns:
        [(Character, similarity_score), ...] 按相似度降序排列
    """
    from app.models.project import Character

    query = select(Character).where(
        Character.project_id == project_id,
        Character.face_embedding.is_not(None),
    )
    if exclude_id is not None:
        query = query.where(Character.id != exclude_id)

    res = await session.execute(query)
    characters = res.scalars().all()

    results: list[tuple[Character, float]] = []
    for char in characters:
        if not char.face_embedding:
            continue
        try:
            other_embedding = json.loads(char.face_embedding)
            if not isinstance(other_embedding, list) or len(other_embedding) != len(embedding):
                continue
            sim = _cosine_similarity(embedding, other_embedding)
            if sim >= threshold:
                results.append((char, sim))
        except (json.JSONDecodeError, ValueError):
            continue

    results.sort(key=lambda x: x[1], reverse=True)
    return results


async def auto_populate_visual_notes(
    character: Character,
    llm_service: LLMService,
) -> str | None:
    """用 LLM 从角色 description 自动提取关键视觉特征，填充 visual_notes。

    Args:
        character: Character 对象
        llm_service: LLM 服务实例

    Returns:
        生成的 visual_notes 文本，失败返回 None
    """
    if not character.description:
        return None

    system_prompt = (
        "You are a character visual design assistant. "
        "Extract key VISUAL traits from the character description. "
        "Focus ONLY on observable, visual characteristics: "
        "hair color, hairstyle, eye color, skin tone, body type, height, "
        "distinguishing features (scars, tattoos, accessories), "
        "clothing style, color palette, signature items. "
        "Output a concise paragraph in the same language as the description. "
        "Do NOT include personality, backstory, or non-visual traits."
    )

    user_prompt = f"Character name: {character.name}\nDescription: {character.description}\n\nExtract the key visual traits."

    try:
        messages = [{"role": "user", "content": user_prompt}]
        final = None
        async for event in llm_service.stream(
            messages=messages,
            system=system_prompt,
            max_tokens=512,
        ):
            if event.get("type") == "final":
                resp = event.get("response")
                if resp is not None:
                    final = resp

        if final is None:
            return None

        visual_notes = final.text.strip()
        if visual_notes:
            return visual_notes  # type: ignore[no-any-return]
        return None
    except Exception as e:
        logger.warning("Failed to auto-populate visual notes for %s: %s", character.name, e)
        return None


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """计算两个向量的余弦相似度。"""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
