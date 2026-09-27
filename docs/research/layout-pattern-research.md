# 布局范式调研（Layout Pattern Research）

> 目标：为 openOii（故事想法 → AI 漫剧成片）前端重设计提供可落地的布局决策依据。
> 覆盖：Home 创作页 / Projects 项目页 / Universes 宇宙页 / Workbench 无限画布工作区。

## 0. 方法与可信度分级

全部结论来自本轮 TinyFish `search` + `fetch_content` 的真实网络访问，无凭记忆编造。每条结论标注等级：

| 标记 | 含义 |
| --- | --- |
| **【实读·官方】** | 我实际读到官方文档 / 官方博文 / 官方源码原文 |
| **【实读·源码】** | 我实际读到线上 CSS / 常量文件原文 |
| **【实测·第三方】** | 第三方对线上 DOM/CSSOM 的测量结果（非官方），可信度中 |
| **【推断】** | 我的推论，**不是事实**，需自行验证 |

本轮**没有**拿到官方 px 值的产品（下文会明确写出）：Figma、Linear、Notion、World Anvil、Novelcrafter、Sudowrite、Krea、Runway、Midjourney、Miro、n8n、Zapier、GitHub Actions、Vercel、Netlify、Temporal、Prefect。它们的官方文档刻意不公开几何常数。
**唯一拿到硬常量的是 tldraw**（`packages/tldraw/src/lib/ui.css` 原始文件）与 **ComfyUI**（源码常量 + issue 中的运行时数值）。

---

## 1. A 类 — 世界构建 / 叙事资产库

### 1.1 World Anvil 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | **双侧栏**：左 = 世界级工具（图标 rail + 点开后 slide-out 出该工具的条目列表，含搜索框与文件夹组织）；右 = 账户级工具（头像 / world switcher / 通知 / 新闻 / 社区 / Notebook / 帮助 / Learn / Studio）。文字顶部另有一条 top bar 承载社区入口。**没有统一顶栏导航。** |
| 几何 | 官方无 px。左栏底部有一对双箭头（`>>`）做「展开 / 折叠 / 完全关闭」三态；右栏是窄条固定。文章页 = 主文（左+中）+ 右侧栏（窄，右），两者都是**字段驱动且用户可自定义**。 |
| 信息层级 | 全局导航放在**两侧**而不是顶部。主操作是**右下角浮动快捷按钮组**：绿色 `+`（建所有类型内容）、Create（不离开当前页面建文章）、黄色 note、蓝色 todo。另有 `Alt+N` 快捷键建文章。 |
| 次要设置收纳 | 左栏底部 cog 展开（Worldbuilding Meta / Subscribers / World Styling / Advanced Settings / Statistics）；右栏头像菜单（Account / Interface / Features）；`Features` 开关按角色裁剪整个 UI（作者/GM/玩家看到不同工具）——这是**按角色收敛信息密度**的范式。 |
| 进度/状态 | 无流水线。Dashboard 有 quick stats 面板 + 「continue working」面板 + 社区 news。 |
| 空状态/首屏 | 登录落到 **Dashboard**：统计 + 续作入口 + 新闻三块；左下 gear 可自定义这个 dashboard。 |
| 响应式 | 官方只说明左栏可三态开合；**窄屏策略无证据**。【推断】双栏在窄屏会互相挤，实际应退化为右侧栏并入抽屉。 |

### 1.2 Sudowrite — Story Bible 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | 项目内**三栏**：左 = 文档组织（Documents / Folders / Add New / Import）；中 = 编辑器（prose 主写区）；右 = **Chat bar + History**，所有 AI 结果以 **Card** 形式堆在这里。**Toolbar 横跨三栏顶部**，放核心 AI 功能。 |
| 几何 | 官方无 px。 |
| 信息层级 | 主 CTA 在跨栏顶部 Toolbar（First Draft / Write / Rewrite / Quick Edit 等）。上下文动作在卡片自身上（点卡片折叠 / 再点展开）。 |
| 进度/状态 | 无阶段进度。**AI 结果的表达单元是 Card 堆叠**：卡堆顶部是斜体 *Prompt*（生成时考虑的提示），下面是 chiclets 显示「Looked at:」引用到的 Story Bible / 前文上下文，卡身标注功能名。可整体折叠成一张卡。 |
| 空状态/首屏 | 登录落到 **homepage = 全部 Projects 列表**，点进项目才进编辑器。 |
| Story Bible 的位置 | **不是独立页面**，而是挂在左栏文档列表**下方**；开启时其字段渲染在 prose 正文**下方**（persistent：切换文档时字段常驻，只有正文换）。字段按 Braindump → Genre → Style → Synopsis → Characters → Worldbuilding → Outline → Scenes → Draft 的顺序，每段有 Generate / Rewrite 按钮，并显式说明哪一段影响哪一段。 |
| 响应式 | 无证据。 |

### 1.3 Novelcrafter 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | **四区**：① 左 Sidebar（写作工具，可 pin 到工作区；底部放 help / 编辑 prompt / 导出 / sync 指示器）② Novel Navigation（返回库、novel settings、最小化 sidebar）③ Top Navigation（4 个模式 tab：plan / write / chat / review，紧邻 View 选择器与 Filters，最右 Settings）④ Main Panel。 |
| 几何 | 官方无 px。Sidebar 可最小化，可 pin。 |
| 信息层级 | **模式切换是顶层导航**（4 个创作阶段），视图与过滤器降一级。存在通用的 **Actions menu** 范式：「如果主界面里找不到某个按钮，它多半在 action menu 里」——作用于 act/chapter/scene、codex entry、snippet、chat，甚至 write 界面里的 codex progression。 |
| 进度/状态 | Codex 条目 = **固定 header + 变化 contents**。Header（A，恒定）：Codex Type 下拉、Name、Tags/Labels、Thumbnail、**Mentions Tracker**（可视化显示该条目在项目哪些位置被提到，形成"焦点热力图"）。Contents（B，随 tab 变）：Details / Research / Relations / Mentions / Tracking 五个 tab。Details 底部有 wordcount + 版本 history（可恢复快照）+ 快照复制按钮。Tracking tab 控制：按名/别名追踪开关、大小写敏感、排除词表、**AI Context 三态（总是发给 AI / 只在被检出时 / 永不）**。 |
| 空状态 | 无证据。 |
| 响应式 | **【实读·官方】小屏时 Top Navigation 变成下拉菜单。** |

### 1.4 Campfire Write 【实读·官方 / 第三方】

- 骨架：左 sidebar 列**模块**（Characters / Maps / Timeline / Manuscript / Items…），每个模块是「**可移动、可缩放的面板（panels you can move, resize, and modify）**」。【实读·官方 marketing】
- 写作页左侧有 sidebar 可**不离开当前页**快速查阅其他模块的笔记。【实读·第三方 ReedSy 评测】
- 创建入口：左栏模块标题右侧的 `+`。【实读·官方 tutorial】
- Manuscript 模块提供 **index card view**。【实读·官方】
- 三形态：browser / desktop 离线 / mobile app。【实读·官方】

### 1.5 Notion — 数据库视图 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | 左 sidebar（Workspace 树：Recents / Favorites / Teamspaces / Shared / Private）+ 主内容；数据库内部上方是 **view tab 条**（Table / Board / List / Timeline / Calendar / Gallery / Chart / Form）。 |
| 几何 | Sidebar：可拖右边缘改宽；`<<` 折叠/展开；section 标题点击折叠；section 可设「Show 5…all」，超出显示 `More` 打开 **pane**。**第三方实测称 sidebar 固定 224px 宽**（仅搜到摘要，正文被 bot 拦截，**未读到原文** → 记为低置信）。Callout 自定义 icon 理想 280×280；cover 图建议 ≥1500px 宽。 |
| **详情打开策略（最可迁移）** | 每个 view 可设 `Open pages in`：**Side peek**（页面在右侧打开，左侧列表继续可交互）/ **Center peek**（居中 modal）/ **Full page**。官方默认规则：**Table / Board / List / Timeline 默认 side peek；Gallery / Calendar 默认 center peek**。 |
| 信息层级 | 主 CTA = sidebar 顶部 `📝`（新建页，先进 preview 模式再选归属地）；每个 teamspace 与每个 page hover 出 `+`。视图设置收在数据库右上 `⋮⋮` → View settings（Layout / Property visibility / Filter / Sort / Group / **Sub-group**）；搜索框在数据库顶部；`Freeze up to column` 冻结首列。 |
| 进度/状态 | Chart view 可出 bar / line / donut。列表本身无进度条。 |
| 空状态 | 新数据库默认 Table；模板 picker 覆盖 50+ 用途。全页数据库可拖进 sidebar 变内联，反之亦可。 |
| 响应式 | **【实读·官方】屏幕不够宽时，`+ 新建视图` 入口降级为「点当前视图名 → New view」。** |

### 1.6 Obsidian — Canvas + 双栏 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | **左 sidebar + 右 sidebar + 中央 editor**，每个 sidebar 内部是 **tab + tab group**（可在 sidebar 内建多个 tab group，tab 可在 sidebar 与主编辑区之间互拖）。Canvas 是占满主区的独立 view。 |
| 几何 | 官方无 px。Sidebar 宽度需拖拽或装插件设置（社区专门有插件做这件事）。**Ribbon 只在桌面 + 大平板出现**。 |
| 信息层级 | 导航在 Ribbon（竖直图标条）。卡片上下文动作 = 右键菜单 + 选中块上方的浮动 **selection controls**（Set color / Remove / Edit label / Zoom to selection）。缩放控件在**右上角**。 |
| 进度/状态 | 无进度。关系表达靠 **连接线的 label + color + group（框）**；连接线支持「Go to target / Go to source」导航。 |
| 空状态/首屏 | 新建 canvas 的路径：Command palette → `Canvas: Create new canvas` / File explorer 右键 / Ribbon。**空 canvas 底部常驻一排「拖入卡片」入口**：空白文件图标（text card）、文档图标（note card）、图片图标（media card）。也可双击画布直接建 text card。 |
| 响应式 | **【实读·官方】移动端与小平板：sidebar 默认隐藏，靠左右滑动手势、左 expand 图标、或 `Toggle left/right` 命令打开。** 桌面可把 note 拖进 sidebar 常驻。另有社区插件专门做「窗口变窄自动隐藏 sidebars」和「hover 展开 ribbon」——反证官方默认不做自动降级。 |

---

## 2. B 类 — AI 生成工作台 / 画布

### 2.1 Krea Realtime 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | **左右二分，没有第三方栏**：左 = canvas（所有输入发生地），右 = 实时输出面。prompt box 与其下（Image/Video 切换、Draw mode、Aspect ratio、Seed）居中。**左下角** = 模型选择 + 一个「隐藏 canvas 只看结果」的 preview toggle。输出面板**底部** = Upscale / Download。 |
| 几何 | 无 px 界面值。输出语义分辨率 **512px（fast 模型）/ 1024px（quality 模型）**；aspect ratio 只有 3 档：1:1 / 3:2 / 2:3。 |
| 信息层级 | **没有主 CTA**——实时生成，无 render 按钮、无队列。工具是「一次手势」：Select(V) / Brush(B) / Eraser(X) / Circle(C) / Rect(R) / Triangle(T) / Upload(I) / Generate(G)，**全部单键快捷键**。设置按功能分组收在 prompt box 下方，模型选择沉到左下。 |
| 进度/状态 | **没有进度条**——每一笔、每次改 prompt 立即反映在输出上，实时刷新本身就是反馈。 |
| 空状态/首屏 | 从 dashboard 开 Realtime session，界面直接是 split-panel；**不确定起点时用 built-in Examples 一键载入 preset canvas + prompt**（等价「空画布给模板」）。 |
| 响应式 | 无证据。 |

### 2.2 Runway 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | 左 = **全局导航栏**（自上而下：New Session / Home / Agent / Tool / Apps / Workflows / Recents / Projects / Assets / Favorited；有 `Expand sidebar` 按钮）。主区 = Session。**生成内容在 Session 的右侧 pane 按时间顺序堆叠，最新在底、最旧在顶。** |
| 几何 | 无 px。credit 余额 / 邀请 / 支持在**右上角**；profile 菜单在**左下角**。 |
| 信息层级 | Home 首屏 = **顶部大 Agent prompt**（`@` 加 References、`/` 用 Skills）+ 其下 Shortcuts + 三段内容（Presets / New at Runway / Get started with Apps）。次要设置全部沉到左下 profile 菜单（Plans & Billing / Invite / Refer / Upgrade / Switch Workspace）。 |
| 进度/状态 | 无阶段进度；Session 内是**时间序流式堆叠**。 |
| 空状态/首屏 | Home 页即首屏：prompt 置顶 + Presets（**分类顺序按 onboarding 答案个性化，不同成员看到的 Home 不同**）+ 新功能卡片 + App 卡片。 |
| 响应式 | 导航栏可折叠/展开（Expand sidebar）。 |

### 2.3 Midjourney web 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | Create 页：**Imagine bar 在页面顶部**（不是底部），下方是结果网格，一次出 4 张。Organize 页：网格 + 文件夹 / 排序 / 过滤。 |
| 几何 | 无 px。 |
| 信息层级 | 主 CTA = Imagine bar 的发送；**设置收在 Imagine bar 内部的 settings 图标里**（不占独立面板）——这是「把设置塞进主输入条」的极简范式。 |
| 进度/状态 | 生成中出现**百分比进度直到 100%**；无阶段时间线。 |
| 空状态/首屏 | Create 页就是输入条 + 空网格；冷启动靠 Personalization / moodboard。 |
| 响应式 | 移动端用发送按钮替代 Enter。 |

### 2.4 ComfyUI —— 本类最硬的几何证据 【实读·官方 + 源码】

| 维度 | 结论 |
| --- | --- |
| 骨架 | **五区**：① top bar（workflow **tab** 条 + 主菜单 + **右侧 Run/Queue 控制区** + 登录态 + 右侧面板开关）② **left sidebar** = 细竖直图标条 `SideToolbar.vue` + 可 resize 的 `SplitterPanel`（tab: `node-library` / `model-library` / `workflows` / `assets`；新版菜单为 Queue / Nodes / Models / Workflows / Templates）③ center = LiteGraph canvas ④ **right side panel**（`RightSidePanel.vue`）⑤ **bottom panel**（Terminal / Shortcuts）。另有左下 bottom toolbar（Help / Console / Shortcuts / Settings）与右下 canvas 控件（pan/select、minimap、hide-links、fit-view）。 |
| 几何（源码） | 布局由 `LiteGraphCanvasSplitterOverlay.vue` 用 PrimeVue `Splitter` 编排：**主 horizontal splitter 分三块**（first panel 依设置放 sidebar 或 properties；center 放 canvas；last 放另一个），**center 内部再套 vertical splitter** 挂 bottom panel。**splitter 尺寸与可见性持久化到 local storage**，state key：`sidebarStateKey`、`builder-splitter`、`bottom-panel-splitter`。**sidebar 可放到左边或右边**（`Comfy.Sidebar.Location`）。节点字号 **14**、子文本 **12**、group 字体 **24**（官方 theme JSON 常量）。 |
| 信息层级 | 全局动作在 top bar 右侧（Run / Queue）；**上下文属性全在右面板**，并随选中动态开关 tab：有执行错误 → 优先 **Errors**；有选中 → **Parameters**；无选中 → 显示 **Nodes** 列表；单选 → **Info**；**Settings 常驻**。右面板有「Locate Node」把画布聚焦到选中节点。 |
| 进度/状态 | 三处并存：① Queue tab 显示 running / waiting ② **bottom panel 是日志流出**（logging / command terminal）③ 画布上节点级红/黄错误态。**节点图本身就是流水线**，没有额外阶段时间线。 |
| 空状态 | 默认加载 default workflow；Templates tab 给内置模板；`New Workflow` 开新 tab（每个 tab 独立 undo/redo 与状态）。模板选择器是**侧栏 + 过滤 + 搜索 + 卡片**结构，支持按平台/模型兼容性/用途标签/运行时过滤，排序有 popular / newest / alphabetical / model-size / VRAM。 |
| 响应式 | 官方无窄屏策略；提供 **Focus Mode**（主动隐藏菜单与 side panel）。另有 `[data-breakpoints-*]` 类钩子。 |
| 缺陷证据（反面教材） | issue #13068：右侧面板打开后，canvas 的 `width` 属性仍是 960，但 `getBoundingClientRect().width` 变成 480，`DomWidgets.vue` 用错值把 DOM widget 压到 460px。**教训：任何依赖 canvas 渲染尺寸的计算必须用 `getBoundingClientRect()` 并监听 ResizeObserver，不能缓存在打开面板前的值。** |

### 2.5 Figma UI3 + FigJam 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | **五区**：① toolbar（**画布底部**，slim）② navigation bar（**最左竖直 tab 条**：File / Agents / Assets / Tools / Variables，底部挂文件通知与警告）③ left sidebar（内容随 nav tab 变）④ right properties panel ⑤ 可滚动 canvas。属性面板顶部是 tab：编辑权限下 Design / Prototype；只读权限下 Comment / Properties。 |
| 几何 | 官方无 px。只确认 **left sidebar 可拖右边缘改宽**、properties panel 可 resize。 |
| 信息层级（UI3 的设计决策，最可复用） | ① **面板从 floating 改回 fixed**（用户反对 floating 留缝后）② 用**底部 slim toolbar 换掉顶部空间**，形成 Figma 全家族统一结构 ③ **x/y 与 Auto Layout + width/height 合并成单一 layout panel**，但保留 x/y 在上（早期把 w/h 提到 x/y 之前会破坏肌肉记忆，被回退）④ **组件控制（variants / instances）上移到颜色与尺寸之前** ⑤ property labels 可选开关（新手友好 / 老手关闭）。 |
| 次要设置收纳 | 文件级动作在左栏顶部 Figma menu；`Minimize UI`（`Cmd/Ctrl+Shift+\`）**一次折叠 nav + left + right** 三块。 |
| 进度/状态 | 无流水线。AI 能力以 **Actions** 形式嵌入日常动作而非独立面板。 |
| 空状态 | Assets tab 列本地 + 库组件（Grid / List 切换）；Tools tab 列 plugins / widgets / shaders；nav bar 底部集中放「库更新 / 缺字体 / 离线」通知。 |
| 响应式（关键交互） | **【实读·官方】Minimize 状态下选中对象 → 右面板自动展开；取消选中 → 右面板自动收回到 minimize。** |
| 跨产品一致性 | 官方明确：**FigJam / Figma Design / Slides 共用「slim toolbar + 可折叠 floating panel」同一结构**，形成家族一致性。 |

### 2.6 tldraw —— 本类唯一拿到原始 CSS 常量的产品 【实读·源码】

骨架 = 全屏 canvas + **命名 UI zone**：

- `TopPanel`：**顶部居中**（tldraw.com 用它放文档标题）
- `SharePanel`：**右上**，位于 style panel **上方**（分享按钮 + 协作者头像）
- style panel：右上浮动卡
- navigation panel：**左下**（page menu + minimap）
- main toolbar：**底部居中**（horizontal）或**左侧竖直**（vertical）

**Inspector panel 的官方做法**：官方示例里 inspector 是 **`<Tldraw>` 之外的普通 React 组件，作为兄弟节点并排**（flex 两栏），不是覆盖层、不走 portal。编辑器实例由 `onMount` 捕获，再用 `EditorProvider` 包住面板，使 `useEditor()` / `useValue()` 在画布之外可用。

几何常量（`packages/tldraw/src/lib/ui.css` 原文）：

| 项 | 值 |
| --- | --- |
| 间距阶梯 `--tl-space-1..10` | 2 / 4 / 8 / 12 / 16 / 20 / 28 / 32 / 64 / 72 px |
| 圆角阶梯 `--tl-radius-0..4` | 2 / 4 / 6 / 9 / 11 px |
| style panel | **宽 148px**（`width: 148px; max-width: 148px`），外边距 `8px`，`margin-top: 4px` |
| page menu wrapper | **宽 220px**，item 高 **40px**，drag handle **32px** |
| minimap | `width:100%`，**高 96px**（`min-height: 96px`） |
| tool button | **48×48**（移动端横向 **48×43**，icon 16px） |
| toolbar lock button | **40×40** |
| 通用 button | 高 **40px**，`min-width: 40px`，`padding: 0 12px`，`font-size: 12px` |
| menu 最小宽 | medium **144px** / small **96px** / tiny 0 |
| dialog | `min-width: 300px`，`max-height: 80%`，header 高 **40px** |
| input wrapper | 高 **44px** |
| toast | 容器 `min-width: 200px`，主体 `max-width: 280px`，viewport 底部 padding **64px** |
| vertical main toolbar 定位 | `top: 90px`（= page menu + back-to-content 按钮高度）、`bottom: 140px`（= 展开 minimap）；`[data-breakpoints-below*='6']` 时 bottom → **90px** |
| shortcuts 弹窗 | `columns: 3`（平板 2 / 移动 1） |
| 移动端溢出按钮 | **32px**（桌面 40px） |

**z 轴分层（直接抄）**：canvas-background **100** < grid **150** < collaborators **245** < watermark **248** < canvas-in-front **250** = menu-click-capture **250** < **panels 300** < menus **400** < toasts **650** < cursor **700** < header/footer **999** < canvas hit-test blocker **10000**。`.tl-canvas` 用 `contain: strict` 自建独立层叠上下文。

其他可抄细节：上下文工具条 `contextual-toolbar` 用 `opacity 0→1 0.08s` 出现、并在鼠标按下时隐藏；menu 在 `max-height: 600px` 以下限 `max-height: 70vh`；toast 入场 `200ms cubic-bezier(0.785,0.135,0.15,0.86)`。

### 2.7 Miro 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | 无限 board + **环绕式浮动工具栏**：Board menu（左上）、Collaboration tools（右上）、People toolbar（上）、**Creation toolbar（左侧竖直）**、Undo/Redo（Creation toolbar 正下方）、**Navigation toolbar（右下：zoom / Frames / Layers / minimap / 全屏）**。 |
| 几何 | 官方无 px，且官方 FAQ 明确：**工具栏大小只能靠浏览器 zoom 改**；**工具栏不能移动**；**工作时不能隐藏**（只有 presentation mode 才隐藏）；Creation toolbar 能通过隐藏工具变短。 |
| 信息层级 | 主创建动作全在左侧 Creation toolbar，**可拖动排序、可右键 unpin，配置只存本 profile**。视图类开关收进 board menu → View（grid / collaborator cursors / comments / scroll bars / object dimensions / undo-redo 位置）。无障碍开关（precise selection / reduce motion / a11y checker）收进 Accessibility 子菜单。 |
| 进度/状态 | 无；协作能力是 reactions / voting / timer / private mode / notes。 |
| 空状态 | 新 board 即空 board + 工具栏，无引导层。 |
| 响应式 | 无断点文档；touchscreen 不支持工具栏自定义。 |

### 2.8 Playground AI / Freepik AI Suite

**Freepik Spaces** 【实读·第三方评测，官方落地页未逐字读】：浏览器内 **node-based canvas**。术语：**Space = 画布容器，Node = 一个步骤，Connector = 连线，Panel = 选中节点的侧栏**。入口在 AI Suite **左栏 `All tools` tab** 下。新建 Space 时**画布直接给一组起始节点选项**（Find Inspiration / Media / Image Generator / Video Generator / Assistant）——**空画布即模板选择器**。模板库含 Social Content Studio / Storyboard Sketch to Visuals / Character Design / Storyboard to motion 等；`Welcome to Spaces` 模板本身是**交互式教程**（把 onboarding 做成一个可运行工作流）。每个 Image Generator 节点内用下拉切模型。节点 **hover 显示 credit 成本**。多人协作是彩色光标 + 一键邀请。

**Playground AI** 【低置信，仅读到官方 marketing / 博文，无文档】：Smart Layers 把一张图拆成可选中 / 移动 / 缩放 / 旋转 / 删除 / 重写的独立图层。**不给布局结论。**

---

## 3. C 类 — 长任务流水线可视化

### 3.1 Linear 【实读·官方 + 实测·第三方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | 官方称自己为 **inverted L 形全局 chrome**（左 sidebar + 顶部 header）+ 主视图。**View header 四段**：Title（面包屑，React children 可以是任意内容）/ Tabs / Side（右侧图标动作组）/ Subheader（过滤器，非必有）。主视图 display 六种：list / board / timeline / split / fullscreen。项目页 = **Overview + Issues 两个固定 tab**，且可以把自定义 view attach 成额外 tab（可左右拖动排序）。项目详情有**右侧栏**，`Cmd/Ctrl+I` 或侧栏图标切换。 |
| 几何 | 官方无 px。**第三方对线上 CSSOM 的实测**（非官方，中置信）：间距基单位 **4px**，阶梯 **4/8/12/16/20/24/32**（明确禁止 scale 外数值如 10px / 18px）；圆角**只有 4 / 6 / 12 / 9999** 四种；type scale **12/14/16/18/24/32/48/72**；边框 `#2a2e33` 或 `rgba(255,255,255,0.08)`；断点 **<640 / 641–768 / 769–1024 / 1025–1280 / >1280**；触控目标 **≥32×32**、可点元素间距 **≥8px**；marketing 容器 max **1440px**、正文列 ~**1100px**，app 本身 fluid；depth 不用 drop shadow 而用 1px 边框 + inset shadow。另一份 token 集（第三方）给 `--container-max: 1200px`、gutters **24/16/12**、motion **150/200ms**、ease `cubic-bezier(0.2,0,0,1)`、focus ring `0 0 0 2px accent + 0 4px 12px rgba(0,0,0,.1)`。 |
| 信息层级 | 全局导航在左 sidebar；过滤器在 subheader；视图设置收在 **Display options 弹层**；项目进度图收进项目详情右侧栏。**2026 刷新刻意把 sidebar 调暗几个档**，让主内容区（用户工作的地方）优先——官方原话「不要让没赢得注意力的元素争夺注意力」。同时把顶部 tab 改紧凑（不占满整宽、圆角、更小图标与字号），并把图标用量整体削减。 |
| 进度/状态 | 项目进度用 **progress graph**（放在项目详情侧栏）；状态用**色块 + 图标**表达而不是进度条；列表行内联状态图标。 |
| 响应式（最精巧的一点） | ① **不依赖断点**：header 右侧动作区用 `ResponsiveSlot` + `ResponsiveSlotContainer`，通过 **ResizeObserver** 测量可用宽度，按 **priority** 动态隐藏低优先级槽位（隐藏 = 渲染 `null`）。② Tabs 溢出时隐藏多余 tab，出现一个 popover 按钮；**触发按钮显示隐藏数量，但如果当前激活 tab 正好被隐藏，则改为显示该 tab 的名字**。③ 窄屏时 Tabs 换行；<640px 导航折叠成汉堡，**主 CTA 保持可见**。④ 官方自陈这套机制「有点过度工程」，且部分用例因缺 `min-width: 0` 实际未生效。 |

### 3.2 Vercel / Netlify 部署流水线 【实读·官方】

| 产品 | 结论 |
| --- | --- |
| Vercel 骨架 | Project → Deployments 列表 → Deployment Details。详情页主区是日志；**侧栏有 Resources tab**（Middleware matchers / Static Assets 文件与大小 / Functions 类型-runtime-size-regions）；**Deployment Summary 是详情页上一个可展开区块，位置在日志上方**。 |
| Vercel 进度呈现 | **纯流式文本日志**（log stream），不是时间线也不是节点图。**warning 黄 / error 红**做语义着色。日志支持行锚点链接（`#L6` 单行、`#L6-L9` 区间，Shift 点时间戳选择区间），**链接功能只对 ≤2000 行的日志有效**；日志总大小超 **4MB 自动截断**。摘要字段含 build time、detected framework。 |
| Netlify 骨架 | deploy detail page：**Deploy Summary 置于 deploy log 之上**。 |
| Netlify 摘要内容 | 上传到 CDN 的文件数、site headers / redirects 状态、deployed functions 与 edge functions 数量；若这批文件已被同 commit 的前次 deploy 上传过也会提示。成功的 deploy，其日志高亮会被抽取进 summary。 |
| Netlify 日志交互 | 行号锚点（`#L5-L10`）+ `Copy to clipboard`；2026 changelog：**log streaming 改成更小批次、更低延迟**。失败 deploy 提供 AI 诊断建议。 |

**范式要点**：**「摘要在上、日志在下、日志可锚点分享」**是部署类流水线的稳定结构；进度表达是「流式文本 + 颜色语义」，不是图形。

### 3.3 GitHub Actions workflow run 【实读·官方】

- 骨架：workflow run 页 = **左侧栏列 jobs**（`Jobs` 分组下逐个 job）+ 主区**实时 graph**。
- 进度呈现：**每个 job 是图上一个节点，job 名左侧图标表示状态，节点之间的连线表示依赖关系。** 点 job 进该 job 的日志，**step 可展开**看细节。
- 范式要点：**同一页并存两种粒度视图**——graph 给「全局在跑什么、卡在哪」，日志给「这一步具体输出了什么」。没有百分比进度条。

### 3.4 Temporal Web UI 【实读·官方】

| 维度 | 结论 |
| --- | --- |
| 骨架 | 左 section = **Namespaces 列表**；**右上角** = namespace switcher；主区 = workflow executions 表格（可按 Status / Workflow ID / Type / Start / End / 任意 Search Attribute 列）。可选时间格式 UTC / Local / Relative。详情页顶部 = 元数据块（Start/Close/Duration、Run ID、Workflow Type、Task Queue、Parent 与 Parent ID、SDK、State Transitions、Billable Actions）+ Input/Results；其下 **History tab 四视图：Timeline / All / Compact / JSON**。另有 Relationships（父子树）、Workers、Pending Activities、Call Stack、Queries、Metadata。 |
| 几何 | 无 px。 |
| 信息层级 | Timeline 是 **accordion，可关闭**，且**开关状态按设备持久化**。Saved Views 存在浏览器本地（每人私有，上限 20 个，名字 ≤255 字符）。 |
| 进度呈现（**本报告最有价值的一段**） | Timeline 用开源库 **vis-timeline** 实现，配自定义 HTML 模板 + Svelte。关键设计：① **Event Group 折叠**——`ActivityTaskScheduled` + `ActivityTaskStarted` + `ActivityTaskCompleted` 三个事件合成**一行**，跨度即该 activity 的时长；② 单点事件（Marker、Signal）画成**点**；③ **颜色编码结果**（绿 = Completed，红 = Failed）；④ **位置编码并行**（同时发生的事件在垂直方向并列，一眼看出并发）；⑤ retry 的 activity 显示**重试图标 + 当前 attempt 号**；⑥ **第一行固定是 Workflow Execution 本身**，给整体时长参照；⑦ 交互 = 垂直滚事件 + 水平滚时间 + `±` 缩放 + **Fit** 复位 + 按 Event Type 过滤；⑧ **限制最大缩小幅度**，官方原话「don't get lost in the sea of time」。 |

### 3.5 Prefect 【实读·官方，但 UI 细节薄】

- Flow runs 列表页 + flow run 详情；**详情页用 tabs 分视图**（tasks / logs / artifacts）。
- Prefect 3 卖点含「real-time flow run monitoring, logging, and state tracking」以及**自动生成依赖图/DAG**——「just run your flow and open the UI」。
- 用户反馈（GitHub issue #18142 + 社区）：**「新 flow run UI 很挤，以前能在 tabs 里分别选 tasks / logs / artifacts」**——即 tab 化分视图被合并成单页后引发抱怨。反向证据：**多视图 tab 化优于把一切塞进一屏**。
- 社区仍在求 Gantt 式 idle-time 可视化（说明官方 Timeline 能力弱于 Temporal）。
- 【低置信】我尝试读的 `docs.prefect.io/v3/how-to-guides/cloud/ui` 被重定向到 get-started，**未读到 UI 结构原文**。

### 3.6 n8n 【实读·第三方 / 官方 issue】

| 维度 | 结论 |
| --- | --- |
| 骨架 | **左侧 Node Panel**（4 个 tab：Nodes 搜节点 / Templates 现成工作流 / …）+ **中央 canvas** + **底部 Execution Panel**（执行历史 + 调试数据）+ **右上 Settings**（workflow 设置、分享、版本历史）。节点配置用 **NDV（node detail panel）叠在 canvas 上**，双击节点打开；新版在试验「点画布右侧 sidebar 图标，不离开 canvas 就能编辑节点」。 |
| 几何 | 官方无 px。**issue #21768 是关键证据**：n8n Cloud 上 NDV 是「standard, narrower width」，自托管某版本回归成「几乎全屏宽，几乎没有空白画布可点击关闭」。→ 说明 **NDV 有明确的目标宽度约束，且「留出足够空白画布以便点外部关闭」是硬需求**。 |
| 信息层级 | 主创建入口**三条等价路径**：右上 `+` / 节点旁 `+` / `Tab` 键搜索。快捷键体系完整：Tab 开节点搜索、Ctrl+S 保存、Ctrl+Enter 执行、Ctrl+Shift+S 加 Sticky Note。 |
| 进度/状态 | 底部 Execution Panel 管执行历史与调试；画布上节点级状态；执行日志流出。 |
| 空状态 | Templates tab 起步。 |
| 响应式 | 社区在提「进编辑器时默认收起 sidebar，好让出画布」——反证默认展开会挤。 |

### 3.7 Zapier 【低置信】

- Zap editor 用**视觉画布**展示每一步，可在画布上直接打开并编辑任意 step。
- **步骤编辑面板有两种布局（horizontal / vertical tabs）可切换**，社区里有人明确偏好 horizontal（不必上下滚）。
- 【低置信】只读到搜索摘要与一篇第三方博客摘要，**未读到官方文档原文**。

---

## 4. 横向对比表

### 4.1 骨架

| 产品 | 骨架 | Inspector 形态 |
| --- | --- | --- |
| World Anvil | 左工具栏 + 右账户栏 + 中内容（双侧栏） | 文章右侧栏（字段驱动） |
| Sudowrite | 三栏（文档 / 正文 / Chat+History）+ 跨栏顶栏 | 右栏 Card 堆叠 |
| Novelcrafter | 左工具栏 + Novel Nav + Top Nav（4 模式）+ 主面板 | Codex 内 tab |
| Campfire | 左模块栏 + 可移动可缩放面板 | 面板本身 |
| Notion | 左 sidebar + 主区 + 视图 tab 条 | **Side peek 右栏 / Center peek / Full page 三选一** |
| Obsidian | 左 sidebar + 中央 editor + 右 sidebar（tab group） | 右 sidebar tab |
| Krea Realtime | **左右二分**（输入 canvas / 实时输出） | 无 |
| Runway | 左全局导航 + 主 Session（右侧时间序堆叠） | 无 |
| Midjourney | 顶部 Imagine bar + 结果网格 | Imagine bar 内嵌设置 |
| ComfyUI | top bar + 左图标条/面板 + canvas + 右属性面板 + bottom panel | **右面板按选中动态开 tab** |
| Figma UI3 | nav bar + left sidebar + canvas + right panel + **底部 toolbar** | 右面板（Design/Prototype 或 Comment/Properties） |
| tldraw | 全屏 canvas + 5 个浮动 zone | **画布之外的兄弟 React 组件（真两栏）** |
| Miro | 无限 board + 环绕浮动工具栏（左创建 / 右下导航 / 左上板菜单） | 无 |
| Linear | inverted L（左 sidebar + 顶 header）+ 主视图 + 可选右详情栏 | 右详情栏（`Cmd/Ctrl+I` 切换） |
| Vercel | 主日志区 + 右 Resources 侧栏 + 顶部可展开 Summary | 右栏 |
| GitHub Actions | 左 job 列表 + 主 run graph | 点击 job 进日志 |
| Temporal | 左 Namespace + 右 namespace switcher + 主表格 → 详情 = 元数据 + History tabs | Timeline accordion |
| n8n | 左 Node Panel + canvas + 底 Execution Panel | NDV 叠在 canvas 上 |

### 4.2 进度/状态呈现形式

| 形式 | 产品 | 适用 |
| --- | --- | --- |
| **流式文本日志** | Vercel、Netlify、ComfyUI bottom panel、n8n Execution Panel | 细节、可锚点分享、可报错着色 |
| **实时节点图** | GitHub Actions、ComfyUI canvas、Prefect DAG | 全局拓扑 + 依赖 + 并行 |
| **一行一阶段时间线（vis-timeline 式）** | Temporal（唯一做透的） | 长任务、有并发、有 retry、需看时长分布 |
| **节点图 + 日志双视图并存** | GitHub Actions、Temporal、Vercel | **最佳实践：两种粒度同页** |
| **百分比进度条** | Midjourney（0→100%） | 单一不可切分任务 |
| **实时刷新（无进度）** | Krea Realtime | 亚秒级反馈回路 |
| **时间序流式堆叠** | Runway Session | 迭代产物累积 |
| **图/表视图切换** | Notion Chart、Linear progress graph | 聚合指标 |

---

## 5. 空状态与首屏（汇总）

| 产品 | 首屏 / 空态做法 |
| --- | --- |
| World Anvil | 落 Dashboard：quick stats + continue working + 社区 news；可自定义 |
| Sudowrite | 落 Projects 列表页 |
| Runway | Home = 顶部大 prompt + Presets（按 onboarding 答案个性化）+ 新功能卡 + App 卡 |
| Midjourney | Create 页 = 输入条 + 空网格；moodboard 冷启动 |
| Krea | split-panel 就绪 + **built-in Examples 一键载入 preset canvas + prompt** |
| Freepik Spaces | **新 Space 直接在画布上给一组起始节点选项**；Welcome 模板 = 交互式教程 |
| Obsidian Canvas | 空 canvas **底部常驻一排「拖入卡片」入口**；也可双击画布建卡 |
| ComfyUI | 默认加载 default workflow；Templates tab；模板选择器 = 侧栏 + 过滤 + 搜索 + 卡片 |
| Figma | Assets / Tools tab 直接给可拖入画布的组件与插件 |
| Notion | 新库默认 Table；50+ 用途模板 picker |
| Miro | 无引导层，纯空白 board |
| n8n | Templates tab |
| Linear | 无官方文案实读 |

---

## 6. 响应式降级策略

| 产品 | 策略 | 等级 |
| --- | --- | --- |
| Linear | **不用断点**：ResizeObserver + priority 槽位动态隐藏 header 次要动作；tabs 溢出进 popover 且激活 tab 以文字留在外面；<640px 导航折叠成汉堡、主 CTA 保留 | 【实读·官方/第三方】 |
| Figma | **选中即展开右面板、取消选中即收起**（minimize 模式下）；`Cmd/Ctrl+Shift+\` 一键折叠 nav+左+右 | 【实读·官方】 |
| Obsidian | 移动端/小平板 sidebar 默认隐藏，左右滑动手势 + expand 图标 + 命令召回；桌面可把 note 拖进 sidebar 常驻 | 【实读·官方】 |
| World Anvil | 左栏双箭头三态（展开/折叠/完全关闭）；窄屏靠关左栏腾位 | 【实读·官方】 |
| Novelcrafter | 小屏 Top Navigation 变下拉菜单 | 【实读·官方】 |
| Notion | 不够宽时「`+` 新建视图」降级为「点当前视图名 → New view」 | 【实读·官方】 |
| ComfyUI | Focus Mode 主动隐藏菜单 + side panel；有 breakpoint 钩子类 | 【实读·官方】 |
| tldraw | `.tlui-layout__mobile` 变体；工具栏 overflow 按钮（40px→移动 32px）；vertical toolbar 底部偏移从 140px 收到 90px；shortcuts 弹窗列数 3→2→1 | 【实读·源码】 |
| Runway | 导航栏可 Expand/collapse | 【实读·官方】 |
| Miro | 官方明确：工具栏不能移动、工作时不能隐藏、大小只能靠浏览器 zoom 改（**反面教材**） | 【实读·官方】 |

**归纳的降级顺序**（多数产品一致）：① 先收 header 上的次要图标动作 → ② 把 sidebar 折成 icon rail 或整条隐藏（以手势/按钮召回）→ ③ 才动主画布；**主 CTA 永不消失**。

---

## 7. 可迁移的布局范式清单（12 条，可直接落代码）

1. **Workbench 用四段式骨架：`icon rail(48px) + 可折叠内容栏(240–280px) + 主画布(1fr) + 可切换检查器(280–320px)`**，rail 只放图标、内容栏可拖拽改宽、检查器可整条关闭。——证据：ComfyUI（`SideToolbar.vue` + 可 resize `SplitterPanel`）、Figma（navigation bar + left sidebar 两段拆分）、World Anvil（左 icon rail + slide-out 菜单）。
2. **检查器默认收起；选中对象自动展开，取消选中自动收起。** 这比给一个开关按钮更省画布。——证据：Figma 官方 help（minimize 状态下选中展开右栏、deselect 收回）。
3. **检查器 = 固定 header + tab 切换 contents**：header 放不随 tab 变化的对象身份（类型 / 名称 / 别名 / 缩略图 / 出现位置热力条），tab 放 Details / Relations / Tracking / Mentions。——证据：Novelcrafter Codex Entry（header A 恒定 + contents B 随 tab 变）、ComfyUI `RightSidePanel`（Errors / Parameters / Nodes / Info / Settings 按选中动态开关）。
4. **画布工具栏放底部居中的 slim 浮动条，配单键快捷键（V/B/X/G…），把顶部整条让给标题与工作流 tab。** ——证据：Figma UI3（底部 slim toolbar 是本次重设计核心决策）、tldraw（`main-toolbar` 底部居中，tool button 48×48）、Krea Realtime（全套单键快捷键）。
5. **所有浮动面板统一几何：外边距 8px、圆角 9–12px、一层柔和 shadow；用对角锚点分位——左下导航/缩放、右上分享/样式、顶部居中标题、底部居中工具栏。** ——证据：tldraw `style-panel__wrapper{margin:8px; margin-top:4px; border-radius: var(--tl-radius-3)=9px}` + `TopPanel`/`SharePanel` zone 定义。
6. **间距与圆角收敛成小阶梯并禁止阶梯外数值：间距 4/8/12/16/20/24/32，圆角 4/6/12/9999，字号 12/14/16/18/24/32。** ——证据：Linear 官方 do/don't（明确「不要引入 4px scale 之外的 10px / 18px」）+ Linear 实测 token 表 + tldraw `--tl-space-*` / `--tl-radius-*` 阶梯。
7. **长流水线必须同时给「图」和「日志」两种粒度视图，同页切换。** 图回答「卡在哪一步」，日志回答「那一步输出了什么」。——证据：GitHub Actions workflow run（左 job 列表 + 右实时 graph + 点 job 展开 step 日志）、Temporal（Timeline / All / Compact / JSON 四视图）、Vercel（Deploy Summary + Deploy Log）、Netlify（Summary 在上、Log 在下）。
8. **17 阶段进度用「一行一阶段」的时间线：把同阶段的多个事件折叠成一根跨度条，颜色编码成败、垂直位置编码并行、第一行放整体时长，并提供 ±缩放 / Fit / 按类型过滤。** ——证据：Temporal Timeline（vis-timeline；group 折叠 scheduled+started+completed；绿 Completed / 红 Failed；retry 带 attempt 号；Fit 按钮；限制最大缩小幅度）。
9. **列表行与按钮统一 40px 高基线，菜单最小宽 144px（compact 96px），弹窗 header 40px，输入框 44px，触控目标 ≥32×32。** ——证据：tldraw ui.css 常量（button 40px / menu group medium 144px、small 96px / dialog header 40px / input wrapper 44px）+ Linear 触控目标 ≥32px。
10. **空画布与空列表不留白：把模板 / 起始节点作为一等公民摆上画布。** ——证据：Freepik Spaces（新建 Space 直接在画布给起始节点选项 + 模板库 + Welcome 交互式教程）、Obsidian Canvas（空 canvas 底部一排拖入卡片入口）、Krea Realtime（built-in Examples 载入 preset canvas + prompt）、ComfyUI（默认加载 default workflow + Templates tab）。
11. **用 ResizeObserver + 优先级槽位代替媒体查询来挤掉次要动作**：每个槽位声明 priority，空间不足时按优先级隐藏低优先项，隐藏项进 popover，且**当前激活项要以外显文字标签留在外面**。——证据：Linear `ResponsiveSlot` / `ResponsiveSlotContainer`（priority + ResizeObserver，非 breakpoint；官方还自陈部分用例因缺 `min-width: 0` 未生效，实现时注意）。
12. **窄屏降级顺序固定为：header 次要动作 → sidebar 折成 rail 或整条隐藏（手势/按钮召回）→ 最后才动主画布；主 CTA 永不消失；并把分栏宽度与面板开关持久化到 localStorage（key 按区域命名）。** ——证据：Linear（<640px 导航折叠、CTA 保留）、Obsidian（移动端 sidebar 默认隐藏 + 滑动召回）、Figma（一键折叠三块 UI）、ComfyUI（`sidebarStateKey` / `builder-splitter` / `bottom-panel-splitter` 持久化 + tab 会话恢复）、Temporal（Timeline accordion 开关按设备持久化）。

**两条例外/反面教材**：Miro 官方明确「工具栏不能移动、工作时不能隐藏、大小只能靠浏览器 zoom 改」，是移动端与窄屏的死角；ComfyUI issue #13068 说明**任何依赖 canvas 渲染尺寸的计算必须走 `getBoundingClientRect()` + ResizeObserver，绝不能缓存面板打开前的值**。

---

## 8. 来源清单（本轮实际访问的 URL）

### A 类
- https://www.worldanvil.com/learn/interface/interface-guide 【实读】
- https://www.worldanvil.com/learn/article-guides/anatomy-article 【实读】
- https://www.worldanvil.com/learn/beginner-tutorials/get-started-ui 【实读】
- https://docs.sudowrite.com/getting-started/dQph1snuwbfMWG9wRjsNug/interface/ubBg2ZEoAwasV98E3ZBwjn 【实读】
- https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC 【实读】
- https://www.novelcrafter.com/help/docs/app/app-layout 【实读】
- https://www.novelcrafter.com/help/docs/codex/anatomy-codex-entry 【实读】
- https://campfirewriting.com/write 【实读·官方 marketing】
- https://reedsy.com/blog/guide/book-writing-software/campfire-write-review/ 【实读·第三方，仅摘要】
- https://www.notion.com/help/views-filters-and-sorts 【实读】
- https://www.notion.com/help/galleries 【实读】
- https://www.notion.com/help/navigate-with-the-sidebar 【实读】
- https://www.notion.com/help/customize-and-style-your-content 【实读】
- https://obsidian.md/help/sidebar 【实读】
- https://obsidian.md/help/plugins/canvas 【实读】

### B 类
- https://www.krea.ai/docs/realtime 【实读】
- https://help.runwayml.com/hc/en-us/articles/24298206897043-Navigating-Runway 【实读】
- https://docs.midjourney.com/hc/en-us/articles/33329261836941-Getting-Started-Guide 【实读】
- https://deepwiki.com/Comfy-Org/ComfyUI_frontend/4.5-sidebar-and-panel-system 【实读·源码衍生】
- https://deepwiki.com/Comfy-Org/ComfyUI_frontend/4.4-layout-and-responsive-design 【实读·源码衍生】
- https://docs.comfy.org/interface/overview 【实读】
- https://docs.comfy.org/interface/appearance 【实读】
- https://github.com/Comfy-Org/ComfyUI_frontend/issues/13068 【实读】
- https://comfyui-wiki.com/en/interface/basic 【实读·第三方】
- https://www.earngenix.com/tutorials/comfyui-interface-overview 【实读·第三方】
- https://www.figma.com/blog/behind-our-redesign-ui3/ 【实读】
- https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar 【实读】
- https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar 【实读】
- https://raw.githubusercontent.com/tldraw/tldraw/main/packages/tldraw/src/lib/ui.css 【实读·源码，本报告几何常量主来源】
- https://deepwiki.com/tldraw/tldraw/3.3-css-theming-and-custom-properties 【实读·源码衍生，token 阶梯与 z-index 表】
- https://deepwiki.com/tldraw/tldraw/3.1-editor-and-ui-components 【实读·源码衍生】
- https://tldraw.dev/examples/inspector-panel 【实读】
- https://tldraw.dev/examples/zones 【实读】
- https://help.miro.com/hc/en-us/articles/360017730553-Toolbars 【实读】
- https://kingy.ai/news/freepik-spaces-freepik-lists-review-the-bulk-creative-production-tool-agencies-have-been-waiting-for/ 【实读·第三方】

### C 类
- https://linear.app/now/how-we-redesigned-the-linear-ui 【实读】
- https://linear.app/now/behind-the-latest-design-refresh 【实读】
- https://linear.app/docs/projects 【实读】
- https://pustelto.com/blog/reverse-engineer-linear-1-header/ 【实读·第三方逆向】
- https://designmd.cc/benchmarks/linear 【实测·第三方 CSSOM】
- https://open-design.ai/plugins/design-system-linear-app/ 【实测·第三方 token】
- https://vercel.com/docs/deployments 【实读】
- https://vercel.com/docs/deployments/logs 【实读】
- https://docs.netlify.com/deploy/deploy-overview/ 【实读】
- https://www.netlify.com/changelog/2026-04-06-deploy-logs-streaming-is-now-faster/ 【实读·仅摘要】
- https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph 【实读】
- https://docs.github.com/en/actions/get-started/quickstart 【实读】
- https://docs.temporal.io/web-ui 【实读】
- https://temporal.io/blog/lets-visualize-a-workflow 【实读，Timeline 实现细节主来源】
- https://docs.prefect.io/v3/get-started 【实读，UI 细节薄】
- https://github.com/PrefectHQ/prefect/issues/18142 【实读·仅摘要】
- https://n8nmarkets.com/fi/learn-automation/1/2 【实读·第三方】
- https://github.com/n8n-io/n8n/issues/21768 【实读】
- https://community.n8n.io/t/help-us-test-some-canvas-improvements/201703 【实读·仅摘要】
- https://zapier.com/blog/zapier-canvas-guide/ 【实读·仅摘要，低置信】
- https://www.xray.tech/post/zapier-visual-editor 【实读·仅摘要，低置信】

### 访问失败 / 被拦截（因此相关结论缺失或降级）
- `medium.com`（Notion sidebar 224px 正文）→ bot_blocked，仅得摘要
- `uxdesign.cc` Figma UI3 浮动面板文章 → bot_blocked
- `docs.figma.com/en/figma-design/explore-the-interface` → 404
- `github.blog/changelog/2024-01-23-new-workflow-run-page/` → 404
- `help.runwayml.com/.../Generating-with-Sessions` → 404
- `docs.github.com/.../view-job-execution-and-logs` → 404
- `docs.prefect.io/v3/how-to-guides/cloud/ui` → 重定向到 get-started
- `raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/src/constants/core.ts` → 404（未取到 sidebar 宽度常量）
- `medium.com/@turagsarkar/n8n-interface-tour…` → bot_blocked

---

## 9. 明确未验证 / 低置信清单（不要当事实用）

1. **Notion sidebar = 224px** —— 仅来自被拦截文章的搜索摘要，未读到原文。
2. **Figma / Linear / World Anvil / Novelcrafter / Sudowrite / Krea / Runway / Midjourney / Miro / n8n / Temporal / Prefect / Vercel / Netlify / GitHub Actions 的面板像素宽度** —— **全部没有官方数值**。本报告中出现的 Linear 数字（4px 基单位、断点、radius）来自第三方对线上 CSSOM 的测量，非官方 token。
3. **Prefect flow run 页的具体布局** —— 只读到功能描述与用户抱怨，未读到 UI 结构原文。
4. **Zapier / Playground AI** —— 仅摘要级证据，不足以给结论。
5. **所有「窄屏时哪个面板先消失」的通用排序** —— 除 Linear / Obsidian / Figma / Novelcrafter / Notion / tldraw 有官方或源码证据外，其余为我的归纳【推断】。
6. **Freepik Spaces 的几何** —— 只读到第三方评测，官方落地页未逐字读。
