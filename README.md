# openOii

<div align="center">
  <img src="./doc/logo.png?v=2" width="180" alt="openOii logo" />

  <p><strong>故事想法 → 分阶段生成 → 漫剧成片</strong></p>
  <p>一个基于 <a href="https://github.com/badlogic/pi-mono">pi</a> 的 AI 漫剧生成学习项目：分阶段确定性工作流 + 审批门 + 可以对话的项目助手。</p>

  <p>
    <img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.10+" />
    <img src="https://img.shields.io/badge/FastAPI-0.115+-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
    <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=111827" alt="React 18" />
    <img src="https://img.shields.io/badge/pi-agent--core-6D28D9?style=flat-square" alt="pi-agent-core" />
  </p>


  <p>
    <a href="#功能">功能</a> ·
    <a href="#界面预览">界面预览</a> ·
    <a href="#架构">架构</a> ·
    <a href="#快速开始">快速开始</a>
  </p>
</div>

## ☁️ 赞助商 · Bloome

<table>
  <tr>
    <td align="center" width="58%" valign="top">
      <a href="https://bloome.im/app?utm_medium=github&utm_source=Xeron2000-openOii-ivor-202607">
        <img src="./doc/Bloome.png" alt="Bloome — 加速世界向人机协作团队转型" width="100%" />
      </a>
    </td>
    <td width="42%" valign="middle">
      <p>也在研究像 <strong>openOii</strong> 这样的分阶段 AI 工作流？</p>
      <p>
        <a href="https://bloome.im/app?utm_medium=github&utm_source=Xeron2000-openOii-ivor-202607"><strong>Bloome</strong></a>
        让 Claude、ChatGPT、DeepSeek 等多个 AI 在同一对话里协作——互相质疑、交叉核对、一起把结果打磨到位。
      </p>
      <ul>
        <li>零配置，云端即用</li>
        <li>网页与移动端均可使用</li>
        <li>配置好的 Agent 可分享给团队</li>
      </ul>
      <p><strong>👉 <a href="https://bloome.im/app?utm_medium=github&utm_source=Xeron2000-openOii-ivor-202607">免费试用 Bloome</a></strong></p>
    </td>
  </tr>
</table>

openOii 把一句故事想法变成一部带配音、字幕和背景音乐的漫剧短片：先规划大纲、角色和分镜，再出角色形象和分镜画面，经过质量审查后生成视频并合成成片。整个过程在一块画布上进行，每个阶段都可以停下来确认、修改或重来。

> [!WARNING]
> 这是一个**学习 / 演示项目**，重点是验证阶段编排、审批门、断点恢复、实时进度和对话式操作。**不适合直接用于生产环境。**

## 功能

- **一句话开始创作**：写下故事，选风格、故事宇宙和参考图；「逐步确认」每个阶段等你确认，「自动确认」一口气跑完。
- **15 个阶段、6 个审批门**：大纲 → 角色 → 分镜 → 角色形象 → 分镜画面 → 视频片段 → 成片；可以取消、断点继续，或只重跑受影响的部分。
- **项目助手**：在工作台里直接问进度、让它重画某一镜或改大纲；任何花钱或改动内容的操作都先弹出确认卡片，审批门只能由你本人通过。
- **质量审查**：视觉模型检查角色一致性和画面问题，并用人脸特征比对同一角色，不合格会提示或重画。
- **成片选项**：按项目开关配音、字幕（软字幕 / 烧进画面）和背景音乐，角色可指定音色。
- **服务商预设**：文本、图像、视频、视觉审查、配音、背景音乐都有预设卡片，只需填密钥；每类都有「测试模式（Fake）」，不调外部接口也能跑通。详见 [docs/providers.md](docs/providers.md)。
- **导出与实时进度**：下载成片或导出 Webtoon 长图；WebSocket 推送进度，刷新或断线重连后状态不丢；支持浅色 / 深色主题。

## 界面预览

<table>
  <tr>
    <td align="center" width="50%">
      <img src="./doc/screenshots/home.webp" alt="openOii 首页：写下故事、选择创作模式" />
      <br />
      <sub><strong>首页 · 写下故事，选择逐步确认或自动确认</strong></sub>
    </td>
    <td align="center" width="50%">
      <img src="./doc/screenshots/projects.webp" alt="openOii 项目库" />
      <br />
      <sub><strong>项目库 · 每个项目的状态一目了然</strong></sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="./doc/screenshots/workbench.webp" alt="openOii 工作台：活动记录、分镜画布与检查器" />
      <br />
      <sub><strong>工作台 · 活动记录（含质量审查评分）、分镜画布与检查器</strong></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="./doc/screenshots/production-options.webp" alt="成片选项：配音、字幕、背景音乐" width="260" />
      <br />
      <sub><strong>成片选项 · 配音 / 字幕 / 背景音乐</strong></sub>
    </td>
    <td align="center" width="50%">
      <img src="./doc/screenshots/export-menu.webp" alt="下载成片与导出 Webtoon" />
      <br />
      <sub><strong>导出 · 下载成片、导出 Webtoon、版本对比</strong></sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="./doc/screenshots/settings-video-presets.webp" alt="设置：视频服务商预设" />
      <br />
      <sub><strong>设置 · 视频服务商预设（文本、图像、视觉审查、配音、背景音乐同样有预设）</strong></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="./doc/screenshots/workbench-dark.webp" alt="工作台深色主题" />
      <br />
      <sub><strong>深色主题 · 工作台</strong></sub>
    </td>
    <td align="center" width="50%">
      <img src="./doc/screenshots/home-dark.webp" alt="首页深色主题" />
      <br />
      <sub><strong>深色主题 · 首页</strong></sub>
    </td>
  </tr>
</table>

## 架构

**分阶段工作流 + pi-agent-core 对话助手**，两者共用一个 Node 引擎和一个 SQLite 文件：

- **工作流**（`engine/src/pipeline`）：15 个阶段由状态机按固定顺序执行，每个阶段是一个普通函数——文本阶段用 [pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai) 调用模型并解析结构化输出，图像 / 视频阶段调用各服务商接口，成片由引擎用 FFmpeg 拼接。下一步做什么由状态机决定，不由模型决定。
- **项目助手**（`engine/src/agent`）：基于 [pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent) 的工具调用循环，用已配置的文本模型。它能读取项目和运行状态，也能启动 / 继续 / 停止运行、重画、重新合成和编辑内容，但每个写操作都要你在确认卡片上点「确认」；它没有通过审批门的工具。每个项目一段对话，保存在 SQLite 里。
- **后端**（`backend/`）：FastAPI 只做产品 API、WebSocket 和引擎网关，外加给引擎调用的配音、背景音乐混音、参考图拼图和人脸比对工具。

```text
frontend/ (React + React Flow)  ──HTTP/WS──▶  backend/ (FastAPI 网关)  ──loopback──▶  engine/ (工作流 + 助手)
                                                         └──────── 共享 SQLite（WAL）+ /static 媒体 ────────┘
```

工作流、视觉审查和助手共用 `engine/src/pi-models.ts` 里的一个 pi-ai 模型注册表（`createModels()`），测试模式用其中的 fake 模型。架构约束见 [AGENTS.md](AGENTS.md)，决策记录在 [docs/adr](docs/adr)。

## 快速开始

需要 Python 3.10+ 与 [uv](https://docs.astral.sh/uv/)、Node.js 22.19+ 与 pnpm，以及 FFmpeg。

```bash
cp backend/.env.example backend/.env   # 想先不花钱：TEXT/IMAGE/VIDEO_PROVIDER=fake

# 后端 API（:18765，启动时自动迁移数据库）
cd backend && uv sync && uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 18765

# 引擎（:18766，只监听本机，与后端共用同一个 SQLite 文件）
cd engine && pnpm install && \
ENGINE_DB_PATH=../backend/data/openoii.db ENGINE_BACKEND_DIR=../backend \
ENGINE_STATIC_DIR=../backend/app/static ENGINE_PYTHON=../backend/.venv/bin/python pnpm dev

# 前端（:15173）
cd frontend && pnpm install && pnpm dev
```

打开 http://localhost:15173 ，API 文档在 http://localhost:18765/docs 。也可以 `docker compose up -d`（后端镜像里打包了引擎）。

测试：`backend` 下 `uv run pytest`，`engine` 下 `pnpm test`，`frontend` 下 `pnpm test` / `pnpm e2e`（`pnpm build` 会检查 JS 体积预算）。

## 🙏 致谢

- [Linux.do](https://linux.do/) - 强烈推荐！高质量技术社区，感谢佬友们的公益站和热心支持 ❤️

## License

MIT
