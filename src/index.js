#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('./config');

const SESSION_NAME = 'mega-terminal';
const WORK_DIR = path.join(os.tmpdir(), 'mega-terminal');
const CLAUDE_LOG = path.join(WORK_DIR, 'claude.log');
const CODEX_LOG = path.join(WORK_DIR, 'codex.log');
const ROUTER_LOG = path.join(WORK_DIR, 'router.log');

// --- Utility ---

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function log(msg) {
  const timestamp = new Date().toISOString().slice(11, 19);
  fs.appendFileSync(ROUTER_LOG, `[${timestamp}] ${msg}\n`);
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[([0-9]*)C/g, (_, n) => ' '.repeat(parseInt(n) || 1))
    .replace(/\x1b\[[0-9;]*[A-BD-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b\[?[?;0-9]*[hl]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function escapeTmux(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

function sendToPane(pane, message) {
  // Use tmux load-buffer + paste-buffer to avoid send-keys length limits
  const tmpFile = path.join(WORK_DIR, `msg-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpFile, message);
    run(`tmux load-buffer -b mega-msg '${tmpFile}'`);
    run(`tmux paste-buffer -b mega-msg -t ${SESSION_NAME}:0.${pane}`);
    run(`sleep 0.5 && tmux send-keys -t ${SESSION_NAME}:0.${pane} Enter`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// --- Setup ---

function setupWorkDir() {
  if (!fs.existsSync(WORK_DIR)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
  }
  for (const f of [CLAUDE_LOG, CODEX_LOG, ROUTER_LOG]) {
    try { fs.unlinkSync(f); } catch {}
  }
  fs.writeFileSync(CLAUDE_LOG, '');
  fs.writeFileSync(CODEX_LOG, '');
  fs.writeFileSync(ROUTER_LOG, '');
}

// --- tmux ---

function killExistingSession() {
  run(`tmux kill-session -t ${SESSION_NAME} 2>/dev/null`);
}

function createTmuxSession() {
  const t = config.theme;

  const claudeCmd = `${config.claude.command} ${config.claude.args.join(' ')}`;
  const codexCmd = `${config.codex.command} ${config.codex.args.join(' ')}`;

  run(`tmux -u new-session -d -s ${SESSION_NAME}`);
  run(`tmux split-window -h -t ${SESSION_NAME}`);
  run(`tmux select-layout -t ${SESSION_NAME} even-horizontal`);

  // Pane titles
  run(`tmux select-pane -t ${SESSION_NAME}:0.0 -T "Claude"`);
  run(`tmux select-pane -t ${SESSION_NAME}:0.1 -T "Codex"`);
  run(`tmux set-option -t ${SESSION_NAME} pane-border-status top`);
  run(`tmux set-option -t ${SESSION_NAME} pane-border-format " #{?pane_active,#[bold],#[dim]} #{pane_title} #[default]"`);

  // Border colors
  run(`tmux set-hook -t ${SESSION_NAME} after-select-pane "if-shell 'test #{pane_index} -eq 0' 'set pane-active-border-style fg=${t.claude.border},bold' 'set pane-active-border-style fg=${t.codex.border},bold'"`);
  run(`tmux set-option -t ${SESSION_NAME} pane-active-border-style "fg=${t.claude.border},bold"`);
  run(`tmux set-option -t ${SESSION_NAME} pane-border-style "fg=colour240"`);

  // Status bar
  run(`tmux set-option -t ${SESSION_NAME} status-style "bg=${t.statusBar.bg},fg=${t.statusBar.fg}"`);
  run(`tmux set-option -t ${SESSION_NAME} status-left " #[bold,fg=${t.claude.label}]Claude#[default,fg=white] + #[bold,fg=${t.codex.label}]Codex#[default] | "`);
  run(`tmux set-option -t ${SESSION_NAME} status-left-length 40`);
  run(`tmux set-option -t ${SESSION_NAME} status-right " Opt+Drag:Copy | Ctrl+B d:Detach "`);
  run(`tmux set-option -t ${SESSION_NAME} status-right-length 45`);

  // Mouse
  run(`tmux set-option -t ${SESSION_NAME} mouse on`);

  // Resize-friendly: use latest client size, aggressive resize
  run(`tmux set-option -t ${SESSION_NAME} window-size latest`);
  run(`tmux set-option -t ${SESSION_NAME} aggressive-resize on`);

  // Pipe pane output to log files (append-only, resize-proof)
  run(`tmux pipe-pane -t ${SESSION_NAME}:0.0 -o "cat >> '${CLAUDE_LOG}'"`);
  run(`tmux pipe-pane -t ${SESSION_NAME}:0.1 -o "cat >> '${CODEX_LOG}'"`);

  // Launch
  run(`tmux send-keys -t ${SESSION_NAME}:0.0 "${claudeCmd}" Enter`);
  run(`tmux send-keys -t ${SESSION_NAME}:0.1 "${codexCmd}" Enter`);
  run(`tmux select-pane -t ${SESSION_NAME}:0.0`);
}

// --- Message Router ---

// Hybrid approach: pipe-pane file size detects new content (resize-immune),
// capture-pane gets clean visible text (no ANSI codes, no TUI chrome)

function hasNewContent(filePath, sizeObj, key) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > sizeObj[key]) {
      sizeObj[key] = stat.size;
      return true;
    }
  } catch {}
  return false;
}

function capturePane(pane) {
  // -J: join wrapped lines, -p: to stdout, -S -80: last 80 lines of scrollback
  return run(`tmux capture-pane -J -p -S -80 -t ${SESSION_NAME}:0.${pane}`);
}

function sanitizeRoutedMessage(msg) {
  return stripAnsi(msg)
    .replace(/\r/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMessages(text, tag, labelSelf, labelOther, options = {}) {
  const maxLen = options.maxLen || 0;
  const results = [];
  const cleaned = stripAnsi(text);
  const lines = cleaned.split('\n');
  const prefix = tag.toLowerCase();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes(labelSelf) || line.includes(labelOther)) continue;
    if (!line.toLowerCase().startsWith(prefix)) continue;

    const msgRaw = line.slice(tag.length);
    const msg = sanitizeRoutedMessage(msgRaw);
    if (!msg || msg.length < 3) continue;
    if (maxLen > 0 && msg.length > maxLen) continue;
    results.push(msg);
  }
  return results;
}

function startMessageRouter() {
  const fileSize = { claude: 0, codex: 0 };
  const sentMessages = new Map();
  const MESSAGE_TTL_MS = 10 * 60 * 1000;
  const MAX_TRACKED = 200;

  log('Router started');

  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of sentMessages.entries()) {
      if (now - ts > MESSAGE_TTL_MS) sentMessages.delete(key);
    }

    // --- Claude pane: detect new content, extract @codex: messages ---
    if (hasNewContent(CLAUDE_LOG, fileSize, 'claude')) {
      const captured = capturePane(0);
      if (captured) {
        // Skip last line (may be partial input line)
        const lines = captured.split('\n');
        const text = lines.slice(0, -1).join('\n');
        const messages = extractMessages(text, '@codex:', '[From Claude]', '[From Codex]');
        for (const msg of messages) {
          const key = 'c2x:' + msg.slice(0, 120);
          if (!sentMessages.has(key)) {
            sentMessages.set(key, now);
            log(`ROUTE Claude->Codex: ${msg.slice(0, 200)}`);
            sendToPane(1, `[From Claude] ${msg}`);
          }
        }
      }
    }

    // --- Codex pane: detect new content, extract @claude: messages ---
    if (hasNewContent(CODEX_LOG, fileSize, 'codex')) {
      const captured = capturePane(1);
      if (captured) {
        const lines = captured.split('\n');
        const text = lines.slice(0, -1).join('\n');
        const messages = extractMessages(
          text,
          '@claude:',
          '[From Codex]',
          '[From Claude]',
          { maxLen: 52 }
        );
        for (const msg of messages) {
          const key = 'x2c:' + msg.slice(0, 120);
          if (!sentMessages.has(key)) {
            sentMessages.set(key, now);
            log(`ROUTE Codex->Claude: ${msg.slice(0, 200)}`);
            sendToPane(0, `[From Codex] ${msg}`);
          }
        }
      }
    }

    while (sentMessages.size > MAX_TRACKED) {
      const oldestKey = sentMessages.keys().next().value;
      sentMessages.delete(oldestKey);
    }
  }, 2000);

  return interval;
}

// --- Cleanup ---

function cleanup() {
  log('Cleaning up');
  for (const f of [CLAUDE_LOG, CODEX_LOG]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

// --- Main ---

function main() {
  if (!run('which tmux')) {
    console.error('Error: tmux not installed. Run: brew install tmux');
    process.exit(1);
  }
  if (!run(`which ${config.claude.command}`)) {
    console.error(`Error: "${config.claude.command}" not found.`);
    process.exit(1);
  }
  if (!run(`which ${config.codex.command}`)) {
    console.error(`Error: "${config.codex.command}" not found.`);
    process.exit(1);
  }

  const purple = '\x1b[38;5;135m';
  const green = '\x1b[38;5;34m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log('');
  console.log(`  ╔══════════════════════════════════════╗`);
  console.log(`  ║  ${bold}MEGA TERMINAL${reset}  v1.0                 ║`);
  console.log(`  ║  ${purple}Claude${reset} + ${green}Codex${reset} Side by Side        ║`);
  console.log(`  ╚══════════════════════════════════════╝`);
  console.log('');
  console.log(`  ${dim}Controls:${reset}`);
  console.log('    Mouse click          → Switch pane');
  console.log('    Option + drag        → Copy text, then Cmd+C');
  console.log('    Ctrl+B, d            → Detach (keep running)');
  console.log('');
  console.log(`  ${dim}Auto-routing:${reset}`);
  console.log(`    ${purple}Claude${reset} writes "${bold}@codex:${reset} ..." → auto-sent to ${green}Codex${reset}`);
  console.log(`    ${green}Codex${reset}  writes "${bold}@claude:${reset} ..." → auto-sent to ${purple}Claude${reset}`);
  console.log('');

  killExistingSession();
  setupWorkDir();
  createTmuxSession();
  const routerInterval = startMessageRouter();

  console.log('  Launching...\n');

  const attach = spawn('tmux', ['-u', 'attach-session', '-t', SESSION_NAME], {
    stdio: 'inherit',
  });

  attach.on('exit', () => {
    clearInterval(routerInterval);
    cleanup();
    console.log('\n  Mega Terminal closed. See you next time!\n');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    clearInterval(routerInterval);
    killExistingSession();
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    clearInterval(routerInterval);
    killExistingSession();
    cleanup();
    process.exit(0);
  });
}

main();
