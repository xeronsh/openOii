# openOii

<div align="center">
  <img src="./doc/logo.png?v=2" width="180" alt="openOii logo" />

  <p><strong>故事想法 → 多智能体协作 → 漫剧成片</strong></p>
  <p>一个以 pi-agent-core 编排为核心的 AI 漫剧生成学习项目。</p>

  <p>
    <img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.10+" />
    <img src="https://img.shields.io/badge/FastAPI-0.115+-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
    <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=111827" alt="React 18" />
    <img src="https://img.shields.io/badge/pi--agent--core-Orchestration-6D28D9?style=flat-square" alt="pi-agent-core" />
  </p>

  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#界面预览">界面预览</a> ·
    <a href="#技术栈">技术栈</a>
  </p>
</div>

## ☁️ 赞助商 · Bloome

<table>
  <tr>
    <td align="center" width="58%" valign="top">
      <a href="https://bloome.im/app?ref=Xeron2000&utm_medium=github&utm_source=Xeron2000-openOii-ivor-202607">
        <img src="./doc/Bloome.png" alt="Bloome — 加速世界向人机协作团队转型" width="100%" />
      </a>
    </td>
    <td width="42%" valign="middle">
      <p>也在研究像 <strong>openOii</strong> 这样的多智能体流水线？</p>
      <p>
        <a href="https://bloome.im/app?ref=Xeron2000&utm_medium=github&utm_source=Xeron2000-openOii-ivor-202607"><strong>Bloome</strong></a>
        让 Claude、ChatGPT、DeepSeek 等多个 AI 在同一对话里协作——互相质疑、交叉核对、一起把结果打磨到位。
      </p>
      <ul>
        <li>零配置，云端即用</li>
        <li>网页与移动端均可使用</li>
        <li>配置好的 Agent 可分享给团队</li>
      </ul>
      <p><strong>👉 <a href="https://bloome.im/app?ref=Xeron2000&utm_medium=github&utm_source=Xeron2000-openOii-ivor-202607">免费试用 Bloome</a></strong></p>
    </td>
  </tr>
</table>

openOii 把故事创意串成 **规划、角色/分镜生成、视频生成与合成** 的完整链路，并用无限画布展示过程与结果。

> [!WARNING]
> 这是一个 **多阶段编排学习 / 演示项目**（pi-agent-core sidecar + 共享 SQLite），重点是验证多阶段编排、恢复执行、实时进度与前后端协作。
> **不适合直接用于工业生产环境**。

## 你能看到什么

- 多阶段 AI 生成链路
- WebSocket 实时进度
- 可恢复 / 可取消 / 可反馈的 run 流程
- tldraw 无限画布审阅角色、分镜与结果
- 前端环境变量配置面板

## 界面预览

<table>
  <tr>
    <td align="center" width="50%">
      <img src="./doc/screenshot-home.png" alt="openOii 首页" />
      <br />
      <sub><strong>首页 · 故事输入与风格选择</strong></sub>
    </td>
    <td align="center" width="50%">
      <img src="./doc/screenshot-canvas.png" alt="openOii 画布与生成流程" />
      <br />
      <sub><strong>画布 · 角色、分镜与生成流程</strong></sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="./doc/screenshot-config.png" alt="openOii 配置面板" />
      <br />
      <sub><strong>配置面板 · 在线管理模型与基础服务</strong></sub>
    </td>
  </tr>
</table>

## 技术栈

- Frontend: React 18 + TypeScript + tldraw
- Backend: FastAPI + SQLModel（HTTP/WS/静态/配置/导出）
- Engine: pi-agent-core sidecar（Node/TS，loopback 18766，拥有 17 阶段状态机与 6 闸门）
- Infra: 单文件 SQLite（WAL）+ `/static`

## 快速开始

```bash
cp backend/.env.example backend/.env
docker-compose up -d
```

- Frontend: http://localhost:15173
- API Docs: http://localhost:18765/docs

本地开发：

```bash
# backend
cd backend
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 18765

# frontend
cd frontend
pnpm install
pnpm dev
```

## 常用命令

```bash
# backend
cd backend
uv run pytest
uv run ruff check app tests

# frontend
cd frontend
pnpm test
pnpm build
```

## License

MIT
