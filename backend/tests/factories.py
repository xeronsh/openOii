from __future__ import annotations

from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.utils import utcnow
from app.models.agent_run import AgentMessage, AgentRun
from app.models.config_item import ConfigItem
from app.models.message import Message
from app.models.project import Character, Project, Shot


async def create_project(
    session: AsyncSession,
    title: str = "Test Project",
    story: str = "Test story",
    style: str = "anime",
    status: str = "draft",
    text_provider_override: str | None = None,
    image_provider_override: str | None = None,
    video_provider_override: str | None = None,
) -> Project:
    project = Project(
        title=title,
        story=story,
        style=style,
        status=status,
        text_provider_override=text_provider_override,
        image_provider_override=image_provider_override,
        video_provider_override=video_provider_override,
    )
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return project


async def create_run(
    session: AsyncSession,
    project_id: int,
    status: str = "queued",
    *,
    live_lease: bool | None = None,
) -> AgentRun:
    """Create a run that reflects the canonical durable status model.

    Historical tests used ``paused`` and treated any bare ``running`` row as an
    active executor. Production no longer does either: recoverable runs are
    ``failed``/``cancelled`` and running ownership is proven by a lease. Keep
    those translations in one test factory rather than weakening production.
    """
    canonical_status = "failed" if status == "paused" else status
    if live_lease is None:
        live_lease = canonical_status in {"running", "waiting_for_approval", "cancelling"}

    run = AgentRun(
        project_id=project_id,
        status=canonical_status,
        lease_owner="test-engine" if live_lease else None,
        lease_token=f"test-lease-{project_id}-{id(session)}" if live_lease else None,
        lease_expires_at=utcnow() + timedelta(minutes=5) if live_lease else None,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return run


async def create_message(
    session: AsyncSession,
    run_id: int,
    project_id: int,
    agent: str = "system",
    role: str = "assistant",
    content: str = "Test message",
) -> Message:
    message = Message(
        run_id=run_id,
        project_id=project_id,
        agent=agent,
        role=role,
        content=content,
    )
    session.add(message)
    await session.commit()
    await session.refresh(message)
    return message


async def create_agent_message(
    session: AsyncSession,
    run_id: int,
    content: str = "Test feedback",
) -> AgentMessage:
    msg = AgentMessage(run_id=run_id, agent="user", role="user", content=content)
    session.add(msg)
    await session.commit()
    await session.refresh(msg)
    return msg


async def create_character(
    session: AsyncSession,
    project_id: int,
    name: str = "Test Character",
    description: str = "Test description",
    image_url: str | None = "http://test.com/image.png",
) -> Character:
    character = Character(
        project_id=project_id,
        name=name,
        description=description,
        image_url=image_url,
    )
    session.add(character)
    await session.commit()
    await session.refresh(character)
    return character


async def create_shot(
    session: AsyncSession,
    project_id: int,
    order: int = 1,
    description: str = "Test shot",
    prompt: str = "Test prompt",
    image_url: str | None = "http://test.com/shot.png",
    video_url: str | None = "http://test.com/shot.mp4",
    duration: float = 5.0,
) -> Shot:
    shot = Shot(
        project_id=project_id,
        order=order,
        description=description,
        prompt=prompt,
        image_url=image_url,
        video_url=video_url,
        duration=duration,
    )
    session.add(shot)
    await session.commit()
    await session.refresh(shot)
    return shot


async def create_config_item(
    session: AsyncSession,
    key: str = "TEST_CONFIG_KEY",
    value: str = "test_value",
    is_sensitive: bool = False,
) -> ConfigItem:
    config = ConfigItem(
        key=key,
        value=value,
        is_sensitive=is_sensitive,
    )
    session.add(config)
    await session.commit()
    await session.refresh(config)
    return config
