'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class SessionManager {
  constructor(config) {
    this.config = config || {};
    this.projectDir = config.projectDir || process.cwd();
    this.sessionsDir = path.join(this.projectDir, '.anvil', 'sessions');
    this.currentSession = null;
  }

  init() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    return this;
  }

  createSession(meta = {}) {
    const session = {
      id: uuidv4(),
      projectDir: this.projectDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: meta.model || 'deepseek-v4-flash',
      messages: [],
      tokenUsage: { input: 0, output: 0, total: 0 },
      operationHistory: [],
      metadata: meta,
    };

    this.currentSession = session;
    return session;
  }

  saveSession(session) {
    const s = session || this.currentSession;
    if (!s) {return false;}

    s.updatedAt = new Date().toISOString();

    try {
      const filePath = path.join(this.sessionsDir, `${s.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(s, null, 2) + '\n', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  loadSession(sessionId) {
    try {
      const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
      if (!fs.existsSync(filePath)) {return null;}

      const data = fs.readFileSync(filePath, 'utf8');
      const session = JSON.parse(data);
      this.currentSession = session;
      return session;
    } catch {
      return null;
    }
  }

  listSessions() {
    try {
      if (!fs.existsSync(this.sessionsDir)) {return [];}

      const files = fs.readdirSync(this.sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();

      return files.map((file) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, file), 'utf8'));
          return {
            id: data.id,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            model: data.model,
            messageCount: (data.messages || []).length,
            tokenTotal: data.tokenUsage?.total || 0,
          };
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  deleteSession(sessionId) {
    try {
      const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch {
    }
    return false;
  }

  addMessage(message) {
    if (!this.currentSession) {
      this.createSession();
    }

    this.currentSession.messages.push({
      role: message.role,
      content: message.content || '',
      thinking: message.thinking || null,
      toolCalls: message.toolCalls || null,
      timestamp: new Date().toISOString(),
    });
  }

  updateTokenUsage(usage) {
    if (!this.currentSession || !usage) {return;}

    this.currentSession.tokenUsage.input += usage.prompt_tokens || 0;
    this.currentSession.tokenUsage.output += usage.completion_tokens || 0;
    this.currentSession.tokenUsage.total += usage.total_tokens || 0;
  }

  addOperation(operation) {
    if (!this.currentSession) {return;}
    this.currentSession.operationHistory.push({
      ...operation,
      timestamp: new Date().toISOString(),
    });
  }

  getLastSessionId() {
    const sessions = this.listSessions();
    return sessions.length > 0 ? sessions[0].id : null;
  }
}

module.exports = SessionManager;
