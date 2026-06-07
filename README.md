# 1peng

**AI 桌面聊天助手** — 自动检测未读消息、智能分析对话、生成回复并发送。

支持微信、企业微信、钉钉、飞书、Slack、Telegram 等主流桌面聊天应用。引擎启动后自动扫描联系人列表中的小红点，逐一点击进入聊天窗口，分析对话内容后生成自然回复，直到所有未读消息全部处理完毕。

## 核心特性

**圆形红点检测** — BFS 洪水填充连通域分析，精准识别联系人列表中的标准圆形小红点。通过宽高比、填充率、直径范围、圆度四重校验，避免误触非通知元素。

**对话结构验证** — 通过像素采样分析确认当前对话是否为真实的左右双向聊天结构，自动跳过公众号、文件传输助手等非对话场景。

**不回复名单** — 通过 Tesseract OCR 从聊天截图顶部提取联系人名称，与名单匹配后自动跳过。

**多模型 Provider** — 内置 DeepSeek、MiniMax、小米 MiMo、豆包 Seed 四个大模型，支持通过 `manifest.json` 声明式接入新模型。

**Obsidian 知识库（RAG）** — 指定本地 Obsidian Vault 路径，模型生成回复时检索相关笔记作为上下文。

**延迟回复** — 生成回复后等待指定秒数再发送，模拟真人思考节奏。

## 下载安装

前往 [Releases](https://github.com/Ethanvibe/IMagent/releases) 下载最新安装包：

- **Windows** — `1peng-1.1.0-setup.exe`
- **macOS** — `1peng-1.1.0.dmg`

首次启动需输入激活码。购买激活码请联系微信客服：**Roooxo**

> 原价 ¥188，限时 ¥66 买断

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
  │     ├─ 否 → 跳过
  │     └─ 是 → 继续
  │
  ├─ OCR 提取联系人名称 → 在不回复名单中？
  │     ├─ 是 → 跳过
  │     └─ 否 → 继续
  │
  ├─ 截图发给 Provider → 模型生成回复
  │
  ├─ 延迟等待 → 粘贴并发送回复
  │
  └─ 返回扫描下一个小红点，直到全部消灭
```

## 快速开始（开发者）

```bash
# 安装依赖
npm install

# 本地开发
npm run dev

# 构建安装包
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

### 配置

1. 选择目标聊天应用（微信/钉钉/飞书等）
2. 点击"框选区域"，依次圈出联系人列表、聊天内容区、输入框
3. 选择一个 Provider 并填写对应的 API Key
4. 点击"启动"开始运行

### 不回复名单

在高级设置中填写不需要自动回复的联系人名字，每行一个。引擎检测到小红点后，会先通过 OCR 识别当前聊天联系人，如果在名单中则跳过。

### Obsidian 知识库

填写本地 Obsidian Vault 的文件夹路径。模型在生成回复前会搜索 Vault 中的相关笔记，作为参考上下文注入 Prompt。

## 技术栈

- **Electron** + **React** + **TypeScript**
- **electron-vite** 构建系统
- **Tesseract.js** OCR 引擎
- **Jimp** 图像处理
- **AI SDK** 兼容 OpenAI 协议

## 项目结构

```
src/
  ├── core/
  │   ├── box-select-device.ts        # 红点检测、气泡验证、OCR
  │   ├── device.ts                   # DesktopDevice 统一接口
  │   ├── generic-channel-session.ts  # 会话编排
  │   ├── runtime-host.ts             # 运行时事件循环
  │   ├── license.ts                  # 激活码验证模块
  │   └── ocr.ts                      # Tesseract OCR 封装
  ├── main/
  │   ├── index.ts                    # Electron 主进程 + IPC
  │   └── provider-bundle.ts          # Provider 加载与调用
  ├── renderer/
  │   └── src/App.tsx                 # React 主界面 + 激活屏
  └── core/rpa/
      ├── screenshot-utils.ts         # 截图与图像处理
      ├── input-utils.ts              # 鼠标键盘操作
      └── vision-utils.ts             # VLM 视觉定位
scripts/
  └── keygen.mjs                      # 激活码生成工具（卖方）
tools/
  └── keygen.html                     # 可视化激活码生成器
```

## 许可

商业授权 · 一次性买断
