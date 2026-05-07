'use strict';

class RenderQueue {
  constructor(minInterval = 30) {
    this._minInterval = minInterval;
    this._lastRender = 0;
    this._pending = false;
    this._queuedFn = null;
  }

  requestRender(renderFn) {
    const now = Date.now();
    const elapsed = now - this._lastRender;

    if (elapsed >= this._minInterval) {
      // 可以立即渲染
      renderFn();
      this._lastRender = now;
      this._pending = false;
      this._queuedFn = null;
    } else if (!this._pending) {
      // 设置待执行的渲染函数（会被后续请求覆盖）
      this._pending = true;
      this._queuedFn = renderFn;
      const remaining = this._minInterval - elapsed;
      setTimeout(() => {
        if (this._queuedFn) {
          this._queuedFn();
          this._lastRender = Date.now();
        }
        this._pending = false;
        this._queuedFn = null;
      }, remaining);
    } else {
      // 已经有待执行的渲染，覆盖它
      this._queuedFn = renderFn;
    }
  }

  forceRender(renderFn) {
    this._pending = false;
    this._queuedFn = null;
    renderFn();
    this._lastRender = Date.now();
  }

  reset() {
    this._pending = false;
    this._queuedFn = null;
    this._lastRender = 0;
  }
}

module.exports = RenderQueue;