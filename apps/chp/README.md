# chp Complete 1.0.0

Portable Windows AI desktop application with local workspaces, configurable online/local model APIs, and a complete independent Cowork-style runtime.

- No LobeHub login, LobeHub cloud sync, remote LobeHub workspace, or LobeHub backend is required by the `chp` runtime.
- Chat history, tasks, project state, API configuration, indexes, Skills, artifacts, captures, logs, and Electron data stay beside `chp.exe` under `data/`.
- Model Gateway supports Anthropic Messages and OpenAI-compatible APIs, including public online endpoints and localhost model servers, streaming tool calls, and image/vision messages.
- Compatible with `chp-api.json`: `protocol`, `base_url`, `api_key`, `model`, `auth_scheme`, `temperature`, and `max_tokens`.
- Chat supports local document attachments and PDF/DOCX/XLSX/PPTX/text/code extraction.
- Work Agent tools include project tree/read/write, ripgrep search and persistent project indexing, command execution, Skills, Artifact generation, MCP tools, and opt-in Computer Use.
- Every Work Agent request captures its project root at launch. Switching projects while another request is running cannot redirect that request's file or command tools.
- Interactive PTY uses `node-pty`; project search/index uses packaged ripgrep.
- MCP Runtime supports arbitrary local stdio MCP servers and packages the official open-source GitHub MCP Server in the Windows delivery.
- Local Skills are stored under portable data and can guide code review, debugging, document, spreadsheet, presentation, and frontend-design workflows.
- Artifact Studio creates Markdown/text/JSON/HTML/CSV plus DOCX, XLSX, PPTX, and PDF files locally.
- Computer Use is explicitly opt-in and provides primary-screen capture plus Windows click/type/key/open-URL actions.
- Windows delivery is an unpacked portable directory compressed into high-compression 7-Zip volumes capped below 150 MB per part; no installer is required.

## Model configuration

Open **Model Gateway** in the app, or place `chp-api.json` beside `chp.exe` before first launch. On first use it is copied into `data/chp-api.json`, keeping subsequent changes portable.

## Portable data

Keep the extracted folder together. Moving the folder moves the application's local state with it.

## Reference implementation policy

The Cowork-style capabilities above are independently implemented in `chp`. Anthropic proprietary application code, private native bindings, fonts, branded UI assets, and `cowork-svc.exe` are not redistributed. Open-source third-party components are packaged according to their respective licenses.
