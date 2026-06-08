'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CheckpointManager {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.checkpointDir = path.join(projectDir, '.anvil', 'checkpoints');
    this.checkpointInterval = 10;
    this._saveCounter = 0;
    this._ensureDir();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    } catch {}
  }

  _generateId() {
    return `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  }

  save(state) {
    const id = this._generateId();
    const checkpoint = {
      id,
      timestamp: new Date().toISOString(),
      version: 1,
      state: {
        messages: state.messages,
        currentTask: state.currentTask,
        iterationCount: state.iterationCount,
        todos: state.todos,
        completedSubtasks: state.completedSubtasks || [],
        toolCallHistory: state.toolCallHistory || [],
      },
      messageCount: state.messages?.length || 0,
      elapsed: state.elapsed || 0,
    };

    const filePath = path.join(this.checkpointDir, `${id}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf8');
      const latestPath = path.join(this.checkpointDir, 'latest.json');
      fs.writeFileSync(latestPath, JSON.stringify({ id, timestamp: checkpoint.timestamp }), 'utf8');

      // 每 5 次 save 执行一次清理，避免每次全量扫描
      this._saveCounter = (this._saveCounter + 1) % 5;
      if (this._saveCounter === 0) {
        this._cleanup();
      }

      return id;
    } catch {
      return null;
    }
  }

  loadLatest() {
    try {
      const latestPath = path.join(this.checkpointDir, 'latest.json');
      if (!fs.existsSync(latestPath)) { return null; }
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      const checkpointPath = path.join(this.checkpointDir, `${latest.id}.json`);
      if (!fs.existsSync(checkpointPath)) { return null; }
      return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    } catch {
      return null;
    }
  }

  hasCheckpoint() {
    try {
      const latestPath = path.join(this.checkpointDir, 'latest.json');
      return fs.existsSync(latestPath);
    } catch {
      return false;
    }
  }

  list() {
    try {
      return fs.readdirSync(this.checkpointDir)
        .filter(f => f.endsWith('.json') && f !== 'latest.json')
        .map(f => {
          const id = f.replace('.json', '');
          const stat = fs.statSync(path.join(this.checkpointDir, f));
          return { id, timestamp: stat.mtime.toISOString() };
        })
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    } catch {
      return [];
    }
  }

  _cleanup(keepCount = 3) {
    try {
      const checkpoints = this.list();
      for (const cp of checkpoints.slice(keepCount)) {
        fs.unlinkSync(path.join(this.checkpointDir, `${cp.id}.json`));
      }
    } catch {}
  }
}

module.exports = { CheckpointManager };
