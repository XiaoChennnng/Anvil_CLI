'use strict';

const chalk = require('chalk');

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL = 80;

class Spinner {
  constructor() {
    this._timer = null;
    this._text = '';
    this._frameIndex = 0;
    this._blinking = false;
    this._visible = true;
  }

  start(text) {
    this._text = text || 'Thinking...';
    if (this._timer) {return;}

    this._frameIndex = 0;
    this._visible = true;
    this._blinking = true;  // 开始闪烁
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
      process.stdout.write(`${chalk.red('[失败]')} ${text}\n`);
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
    // 只要在运行就闪烁：每帧交替显示/隐藏（每 80ms 切换）
    if (this._blinking && !this._visible) {
      const cols = process.stdout.columns || 80;
      process.stdout.write(`\r${' '.repeat(cols)}\r`);
    } else {
      process.stdout.write(`\r${line}`);
    }
    // 切换可见性
    this._visible = !this._visible;
  }

  _stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._blinking = false;
    const cols = process.stdout.columns || 80;
    process.stdout.write(`\r${' '.repeat(cols)}\r`);
  }
}

module.exports = Spinner;
