from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from app.schemas.export import ExportCompletedEventData
from app.schemas.ws import (
    AgentThinkingEventData,
    AudioGeneratedEventData,
    BibleUpdatedEventData,
    CharacterCreatedEventData,
    CharacterDeletedEventData,
    CharacterUpdatedEventData,
    ConsistencyEvalCompletedEventData,
    CritiqueResultEventData,
    DataClearedEventData,
    ErrorEventData,
    ProjectUpdatedEventData,
    OutlineUpdatedEventData,
    RunAwaitingConfirmEventData,
    RunCancelledEventData,
    RunCompletedEventData,
    RunConfirmedEventData,
    RunFailedEventData,
    RunMessageEventData,
    RunProgressEventData,
    RunStartedEventData,
    ShotCreatedEventData,
    ShotDeletedEventData,
    ShotsReorderedEventData,
    ShotUpdatedEventData,
    VersionCreatedEventData,
    VersionRollbackEventData,
    WsEvent,
)


_EVENT_DATA_MODELS: dict[str, type[Any]] = {
    "run_started": RunStartedEventData,
    "run_progress": RunProgressEventData,
    "run_message": RunMessageEventData,
    "run_completed": RunCompletedEventData,
    "run_failed": RunFailedEventData,
    "run_cancelled": RunCancelledEventData,
    "run_awaiting_confirm": RunAwaitingConfirmEventData,
    "run_confirmed": RunConfirmedEventData,
    "character_created": CharacterCreatedEventData,
    "character_updated": CharacterUpdatedEventData,
    "character_deleted": CharacterDeletedEventData,
    "shot_created": ShotCreatedEventData,
    "shot_updated": ShotUpdatedEventData,
    "shots_reordered": ShotsReorderedEventData,
    "shot_deleted": ShotDeletedEventData,
    "outline_updated": OutlineUpdatedEventData,
    "project_updated": ProjectUpdatedEventData,
    "data_cleared": DataClearedEventData,
    "error": ErrorEventData,
    "critique_result": CritiqueResultEventData,
    "bible_updated": BibleUpdatedEventData,
    "agent_thinking": AgentThinkingEventData,
    "audio_generated": AudioGeneratedEventData,
    "version_created": VersionCreatedEventData,
    "version_rollback": VersionRollbackEventData,
    "export_completed": ExportCompletedEventData,
    "consistency_eval_completed": ConsistencyEvalCompletedEventData,
}


class ConnectionManager:
    def __init__(self) -> None:
        self._conns: dict[int, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, project_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._conns[project_id].add(websocket)

    async def disconnect(self, project_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            if project_id in self._conns:
                self._conns[project_id].discard(websocket)
                if not self._conns[project_id]:
                    self._conns.pop(project_id, None)

    @staticmethod
    def _validated_payload(event: dict[str, Any] | WsEvent) -> dict[str, Any]:
        if isinstance(event, dict):
            event = WsEvent.model_validate(event)

        data_model = _EVENT_DATA_MODELS.get(event.type)
        if data_model is not None:
            validated_data = data_model.model_validate(event.data)
            event = WsEvent(type=event.type, data=validated_data.model_dump(mode="json"))
        return event.model_dump()

    async def send_event_to(self, websocket: WebSocket, event: dict[str, Any] | WsEvent) -> None:
        """Validate and send one event to exactly one WebSocket.

        Engine event replay is per connection. Broadcasting a replayed event to
        every project socket causes N tailers × N clients duplicate delivery
        when the same project is open in multiple tabs.
        """
        if websocket.client_state != WebSocketState.CONNECTED:
            return
        await websocket.send_json(self._validated_payload(event))

    async def send_event(self, project_id: int, event: dict[str, Any] | WsEvent) -> None:
        payload = self._validated_payload(event)
        conns = list(self._conns.get(project_id, set()))
        for ws in conns:
            if ws.client_state != WebSocketState.CONNECTED:
                continue
            try:
                await ws.send_json(payload)
            except Exception:
                await self.disconnect(project_id, ws)


ws_manager = ConnectionManager()
