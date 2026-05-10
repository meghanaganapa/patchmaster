# PatchMaster

A lightweight VS Code extension that turns a natural-language task into workspace edits, asks before running commands, explains command failures, and retries fixes.

## Features

- One-button agent workflow: describe the task, then click `Run and Fix`.
- Creates and updates files inside the current workspace.
- Runs generated check commands only after user confirmation.
- Streams real command output while installs, tests, or run commands are executing.
- Feeds command failures back into the agent for another fix attempt.
- Uses a higher retry budget by default so it can keep working through failures.
- Labels transcript messages as `Human`, `Agent`, `Agent status`, or `Error`.
- Highlights the important human context, result, changed files, and command output in each answer.
- Supports uploaded context files from the agent panel.
- Supports fresh-start workflows with confirmed file deletion.
- Includes a pause/stop button for active command execution.
- Uses the active file and nearby workspace files as context.

## Requirements

- VS Code 1.90 or newer.
- Node.js available on your PATH.
- An OpenAI API key set in one of these places:
  - VS Code setting: `patchMaster.openaiApiKey`
  - Environment variable: `OPENAI_API_KEY`

Do not commit API keys in `.vscode/settings.json`.

## Install And Run Locally

```bash
npm install
npm test
```

Then launch the extension:

1. Open this folder in VS Code.
2. Press `F5`, or run the included `Run PatchMaster` launch configuration.
3. In the Extension Development Host window, open the Command Palette.
4. Run `PatchMaster: Open Agent`.

## Usage

Type a task, optionally upload context files, then click `Run and Fix`.

Example prompts:

- `Create a Python reminder script that sends email reminders and run a syntax check.`
- `Install the requirements and run the code.`
- `Fix the bug in the active file and run the project's test command.`
- `Create a small CLI app for scheduling reminders and include setup instructions.`
- `Delete the old files and start fresh with a Python reminder app.`

When the agent wants to run a command, VS Code will ask for confirmation first.
When the agent wants to delete files, VS Code will ask for confirmation first.

## Settings

- `patchMaster.openaiApiKey`: API key, if not using `OPENAI_API_KEY`.
- `patchMaster.model`: model name.
- `patchMaster.maxFileChars`: active-file context limit.
- `patchMaster.defaultTestCommand`: optional default command for fix loops.
- `patchMaster.maxIterations`: maximum retry attempts. The default is `20`.

## Submission Notes

This project intentionally has no runtime npm dependencies. The built-in Node.js and VS Code APIs are enough for the extension itself. `npm install` is still safe to run and will create/verify the package lock for repeatable installs.
