"""TaskManager：按 run id 跟踪局部 run 的后台任务。

关键回归点：同项目下的多个局部 run 必须能**并行**。
旧实现按 project_id 存单槽位且 register 时主动 cancel 旧任务，
于是「重绘角色 A 后重绘角色 B」会静默取消 A，而 A 的 AgentRun 行
仍留在 running —— 前端永远等一个不会结束的运行。
"""

from __future__ import annotations

import asyncio

import pytest

from app.services.task_manager import TaskManager


def _pending_task() -> asyncio.Task[None]:
    async def coro() -> None:
        await asyncio.sleep(100)

    return asyncio.create_task(coro())


@pytest.mark.asyncio
async def test_register_keys_by_run_id():
    mgr = TaskManager()
    task = _pending_task()
    await asyncio.sleep(0)
    mgr.register(7, 100, task)

    assert mgr.is_running(7) is True
    assert mgr.is_running(8) is False
    task.cancel()


@pytest.mark.asyncio
async def test_parallel_runs_on_same_project_do_not_cancel_each_other():
    """回归守卫：同项目两个 run 各自独立，后者登记不得取消前者。"""
    mgr = TaskManager()
    first = _pending_task()
    await asyncio.sleep(0)
    mgr.register(1, 100, first)

    second = _pending_task()
    await asyncio.sleep(0)
    mgr.register(2, 100, second)

    await asyncio.sleep(0)
    assert first.cancelled() is False, "登记第二个 run 不应取消第一个"
    assert mgr.is_running(1) is True
    assert mgr.is_running(2) is True
    assert mgr.project_has_running(100) is True

    first.cancel()
    second.cancel()


@pytest.mark.asyncio
async def test_cancel_targets_only_that_run():
    mgr = TaskManager()
    first = _pending_task()
    second = _pending_task()
    await asyncio.sleep(0)
    mgr.register(1, 100, first)
    mgr.register(2, 100, second)

    assert mgr.cancel(1) is True
    await asyncio.sleep(0)
    assert first.cancelling() > 0 or first.done()
    assert second.cancelled() is False
    second.cancel()


@pytest.mark.asyncio
async def test_cancel_project_cancels_all_runs_of_that_project():
    mgr = TaskManager()
    a = _pending_task()
    b = _pending_task()
    other = _pending_task()
    await asyncio.sleep(0)
    mgr.register(1, 100, a)
    mgr.register(2, 100, b)
    mgr.register(3, 200, other)

    assert mgr.cancel_project(100) == 2
    await asyncio.sleep(0)
    assert a.cancelled() and b.cancelled()
    assert other.cancelled() is False
    other.cancel()


def test_cancel_unknown_run_is_false():
    assert TaskManager().cancel(999) is False


@pytest.mark.asyncio
async def test_completed_task_drops_itself_from_registry():
    mgr = TaskManager()

    async def quick() -> None:
        return None

    task = asyncio.create_task(quick())
    mgr.register(5, 100, task)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert mgr.is_running(5) is False
    assert mgr.cancel(5) is False


@pytest.mark.asyncio
async def test_cancel_returns_false_when_already_done():
    mgr = TaskManager()

    async def quick() -> None:
        return None

    task = asyncio.create_task(quick())
    await task
    mgr.register(1, 100, task)
    assert mgr.cancel(1) is False


@pytest.mark.asyncio
async def test_remove_unregisters_run():
    mgr = TaskManager()
    task = _pending_task()
    await asyncio.sleep(0)
    mgr.register(1, 100, task)
    mgr.remove(1)

    assert mgr.is_running(1) is False
    assert mgr.project_has_running(100) is False
    task.cancel()


def test_remove_and_cancel_of_unknown_ids_do_not_raise():
    mgr = TaskManager()
    mgr.remove(999)
    assert mgr.cancel(999) is False
    assert mgr.project_has_running(999) is False
