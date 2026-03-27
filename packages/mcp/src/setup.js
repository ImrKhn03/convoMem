#!/usr/bin/env node
'use strict';

/**
 * ConvoMem MCP Auto-Setup CLI
 *
 * Usage:
 *   npx convomem-mcp-setup --api-key sk-ls-xxx
 *   npx convomem-mcp-setup --api-key sk-ls-xxx --base-url https://api.myconvomem.com
 *   npx convomem-mcp-setup --api-key sk-ls-xxx --only vscode,cursor
 *   npx convomem-mcp-setup --api-key sk-ls-xxx --all
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HOME = os.homedir();
const PLATFORM = process.platform;

// ─── ANSI colors ─────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  underline: '\x1b[4m',
  // Foreground
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  // Background
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

function log(msg = '') { process.stdout.write(msg + '\n'); }
function ok(msg) { log(`  ${c.green}✓${c.reset} ${msg}`); }
function info(msg) { log(`  ${c.cyan}→${c.reset} ${msg}`); }
function warn(msg) { log(`  ${c.yellow}⚠${c.reset} ${c.yellow}${msg}${c.reset}`); }
function err(msg) { log(`  ${c.red}✗${c.reset} ${c.red}${msg}${c.reset}`); }

// ─── MCP command resolution ─────────────────────────────────────────────────

const NPX_COMMAND = { command: 'npx', args: ['-y', 'convomem-mcp'] };
const LOCAL_COMMAND = { command: 'node', args: [path.resolve(__dirname, 'index.js')] };

function getMcpCommand() {
  // If running from node_modules, the user installed via npm
  if (__dirname.includes('node_modules')) return NPX_COMMAND;
  try {
    const { execSync } = require('child_process');
    execSync('npm list -g convomem-mcp --depth=0 2>/dev/null', { encoding: 'utf8' });
    return NPX_COMMAND;
  } catch { /* not global */ }
  return LOCAL_COMMAND;
}

// ─── Prompt strings ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You have access to ConvoMem memory tools. At the start of every conversation, ' +
  'call convomem_lookup with the user\'s first message as the topic to retrieve relevant personal context. ' +
  'Use any returned context naturally in your response — never quote it verbatim or mention the lookup. ' +
  'When the user shares new preferences, facts, or decisions, call convomem_capture at the end of the ' +
  'conversation to save them. This gives the user a persistent memory across all sessions.';

const COPILOT_INSTRUCTION =
  'You have access to ConvoMem memory tools via MCP. ' +
  'At the start of EVERY conversation, you MUST call convomem_lookup with the user\'s first message as the topic. ' +
  'Use any returned context naturally — never mention the lookup. ' +
  'When the user shares preferences, decisions, or facts, call convomem_capture with the conversation messages. ' +
  'After responding, call convomem_feedback with the memory IDs from the lookup to signal whether the context was helpful — this improves future injection quality.';

const CLAUDE_MD_BLOCK =
  '\n## ConvoMem Memory (auto-injected)\n\n' +
  'You have access to ConvoMem memory tools via MCP.\n' +
  'At the start of every conversation, call `convomem_lookup` with the user\'s first message as the topic.\n' +
  'Use any returned context naturally — do not quote it or mention the lookup.\n' +
  'When the user shares new preferences, decisions, or facts, call `convomem_capture` with the full conversation.\n' +
  'After responding, call `convomem_feedback` with the memory IDs from the lookup to signal whether the injected context was helpful.\n';

// ─── Config paths ────────────────────────────────────────────────────────────

function getClaudeDesktopConfigPath() {
  if (PLATFORM === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (PLATFORM === 'win32') return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  return path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
}

function getVSCodeUserDir() {
  if (PLATFORM === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Code', 'User');
  if (PLATFORM === 'win32') return path.join(process.env.APPDATA || '', 'Code', 'User');
  return path.join(HOME, '.config', 'Code', 'User');
}

function getVSCodeMcpPath() { return path.join(getVSCodeUserDir(), 'mcp.json'); }
function getVSCodeSettingsPath() { return path.join(getVSCodeUserDir(), 'settings.json'); }

function getCursorConfigPath() { return path.join(HOME, '.cursor', 'mcp.json'); }
function getClaudeCodeMdPath() { return path.join(HOME, '.claude', 'CLAUDE.md'); }
function getOpenCodeConfigPath() { return path.join(HOME, '.config', 'opencode', 'opencode.json'); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  } catch { return {}; }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function fileExists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

// ─── Interactive TUI ─────────────────────────────────────────────────────────

/**
 * Fallback numbered-list selector for non-TTY environments.
 */
async function fallbackSelect(items) {
  log();
  items.forEach((item, i) => {
    const status = item.available ? `${c.green}✓${c.reset}` : `${c.dim}—${c.reset}`;
    const label = item.available ? item.name : `${c.dim}${item.name} (not installed)${c.reset}`;
    log(`    ${status} ${i + 1}. ${label}`);
  });
  log();
  log(`  ${c.dim}Enter numbers (e.g. 1,2) or "a" for all detected:${c.reset}`);
  const answer = await textInput('Selection:');
  if (!answer || answer.toLowerCase() === 'a') {
    return items.filter((i) => i.available).map((i) => i.key);
  }
  return answer.split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && items[n - 1])
    .map((n) => items[n - 1].key);
}

/**
 * Arrow-key driven checkbox selector.
 * Falls back to numbered list if stdin is not a TTY.
 * Returns array of selected item keys.
 */
async function interactiveSelect(items) {
  // Fallback for non-TTY (piped input, CI, etc.)
  if (!process.stdin.isTTY) {
    return fallbackSelect(items);
  }

  return new Promise((resolve) => {
    let cursor = 0;
    const selected = new Set();

    function render() {
      // Move cursor up to overwrite previous render
      if (renderCount > 0) {
        process.stdout.write(`\x1b[${items.length + 3}A`);
      }

      log(`  ${c.dim}Use ${c.reset}${c.bold}↑↓${c.reset}${c.dim} to move, ${c.reset}${c.bold}space${c.reset}${c.dim} to toggle, ${c.reset}${c.bold}enter${c.reset}${c.dim} to confirm, ${c.reset}${c.bold}a${c.reset}${c.dim} all${c.reset}`);
      log();

      items.forEach((item, i) => {
        const isCursor = i === cursor;
        const isSelected = selected.has(item.key);
        const isAvailable = item.available;

        const pointer = isCursor ? `${c.cyan}❯${c.reset}` : ' ';
        const checkbox = isSelected
          ? `${c.green}◉${c.reset}`
          : `${c.dim}○${c.reset}`;
        const label = isAvailable
          ? (isCursor ? `${c.bold}${c.white}${item.name}${c.reset}` : item.name)
          : `${c.dim}${item.name} (not installed)${c.reset}`;

        log(` ${pointer} ${checkbox}  ${label}`);
      });

      log();
      renderCount++;
    }

    let renderCount = 0;

    // Enable raw mode for keypress detection
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    render();

    process.stdin.on('data', (key) => {
      // Ctrl+C
      if (key === '\x03') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        log('\n  Cancelled.');
        process.exit(0);
      }

      // Enter
      if (key === '\r' || key === '\n') {
        if (selected.size === 0) {
          // Nothing selected — hint the user
          process.stdout.write(`\x1b[1A\x1b[K  ${c.yellow}Use space to select at least one, or 'a' for all${c.reset}\n`);
          return;
        }
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeAllListeners('data');
        const result = items.filter((i) => selected.has(i.key)).map((i) => i.key);
        resolve(result);
        return;
      }

      // Space — toggle
      if (key === ' ') {
        const item = items[cursor];
        if (item.available) {
          if (selected.has(item.key)) selected.delete(item.key);
          else selected.add(item.key);
        }
        render();
        return;
      }

      // Arrow keys (escape sequences)
      if (key === '\x1b[A') { // Up
        cursor = cursor > 0 ? cursor - 1 : items.length - 1;
        render();
      } else if (key === '\x1b[B') { // Down
        cursor = cursor < items.length - 1 ? cursor + 1 : 0;
        render();
      }

      // 'a' to select all available
      if (key === 'a') {
        items.forEach((i) => { if (i.available) selected.add(i.key); });
        render();
      }

      // 'n' to deselect all
      if (key === 'n') {
        selected.clear();
        render();
      }
    });
  });
}

/**
 * Animated text input with label.
 */
async function textInput(label) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${c.cyan}?${c.reset} ${label} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Integration detection ───────────────────────────────────────────────────

const INTEGRATIONS = [
  {
    key: 'claude-desktop',
    name: 'Claude Desktop',
    detect: () => {
      if (PLATFORM === 'darwin') return fileExists('/Applications/Claude.app');
      return fileExists(path.dirname(getClaudeDesktopConfigPath()));
    },
  },
  {
    key: 'vscode',
    name: 'VS Code',
    detect: () => fileExists(getVSCodeUserDir()),
  },
  {
    key: 'cursor',
    name: 'Cursor',
    detect: () => {
      if (PLATFORM === 'darwin') return fileExists('/Applications/Cursor.app') || fileExists(path.join(HOME, '.cursor'));
      return fileExists(path.join(HOME, '.cursor'));
    },
  },
  {
    key: 'claude-code',
    name: 'Claude Code CLI',
    detect: () => {
      try {
        const { execSync } = require('child_process');
        execSync('which claude', { stdio: 'ignore' });
        return true;
      } catch { return fileExists(path.join(HOME, '.claude')); }
    },
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    detect: () => {
      try {
        const { execSync } = require('child_process');
        execSync('which opencode', { stdio: 'ignore' });
        return true;
      } catch {}
      return fileExists(path.join(HOME, '.config', 'opencode'));
    },
  },
];

// ─── Setup functions ─────────────────────────────────────────────────────────

function setupClaudeDesktop(apiKey, baseUrl, mcpCmd) {
  const configPath = getClaudeDesktopConfigPath();
  const config = readJSON(configPath);

  config.mcpServers = config.mcpServers || {};
  config.mcpServers.convomem = {
    command: mcpCmd.command,
    args: [...mcpCmd.args],
    env: { CONVOMEM_API_KEY: apiKey, CONVOMEM_BASE_URL: baseUrl },
  };

  writeJSON(configPath, config);
  ok('MCP server added to Claude Desktop config');

  if (PLATFORM === 'darwin') {
    try {
      const { execSync } = require('child_process');
      execSync('pbcopy', { input: SYSTEM_PROMPT });
      ok('System prompt copied to clipboard');
      info('Paste it into Claude Desktop → Settings → Custom Instructions');
    } catch { /* */ }
  }

  return true;
}

function setupVSCode(apiKey, baseUrl, mcpCmd) {
  const mcpPath = getVSCodeMcpPath();
  const settingsPath = getVSCodeSettingsPath();

  // 1. Write MCP server to dedicated mcp.json (VS Code 1.99+)
  const mcpConfig = readJSON(mcpPath);
  mcpConfig.servers = mcpConfig.servers || {};
  mcpConfig.servers.convomem = {
    type: 'stdio',
    command: mcpCmd.command,
    args: [...mcpCmd.args],
    env: { CONVOMEM_API_KEY: apiKey, CONVOMEM_BASE_URL: baseUrl },
  };
  if (!mcpConfig.inputs) mcpConfig.inputs = [];
  writeJSON(mcpPath, mcpConfig);
  ok(`MCP server added → ${c.dim}mcp.json${c.reset}`);

  // 2. Remove legacy MCP keys from settings.json (avoid VS Code warnings)
  const settings = readJSON(settingsPath);
  let settingsChanged = false;

  if (settings.mcp) {
    delete settings.mcp;
    settingsChanged = true;
  }
  if (settings['github.copilot.chat.mcp.servers']) {
    delete settings['github.copilot.chat.mcp.servers'];
    settingsChanged = true;
  }

  // 3. Add/update Copilot instructions — always replace to pick up new tool additions
  const instructions = settings['github.copilot.chat.codeGeneration.instructions'] || [];
  const existingIdx = instructions.findIndex((i) => i.text && i.text.includes('convomem_lookup'));
  if (existingIdx >= 0) {
    instructions[existingIdx] = { text: COPILOT_INSTRUCTION };
    ok('Copilot instructions updated');
  } else {
    instructions.push({ text: COPILOT_INSTRUCTION });
    ok('Copilot auto-lookup instructions added');
  }
  settings['github.copilot.chat.codeGeneration.instructions'] = instructions;
  settingsChanged = true;

  if (settingsChanged) writeJSON(settingsPath, settings);
  return true;
}

function setupCursor(apiKey, baseUrl, mcpCmd) {
  const configPath = getCursorConfigPath();
  const config = readJSON(configPath);

  config.mcpServers = config.mcpServers || {};
  config.mcpServers.convomem = {
    command: mcpCmd.command,
    args: [...mcpCmd.args],
    env: { CONVOMEM_API_KEY: apiKey, CONVOMEM_BASE_URL: baseUrl },
  };

  writeJSON(configPath, config);
  ok('MCP server added to Cursor config');
  return true;
}

function setupClaudeCode(apiKey, baseUrl, mcpCmd) {
  const { execSync } = require('child_process');
  const claudeMdPath = getClaudeCodeMdPath();

  let claudeBin = 'claude';
  try { claudeBin = execSync('which claude', { encoding: 'utf8' }).trim(); } catch { /* */ }

  try {
    try { execSync(`${claudeBin} mcp remove convomem -s user`, { stdio: 'ignore' }); } catch { /* */ }
    const cmdStr = mcpCmd.args.join(' ');
    execSync(
      `${claudeBin} mcp add convomem -s user ` +
      `-e CONVOMEM_API_KEY=${apiKey} -e CONVOMEM_BASE_URL=${baseUrl} ` +
      `-- ${mcpCmd.command} ${cmdStr}`,
      { stdio: 'ignore' }
    );
    ok('MCP server registered with Claude Code (user scope)');
  } catch (e) {
    warn(`Claude Code registration failed: ${e.message}`);
    return false;
  }

  fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
  let existing = '';
  try { existing = fs.readFileSync(claudeMdPath, 'utf8'); } catch { /* */ }
  if (existing.includes('ConvoMem Memory')) {
    // Replace existing block — strip from the header to the next ## heading or end of file
    existing = existing.replace(/\n## ConvoMem Memory[^\n]*\n[\s\S]*?(?=\n## |\n# |$)/, CLAUDE_MD_BLOCK);
    ok('Auto-lookup instructions updated in ~/.claude/CLAUDE.md');
  } else {
    existing = existing + CLAUDE_MD_BLOCK;
    ok('Auto-lookup instructions added to ~/.claude/CLAUDE.md');
  }
  fs.writeFileSync(claudeMdPath, existing, 'utf8');

  return true;
}

function setupOpenCode(apiKey, baseUrl, mcpCmd) {
  const configPath = getOpenCodeConfigPath();
  const config = readJSON(configPath);

  config.mcp = config.mcp || {};
  config.mcp.convomem = {
    type: 'local',
    command: [mcpCmd.command, ...mcpCmd.args],
    enabled: true,
    environment: {
      CONVOMEM_API_KEY: apiKey,
      CONVOMEM_BASE_URL: baseUrl,
    },
  };

  writeJSON(configPath, config);
  ok('MCP server added to OpenCode config');
  return true;
}

const SETUP_FN = {
  'claude-desktop': setupClaudeDesktop,
  'vscode': setupVSCode,
  'cursor': setupCursor,
  'claude-code': setupClaudeCode,
  'opencode': setupOpenCode,
};

// ─── Uninstall functions ──────────────────────────────────────────────────────

function uninstallClaudeDesktop() {
  const configPath = getClaudeDesktopConfigPath();
  const config = readJSON(configPath);
  if (config.mcpServers?.convomem) {
    delete config.mcpServers.convomem;
    writeJSON(configPath, config);
    ok('Removed convomem from Claude Desktop config');
  } else {
    info('ConvoMem not found in Claude Desktop config');
  }
}

function uninstallVSCode() {
  const mcpPath = getVSCodeMcpPath();
  const settingsPath = getVSCodeSettingsPath();

  const mcpConfig = readJSON(mcpPath);
  if (mcpConfig.servers?.convomem) {
    delete mcpConfig.servers.convomem;
    writeJSON(mcpPath, mcpConfig);
    ok('Removed convomem from VS Code mcp.json');
  } else {
    info('ConvoMem not found in VS Code mcp.json');
  }

  const settings = readJSON(settingsPath);
  const instructions = settings['github.copilot.chat.codeGeneration.instructions'] || [];
  const filtered = instructions.filter((i) => !i.text?.includes('convomem_lookup'));
  if (filtered.length !== instructions.length) {
    settings['github.copilot.chat.codeGeneration.instructions'] = filtered;
    writeJSON(settingsPath, settings);
    ok('Removed ConvoMem Copilot instructions from VS Code settings.json');
  }
}

function uninstallCursor() {
  const configPath = getCursorConfigPath();
  const config = readJSON(configPath);
  if (config.mcpServers?.convomem) {
    delete config.mcpServers.convomem;
    writeJSON(configPath, config);
    ok('Removed convomem from Cursor config');
  } else {
    info('ConvoMem not found in Cursor config');
  }
}

function uninstallClaudeCode() {
  const { execSync } = require('child_process');
  const claudeMdPath = getClaudeCodeMdPath();

  let claudeBin = 'claude';
  try { claudeBin = execSync('which claude', { encoding: 'utf8' }).trim(); } catch { /* */ }

  // Remove both old (lifesync) and new (convomem) registration names
  let removed = false;
  for (const name of ['convomem', 'lifesync']) {
    try {
      execSync(`${claudeBin} mcp remove ${name} -s user`, { stdio: 'pipe' });
      ok(`Removed '${name}' MCP server from Claude Code`);
      removed = true;
    } catch { /* not registered under this name */ }
  }
  if (!removed) info('No ConvoMem/LifeSync MCP server found in Claude Code');

  // Remove both old and new CLAUDE.md blocks
  try {
    let content = fs.readFileSync(claudeMdPath, 'utf8');
    const original = content;
    content = content.replace(/\n## ConvoMem Memory[^\n]*\n[\s\S]*?(?=\n## |\n# |$)/, '');
    content = content.replace(/\n## LifeSync Memory[^\n]*\n[\s\S]*?(?=\n## |\n# |$)/, '');
    if (content !== original) {
      fs.writeFileSync(claudeMdPath, content, 'utf8');
      ok('Removed memory block from ~/.claude/CLAUDE.md');
    } else {
      info('No memory block found in ~/.claude/CLAUDE.md');
    }
  } catch { /* file doesn't exist */ }
}

function uninstallOpenCode() {
  const configPath = getOpenCodeConfigPath();
  const config = readJSON(configPath);
  if (config.mcp?.convomem) {
    delete config.mcp.convomem;
    writeJSON(configPath, config);
    ok('Removed convomem from OpenCode config');
  } else {
    info('ConvoMem not found in OpenCode config');
  }
}

const UNINSTALL_FN = {
  'claude-desktop': uninstallClaudeDesktop,
  'vscode': uninstallVSCode,
  'cursor': uninstallCursor,
  'claude-code': uninstallClaudeCode,
  'opencode': uninstallOpenCode,
};

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { apiKey: null, baseUrl: 'http://localhost:8000', only: null, all: false, uninstall: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-key' && args[i + 1]) result.apiKey = args[++i];
    else if (args[i] === '--base-url' && args[i + 1]) result.baseUrl = args[++i];
    else if (args[i] === '--only' && args[i + 1]) result.only = args[++i].split(',').map((s) => s.trim());
    else if (args[i] === '--all') result.all = true;
    else if (args[i] === '--uninstall') result.uninstall = true;
  }
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log();
  const parsed = parseArgs();

  // ── Uninstall mode ──────────────────────────────────────────────────────────
  if (parsed.uninstall) {
    log(`  ${c.bold}${c.magenta}ConvoMem${c.reset} ${c.bold}MCP Uninstall${c.reset}`);
    log(`  ${c.dim}─────────────────────────────────${c.reset}`);
    log();

    let selected;
    if (parsed.only) {
      selected = parsed.only.filter((k) => UNINSTALL_FN[k]);
    } else if (parsed.all) {
      selected = Object.keys(UNINSTALL_FN);
    } else {
      log(`  ${c.bold}Select integrations to remove:${c.reset}`);
      log();
      const items = INTEGRATIONS.map((i) => ({ key: i.key, name: i.name, available: true }));
      selected = await interactiveSelect(items);
    }

    if (selected.length === 0) { warn('Nothing selected.'); process.exit(0); }

    log();
    for (const key of selected) UNINSTALL_FN[key]();

    log();
    log(`  ${c.green}${c.bold}Uninstall complete!${c.reset}`);
    log();
    if (selected.includes('claude-desktop')) info('Restart Claude Desktop');
    if (selected.includes('vscode'))         info('Restart VS Code');
    if (selected.includes('cursor'))         info('Restart Cursor');
    if (selected.includes('opencode'))       info('Restart OpenCode');
    log();
    return;
  }

  // ── Setup mode ──────────────────────────────────────────────────────────────
  log(`  ${c.bold}${c.magenta}ConvoMem${c.reset} ${c.bold}MCP Setup${c.reset}`);
  log(`  ${c.dim}─────────────────────────────────${c.reset}`);
  log();

  // 1. Get API key
  let apiKey = parsed.apiKey;
  if (!apiKey) {
    log(`  ${c.dim}Get a key from your ConvoMem dashboard or via API:${c.reset}`);
    log(`  ${c.dim}  POST /api/auth/api-keys with your JWT${c.reset}`);
    log();
    apiKey = await textInput(`API key ${c.dim}(sk-cm-...)${c.reset}:`);
  }

  if (!apiKey || !apiKey.startsWith('sk-cm-')) {
    log();
    err('Invalid API key — must start with sk-cm-');
    process.exit(1);
  }
  ok(`API key: ${c.dim}${apiKey.slice(0, 10)}...${apiKey.slice(-4)}${c.reset}`);

  // 2. Resolve command format
  const mcpCmd = getMcpCommand();
  if (mcpCmd === LOCAL_COMMAND) {
    log();
    warn(`Dev mode — using local path. Publish to npm for portable ${c.bold}npx${c.reset}${c.yellow} command.${c.reset}`);
  }

  // 3. Verify API connectivity BEFORE writing any configs
  log();
  process.stdout.write(`  ${c.dim}Verifying API connection at ${parsed.baseUrl}...${c.reset}`);
  try {
    const resp = await fetch(`${parsed.baseUrl}/api/memories?limit=1`, {
      headers: { 'X-API-Key': apiKey },
    });
    process.stdout.write('\r\x1b[K');

    if (resp.status === 401) {
      err('API key rejected (HTTP 401) — check your key and try again');
      process.exit(1);
    }

    if (resp.status === 403) {
      err('Access forbidden (HTTP 403) — key may lack required permissions');
      process.exit(1);
    }

    if (!resp.ok) {
      warn(`Server returned HTTP ${resp.status}`);
      const answer = await textInput('Proceed with setup anyway? (y/N):');
      if (!answer.toLowerCase().startsWith('y')) {
        info('Setup cancelled.');
        process.exit(0);
      }
    } else {
      ok(`API connected at ${c.dim}${parsed.baseUrl}${c.reset}`);
    }
  } catch (e) {
    process.stdout.write('\r\x1b[K');
    warn(`Cannot reach ${parsed.baseUrl} — ${e.message}`);
    info('Server may not be running yet.');
    const answer = await textInput('Save config anyway and connect later? (Y/n):');
    if (answer.toLowerCase().startsWith('n')) {
      info('Setup cancelled.');
      process.exit(0);
    }
  }

  // 4. Pick integrations
  let selected;
  if (parsed.only) {
    selected = parsed.only.filter((k) => SETUP_FN[k]);
  } else if (parsed.all) {
    selected = INTEGRATIONS.filter((i) => i.detect()).map((i) => i.key);
  } else {
    log();
    log(`  ${c.bold}Select integrations to configure:${c.reset}`);
    log();

    const items = INTEGRATIONS.map((i) => ({
      key: i.key,
      name: i.name,
      available: i.detect(),
    }));

    selected = await interactiveSelect(items);
  }

  if (selected.length === 0) {
    log();
    warn('Nothing selected.');
    process.exit(0);
  }

  // 5. Configure each selected integration
  log();
  log(`  ${c.bold}Configuring ${selected.length} integration${selected.length > 1 ? 's' : ''}...${c.reset}`);
  log();

  const results = {};
  for (const key of selected) {
    results[key] = SETUP_FN[key](apiKey, parsed.baseUrl, mcpCmd);
  }

  // 6. Done
  log();
  log(`  ${c.green}${c.bold}Setup complete!${c.reset}`);
  log();
  if (results['claude-desktop']) info('Restart Claude Desktop');
  if (results['vscode'])         info('Restart VS Code — tools auto-activate in Copilot Agent mode');
  if (results['cursor'])         info('Restart Cursor');
  if (results['claude-code'])    info('Claude Code ready — memory active on next session');
  if (results['opencode'])       info('Restart OpenCode');
  log();
}

main().catch((e) => {
  log();
  err(`Setup failed: ${e.message}`);
  process.exit(1);
});
