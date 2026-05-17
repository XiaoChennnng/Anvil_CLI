/**
 * 团队模块统一导出
 * @file index.js
 */

const TeamManager = require('./manager');
const AgentSpawner = require('./agent-spawner');
const TaskDistributor = require('./task-distributor');
const ResultAggregator = require('./result-aggregator');
const TeamCommunication = require('./team-communication');
const TaskStateManager = require('./task-state');
const TeamErrorHandler = require('./error-handler');
const DynamicPromptGenerator = require('./prompt-templates');

const constants = require('./constants');
const {
  TeamState,
  TaskPriority,
  TaskState,
  AgentRoles,
  TaskTypes,
  AggregationStrategy,
  ConflictResolution,
  TeamErrorType,
  FallbackStrategy,
  MessageTypes,
} = constants;

module.exports = {
  // 核心类
  TeamManager,
  AgentSpawner,
  TaskDistributor,
  ResultAggregator,
  TeamCommunication,
  TaskStateManager,
  TeamErrorHandler,
  DynamicPromptGenerator,

  // 常量
  constants,
  TeamState,
  TaskPriority,
  TaskState,
  AgentRoles,
  TaskTypes,
  AggregationStrategy,
  ConflictResolution,
  TeamErrorType,
  FallbackStrategy,
  MessageTypes,
};
