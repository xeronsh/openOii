# Engine Capability Matrix

Phase A audit for `refactor/pi-only-simplification`. `✓` means implemented in the runtime, `△` means partial, and `✗` means missing. “Python” includes surviving API/helper code; that code does not make FastAPI an orchestration runtime.

| Capability | Python | Engine | Required |
| --- | --- | --- | --- |
| Outline | — | ✓ | ✓ |
| Character planning | — | ✓ | ✓ |
| Shot planning | — | ✓ | ✓ |
| Character rendering | — | ✓ | ✓ |
| Shot rendering | — | ✓ | ✓ |
| Critique | — | ✓ | ✓ |
| Video generation and merge | — | ✓ | ✓ |
| Style template resolution | helper only | ✓ | ✓ |
| Character bible prompt context | helper only | ✓ | ✓ |
| Character identity lock | helper only | ✓ | ✓ |
| Face embedding compute/store in render; similarity lookup API | shared helper + manual API | ✓ | ✓ |
| Auto-populate missing visual notes | helper only | ✓ | ✓ |
| Character reference montage for shot rendering | shared helper | ✓ | ✓ |
| Configured I2V modes / nine-grid reference | shared helper | ✓ | ✓ |
| TTS, BGM, and final re-merge after audio | shared helper | ✓ | ✓ |
| Targeted character rerender | durable scope in `patch_plan` | ✓ | ✓ |
| Targeted shot rerender | durable scope in `patch_plan` | ✓ | ✓ |
| Provider cancellation propagation | API forwards command | ✓ | ✓ |
| Crash resume | API hydrates run state | ✓ | ✓ |

The Python `RenderAgent`, `ComposeAgent`, `agent_runner`, `LocalRunSpec.agent_plan`, and `task_manager` have already been removed. Engine fills missing visual notes, extracts/stores face embeddings, composes character references for shot images, honors configured first-frame/reference video modes, and processes TTS/BGM before the final merge.

Engine streams requests through one `engine_media_cli` worker per stage. The worker reuses the existing ImageComposer, AudioService, and `compute_face_embedding_from_bytes` helpers; Engine owns invocation timing and persists outputs under its lease/CAS. Similarity lookup remains a product API query.

Feedback routes persist only the classified start stage and selected entity scope. Engine derives downstream invalidation, reloads the scope on start or resume, and passes target ids to `PipelineRunner`, so a selected character or shot reaches the targeted stage path after crashes too.
