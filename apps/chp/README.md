# chp

Portable Windows AI desktop application with local workspaces and configurable model APIs.

- No LobeHub login, cloud sync, remote workspace, or LobeHub backend is required by the chp runtime.
- Chat history, tasks, workspace state, API configuration, artifacts, logs, and Electron data are stored beside `chp.exe` under `data/`.
- Model access supports Anthropic Messages and OpenAI-compatible HTTP APIs, including public online endpoints and localhost model servers.
- Compatible with the provided `chp-api.json` fields: `protocol`, `base_url`, `api_key`, `model`, and `auth_scheme`.
- Streaming chat, document attachments, PDF/DOCX/XLSX/PPTX extraction, project file search/editing, terminal execution, local tasks, and artifacts are included.
- Work mode exposes scoped AI tools for listing/searching/reading/writing project files, running commands, and creating artifacts. Workspace paths are guarded against escaping the selected project root.
- Windows delivery is an unpacked portable directory compressed into split 7-Zip volumes; no installer is required.

## Model configuration

Open **Model Gateway** in the app, or place `chp-api.json` beside `chp.exe` before first launch. On first use, the configuration is copied into `data/chp-api.json` so subsequent changes remain portable.

## Portable data

Keep the entire extracted folder together. `data/` is created/used beside the executable, so moving the folder moves the application state with it.
