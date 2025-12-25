# MyFirst-AI-Plugin 

## 🤖 小万助手 (Wan-Agent)

> **“让浏览器长出眼睛、脑子和双手，听懂人话，自动干活。”**

## 📖 项目简介 (Introduction)

你好！我是万崇文（小万），一名长沙理工大学的大二学生。

**小万助手 (Wan-Agent)** 是一个基于 Chrome 扩展架构开发的 **AI 网页自动化工具**。
它的灵感来源于 **Tampermonkey（油猴）** 的脚本执行能力和 **ChatGPT Atlas** 的智能规划能力。

在这个 AI 时代，我认为操作浏览器不应该再是冷冰冰的代码，而应该是自然的对话。这个项目的目标，是探索**“Read-Write Web”**（可读可写的万维网）—— 让 AI 不仅能“读懂”网页，还能代替人类去“操作”网页。

## ✨ 核心功能 (Features)

目前的版本已经实现了“侦察-思考-执行”的完整闭环：

* **👀 全局视觉 (Read):** 能够智能扫描网页，识别文本背景、输入框（Inputs）和按钮（Buttons），包括隐藏在 `div` 或 Shadow DOM 中的复杂元素。
* **🧠 AI 大脑 (Think):** 接入 **Google Gemini 2.5 Flash** (via OpenRouter)，能够理解用户的自然语言指令（如“帮我登录”、“把所有商品存下来”），并制定操作计划。
* **✍️ 自动执行 (Act):**
* **智能填表:** 根据上下文自动填充表单（支持 `text`, `number`, `email` 等多种格式）。
* **自动点击:** 识别并点击正确的按钮（登录、提交、搜索等），支持交互特效。



## 🛠 技术原理 (How it works)

这个插件是一个微型的 **RPA (机器人流程自动化)** 系统：

1. **Inject (注入):** 用户下达指令后，插件向当前网页注入“侦察兵脚本”。
2. **Analyze (分析):** 脚本提取网页的 DOM 结构，转化为简化版的 JSON 数据。
3. **Plan (规划):** 将 `网页结构 + 用户指令` 发送给 LLM (大模型)，请求返回 JSON 格式的行动计划。
4. **Execute (执行):** 插件接收计划，模拟用户行为（Input Event / Click Event）完成操作。

## 🚀 快速开始 (Quick Start)

### 1. 准备工作

* 你需要一个 Chromium 内核的浏览器（Chrome, Edge, Arc 等）。
* 你需要一个 [OpenRouter](https://openrouter.ai/) 的 API Key。

### 2. 安装步骤

1. 下载本项目源代码到本地。
2. 打开 `popup.js`，找到第 2 行，填入你的 API Key：
```javascript
const API_KEY = 'sk-or-你的密钥...';

```


3. 打开浏览器，进入扩展管理页面 `chrome://extensions/`。
4. 开启右上角的 **“开发者模式” (Developer mode)**。
5. 点击左上角的 **“加载已解压的扩展程序” (Load unpacked)**，选择本项目文件夹。

### 3. 使用方法

1. 打开任意网页（如登录页、表单页、新闻页）。
2. 点击浏览器右上角的插件图标。
3. 在输入框中输入你的指令，例如：
* *“按网页提示填写账号 tomsmith 和密码，然后登录”*
* *“帮我总结这篇文章的三个核心观点”*
* *“搜索 M3 MacBook Air 的价格”*


4. 点击绿色按钮，观察 AI 的自动操作。

## 🔮 未来愿景 (Roadmap)

作为本科生项目，它目前还很稚嫩。我希望这个项目可以完全结合Tampermonkey和ChatGPT Atlas的功能，实现一个AI自动化工具。

## 🤝 致谢 (Credits)

感谢开源社区的启发，以及 Gemini 2.5 提供的强大模型支持。
特别感谢我的 AI 导师（Gemini）在开发过程中提供的耐心指导。

---

*Created with ❤️ by Wan Chongwen @ CSUST | 2025*