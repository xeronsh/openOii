"""后台任务登记表 —— 按 run id 跟踪可取消的局部 run。

为什么是 run id 而不是 project_id
---------------------------------
`assert_resource_idle` 的锁粒度是 (project, resource_type, resource_id)，
所以同一个项目下**允许**并行多个局部 run（例如同时重绘两个不同角色）。
旧实现按 project_id 存一个槽位，register 时还会主动 cancel 旧任务，
于是「先重绘角色 A，再重绘角色 B」会把 A 悄悄取消掉，
而 A 对应的 AgentRun 行仍留在 running —— 前端永远等一个不会结束的运行。

按 run id 存之后，每个 run 各有一个句柄：
- 取消单个 run：cancel(run_id)
- 取消项目下所有 run：cancel_project(project_id)
- 进程内状态，不跨实例（与既有单 worker 假设一致）
"""

from __future__ import annotations

import asyncio
from typing import Dict, Tuple


class TaskManager:
    """run_id -> task（进程内）。"""

    def __init__(self) -> None:
        self._tasks: Dict[int, Tuple[int, asyncio.Task]] = {}

    def register(self, run_id: int, project_id: int, task: asyncio.Task) -> None:
        """登记一个 run 的任务。**不**取消同项目的其他任务（它们可以并行）。"""
        self._tasks[run_id] = (project_id, task)
        task.add_done_callback(lambda _t: self._tasks.pop(run_id, None))

    def cancel(self, run_id: int) -> bool:
        entry = self._tasks.get(run_id)
        if entry is None:
            return False
        task = entry[1]
        if task.done():
            return False
        task.cancel()
        return True

    def cancel_project(self, project_id: int) -> int:
        """取消该项目下所有局部 run，返回取消个数。"""
        cancelled = 0
        for run_id, (pid, task) in list(self._tasks.items()):
            if pid == project_id and not task.done():
                task.cancel()
                cancelled += 1
        return cancelled

    def remove(self, run_id: int) -> None:
        self._tasks.pop(run_id, None)

    def is_running(self, run_id: int) -> bool:
        entry = self._tasks.get(run_id)
        return entry is not None and not entry[1].done()

    def project_has_running(self, project_id: int) -> bool:
        return any(
            pid == project_id and not task.done() for pid, task in self._tasks.values()
        )


task_manager = TaskManager()
