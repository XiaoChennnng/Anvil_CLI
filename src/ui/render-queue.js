'use strict';

class RenderQueue {
  constructor(minInterval = 30) {
    this._minInterval = minInterval;
    this._lastRender = 0;
    this._pending = false;
    this._queuedFn = null;
    this._timerId = null;
  }

  requestRender(renderFn) {
    const now = Date.now();
    const elapsed = now - this._lastRender;

    if (elapsed >= this._minInterval) {
      renderFn();
      this._lastRender = now;
      this._pending = false;
      this._queuedFn = null;
    } else if (!this._pending) {
      this._pending = true;
      this._queuedFn = renderFn;
      const remaining = this._minInterval - elapsed;
      this._timerId = setTimeout(() => {
        if (this._queuedFn) {
          this._queuedFn();
          this._lastRender = Date.now();
        }
        this._pending = false;
        this._queuedFn = null;
        this._timerId = null;
      }, remaining);
    } else {
      if (this._timerId) {
        clearTimeout(this._timerId);
      }
      this._queuedFn = renderFn;
      this._timerId = setTimeout(() => {
        if (this._queuedFn) {
          this._queuedFn();
          this._lastRender = Date.now();
        }
        this._pending = false;
        this._queuedFn = null;
        this._timerId = null;
      }, this._minInterval);
    }
  }

  forceRender(renderFn) {
    this._pending = false;
    this._queuedFn = null;
    renderFn();
    this._lastRender = Date.now();
  }

  reset() {
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
    this._pending = false;
    this._queuedFn = null;
    this._lastRender = 0;
  }
}

module.exports = RenderQueue;