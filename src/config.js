module.exports = {
  claude: {
    command: process.env.CLAUDE_CMD || 'claude',
    args: ['--dangerously-skip-permissions'],
  },
  codex: {
    command: process.env.CODEX_CMD || 'codex',
    args: ['--dangerously-bypass-approvals-and-sandbox'],
  },

  routeTag: '@codex:',
  reverseTag: '@claude:',

  theme: {
    claude: {
      border: 'colour135',
      label: '#af5fff',
    },
    codex: {
      border: 'colour34',
      label: '#00af00',
    },
    statusBar: {
      bg: '#1a1a2e',
      fg: 'white',
    },
  },
};
