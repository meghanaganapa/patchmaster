const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

let chatPanel;
let chatHistory = [];
let activeRun = null;

function makeTaskId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getRecentHumanTasks() {
  return chatHistory
    .filter((item) => item.role === 'user')
    .slice(-4)
    .map((item) => item.content);
}

function taskLikelyNeedsAction(task) {
  return /\b(create|build|make|add|fix|repair|debug|run|test|install|update|edit|write|code|implement|generate|change|error|bug|issue|failing|failed)\b/i.test(task);
}

function taskLikelyNeedsCommand(task) {
  return /\b(run|test|install|requirements|dependencies|package|start|execute|launch|serve|npm install|pip install)\b/i.test(task);
}

function taskLikelyRequestsFreshStart(task) {
  return /\b(delete all|remove all|start fresh|start from scratch|clean slate|wipe|reset project|new project)\b/i.test(task);
}

function defaultVerificationCommand() {
  const workspaceRoot = getWorkspaceRoot();
  const packageJson = vscode.Uri.file(path.join(workspaceRoot, 'package.json'));
  const pythonFilesPattern = new vscode.RelativePattern(workspaceRoot, '*.py');

  return vscode.workspace.fs.stat(packageJson)
    .then(() => 'npm test')
    .then(undefined, () => vscode.workspace.findFiles(pythonFilesPattern, undefined, 1)
      .then((files) => files.length ? 'python -m compileall . -q' : ''));
}

async function defaultRunCommandsForTask(task) {
  const workspaceRoot = getWorkspaceRoot();
  const commands = [];
  const hasPackageJson = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(workspaceRoot, 'package.json')))
    .then(() => true, () => false);
  const hasRequirements = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(workspaceRoot, 'requirements.txt')))
    .then(() => true, () => false);
  const pythonFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceRoot, '*.py'), undefined, 5);

  if (/\b(install|requirements|dependencies|package)\b/i.test(task)) {
    if (hasPackageJson) {
      commands.push('npm install');
    }
    if (hasRequirements) {
      commands.push('python -m pip install -r requirements.txt');
    }
  }

  if (/\b(run|start|execute|launch|serve)\b/i.test(task)) {
    if (hasPackageJson) {
      commands.push('npm test');
    } else if (pythonFiles.length === 1) {
      commands.push(`python ${path.basename(pythonFiles[0].fsPath)}`);
    } else if (pythonFiles.length > 1) {
      commands.push('python -m compileall . -q');
    }
  }

  return [...new Set(commands)];
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('patchMaster.openAgent', () => openChat(context)),
    vscode.commands.registerCommand('patchMaster.workspaceTask', workspaceTaskCommand)
  );
}

function deactivate() {}

function getConfig() {
  const config = vscode.workspace.getConfiguration('patchMaster');
  return {
    apiKey: config.get('openaiApiKey') || process.env.OPENAI_API_KEY || '',
    model: config.get('model') || 'gpt-5.2-codex',
    maxFileChars: config.get('maxFileChars') || 16000,
    defaultTestCommand: config.get('defaultTestCommand') || '',
    maxIterations: config.get('maxIterations') || 20,
  };
}

function getActiveFileContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }

  const { maxFileChars } = getConfig();
  const document = editor.document;
  const text = document.getText();
  const truncated = text.length > maxFileChars;

  return {
    path: document.uri.fsPath,
    languageId: document.languageId,
    text: truncated ? text.slice(0, maxFileChars) : text,
    truncated,
  };
}

async function callOpenAI(messages, temperature = 0.2) {
  const { apiKey, model } = getConfig();
  if (!apiKey) {
    throw new Error('Missing API key. Set patchMaster.openaiApiKey or OPENAI_API_KEY.');
  }

  if (typeof fetch !== 'function') {
    throw new Error('This VS Code build does not expose fetch in the extension host. Update VS Code and try again.');
  }

  const requestBody = {
    model,
    input: messages.map((message) => ({
      role: message.role === 'system' ? 'developer' : message.role,
      content: message.content,
    })),
  };

  if (!model.includes('codex') && !model.startsWith('gpt-5')) {
    requestBody.temperature = temperature;
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : `OpenAI request failed with ${response.status}`;
    throw new Error(message);
  }

  const text = extractResponseText(data);
  if (!text) {
    throw new Error('OpenAI response did not include text output.');
  }

  return text.trim();
}

function extractResponseText(data) {
  if (typeof data.output_text === 'string') {
    return data.output_text;
  }

  if (!Array.isArray(data.output)) {
    return '';
  }

  return data.output
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((content) => {
      if (typeof content.text === 'string') {
        return content.text;
      }
      if (typeof content.output_text === 'string') {
        return content.output_text;
      }
      return '';
    })
    .join('');
}

function buildSystemPrompt(fileContext) {
  const filePart = fileContext
    ? [
        `Active file: ${fileContext.path}`,
        `Language: ${fileContext.languageId}`,
        fileContext.truncated ? 'The file context is truncated.' : 'The full active file is included.',
        '',
        fileContext.text,
      ].join('\n')
    : 'No active file is attached.';

  return [
    'You are a Codex-style coding agent running inside VS Code.',
    'Be concise, practical, and specific.',
    'When asked about code, reason from the active file context.',
    'When a change is needed, explain the smallest useful edit before applying it.',
    'Do not claim to run commands unless the user asks and the extension runs them.',
    '',
    filePart,
  ].join('\n');
}

async function chatWithAgent(userText) {
  const fileContext = getActiveFileContext();
  const messages = [
    { role: 'system', content: buildSystemPrompt(fileContext) },
    ...chatHistory.slice(-10),
    { role: 'user', content: userText },
  ];

  const response = await callOpenAI(messages, 0.25);
  chatHistory.push({ role: 'user', content: userText });
  chatHistory.push({ role: 'assistant', content: response });
  return response;
}

async function applyEditToActiveFile(instruction, feedback = '') {
  const editor = vscode.window.activeTextEditor;
  const fileContext = getActiveFileContext();
  if (!editor || !fileContext) {
    throw new Error('Open a file first.');
  }

  const messages = [
    {
      role: 'system',
      content: [
        'You edit exactly one VS Code active file.',
        'Return strict JSON only, with keys "content" and "summary".',
        '"content" must be the complete updated file.',
        '"summary" must be one short plain-English sentence.',
        'Do not include markdown fences.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `File path: ${fileContext.path}`,
        `Language: ${fileContext.languageId}`,
        `Instruction: ${instruction}`,
        feedback ? `Previous test/check feedback:\n${feedback}` : '',
        '',
        'Current file content:',
        fileContext.text,
      ].join('\n'),
    },
  ];

  const raw = await callOpenAI(messages, 0.1);
  const cleaned = stripJsonFence(raw);
  let result;
  try {
    result = JSON.parse(cleaned);
  } catch (error) {
    throw new Error('The model did not return valid edit JSON.');
  }

  if (typeof result.content !== 'string') {
    throw new Error('The model response did not include updated file content.');
  }

  const document = editor.document;
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullRange, result.content);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error('VS Code could not apply the edit.');
  }

  await document.save();
  return result.summary || 'Updated the active file.';
}

function getWorkspaceCwd() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }

  const firstFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return firstFolder ? firstFolder.uri.fsPath : process.cwd();
}

function getWorkspaceRoot() {
  const firstFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!firstFolder) {
    throw new Error('Open a workspace folder first.');
  }

  return firstFolder.uri.fsPath;
}

function getRelativeWorkspacePath(filePath) {
  const workspaceRoot = getWorkspaceRoot();
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

function getWorkspaceUri(relativePath) {
  const workspaceRoot = getWorkspaceRoot();
  const normalized = path.normalize(relativePath);
  const target = path.resolve(workspaceRoot, normalized);
  const relative = path.relative(workspaceRoot, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to edit outside the workspace: ${relativePath}`);
  }

  return vscode.Uri.file(target);
}

async function readWorkspaceFileForContext(relativePath) {
  const uri = getWorkspaceUri(relativePath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');

  return {
    path: relativePath.replace(/\\/g, '/'),
    text: text.length > 8000 ? `${text.slice(0, 8000)}\n...truncated...` : text,
  };
}

async function getWorkspaceContext(attachedPaths = []) {
  const files = await vscode.workspace.findFiles(
    '**/*',
    '**/{.git,node_modules,out,dist,build,.vscode-test}/**',
    25
  );
  const activeFile = getActiveFileContext();
  const snippets = [];
  const attached = [];

  for (const attachedPath of attachedPaths) {
    try {
      attached.push(await readWorkspaceFileForContext(attachedPath));
    } catch (error) {
      attached.push({
        path: attachedPath,
        text: `(Could not read attached file: ${error.message})`,
      });
    }
  }

  for (const uri of files.slice(0, 12)) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      snippets.push({
        path: getRelativeWorkspacePath(uri.fsPath),
        text: text.length > 4000 ? `${text.slice(0, 4000)}\n...truncated...` : text,
      });
    } catch (error) {
      snippets.push({
        path: getRelativeWorkspacePath(uri.fsPath),
        text: `(Could not read file: ${error.message})`,
      });
    }
  }

  return {
    files: snippets,
    activeFile,
    attached,
  };
}

function runShellCommand(command, cwd, runState, onOutput) {
  return new Promise((resolve) => {
    if (runState && runState.cancelled) {
      resolve({
        ok: false,
        code: 130,
        stdout: '',
        stderr: 'Cancelled by user.',
        output: 'Cancelled by user.',
        cancelled: true,
      });
      return;
    }

    const child = cp.spawn(
      command,
      {
        cwd,
        shell: true,
        windowsHide: true,
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onOutput && text.trim()) {
        onOutput(text.trim());
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onOutput && text.trim()) {
        onOutput(text.trim());
      }
    });

    child.on('error', (error) => {
      if (runState && runState.child === child) {
        runState.child = null;
      }
      resolve({
        ok: false,
        code: typeof error.code === 'number' ? error.code : 1,
        stdout,
        stderr: `${stderr}${error.message}`,
        output: `${stdout || ''}${stderr || ''}${error.message}`.trim(),
        cancelled: Boolean(runState && runState.cancelled),
      });
    });

    child.on('close', (code) => {
      if (runState && runState.child === child) {
        runState.child = null;
      }
      resolve({
        ok: code === 0 && !(runState && runState.cancelled),
        code: typeof code === 'number' ? code : 0,
        stdout,
        stderr,
        output: (runState && runState.cancelled)
          ? 'Cancelled by user.'
          : `${stdout || ''}${stderr || ''}`.trim(),
        cancelled: Boolean(runState && runState.cancelled),
      });
    });

    if (runState) {
      runState.child = child;
      if (runState.cancelled) {
        killProcessTree(child);
      }
    }
  });
}

function cancelActiveRun() {
  if (!activeRun) {
    return false;
  }

  activeRun.cancelled = true;
  if (activeRun.child) {
    killProcessTree(activeRun.child);
  }
  return true;
}

function killProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    cp.spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      shell: false,
    });
    return;
  }

  child.kill('SIGTERM');
}

async function confirmDeleteFiles(files) {
  if (!files.length) {
    return true;
  }

  const preview = files.slice(0, 12).map((file) => `- ${file}`).join('\n');
  const more = files.length > 12 ? `\n- ...and ${files.length - 12} more` : '';
  const answer = await vscode.window.showWarningMessage(
    [
      'The agent wants to delete workspace files.',
      '',
      preview + more,
      '',
      'Only approve this if you really want to remove these files.',
    ].join('\n'),
    { modal: true },
    'Delete'
  );

  return answer === 'Delete';
}

async function deleteWorkspaceFiles(files) {
  const deleted = [];

  for (const filePath of files) {
    if (typeof filePath !== 'string') {
      continue;
    }

    const normalized = filePath.replace(/\\/g, '/');
    if (
      normalized.startsWith('.git/') ||
      normalized === '.git' ||
      normalized.startsWith('node_modules/') ||
      normalized === 'node_modules'
    ) {
      continue;
    }

    const uri = getWorkspaceUri(filePath);
    try {
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      deleted.push(filePath);
    } catch (error) {
      if (error && error.code !== 'FileNotFound') {
        throw error;
      }
    }
  }

  return deleted;
}

async function applyWorkspaceFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const changed = [];

  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('Workspace task returned an invalid file edit.');
    }

    const uri = getWorkspaceUri(file.path);
    const parent = vscode.Uri.file(path.dirname(uri.fsPath));
    await vscode.workspace.fs.createDirectory(parent);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'));
    changed.push(file.path);
  }

  await vscode.workspace.saveAll(false);
  return changed;
}

async function askForWorkspacePlan(task, feedback = '', taskId = makeTaskId(), attachedPaths = [], uploadedFiles = []) {
  const workspaceContext = await getWorkspaceContext(attachedPaths);
  const verificationCommand = await defaultVerificationCommand();
  const messages = [
    {
      role: 'system',
      content: [
        'You are a VS Code workspace coding agent.',
        'The latest task is the source of truth. Older conversation is only weak background context.',
        'Do not repeat or copy a previous answer unless the latest task explicitly asks for the same thing.',
        'Work in an inspect -> edit -> verify loop. Use command results to decide the next edit.',
        'Do not stop at a generic explanation when the workspace can be inspected, edited, or verified.',
        'Make your visible response explain the approach, important evidence from files or command output, and the concrete solution.',
        'Use **bold** for important filenames, decisions, errors, and final answers in response/context.',
        'Do not reveal hidden chain-of-thought. Provide concise working notes and rationale instead.',
        'Return strict JSON only with keys "response", "summary", "context", "files", "deleteFiles", and "commands".',
        '"response" is a helpful human-readable answer that explains what you will do or what you changed.',
        '"summary" is one short sentence for notifications.',
        '"context" is an array of short points the human needs to know, such as assumptions, required credentials, generated files, or commands.',
        '"files" is an array of {"path": "relative/path", "content": "complete file content"}.',
        '"deleteFiles" is an array of workspace-relative paths to remove when the user asks to start fresh or delete stale files.',
        '"commands" is an array of shell commands to run after editing. Keep commands minimal.',
        'You may include read-only inspection commands before edits are needed, such as listing files, checking package scripts, or running tests.',
        'When multiple commands are useful, return all of them in order.',
        'Use commands to verify your work. Prefer the project test command when available.',
        'When the user asks to create, build, add, implement, fix, or edit code, you must include at least one file edit unless the task is impossible.',
        'Only include commands when the latest user task explicitly asks to run, test, install, start, launch, execute, or check something.',
        'When the user asks to run or test code, include a command.',
        'When the user asks to install requirements, dependencies, or packages, include installation commands such as npm install or python -m pip install -r requirements.txt when those files exist.',
        'When the user asks to install and run, include both install commands and run/test commands in order.',
        'If the task is impossible, return no files and explain the exact blocker in response and context.',
        'When previous command feedback is present, explain the likely cause in response and fix it in files.',
        'Create or update files needed to satisfy the user. Use relative paths only.',
        'If the latest task asks to delete everything, start fresh, wipe, reset, or start from scratch, include deleteFiles for stale project files and then include new files.',
        'Never include .git or node_modules in deleteFiles.',
        'Do not include markdown fences.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Task id: ${taskId}`,
        '',
        'Recent human tasks, oldest to newest:',
        ...getRecentHumanTasks().map((item) => `- ${item}`),
        '',
        'Latest task to solve now:',
        task,
        verificationCommand ? `Suggested verification command: ${verificationCommand}` : 'Suggested verification command: none detected',
        feedback ? `Previous command feedback:\n${feedback}` : '',
        '',
        'User-attached files:',
        ...workspaceContext.attached.map((file) => [
          `--- ${file.path} ---`,
          file.text,
        ].join('\n')),
        '',
        'Uploaded files:',
        ...uploadedFiles.map((file) => [
          `--- ${file.name || 'uploaded-file'} ---`,
          typeof file.content === 'string' && file.content.length > 12000
            ? `${file.content.slice(0, 12000)}\n...truncated...`
            : (file.content || ''),
        ].join('\n')),
        '',
        'Active file context:',
        workspaceContext.activeFile
          ? `${workspaceContext.activeFile.path}\n${workspaceContext.activeFile.text}`
          : 'No active file.',
        '',
        'Workspace files:',
        ...workspaceContext.files.map((file) => [
          `--- ${file.path} ---`,
          file.text,
        ].join('\n')),
      ].join('\n'),
    },
  ];

  const raw = await callOpenAI(messages, 0.1);
  const cleaned = await coerceWorkspacePlanJson(raw, messages);
  let result;
  try {
    result = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`The model did not return valid workspace-task JSON. Raw response: ${raw.slice(0, 1000)}`);
  }

  return {
    response: typeof result.response === 'string' ? result.response : '',
    summary: typeof result.summary === 'string' ? result.summary : 'Updated the workspace.',
    context: Array.isArray(result.context) ? result.context.filter((item) => typeof item === 'string') : [],
    files: Array.isArray(result.files) ? result.files : [],
    deleteFiles: Array.isArray(result.deleteFiles) ? result.deleteFiles.filter((file) => typeof file === 'string') : [],
    commands: Array.isArray(result.commands) ? result.commands.filter((command) => typeof command === 'string') : [],
  };
}

async function coerceWorkspacePlanJson(raw, originalMessages) {
  const cleaned = stripJsonFence(raw);
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch (error) {
    const repaired = await callOpenAI([
      {
        role: 'system',
        content: [
          'Convert the assistant response into strict JSON only.',
          'Use keys "response", "summary", "context", "files", "deleteFiles", and "commands".',
          'Preserve any file contents and commands from the response.',
          'Do not include markdown fences.',
        ].join(' '),
      },
      ...originalMessages.slice(-1),
      {
        role: 'user',
        content: `Invalid response to convert:\n${raw}`,
      },
    ], 0);
    return stripJsonFence(repaired);
  }
}

async function explainFailure(task, feedback) {
  const messages = [
    {
      role: 'system',
      content: [
        'You explain coding task failures inside VS Code.',
        'Be clear and helpful.',
        'Say what failed, the likely cause, and what the user can do next.',
        'If the agent will retry, say that briefly.',
        'Do not invent command output.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `User task: ${task}`,
        '',
        'Failure details:',
        feedback,
      ].join('\n'),
    },
  ];

  return callOpenAI(messages, 0.2);
}

function buildTaskReport(status, plan, changedFiles, commandOutput = '') {
  return [
    'Result',
    status,
    '',
    'Important context',
    plan.context && plan.context.length
      ? plan.context.map((item) => `- ${item}`).join('\n')
      : '- No extra context required.',
    '',
    'Agent answer',
    plan.response || plan.summary,
    '',
    'Files changed',
    changedFiles.length ? changedFiles.map((file) => `- ${file}`).join('\n') : '- None',
    commandOutput
      ? [
          '',
          'Command output',
          commandOutput.slice(-4000),
        ].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function addElapsedToReport(report, startedAt) {
  return [
    'Elapsed time',
    formatElapsed(startedAt),
    '',
    report,
  ].join('\n');
}

function buildFinalFailureReport(maxIterations, finalSummary, changedFiles, lastOutput) {
  return [
    'Result',
    `Stopped after ${maxIterations} attempts without a passing command.`,
    '',
    'Important context',
    '- The agent used all configured retry attempts.',
    '- Increase patchMaster.maxIterations if you want it to keep trying longer.',
    '- Review the last command output below for the remaining blocker.',
    '',
    'Agent answer',
    finalSummary || 'The task did not reach a passing command.',
    '',
    'Files changed',
    changedFiles.length ? changedFiles.map((file) => `- ${file}`).join('\n') : '- None',
    '',
    'Last command output',
    lastOutput.slice(-4000),
  ].filter(Boolean).join('\n');
}

async function confirmAutomaticCommands(commands) {
  const preview = commands.slice(0, 5).map((command) => `- ${command}`).join('\n');
  const more = commands.length > 5 ? `\n- ...and ${commands.length - 5} more` : '';
  const answer = await vscode.window.showWarningMessage(
    [
      'Allow the agent to run commands automatically for this task?',
      '',
      preview + more,
      '',
      'It will keep using command output to fix errors until the task passes or reaches the retry limit.',
    ].join('\n'),
    { modal: true },
    'Allow'
  );

  return answer === 'Allow';
}

async function runCommandList(commands, cwd, postUpdate, runState) {
  const outputs = [];

  for (const command of commands) {
    postUpdate(`Running command:\n${command}`);
    const result = await runShellCommand(command, cwd, runState, (chunk) => {
      postUpdate(`Command output:\n${chunk.slice(-3000)}`);
    });
    const output = result.output || '(command produced no output)';
    outputs.push([
      `Command: ${command}`,
      `Exit code: ${result.code}`,
      'Output:',
      output,
    ].join('\n'));

    if (!result.ok) {
      return {
        ok: false,
        failedCommand: command,
        output: outputs.join('\n\n'),
        cancelled: result.cancelled,
      };
    }
  }

  return {
    ok: true,
    failedCommand: '',
    output: outputs.join('\n\n'),
    cancelled: false,
  };
}

async function runWorkspaceTask(task, postUpdate, attachedPaths = [], uploadedFiles = []) {
  const cwd = getWorkspaceCwd();
  const { maxIterations } = getConfig();
  const taskId = makeTaskId();
  const startedAt = Date.now();
  let feedback = '';
  let finalSummary = '';
  const changedFiles = new Set();
  const deletedFiles = new Set();
  let lastOutput = '';
  let lastPlanText = '';
  let commandApproval = false;
  let commandApprovalAsked = false;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    postUpdate(`[${formatElapsed(startedAt)}] Iteration ${iteration}/${maxIterations}: inspecting context and planning the next action...`);
    if (activeRun && activeRun.cancelled) {
      return addElapsedToReport(buildTaskReport('Cancelled by user.', {
        context: ['Execution was stopped from the UI.'],
        response: 'The task was cancelled before it finished.',
        summary: 'Cancelled by user.',
      }, Array.from(changedFiles)), startedAt);
    }

    const plan = await askForWorkspacePlan(task, feedback, taskId, attachedPaths, uploadedFiles);
    finalSummary = plan.summary;
    const commandRequested = taskLikelyNeedsCommand(task);
    if (!commandRequested && plan.commands.length) {
      plan.context.push('Command execution was skipped because the latest request did not ask to run, test, install, start, launch, execute, or check anything.');
      plan.commands = [];
    }
    if (plan.response) {
      postUpdate(`[${formatElapsed(startedAt)}] Working notes:\n${plan.response}`);
    }

    const planText = `${plan.summary}\n${plan.response}`.trim();
    const repeatedPlan = planText && planText === lastPlanText;
    lastPlanText = planText;

    if (taskLikelyRequestsFreshStart(task) && !plan.deleteFiles.length) {
      feedback = [
        'The latest task appears to ask for a fresh start, but deleteFiles was empty.',
        'Return deleteFiles for stale workspace files that should be removed, plus files for the new project.',
        'Never include .git or node_modules.',
        `Latest task: ${task}`,
      ].join('\n');
      postUpdate(`[${formatElapsed(startedAt)}] Iteration ${iteration}: this looks like a fresh-start request, so I am asking for deleteFiles and replacement files.`);
      continue;
    }

    if (taskLikelyNeedsCommand(task) && !plan.commands.length) {
      const fallbackCommands = await defaultRunCommandsForTask(task);
      if (fallbackCommands.length) {
        fallbackCommands.forEach((command) => plan.commands.push(command));
        plan.context.push(`I added detected command(s) because this request asks to install or run code: ${fallbackCommands.join(', ')}`);
      }
    }

    if (taskLikelyNeedsAction(task) && !plan.files.length && !plan.commands.length && !plan.deleteFiles.length) {
      feedback = [
        'The previous response did not take an action.',
        'For this latest task, return concrete file edits, deleteFiles, and/or shell commands instead of only explanation.',
        taskLikelyNeedsCommand(task) ? 'This request asks to install or run code, so commands are required.' : '',
        `Latest task: ${task}`,
      ].join('\n');
      postUpdate(`[${formatElapsed(startedAt)}] Iteration ${iteration}: the plan had no edits or commands, so I am asking for an actionable fix.`);
      continue;
    }

    if (repeatedPlan && iteration > 1) {
      feedback = [
        'The previous response repeated the same plan.',
        'Revise the approach. Use the current workspace files and latest task, and return a different concrete edit or command.',
        `Latest task: ${task}`,
      ].join('\n');
      postUpdate(`[${formatElapsed(startedAt)}] Iteration ${iteration}: the plan repeated itself, so I am asking for a different fix.`);
      continue;
    }

    if (plan.deleteFiles && plan.deleteFiles.length) {
      const okToDelete = await confirmDeleteFiles(plan.deleteFiles);
      if (!okToDelete) {
        return addElapsedToReport(buildTaskReport(`${finalSummary}\n\nSkipped file deletion because it was not approved.`, plan, Array.from(changedFiles)), startedAt);
      }
      postUpdate(`[${formatElapsed(startedAt)}] Iteration ${iteration}: deleting ${plan.deleteFiles.length} file${plan.deleteFiles.length === 1 ? '' : 's'}...`);
      const removed = await deleteWorkspaceFiles(plan.deleteFiles);
      removed.forEach((file) => deletedFiles.add(file));
    }

    if (plan.files.length) {
      postUpdate(`[${formatElapsed(startedAt)}] Iteration ${iteration}: applying ${plan.files.length} file change${plan.files.length === 1 ? '' : 's'}...`);
      const appliedFiles = await applyWorkspaceFiles(plan.files);
      appliedFiles.forEach((file) => changedFiles.add(file));
    }

    if (commandRequested && !plan.commands.length && (changedFiles.size || deletedFiles.size)) {
      const verificationCommand = await defaultVerificationCommand();
      if (verificationCommand) {
        plan.commands.push(verificationCommand);
        plan.context.push(`No command was returned, so I used the detected verification command: ${verificationCommand}`);
      }
    }

    if (!plan.commands.length) {
      return addElapsedToReport(buildTaskReport(finalSummary, plan, Array.from(changedFiles)), startedAt);
    }

    if (!commandApprovalAsked) {
      commandApproval = await confirmAutomaticCommands(plan.commands);
      commandApprovalAsked = true;
    }

    if (!commandApproval) {
      return addElapsedToReport(buildTaskReport(`${finalSummary}\n\nSkipped commands because automatic command execution was not approved.`, plan, Array.from(changedFiles)), startedAt);
    }

    postUpdate(`[${formatElapsed(startedAt)}] Iteration ${iteration}: running ${plan.commands.length} command${plan.commands.length === 1 ? '' : 's'}...`);
    const commandRun = await runCommandList(plan.commands, cwd, postUpdate, activeRun);
    lastOutput = commandRun.output || '(commands produced no output)';
    if (commandRun.cancelled) {
      return addElapsedToReport(buildTaskReport('Cancelled by user.', {
        context: ['Execution was stopped from the UI.'],
        response: 'The current command was stopped. Any file changes already applied remain in the workspace.',
        summary: 'Cancelled by user.',
      }, Array.from(changedFiles), lastOutput), startedAt);
    }
    if (commandRun.ok) {
      return addElapsedToReport(buildTaskReport([
        `Passed after ${iteration} iteration${iteration === 1 ? '' : 's'}.`,
        finalSummary,
      ].join('\n'), plan, Array.from(changedFiles), lastOutput), startedAt);
    }

    feedback = [
      'A command failed during verification.',
      `Failed command: ${commandRun.failedCommand}`,
      '',
      lastOutput.slice(-8000),
    ].join('\n');
    try {
      const explanation = await explainFailure(task, feedback);
      postUpdate(`[${formatElapsed(startedAt)}] Command failed:\n${explanation}`);
    } catch (error) {
      postUpdate(`[${formatElapsed(startedAt)}] Command failed. I will retry with this output:\n${lastOutput.slice(-2000)}`);
    }
    postUpdate(`[${formatElapsed(startedAt)}] Iteration ${iteration}: asking for a fix...`);
  }

  return addElapsedToReport(buildFinalFailureReport(maxIterations, finalSummary, Array.from(changedFiles), lastOutput), startedAt);
}

async function autonomousFix(task, testCommand, postUpdate) {
  if (!getActiveFileContext()) {
    throw new Error('Open the file you want the agent to edit first.');
  }

  const { maxIterations } = getConfig();
  const cwd = getWorkspaceCwd();
  let feedback = '';
  let lastSummary = '';

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    postUpdate(`Iteration ${iteration}/${maxIterations}: editing active file...`);
    lastSummary = await applyEditToActiveFile(
      [
        task,
        '',
        'Autonomous loop requirements:',
        '- Make the smallest useful change to satisfy the task.',
        '- Preserve unrelated code.',
        '- Account for the latest test/check output if provided.',
      ].join('\n'),
      feedback
    );
    postUpdate(`Iteration ${iteration}: ${lastSummary}`);

    postUpdate(`Iteration ${iteration}: running ${testCommand}`);
    const result = await runShellCommand(testCommand, cwd);
    const output = result.output || '(command produced no output)';

    if (result.ok) {
      return [
        `Passed after ${iteration} iteration${iteration === 1 ? '' : 's'}.`,
        '',
        lastSummary,
        '',
        'Command output:',
        output.slice(-4000),
      ].join('\n');
    }

    feedback = [
      `Command: ${testCommand}`,
      `Exit code: ${result.code}`,
      'Output:',
      output.slice(-8000),
    ].join('\n');
    postUpdate(`Iteration ${iteration}: command failed. Feeding the error back into the agent.`);
  }

  return [
    'Result',
    `Stopped after ${maxIterations} attempts without a passing command.`,
    '',
    'Important context',
    '- The active-file helper used all configured retry attempts.',
    '- Increase patchMaster.maxIterations if you want it to keep trying longer.',
    '',
    'Agent answer',
    lastSummary || 'The task did not reach a passing command.',
    '',
    'Last command output',
    feedback.slice(-4000),
  ].join('\n');
}

function stripJsonFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

async function applyToActiveFileCommand() {
  const instruction = await vscode.window.showInputBox({
    prompt: 'What should the agent change in the active file?',
    placeHolder: 'Fix the bug, add validation, refactor this function...',
  });
  if (!instruction) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'PatchMaster is editing the active file',
      cancellable: false,
    },
    async () => {
      const summary = await applyEditToActiveFile(instruction);
      vscode.window.showInformationMessage(summary);
    }
  );
}

async function workspaceTaskCommand() {
  const task = await vscode.window.showInputBox({
    prompt: 'What should the agent create, run, and fix?',
    placeHolder: 'Create a Python reminder script and run a syntax check',
  });
  if (!task) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'PatchMaster workspace task',
      cancellable: false,
    },
    async (progress) => {
      activeRun = { cancelled: false, child: null };
      const report = await runWorkspaceTask(task, (message) => {
        progress.report({ message });
      }, [], []);
      activeRun = null;
      vscode.window.showInformationMessage(report.split('\n')[0]);
    }
  );
}

async function autonomousFixCommand() {
  const task = await vscode.window.showInputBox({
    prompt: 'Task or bug report for the autonomous agent',
    placeHolder: 'Fix the failing login validation test',
  });
  if (!task) {
    return;
  }

  const { defaultTestCommand } = getConfig();
  const testCommand = await vscode.window.showInputBox({
    prompt: 'Command the agent should run after each edit',
    value: defaultTestCommand,
    placeHolder: 'npm test, pytest, python -m unittest, node test.js...',
  });
  if (!testCommand) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `The agent will edit the active file and repeatedly run:\n\n${testCommand}`,
    { modal: true },
    'Start'
  );
  if (answer !== 'Start') {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'PatchMaster autonomous loop',
      cancellable: false,
    },
    async (progress) => {
      const report = await autonomousFix(task, testCommand, (message) => {
        progress.report({ message });
      });
      vscode.window.showInformationMessage(report.split('\n')[0]);
    }
  );
}

async function runCommandFromPrompt(commandFromChat) {
  const command = commandFromChat || await vscode.window.showInputBox({
    prompt: 'Terminal command to run',
    placeHolder: 'python api.py',
  });
  if (!command) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Run this command in the VS Code terminal?\n\n${command}`,
    { modal: true },
    'Run'
  );
  if (answer !== 'Run') {
    return;
  }

  const terminal = vscode.window.createTerminal('PatchMaster');
  terminal.show();
  terminal.sendText(command);
}

function openChat(context) {
  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  chatPanel = vscode.window.createWebviewPanel(
    'patchMasterChat',
    'PatchMaster',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  chatPanel.webview.html = getWebviewHtml(chatPanel.webview);

  chatPanel.onDidDispose(() => {
    chatPanel = undefined;
  }, null, context.subscriptions);

  chatPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.type === 'workspace') {
        chatHistory.push({ role: 'user', content: message.text });
        activeRun = { cancelled: false, child: null };
        const report = await runWorkspaceTask(message.text, (text) => {
          chatPanel.webview.postMessage({ type: 'status', text });
        }, Array.isArray(message.files) ? message.files : [], Array.isArray(message.uploadedFiles) ? message.uploadedFiles : []);
        activeRun = null;
        chatHistory.push({ role: 'assistant', content: report });
        chatPanel.webview.postMessage({ type: 'reply', text: report });
      }

      if (message.type === 'cancel') {
        const cancelled = cancelActiveRun();
        chatPanel.webview.postMessage({
          type: 'status',
          text: cancelled ? 'Cancellation requested. Stopping the active command...' : 'No active task is running.',
        });
      }

      if (message.type === 'clear') {
        chatHistory = [];
        chatPanel.webview.postMessage({ type: 'reply', text: 'Chat history cleared.' });
      }
    } catch (error) {
      activeRun = null;
      const fallback = [
        'I could not complete that task.',
        '',
        `What failed: ${error.message}`,
        '',
        'Try making the request more specific, or check that the OpenAI API key is set and the workspace folder is open.',
      ].join('\n');
      chatPanel.webview.postMessage({ type: 'error', text: fallback });
    }
  }, null, context.subscriptions);
}

function getWebviewHtml(webview) {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>PatchMaster</title>
  <style>
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    header { padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; align-items: center; justify-content: space-between; background: var(--vscode-sideBar-background); }
    h1 { margin: 0; font-size: 15px; font-weight: 700; }
    main { height: calc(100vh - 50px); display: flex; flex-direction: column; }
    #log { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 14px; scrollbar-width: thin; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
    #log::-webkit-scrollbar { width: 10px; }
    #log::-webkit-scrollbar-track { background: transparent; }
    #log::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
    #log::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); background-clip: content-box; }
    .message { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; margin-bottom: 12px; white-space: pre-wrap; line-height: 1.5; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
    .message-label { display: block; margin-bottom: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .message-body { display: block; }
    .section-title { display: block; margin-top: 10px; margin-bottom: 4px; font-weight: 800; color: var(--vscode-textLink-foreground); }
    .strong { font-weight: 800; color: var(--vscode-editor-foreground); }
    .section-title:first-child { margin-top: 0; }
    .user { background: var(--vscode-input-background); }
    .agent { background: var(--vscode-editor-inactiveSelectionBackground); }
    .status { background: transparent; border-style: dashed; }
    .error { color: var(--vscode-errorForeground); }
    .bar { border-top: 1px solid var(--vscode-panel-border); padding: 12px; display: grid; gap: 9px; background: var(--vscode-sideBar-background); }
    input { width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; font: inherit; }
    textarea { width: 100%; min-height: 70px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; font: inherit; }
    #filePicker { display: none; }
    #uploaded { display: flex; gap: 6px; flex-wrap: wrap; min-height: 20px; }
    .chip { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 8px; background: var(--vscode-editor-background); font-size: 12px; }
    .meta-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .field-label { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .buttons { display: flex; gap: 8px; flex-wrap: wrap; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 5px; padding: 8px 11px; cursor: pointer; font-weight: 700; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.danger { color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
    button:disabled { opacity: 0.7; cursor: wait; }
  </style>
</head>
<body>
  <header>
    <h1>PatchMaster</h1>
    <button id="clear" class="secondary">Clear</button>
  </header>
  <main>
    <div id="log"></div>
    <div class="bar">
      <textarea id="input" placeholder="Describe what to build, run, or fix."></textarea>
      <div class="buttons">
        <button id="upload" class="secondary">Upload Files</button>
        <input id="filePicker" type="file" multiple>
      </div>
      <div id="uploaded"></div>
      <div class="meta-row">
        <span id="runtime">Elapsed: 0s</span>
        <span>Shift+Enter for a new line</span>
      </div>
      <div class="buttons">
        <button id="workspace">Run and Fix</button>
        <button id="cancel" class="danger" disabled>Pause / Stop</button>
      </div>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const log = document.getElementById('log');
    const input = document.getElementById('input');
    const filePicker = document.getElementById('filePicker');
    const uploaded = document.getElementById('uploaded');
    const runtime = document.getElementById('runtime');
    const buttons = Array.from(document.querySelectorAll('button'));
    const cancelButton = document.getElementById('cancel');
    let uploadedFiles = [];
    let timer = null;
    let startedAt = 0;

    function formatElapsed(ms) {
      const seconds = Math.max(0, Math.round(ms / 1000));
      const minutes = Math.floor(seconds / 60);
      const remainder = seconds % 60;
      return minutes ? minutes + 'm ' + remainder + 's' : remainder + 's';
    }

    function startTimer() {
      startedAt = Date.now();
      runtime.textContent = 'Elapsed: 0s';
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        runtime.textContent = 'Elapsed: ' + formatElapsed(Date.now() - startedAt);
      }, 1000);
    }

    function stopTimer() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (startedAt) {
        runtime.textContent = 'Elapsed: ' + formatElapsed(Date.now() - startedAt);
      }
    }

    function setBusy(busy) {
      buttons.forEach((button) => {
        if (button.id !== 'cancel') button.disabled = busy;
      });
      cancelButton.disabled = !busy;
    }

    function add(text, type) {
      const item = document.createElement('div');
      item.className = 'message ' + type;
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = type === 'user'
        ? 'Human'
        : type === 'agent'
          ? 'Agent'
          : type === 'status'
            ? 'Agent status'
            : 'Error';
      const body = document.createElement('span');
      body.className = 'message-body';
      renderBody(body, text);
      item.appendChild(label);
      item.appendChild(body);
      log.appendChild(item);
      log.scrollTop = log.scrollHeight;
    }

    function renderBody(container, text) {
      const sections = new Set([
        'Result',
        'Elapsed time',
        'Important context',
        'Agent answer',
        'Files changed',
        'Command output',
        'Last command output',
      ]);
      const lines = text.split('\\n');
      lines.forEach((line, index) => {
        if (sections.has(line.trim())) {
          const title = document.createElement('span');
          title.className = 'section-title';
          title.textContent = line;
          container.appendChild(title);
        } else {
          appendInline(container, line);
        }
        if (index < lines.length - 1) {
          container.appendChild(document.createElement('br'));
        }
      });
    }

    function appendInline(container, line) {
      const parts = line.split(/(\\*\\*[^*]+\\*\\*)/g);
      parts.forEach((part) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          const strong = document.createElement('span');
          strong.className = 'strong';
          strong.textContent = part.slice(2, -2);
          container.appendChild(strong);
        } else {
          container.appendChild(document.createTextNode(part));
        }
      });
    }

    function renderUploadedFiles() {
      uploaded.textContent = '';
      uploadedFiles.forEach((file) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = file.name;
        uploaded.appendChild(chip);
      });
    }

    function readFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({
          name: file.name,
          content: String(reader.result || ''),
        });
        reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
        reader.readAsText(file);
      });
    }

    function send(type) {
      const text = input.value.trim();
      if (!text && type !== 'clear') return;
      if (type !== 'clear') {
        add(text, 'user');
        input.value = '';
      }
      if (type !== 'clear') {
        startTimer();
      }
      setBusy(true);
      vscode.postMessage({ type, text, files: [], uploadedFiles });
    }

    document.getElementById('workspace').addEventListener('click', () => send('workspace'));
    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    document.getElementById('upload').addEventListener('click', () => filePicker.click());
    filePicker.addEventListener('change', async () => {
      const selected = Array.from(filePicker.files || []);
      const read = await Promise.all(selected.map(readFile));
      uploadedFiles = uploadedFiles.concat(read);
      renderUploadedFiles();
      filePicker.value = '';
    });
    document.getElementById('clear').addEventListener('click', () => send('clear'));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send('workspace');
      }
    });

    window.addEventListener('message', (event) => {
      setBusy(false);
      if (event.data.type === 'reply') {
        stopTimer();
        add(event.data.text, 'agent');
      }
      if (event.data.type === 'status') {
        setBusy(true);
        add(event.data.text, 'status');
      }
      if (event.data.type === 'error') {
        stopTimer();
        add(event.data.text, 'error');
      }
      input.focus();
    });

    add('Describe one build, run, install, or fix task. Upload any files I should inspect, then I will show live command output while installs run, ask before running commands, and retry with command output if something fails.', 'agent');
  </script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate,
};
