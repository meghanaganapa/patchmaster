# Coding Agent Test Cases

Use these cases to verify the extension before submitting or demoing it.

## 1. Open Agent UI

**Goal:** Confirm the extension opens correctly.

**Steps:**
1. Launch the Extension Development Host.
2. Open Command Palette.
3. Run `PatchMaster: Open Agent`.

**Expected result:**
- The agent panel opens.
- The chat area shows the initial agent message.
- The `Run and Fix`, `Upload Files`, and `Pause / Stop` controls are visible.

## 2. Create File Without Running Commands

**Prompt:**
```text
Create a simple Python hello world script.
```

**Expected result:**
- The agent creates or updates a Python file.
- It does not ask to run shell commands.
- The final response shows `Files changed`.

## 3. Install And Run Command Flow

**Prompt:**
```text
Install the requirements and run the code.
```

**Expected result:**
- The agent detects install/run commands such as `npm install`, `npm test`, or Python equivalents.
- It asks for permission before running commands.
- Live command output appears in the chat.
- The elapsed timer updates while commands run.

## 4. Failed Command Retry

**Setup:**
Create a file with an intentional syntax error.

**Prompt:**
```text
Run the code and fix any errors.
```

**Expected result:**
- The first command fails.
- The failure output appears in the chat.
- The agent edits the file and retries.
- The final response explains the fix.

## 5. Upload File Context

**Steps:**
1. Click `Upload Files`.
2. Select a source file.
3. Prompt:

```text
Review the uploaded file and improve the error handling.
```

**Expected result:**
- The uploaded file appears as a chip.
- The agent uses the uploaded content in its response.
- The response references relevant file context.

## 6. Fresh Start With Deletion Confirmation

**Prompt:**
```text
Delete the old files and start fresh with a small Python reminder app.
```

**Expected result:**
- The agent proposes files to delete.
- VS Code asks for deletion confirmation.
- `.git` and `node_modules` are not deleted.
- New replacement files are created after confirmation.

## 7. Pause / Stop Long Command

**Prompt:**
```text
Install the requirements and run the code.
```

**Steps:**
1. Approve command execution.
2. Click `Pause / Stop` while a command is running.

**Expected result:**
- The active command stops quickly.
- The chat shows that cancellation was requested.
- The final response says the task was cancelled.

## 8. No Command When Not Requested

**Prompt:**
```text
Create a README section explaining how this project works.
```

**Expected result:**
- The agent edits documentation.
- It does not run commands.
- If the model suggests commands, the extension skips them.

## 9. Repeated Answer Guard

**Prompt 1:**
```text
Create a Python reminder script.
```

**Prompt 2:**
```text
Now create a JavaScript version instead.
```

**Expected result:**
- The second response follows the latest request.
- It does not repeat the Python answer.

## 10. Missing API Key

**Setup:**
Remove `OPENAI_API_KEY` from the environment and do not set `patchMaster.openaiApiKey`.

**Prompt:**
```text
Create a small script.
```

**Expected result:**
- The extension shows a clear missing-key error.
- No files are changed.
