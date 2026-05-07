'use strict';

class ScreenBuffer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._cells = this._createEmptyGrid();
    this._lastRender = this._createEmptyGrid();
  }

  /**
   * 创建空的网格
   */
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

  /**
   * 设置单个单元格
   * @param {number} row - 行 (1-based for external, 0-based internal)
   * @param {number} col - 列
   * @param {string} char - 字符
   * @param {string|null} style - 样式（保留字段）
   */
  setCell(row, col, char, style = null) {
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) {return;}
    this._cells[row][col] = { char, style };
  }

  /**
   * 获取单个单元格
   * @param {number} row - 行 (0-based)
   * @param {number} col - 列
   */
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

  /**
   * 获取一行内容
   * @param {number} row - 行 (0-based)
   * @returns {Array} 该行的单元格数组
   */
  getRow(row) {
    if (row < 0 || row >= this.height) {return [];}
    return this._cells[row];
  }

  /**
   * 设置一行内容
   * @param {number} row - 行 (0-based)
   * @param {Array} cells - 该行的单元格数组 [{char, style}, ...]
   */
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

  /**
   * 计算两个缓冲区的差异
   * @returns {Array} 需要更新的区域列表 [{row, startCol, endCol}, ...]
   */
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

  /**
   * 提交当前帧作为上一帧（用于下次 diff）
   */
  commit() {
    // 深拷贝
    for (let row = 0; row < this.height; row++) {
      for (let col = 0; col < this.width; col++) {
        this._lastRender[row][col] = { ...this._cells[row][col] };
      }
    }
  }

  /**
   * 更新尺寸
   * @param {number} width - 新宽度
   * @param {number} height - 新高度
   */
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