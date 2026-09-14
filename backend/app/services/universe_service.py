"""Universe / IP 宇宙服务 — 管理跨项目的共享世界观和角色库。"""

from __future__ import annotations

import logging

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.utils import utcnow
from app.models.universe import Universe, SharedCharacter, UniverseProjectLink
from app.models.project import Character, Project
from app.services.revision import commit_versioned

logger = logging.getLogger(__name__)


class UniverseService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ── Universe CRUD ──────────────────────────────────────────

    async def create_universe(
        self,
        name: str,
        description: str | None = None,
        world_setting: str | None = None,
        style_rules: str | None = None,
        cover_image_url: str | None = None,
    ) -> Universe:
        """创建新 IP 宇宙"""
        universe = Universe(
            name=name,
            description=description,
            world_setting=world_setting,
            style_rules=style_rules,
            cover_image_url=cover_image_url,
        )
        self.session.add(universe)
        await self.session.commit()
        await self.session.refresh(universe)
        return universe

    async def delete_universe(self, universe: Universe) -> bool:
        """删除宇宙（级联删除关联的角色和项目链接，清除项目的外键引用）"""
        from app.models.project import Project
        # 清除关联 project 的 universe_id
        result = await self.session.execute(
            select(Project).where(Project.universe_id == universe.id)
        )
        for project in result.scalars().all():
            project.universe_id = None
            project.chapter_number = None
            project.chapter_title = None
            self.session.add(project)

        # 软删除共享角色
        result2 = await self.session.execute(
            select(SharedCharacter).where(SharedCharacter.universe_id == universe.id)
        )
        for sc in result2.scalars().all():
            sc.is_active = False
            self.session.add(sc)

        # 软删除 universe
        universe.is_active = False
        self.session.add(universe)
        await commit_versioned(self.session, universe, entity="project")
        return True

    async def list_universes(self) -> list[Universe]:
        """列出所有宇宙"""
        result = await self.session.execute(
            select(Universe)
            .where(Universe.is_active == True)  # noqa: E712
            .order_by(Universe.updated_at.desc())
        )
        return list(result.scalars().all())

    async def update_universe(self, universe: Universe, **kwargs) -> Universe:
        """更新宇宙"""
        for k, v in kwargs.items():
            if hasattr(universe, k):
                setattr(universe, k, v)
        universe.updated_at = utcnow()
        self.session.add(universe)
        await self.session.commit()
        await self.session.refresh(universe)
        return universe

    # ── Universe-Project 关联 ──────────────────────────────────

    async def add_project_to_universe(
        self,
        universe_id: int,
        project_id: int,
        chapter_number: int | None = None,
        chapter_title: str | None = None,
        is_main_story: bool = True,
    ) -> UniverseProjectLink:
        """将项目加入宇宙"""
        # 检查是否已存在关联
        existing = await self.session.execute(
            select(UniverseProjectLink).where(
                UniverseProjectLink.universe_id == universe_id,
                UniverseProjectLink.project_id == project_id,
            )
        )
        link = existing.scalars().first()
        if link:
            # 已存在，更新字段
            if chapter_number is not None:
                link.chapter_number = chapter_number
            if chapter_title is not None:
                link.chapter_title = chapter_title
            link.is_main_story = is_main_story
            self.session.add(link)
            await self.session.commit()
            await self.session.refresh(link)
            return link

        link = UniverseProjectLink(
            universe_id=universe_id,
            project_id=project_id,
            chapter_number=chapter_number,
            chapter_title=chapter_title,
            is_main_story=is_main_story,
        )
        self.session.add(link)

        # 同时更新 project 的 universe_id
        project = await self.session.get(Project, project_id)
        if project:
            project.universe_id = universe_id
            if chapter_number is not None:
                project.chapter_number = chapter_number
            if chapter_title is not None:
                project.chapter_title = chapter_title
            self.session.add(project)

        await commit_versioned(self.session, project, entity="project")
        await self.session.refresh(link)
        return link

    async def remove_project_from_universe(
        self, universe_id: int, project_id: int
    ) -> bool:
        """从宇宙中移除项目"""
        result = await self.session.execute(
            delete(UniverseProjectLink).where(
                UniverseProjectLink.universe_id == universe_id,
                UniverseProjectLink.project_id == project_id,
            )
        )
        # 同时清除 project 的 universe_id
        project = await self.session.get(Project, project_id)
        if project and project.universe_id == universe_id:
            project.universe_id = None
            project.chapter_number = None
            project.chapter_title = None
            self.session.add(project)

        await commit_versioned(self.session, project, entity="project")
        return result.rowcount > 0  # type: ignore[no-any-return]

    # ── 共享角色 ──────────────────────────────────────────────

    async def promote_character_to_shared(
        self, character_id: int, universe_id: int
    ) -> SharedCharacter:
        """将项目角色提升为宇宙共享角色"""
        character = await self.session.get(Character, character_id)
        if not character:
            raise ValueError(f"Character {character_id} not found")

        # 检查是否已存在同源共享角色
        existing = await self.session.execute(
            select(SharedCharacter).where(
                SharedCharacter.universe_id == universe_id,
                SharedCharacter.source_character_id == character_id,
                SharedCharacter.source_project_id == character.project_id,
            )
        )
        existing_sc = existing.scalars().first()
        if existing_sc:
            # 更新现有共享角色
            existing_sc.name = character.name
            existing_sc.description = character.description
            existing_sc.visual_notes = character.visual_notes
            existing_sc.face_embedding = character.face_embedding
            existing_sc.canonical_image_url = character.image_url
            existing_sc.reference_images = list(character.reference_images or [])
            existing_sc.version += 1
            existing_sc.updated_at = utcnow()
            self.session.add(existing_sc)
            await self.session.commit()
            await self.session.refresh(existing_sc)
            return existing_sc

        shared_char = SharedCharacter(
            universe_id=universe_id,
            name=character.name,
            description=character.description,
            visual_notes=character.visual_notes,
            face_embedding=character.face_embedding,
            canonical_image_url=character.image_url,
            reference_images=list(character.reference_images or []),
            source_project_id=character.project_id,
            source_character_id=character.id,
            version=1,
        )
        self.session.add(shared_char)
        await self.session.commit()
        await self.session.refresh(shared_char)
        return shared_char

    async def import_shared_character_to_project(
        self, shared_character_id: int, project_id: int
    ) -> Character:
        """将共享角色导入项目"""
        shared_char = await self.session.get(SharedCharacter, shared_character_id)
        if not shared_char:
            raise ValueError(f"SharedCharacter {shared_character_id} not found")

        # 检查项目内是否已有同名角色
        existing = await self.session.execute(
            select(Character).where(
                Character.project_id == project_id,
                Character.name == shared_char.name,
            )
        )
        existing_char = existing.scalars().first()
        if existing_char:
            # 更新现有角色
            existing_char.description = shared_char.description
            existing_char.visual_notes = shared_char.visual_notes
            existing_char.face_embedding = shared_char.face_embedding
            existing_char.image_url = shared_char.canonical_image_url
            existing_char.reference_images = list(shared_char.reference_images or [])
            self.session.add(existing_char)
            await commit_versioned(self.session, existing_char, entity="character")
            await self.session.refresh(existing_char)
            return existing_char

        character = Character(
            project_id=project_id,
            name=shared_char.name,
            description=shared_char.description,
            visual_notes=shared_char.visual_notes,
            face_embedding=shared_char.face_embedding,
            image_url=shared_char.canonical_image_url,
            reference_images=list(shared_char.reference_images or []),
        )
        self.session.add(character)
        await self.session.commit()
        await self.session.refresh(character)
        return character

    async def sync_character_back(self, character_id: int) -> SharedCharacter | None:
        """将项目中的角色变更同步回共享角色"""
        character = await self.session.get(Character, character_id)
        if not character:
            return None

        # 查找该角色来源的共享角色
        result = await self.session.execute(
            select(SharedCharacter).where(
                SharedCharacter.source_character_id == character_id,
                SharedCharacter.source_project_id == character.project_id,
            )
        )
        shared_char = result.scalars().first()
        if not shared_char:
            return None

        shared_char.name = character.name
        shared_char.description = character.description
        shared_char.visual_notes = character.visual_notes
        shared_char.face_embedding = character.face_embedding
        shared_char.canonical_image_url = character.image_url
        shared_char.reference_images = list(character.reference_images or [])
        shared_char.version += 1
        shared_char.updated_at = utcnow()
        self.session.add(shared_char)
        await self.session.commit()
        await self.session.refresh(shared_char)
        return shared_char

    # ── 查询 ──────────────────────────────────────────────────

    async def get_universe_chapters(
        self, universe_id: int
    ) -> list[UniverseProjectLink]:
        """获取宇宙下的所有章节（按 chapter_number 排序）"""
        result = await self.session.execute(
            select(UniverseProjectLink)
            .where(UniverseProjectLink.universe_id == universe_id)
            .order_by(
                UniverseProjectLink.is_main_story.desc(),
                UniverseProjectLink.chapter_number.asc().nulls_last(),
            )
        )
        return list(result.scalars().all())

    async def get_universe_shared_characters(
        self, universe_id: int
    ) -> list[SharedCharacter]:
        """获取宇宙的所有共享角色"""
        result = await self.session.execute(
            select(SharedCharacter)
            .where(
                SharedCharacter.universe_id == universe_id,
                SharedCharacter.is_active == True,  # noqa: E712
            )
            .order_by(SharedCharacter.name)
        )
        return list(result.scalars().all())

    async def auto_import_shared_characters(
        self,
        project_id: int,
        *,
        mode: str = "all",
    ) -> list[Character]:
        """自动将宇宙共享角色导入项目。

        mode:
          - "all": 导入全部尚未存在的共享角色（章节默认）
          - "hints": 仅导入 character_hints 中点名的角色
        """
        project = await self.session.get(Project, project_id)
        if not project or not project.universe_id:
            return []

        shared_chars = await self.get_universe_shared_characters(project.universe_id)
        if not shared_chars:
            return []

        existing_result = await self.session.execute(
            select(Character).where(Character.project_id == project_id)
        )
        existing_chars = list(existing_result.scalars().all())
        existing_names = {c.name for c in existing_chars}

        imported: list[Character] = []
        hints = [h.strip() for h in (project.character_hints or []) if isinstance(h, str) and h.strip()]
        hint_names = set(hints)

        for sc in shared_chars:
            if sc.name in existing_names:
                continue
            if mode == "hints":
                if sc.name not in hint_names:
                    continue
            # mode == "all" (default): import every missing shared character
            assert sc.id is not None
            char = await self.import_shared_character_to_project(sc.id, project_id)
            imported.append(char)
            existing_names.add(sc.name)

        return imported

    async def get_sibling_chapter_summaries(
        self, universe_id: int, *, exclude_project_id: int | None = None, limit: int = 8
    ) -> list[dict]:
        """Prior chapters for continuity injection into outline/plan."""
        links = await self.get_universe_chapters(universe_id)
        summaries: list[dict] = []
        for link in links:
            if exclude_project_id is not None and link.project_id == exclude_project_id:
                continue
            project = await self.session.get(Project, link.project_id)
            if project is None:
                continue
            summaries.append(
                {
                    "project_id": project.id,
                    "chapter_number": link.chapter_number or project.chapter_number,
                    "chapter_title": link.chapter_title or project.chapter_title or project.title,
                    "title": project.title,
                    "summary": project.summary,
                    "status": project.status,
                    "is_main_story": link.is_main_story,
                }
            )
            if len(summaries) >= limit:
                break
        return summaries
