# 1peng

**AI 桌面聊天助手** — 自动检测未读消息、智能分析对话、生成回复并发送。

支持微信、企业微信、钉钉、飞书、Slack、Telegram 等主流桌面聊天应用。引擎启动后自动扫描联系人列表中的小红点，逐一点击进入聊天窗口，分析对话内容后生成自然回复，直到所有未读消息全部处理完毕。

## 核心特性

**圆形红点检测** — 使用 BFS 洪水填充连通域分析，精准识别联系人列表中的标准圆形小红点（通知标记）。通过宽高比、填充率、直径范围、圆度四重校验，避免误触非通知元素。检测到红点后自动点击切换到对应聊天窗口。

**左右气泡结构验证** — 进入聊天窗口后，通过像素采样分析确认当前对话是否为真实的左右双向聊天结构（左侧对方消息、右侧我的消息）。自动跳过公众号、文件传输助手等非对话场景。

**不回复名单** — 支持配置不需要自动回复的联系人名单。通过 Tesseract OCR 从聊天截图顶部提取当前联系人名称，与名单匹配后自动跳过，继续消灭下一个小红点。

**多模型 Provider** — 内置 DeepSeek、MiniMax、小米 MiMo、豆包 Seed 四个大模型 Provider，可自由切换。Provider 架构支持通过 `manifest.json` 声明式接入新模型。

**Obsidian 知识库（RAG）** — 可指定本地 Obsidian Vault 路径，模型生成回复时会检索相关笔记作为上下文，让回复更贴合你的知识体系。

**延迟回复** — 生成回复后等待指定秒数再发送，模拟真人思考节奏，避免秒回显得过于机械。

## 下载安装

前往 [Releases](https://github.com/letoneroc-maker/IMagent/releases) 页面下载最新安装包：

- **Windows** — `1peng-1.0.0-setup.exe`
- **macOS** — `1peng-1.0.0.dmg`

## 技术栈

- **Electron** + **React** + **TypeScript**
- **electron-vite** 构建系统
- **Tesseract.js** OCR 引擎（中文 + 英文）
- **Jimp** 图像处理
- **AI SDK** (@ai-sdk/openai) 兼容 OpenAI 协议的模型调用

## 快速开始

### 安装依赖

```bash
npm install
```

### 本地开发

```bash
npm run dev
```

启动后，应用会打开主界面。按以下步骤配置：

1. 选择目标聊天应用（微信/钉钉/飞书等）
2. 点击"框选区域"，依次圈出联系人列表、聊天内容区、输入框
3. 选择一个 Provider 并填写对应的 API Key
4. 点击"启动"开始运行

### 构建安装包

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## 配置说明

### API 密钥与模型

在 Provider 列表中选择一个模型（DeepSeek / MiniMax / 小米 / 豆包），填入对应的 API Key 和接口地址。系统提示词可自定义，用于指导模型如何生成回复。

### 不回复名单

在高级设置中填写不需要自动回复的联系人名字，每行一个。引擎检测到小红点后，会先通过 OCR 识别当前聊天联系人，如果在名单中则跳过，不做回复。

### Obsidian 知识库

填写本地 Obsidian Vault 的文件夹路径。模型在生成回复前会搜索 Vault 中的相关笔记，作为参考上下文注入 Prompt。

### 框选模式

对于钉钉、飞书、Slack 等非微信应用，需要手动框选三个区域：

- **联系人列表** — 左侧的聊天列表区域
- **聊天内容区** — 中间的对话消息区域
- **输入框** — 底部的消息输入框

框选结果会按应用类型保存到本地，下次启动自动复用。

## 工作流程

```
启动引擎
  │
  ├─ 框选/VLM 识别聊天窗口布局
  │
  ├─ 扫描联系人列表 → 发现圆形小红点？
  │     ├─ 否 → 等待轮询
  │     └─ 是 → 点击红点，进入聊天窗口
  │
  ├─ 验证左右气泡结构 → 是真实对话？
  │     ├─ 否 → 跳过，返回扫描
  │     └─ 是 → 继续
  │
  ├─ OCR 提取联系人名称 → 在不回复名单中？
  │     ├─ 是 → 跳过，返回扫描
  │     └─ 否 → 继续
  │
  ├─ 截图发给 Provider → 模型生成回复
  │
  ├─ 延迟等待 → 粘贴并发送回复
  │
  └─ 返回扫描下一个小红点，直到全部消灭
```

## Provider 接入

每个 Provider 是一个独立目录，位于 `resources/providers/{id}/`，包含：

```
resources/providers/my-provider/
  ├── manifest.json       # 声明配置结构、模型名称、描述等
  └── provider.bundle.js  # 入口逻辑，接收截图/文本，返回回复
```

详细的 Provider 接入文档见：[docs/provider.md](./docs/provider.md)

## 项目结构

```
src/
  ├── core/
  │   ├── box-select-device.ts   # 框选设备：红点检测、气泡验证、OCR
  │   ├── device.ts              # DesktopDevice 统一接口
  │   ├── generic-channel-session.ts  # 会话编排：事件循环驱动
  │   ├── runtime-host.ts        # 运行时事件循环宿主
  │   ├── session-types.ts       # 会话类型定义
  │   └── ocr.ts                 # Tesseract OCR 封装
  ├── main/
  │   ├── index.ts               # Electron 主进程
  │   └── provider-bundle.ts     # Provider 加载与调用
  ├── renderer/
  │   └── src/App.tsx            # React 主界面
  └── core/rpa/
      ├── screenshot-utils.ts    # 截图与图像处理工具
      ├── input-utils.ts         # 鼠标键盘操作
      └── vision-utils.ts        # VLM 视觉定位与布局缓存
```

## 许可

MIT License
