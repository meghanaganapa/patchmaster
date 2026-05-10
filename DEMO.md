# Demo Guide

## What I Built

I built a VS Code coding agent called **PatchMaster**. It lets a developer describe a coding task in natural language, then the agent can inspect project context, create or edit files, ask before running commands, stream command output, explain failures, and retry fixes.

## Why It Runs Cross-Platform

The main product is a VS Code extension. VS Code extensions run on Windows, macOS, and Linux as long as the user has:

- VS Code 1.90 or newer
- Node.js
- An OpenAI API key

The extension uses VS Code APIs and Node.js built-ins, so it does not depend on Windows-only libraries. For stopping commands, it uses Windows `taskkill` only on Windows and falls back to `SIGTERM` on macOS/Linux.

## Demo Steps

1. Install the extension from the `.vsix` file.
2. Set `OPENAI_API_KEY` or configure `patchMaster.openaiApiKey`.
3. Open any project folder in VS Code.
4. Run `PatchMaster: Open Agent` from the Command Palette.
5. Try this prompt:

```text
Create a small Python reminder script. Do not run commands.
```

Expected result:
- The agent creates/updates files.
- It does not run commands because the prompt did not ask for command execution.

6. Try this prompt:

```text
Install the requirements and run the code.
```

Expected result:
- The agent asks before running commands.
- It streams command output while installing/running.
- If a command fails, it uses the output to retry.

7. Try uploading a file using `Upload Files`, then ask:

```text
Review the uploaded file and improve the error handling.
```

Expected result:
- The agent uses uploaded content as context.
- It explains what it changed.

## What To Say In The Demo

I built this as a local coding agent inside VS Code. The important part is that it is not just a chatbot. It can edit workspace files, run commands with confirmation, stream command output, retry after failures, and show structured explanations for the human.

I also added safety controls:

- It asks before running commands.
- It asks before deleting files.
- It has a pause/stop button.
- It avoids command execution unless the user explicitly asks to run, test, install, start, launch, execute, or check something.

## Test Coverage

Manual test scenarios are documented in `TEST_CASES.md`. Automated validation currently checks:

- Extension JavaScript syntax with `npm test`
- Python syntax with `python -m py_compile reminder_agent.py`
