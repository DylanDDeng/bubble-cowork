# WorkAny 预览能力实现分析（HTML / 文档 / PPTX）

本文基于当前仓库代码，对「HTML 代码预览」「文档预览（DOCX / PDF / Markdown 等）」「PPTX 预览」的实现链路做一次偏源码级的梳理，方便后续排查/扩展。

涉及的核心模块：

- 前端（React）：`src/`
- 本地 API（Node + Hono）：`src-api/`
- 桌面壳（Tauri）：`src-tauri/`

---

## 1. 总体链路：文件如何变成“可预览”的 Artifact

### 1.1 Artifact 的数据结构

统一的数据结构在 `src/components/artifacts/types.ts`：

- `ArtifactType`：`html | document | presentation | pdf | ...`
- `Artifact`：`{ id, name, type, content?, path?, ... }`

这个结构把“预览所需信息”归一化成两类：

- **文本类**：依赖 `content`（例如 `html/markdown/json/code/text/csv`）
- **二进制/复杂格式**：依赖 `path`（例如 `pdf/docx/pptx/xlsx/image/audio/video/font`），由专用组件再去读文件并解析/渲染

### 1.2 Artifact 从哪里来（两条来源）

在 `src/app/pages/TaskDetail.tsx` 中构建当前任务的 `artifacts` 列表（简化描述）：

1. 从 Agent 的 `Write` 工具消息提取（带 `file_path` + `content`）：`TaskDetail.tsx` 内 `loadArtifacts()`。
2. 从数据库 `files` 表加载（Tauri SQLite / Web IndexedDB）：`src/shared/db/database.ts` + `getFilesByTaskId()`。
3. “补充兜底”：从文本消息/工具输出里用正则扫出 `*.pptx|*.xlsx|*.docx|*.pdf` 路径，生成只带 `path` 的 artifact（用于让用户点击预览）。

右侧面板同样会在 `src/components/task/RightSidebar.tsx` 里做一份 `Write` 工具的 artifacts 提取（有一定重复），并额外提供“工作目录文件树”的点击预览能力。

### 1.3 工作目录文件树：如何按文件类型决定“读 content 还是只传 path”

`RightSidebar.tsx` 里 `FileTreeItem.handleClick()` 的逻辑是预览体系的关键入口：

1. 通过扩展名映射到 `ArtifactType`（`getArtifactTypeByExt()`）。
2. **对 `SKIP_CONTENT_TYPES`（二进制/流式类型）直接返回 `{type, path}`**，不去读文件内容：
   - `image/pdf/spreadsheet/presentation/document/audio/video/font`
3. 对文本类文件：
   - 先调用 API `POST /files/stat` 拿 size（`MAX_TEXT_FILE_SIZE = 10MB`）
   - 再调用 API `POST /files/read` 读 UTF-8 文本
   - 构造 `{type, path, content}` 传给 `onSelectArtifact`
4. 用 `AbortController` 取消上一次读取，避免频繁切换文件时的竞态/卡顿。

相关 API 在 `src-api/src/app/api/files.ts`：

- `POST /files/readdir`：递归列目录（带忽略规则，避免 `node_modules/dist/.git` 等）
- `POST /files/stat`：exists/size/mtime
- `POST /files/read`：读取文本（带 home 目录安全限制）
- `POST /files/open`：系统默认程序打开文件
- `POST /files/open-in-editor`：优先 Cursor/VSCode 等打开代码文件

---

## 2. HTML 代码预览：Static Preview vs Live Preview

HTML 预览的主入口是 `src/components/artifacts/ArtifactPreview.tsx`。

### 2.1 预览 UI：Preview / Code 两种 ViewMode

`ArtifactPreview.tsx` 里有两层开关：

- `viewMode`: `preview | code`
- 对 HTML 额外有：`previewMode`: `static | live`

“代码视图”使用 `src/components/artifacts/CodePreview.tsx`：

- `react-syntax-highlighter` + Prism 主题
- `getLanguageHint()`（`src/components/artifacts/utils.ts`）根据扩展名做语法高亮语言提示

### 2.2 Static Preview：Blob + iframe（并内联 CSS/JS）

当满足：

- `artifact.type === 'html'`
- `viewMode === 'preview'`
- `previewMode === 'static'`
- 且 `artifact.content` 存在

会走静态预览：

1. `inlineAssets(html, allArtifacts)`：在 `src/components/artifacts/utils.ts`
   - 用正则匹配并替换：
     - `<link ... href="xxx.css">` -> `<style>...css内容...</style>`
     - `<script src="xxx.js"></script>` -> `<script>...js内容...</script>`
   - 只对“相对路径/本地文件名”生效；`http(s)://` 或 `//` 资源不内联。
2. `new Blob([enhancedHtml], { type: 'text/html' })`
3. `URL.createObjectURL(blob)` 得到 `iframeSrc`
4. `<iframe src={iframeSrc} sandbox="allow-scripts allow-same-origin" />`
5. `useEffect` cleanup：`URL.revokeObjectURL(iframeSrc)`，避免内存泄漏

重要的限制点（源码决定的行为）：

- 只内联 CSS/JS；**图片/字体等相对资源**在 static 模式下通常无法加载（因为没有 HTTP server 去 serve 相对路径）。
- 内联查找的范围仅限 `allArtifacts`（即 `TaskDetail.tsx` 当前维护的 artifacts 列表），并不会自动从“工作目录文件树”里把相关 CSS/JS 都读出来；因此 static 模式对“整目录的多文件项目”支持有限，更多依赖 Live Preview。
- `sandbox` 允许脚本执行（`allow-scripts`），同时允许同源（`allow-same-origin`）。这提升了兼容性，但也意味着预览的 HTML/JS 具备较高能力；实际使用中要依赖“内容来源可信”这一前提。

### 2.3 Live Preview：启动 Vite Dev Server（带 HMR）

Live Preview 的目标是解决：

- 相对资源加载问题
- 多文件联动/热更新
- 更接近真实 Web 项目运行环境

#### 2.3.1 前端触发链路

1. `ArtifactPreview.tsx` 启动时会请求：
   - `GET /preview/node-available`（`src-api/src/app/api/preview.ts`）
   - 只有 `available === true`（系统安装了 Node + npm）才允许显示 Live 开关
2. 用户切换到 Live：
   - `TaskDetail.tsx` 调用 `useVitePreview().startPreview(workingDir)`
   - 发起 `POST /preview/start { taskId, workDir }`
3. `useVitePreview`（`src/shared/hooks/useVitePreview.ts`）：
   - 将状态置为 `starting`
   - 如果服务端返回仍是 `starting`，每 2 秒轮询 `GET /preview/status/:taskId`
4. UI 使用 `src/components/task/VitePreview.tsx`：
   - 用 `<iframe src={previewUrl} />` 展示 Vite dev server
   - 提供 refresh/stop/open external 等控制

#### 2.3.2 API/服务端：PreviewManager 如何“零配置”把目录跑起来

核心实现：`src-api/src/shared/services/preview.ts`。

关键点：

- Node 可用性检测：`isNodeAvailable()` 通过执行 `node --version` 和 `npm --version` 判断。
- 端口管理：
  - 默认范围 `5173 ~ 5273`
  - 最多并发 `MAX_CONCURRENT_PREVIEWS = 5`
  - 空闲 30 分钟自动停（`IDLE_TIMEOUT_MS = 30min`）
  - 10 秒一次健康检查（`HEALTH_CHECK_INTERVAL_MS = 10s`）
- “零配置项目文件”自动补齐（`ensureProjectFiles()`）：
  - 若 `package.json` 不存在，写入一个最小 `DEFAULT_PACKAGE_JSON`（只含 `vite` devDependency，且把 vite pin 到 `~5.4.0`）
  - 强制写 `vite.config.js`（并删除可能冲突的 `vite.config.ts/mts/mjs`）
  - 若缺少 `index.html`：
    - 若目录里找到任意 `*.html`，自动生成一个 `index.html` 做 meta refresh 跳转
- 依赖安装：
  - 若 `node_modules/.bin/vite` 不存在，则在 `workDir` 下执行 `npm install`（2 分钟超时）
- 启动方式：
  - 优先 `node node_modules/vite/bin/vite.js`
  - 兜底 `npx vite`
- 启动就绪判断：轮询 `http://localhost:${port}`，**返回 200 或 404 都认为 server ready**（404 代表 server 已跑但没有入口文件）。

#### 2.3.3 生产/开发端口与 sidecar

前端 API 地址：`src/config/index.ts`

- dev：`http://localhost:2026`
- prod：`http://localhost:2620`

Tauri 侧在生产环境会 spawn 打包后的 API sidecar（`src-tauri/src/lib.rs`）：

- 端口：2620
- 退出时清理 sidecar 进程，并尝试按端口 kill 残留

---

## 3. 文档预览：DOCX / PDF / Markdown（以及共用策略）

### 3.1 共用策略：本地文件优先走 Tauri FS，远程 URL 走 fetch

多数二进制预览组件都遵循同一套策略（见 `src/components/artifacts/*.tsx`）：

- 如果 `artifact.path` 是 `http(s)://` 或 `//`（`isRemoteUrl()`）：
  - 直接 `fetch(url)` 获取 `arrayBuffer/blob`
- 否则：
  - 用 `@tauri-apps/plugin-fs`：
    - `stat(path)` 取大小
    - `readFile(path)` 读内容

并统一做了本地文件大小限制：`MAX_PREVIEW_SIZE = 50MB`（`src/components/artifacts/utils.ts`）。

超过限制会走 `FileTooLarge` 组件，提示用户用外部应用打开。

### 3.2 PDF：直接 iframe 交给内置 PDF Viewer

实现：`src/components/artifacts/PdfPreview.tsx`

- 本地：`readFile(path)` -> `new Blob([data], { type: 'application/pdf' })`
- 远程：`fetch(url).blob()`
- `URL.createObjectURL(blob)` 得到 `pdfUrl`
- `<iframe src={pdfUrl} />` 进行渲染

这意味着 PDF 渲染质量/能力取决于 WebView/浏览器内置 PDF 查看器，而不是项目自己实现的 PDF 解析。

### 3.3 DOCX：JSZip 解包 + 解析 `word/document.xml` 的段落文本

实现：`src/components/artifacts/DocxPreview.tsx`

流程：

1. 读取文件为 `ArrayBuffer`
2. `JSZip.loadAsync(arrayBuffer)` 解包
3. 读取 `word/document.xml`（字符串）
4. `DOMParser` 解析 XML
5. 遍历段落节点：
   - `w:p`：段落
   - `w:t`：文本 run
   - `w:pStyle`：样式名，用于粗略判断标题（heading/title/h1/h2…）
   - `w:rPr`：粗体/斜体（注意：这里是“段落级”粗略判断，并不精确到每个 run）
6. 渲染：
   - 标题映射为 `<h1~h4>`
   - 普通段落映射为 `<p>`

局限性（由实现方式决定）：

- 不支持表格、图片、复杂排版、页眉页脚等；只抽取了文本段落。
- `.doc`（旧二进制格式）会解析失败：因为它不是 zip 容器。

### 3.4 Markdown：ReactMarkdown + frontmatter 展示

实现：`ArtifactPreview.tsx` 内部的 Markdown 分支（`ReactMarkdown` + `remark-gfm`）。

补充能力：

- `parseFrontmatter()`（`src/components/artifacts/utils.ts`）对 `--- ... ---` YAML frontmatter 做了一个简化解析
- 若 frontmatter 存在，会先渲染成一个 key/value 表格，再渲染正文 Markdown

---

## 4. PPTX 预览：JSZip 解包 + slide XML + rels 图片关联（“结构化摘要式预览”）

实现：`src/components/artifacts/PptxPreview.tsx`

整体思路不是“高保真渲染 PowerPoint”，而是：

- 尝试提取每页的关键文本
- 尝试找出每页引用的图片（只展示一张代表图）
- 用一个 16:9 的容器做“幻灯片式浏览”

### 4.1 解析流程

1. 读取 PPTX 为 `ArrayBuffer`
2. `JSZip.loadAsync(arrayBuffer)` 解包
3. 扫描 `ppt/media/*`：
   - 每个 media 文件解成 `Blob`
   - `URL.createObjectURL(blob)` 得到本地可用的图片 URL
   - 建立 `fileName -> blobUrl` 映射（`newImageUrls`）
4. 从 `ppt/slides/slide{n}.xml` 按序读取每一页：
   - `DOMParser` 解析 slide XML
   - 抽取 `a:t` 文本，第一段作为 `title`，其余作为 `content[]`
5. 读取 `ppt/slides/_rels/slide{n}.xml.rels`：
   - 找 `Relationship`，若 `Type` 包含 `image` 且 `Target` 指向 `media/xxx`
   - 用 `xxx` 去映射到第 3 步的 `blobUrl`
6. 得到 `PptxSlide[]`：
   - `{ index, title, content, imageUrl? }`
7. 渲染：
   - 有 `imageUrl`：展示图片（object-contain）+ 底部渐变标题栏
   - 无 `imageUrl`：纯文本版式
   - 底部缩略图条用于切页
8. 组件卸载时统一 `revokeObjectURL` 清理图片 blob URL

### 4.2 局限性与预期

这种实现的特点是“轻量、跨平台、依赖少”，但也天然有局限：

- 不能还原 PPT 的布局、字号、形状、动画；更多是“内容摘要式”预览。
- 一页可能有多张图片/图表，当前实现通常只取其中一张（取决于 rels 遍历顺序）。
- `.ppt`（旧二进制格式）无法按该方案解析，会失败并提示用外部 PowerPoint 打开。

---

## 5. 扩展点：如果要新增一种文件预览

通常需要改动 3 个位置：

1. **类型识别**：
   - `src/components/task/RightSidebar.tsx`：`getArtifactTypeByExt()` + `SKIP_CONTENT_TYPES`
   - `src/app/pages/TaskDetail.tsx`：`getArtifactTypeFromExt()`（避免 artifacts 列表里类型不一致）
2. **预览组件**：
   - 在 `src/components/artifacts/` 新增 `XxxPreview.tsx`
   - 在 `ArtifactPreview.tsx` 的 `PreviewContent` 分支中挂载
3. **读取策略**：
   - 文本类：走 `/files/read`
   - 二进制类：走 Tauri `readFile` 或者考虑补上 `/files/read-binary` 的前端使用（目前 API 已实现但前端未用）

---

## 6. 一句话结论

- HTML：static=Blob+iframe（可内联 CSS/JS），live=API 启动 Vite dev server（HMR、资源可用性更强）
- DOCX/PPTX：前端用 JSZip 解包并做“内容抽取式”渲染（非高保真）
- PDF：Blob URL + iframe，交给内置 PDF viewer
