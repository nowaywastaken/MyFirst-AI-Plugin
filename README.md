# AI Web Agent - Intelligent Browser Automation

> **"Empowering browsers with vision, cognition, and action capabilities."**

## 📖 Introduction

**AI Web Agent** is a next-generation browser extension designed to bridge the gap between Large Language Models (LLMs) and web interaction. Inspired by the flexibility of UserScripts and the intelligence of autonomous agents, this tool transforms your browser into a programmable, AI-driven workspace.

By integrating **Google Gemini 2.5 Flash** (via OpenRouter), it enables users to control web pages using natural language commands, automating complex workflows that traditionally required manual intervention or rigid, hard-coded scripts.

## ✨ Key Features

### 🤖 Autonomous Agent Mode
- **Natural Language Control**: Simply describe what you want to do (e.g., "Login with these credentials," "Extract all product prices," "Summarize this article").
- **Visual Grounding**: The agent analyzes the DOM structure, identifying inputs, buttons, and interactive elements, even within Shadow DOMs.
- **Dynamic Planning**: utilizing a "Observe-Think-Act" loop, the AI formulates a step-by-step plan to achieve your goal, handling navigation, clicks, and form filling automatically.

### 🔌 Intelligent Script Management
- **Generative Scripting**: Ask the AI to write a persistent script for a specific site (e.g., "Always hide the sidebar on this news site").
- **Auto-Repair**: If a script breaks due to website updates, the "Fix It" feature sends the current page context and error state to the AI to generate a patched version instantly.
- **Tampermonkey-style Execution**: Manage, enable, or disable your custom JavaScript snippets with a built-in manager.

### 🎒 Persistent Context ("Memory Backpack")
- **Long-term Memory**: Store frequently used information (like shipping addresses, preference profiles, or specific instructions) in the "Memory Backpack".
- **Context-Aware**: The agent automatically retrieves relevant information from memory when executing tasks, ensuring personalized automation.

### 🛡️ Privacy & Security
- **Local Key Storage**: Your API credentials are stored securely in your local browser storage (`chrome.storage.local`) and are never sent to third-party servers other than the LLM provider.
- **Transparent Execution**: All AI actions are visualized with an overlay, showing exactly what the agent is "thinking" and doing in real-time.

## 🚀 Quick Start

### Prerequisites
- A Chromium-based browser (Chrome, Edge, Arc, Brave).
- An API Key from [OpenRouter](https://openrouter.ai/) (for access to Google Gemini models).

### Installation

1.  **Clone or Download**: Download this repository to your local machine.
2.  **Open Extension Management**: Navigate to `chrome://extensions/` in your browser.
3.  **Enable Developer Mode**: Toggle the switch in the top-right corner.
4.  **Load Unpacked**: Click the button in the top-left and select the folder containing this project.

### Configuration

1.  Click the extension icon in your browser toolbar.
2.  Navigate to the **Settings** (gear icon) or open the Options page.
3.  Enter your **OpenRouter API Key**.
4.  Save your settings.

## 💡 Usage Guide

### 1. The AI Agent
- Navigate to any webpage you wish to automate.
- Open the extension popup.
- Type your command in the text box (e.g., *"Find the cheapest laptop on this page and highlight it"*).
- Click **"Run"**. The agent will display an overlay on the page as it analyzes and executes your request.

### 2. Script Generation
- Switch to the **Scripts** tab in the popup.
- Describe the script you want (e.g., *"Auto-skip video ads on this site"*).
- Click **Generate**. The new script will be saved and automatically applied to matching URLs.

### 3. Memory Management
- Click the **"Backpack"** (🎒) icon in the popup.
- Add text notes or data you want the AI to remember.
- Click **Save**.

## 🔮 Roadmap

- [ ] Enhanced semantic understanding of complex DOM structures.
- [ ] Cross-tab workflow orchestration.
- [ ] Cloud synchronization for scripts and memory (optional).
- [ ] Support for local LLM inference (Ollama/Llama.cpp).

## 📄 License

This project is open-source and available for educational and personal use.

---

*Disclaimer: This tool automates browser interactions. Use responsibly and ensure compliance with the Terms of Service of the websites you visit. The developers are not responsible for unintended actions caused by AI hallucinations.*