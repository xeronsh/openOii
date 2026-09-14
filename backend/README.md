# openOii Backend

FastAPI + SQLModel + SQLite(与 pi 引擎共享同一文件)后端。测试使用内存 SQLite。

## Run

```bash
cd backend
uv run uvicorn app.main:app --reload
```

WebSocket: `ws://localhost:8000/ws/projects/{project_id}`

