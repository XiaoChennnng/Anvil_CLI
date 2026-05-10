'use strict';

const fs = require('fs');
const path = require('path');

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

class Logger {
  constructor(logDir) {
    this.logDir = logDir;
    this.level = LOG_LEVELS.DEBUG;
    this._stream = null;
    this._currentDate = null;
  }

  init() {
    fs.mkdirSync(this.logDir, { recursive: true });
    return this;
  }

  _getStream(now) {
    const dateStr = now.toISOString().split('T')[0];

    if (this._currentDate !== dateStr) {
      if (this._stream) {
        this._stream.end();
      }
      this._currentDate = dateStr;
      const logFile = path.join(this.logDir, `anvil-${dateStr}.log`);
      this._stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
    }
    return this._stream;
  }

  _log(level, message, extra) {
    const now = new Date(); // 只创建一次 Date 对象
    const stream = this._getStream(now);
    const timestamp = now.toISOString();
    const levelName = LEVEL_NAMES[level] || 'UNKNOWN';

    let line = `[${timestamp}] [${levelName}] ${message}`;
    if (extra) {
      if (typeof extra === 'object') {
        try {
          line += ` ${JSON.stringify(extra)}`;
        } catch {
          line += ` ${String(extra)}`;
        }
      } else {
        line += ` ${String(extra)}`;
      }
    }
    line += '\n';

    // 反压保护：write 返回 false 时丢弃（避免内存膨胀）
    if (!stream.write(line)) {
      this._streamDropped = (this._streamDropped || 0) + 1;
    }
  }

  debug(message, extra) {
    this._log(LOG_LEVELS.DEBUG, message, extra);
  }

  info(message, extra) {
    this._log(LOG_LEVELS.INFO, message, extra);
  }

  warn(message, extra) {
    this._log(LOG_LEVELS.WARN, message, extra);
  }

  error(message, extra) {
    this._log(LOG_LEVELS.ERROR, message, extra);
  }

  logCommandOutput(command, stdout, stderr) {
    const now = new Date();
    const stream = this._getStream(now);
    const timestamp = now.toISOString();
    stream.write(`\n${'='.repeat(60)}\n`);
    stream.write(`[${timestamp}] [CMD] Command: ${command}\n`);
    stream.write(`${'-'.repeat(60)}\n`);
    if (stdout) {
      stream.write(`[STDOUT]\n${stdout}\n`);
    }
    if (stderr) {
      stream.write(`[STDERR]\n${stderr}\n`);
    }
    stream.write(`${'='.repeat(60)}\n\n`);
  }

  close() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }
}

module.exports = Logger;
