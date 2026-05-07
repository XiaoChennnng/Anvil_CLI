'use strict';

const chalk = require('chalk');

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL = 80;

class Spinner {
  constructor() {
    this._timer = null;
    this._text = '';
    this._frameIndex = 0;
  }

  start(text) {
    this._text = text || 'Thinking...';
    if (this._timer) {return;}

    this._frameIndex = 0;
    this._render();
    this._timer = setInterval(() => {
      this._frameIndex = (this._frameIndex + 1) % FRAMES.length;
      this._render();
    }, INTERVAL);
  }

  setText(text) {
    this._text = text;
  }

  succeed(text) {
    this._stop();
    if (text) {
      process.stdout.write(`${chalk.green('✓')} ${text}\n`);
    }
  }

  fail(text) {
    this._stop();
    if (text) {
      process.stdout.write(`${chalk.red('✗')} ${text}\n`);
    }
  }

  stop() {
    this._stop();
  }

  get isRunning() {
    return this._timer !== null;
  }

  _render() {
    const frame = FRAMES[this._frameIndex];
    const line = `${chalk.cyan(frame)} ${this._text}`;
    process.stdout.write(`\r${line}`);
  }

  _stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // 清除当前行
    const cols = process.stdout.columns || 80;
    process.stdout.write(`\r${' '.repeat(cols)}\r`);
  }
}

module.exports = Spinner;
