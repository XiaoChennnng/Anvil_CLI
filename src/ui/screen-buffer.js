'use strict';

class ScreenBuffer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._cells = this._createEmptyGrid();
    this._lastRender = this._createEmptyGrid();
  }

  _createEmptyGrid() {
    const grid = [];
    for (let row = 0; row < this.height; row++) {
      grid[row] = [];
      for (let col = 0; col < this.width; col++) {
        grid[row][col] = { char: ' ', style: null };
      }
    }
    return grid;
  }

  setCell(row, col, char, style = null) {
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) {return;}
    this._cells[row][col] = { char, style };
  }

  getCell(row, col) {
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) {
      return null;
    }
    return this._cells[row][col];
  }

  clear() {
    for (let row = 0; row < this.height; row++) {
      for (let col = 0; col < this.width; col++) {
        this._cells[row][col] = { char: ' ', style: null };
      }
    }
  }

  getRow(row) {
    if (row < 0 || row >= this.height) {return [];}
    return this._cells[row];
  }

  setRow(row, cells) {
    if (row < 0 || row >= this.height) {return;}
    for (let col = 0; col < this.width; col++) {
      if (col < cells.length) {
        this._cells[row][col] = cells[col];
      } else {
        this._cells[row][col] = { char: ' ', style: null };
      }
    }
  }

  // 计算两个缓冲区的差异
  diff() {
    const changes = [];

    for (let row = 0; row < this.height; row++) {
      let startCol = -1;
      let endCol = -1;

      for (let col = 0; col < this.width; col++) {
        const current = this._cells[row][col];
        const last = this._lastRender[row][col];

        if (current.char !== last.char || current.style !== last.style) {
          if (startCol === -1) {
            startCol = col;
          }
          endCol = col;
        } else if (startCol !== -1 && endCol !== -1) {
          // 发现断裂，记录当前段并重新开始
          changes.push({ row, startCol, endCol: endCol + 1 });
          startCol = -1;
          endCol = -1;
        }
      }

      // 处理最后一段
      if (startCol !== -1 && endCol !== -1) {
        changes.push({ row, startCol, endCol: endCol + 1 });
      }
    }

    return changes;
  }

  // 提交当前帧作为上一帧（用于下次 diff）
  commit() {
    // 深拷贝
    for (let row = 0; row < this.height; row++) {
      for (let col = 0; col < this.width; col++) {
        this._lastRender[row][col] = { ...this._cells[row][col] };
      }
    }
  }

  resize(width, height) {
    const newCells = [];
    for (let row = 0; row < height; row++) {
      newCells[row] = [];
      for (let col = 0; col < width; col++) {
        if (row < this.height && col < this.width) {
          newCells[row][col] = this._cells[row][col];
        } else {
          newCells[row][col] = { char: ' ', style: null };
        }
      }
    }

    // 同样更新 lastRender
    const newLastRender = [];
    for (let row = 0; row < height; row++) {
      newLastRender[row] = [];
      for (let col = 0; col < width; col++) {
        if (row < this.height && col < this.width) {
          newLastRender[row][col] = this._lastRender[row][col];
        } else {
          newLastRender[row][col] = { char: ' ', style: null };
        }
      }
    }

    this.width = width;
    this.height = height;
    this._cells = newCells;
    this._lastRender = newLastRender;
  }
}

module.exports = ScreenBuffer;