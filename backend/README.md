# openOii Backend

FastAPI + SQLModel + SQLite(与 pi 引擎共享同一文件)后端。测试使用内存 SQLite。

## Run

```bash
cd backend
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 18765
```

WebSocket: `ws://localhost:18765/ws/projects/{project_id}`

