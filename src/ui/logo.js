'use strict';

const chalk = require('chalk');
const path = require('path');

const LOGO = `
    ╔═══════════════════════════════════╗
    ║                                   ║
    ║                                   ║
    ║                                   ║
    ╚═══════════════════════════════════╝
`;

function showLogo(options = {}) {
  const color = options.color || 'cyan';
  const projectName = options.projectName || 'Anvil';
  const logoLines = LOGO.split('\n');
  // 在中间两行显示项目名称
  const nameLen = projectName.length;
  const padding = Math.max(0, 30 - nameLen);
  const leftPad = Math.floor(padding / 2);
  const rightPad = padding - leftPad;

  logoLines[3] = `    ║${' '.repeat(leftPad)}${chalk.yellow.bold(projectName)}${' '.repeat(rightPad)}║`;
  logoLines[4] = `    ║${' '.repeat(33)}║`;

  const logoStr = logoLines.join('\n');
  const colored = chalk[color] ? chalk[color](logoStr) : chalk.cyan(logoStr);
  console.log(colored);
  console.log(chalk.dim(`  ⚒  ${projectName}  —  Powered by Anvil\n`));
}

function getLogoText(options = {}) {
  const color = options.color || 'cyan';
  const projectName = options.projectName || 'Anvil';
  const logoLines = LOGO.split('\n');
  const nameLen = projectName.length;
  const padding = Math.max(0, 30 - nameLen);
  const leftPad = Math.floor(padding / 2);
  const rightPad = padding - leftPad;

  logoLines[3] = `    ║${' '.repeat(leftPad)}${chalk.yellow.bold(projectName)}${' '.repeat(rightPad)}║`;
  logoLines[4] = `    ║${' '.repeat(33)}║`;

  const logoStr = logoLines.join('\n');
  const colored = chalk[color] ? chalk[color](logoStr) : chalk.cyan(logoStr);
  return colored + '\n' + chalk.dim(`  ⚒  ${projectName}  —  Powered by Anvil\n`);
}

module.exports = { showLogo, getLogoText };
