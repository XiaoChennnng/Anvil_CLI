'use strict';

/**
 * Computer Use 工具 - 真正的桌面自动化控制
 * 让多模态模型能够截图、点击、输入，实现完整的电脑操作闭环
 * 仅对支持 vision 的模型有效
 */

const fs = require('fs');
const path = require('path');

// 桌面自动化依赖（可选）
let robot = null;
try {
  robot = require('@hurdlegroup/robotjs');
} catch {
  try {
    robot = require('robotjs');
  } catch {
    // 可选依赖，未安装时只能使用文本截图
  }
}

// 截图依赖
let screenshotDesktop = null;
try {
  screenshotDesktop = require('screenshot-desktop');
} catch {
  // 可选依赖
}

/**
 * 注册 Computer Use 工具
 * @param {ToolRegistry} registry - 工具注册表
 * @param {Object} context - 上下文对象 { tui, chatEngine }
 */
function registerComputerUseTools(registry, context) {
  const { tui } = context;

  // 截图工具 - 观察当前屏幕状态
  registry.register({
    name: 'computer',
    description: `截取当前屏幕截图，供 AI 观察电脑状态。

使用时机：
- 任务开始时，了解初始桌面/应用状态
- 每次点击/输入操作后，验证操作结果
- 不确定当前界面状态时
- 等待界面加载完成后

使用流程：
1. 调用 computer 截图
2. 分析图片内容，确定目标元素位置
3. 执行操作（点击/输入）
4. 再次调用 computer 验证结果

参数说明：
- wait: 截图前等待毫秒数（默认500）。用于等待界面动画完成、窗口加载等。`,
    parameters: {
      type: 'object',
      properties: {
        wait: {
          type: 'number',
          description: '截图前等待的毫秒数（默认500），用于等待屏幕变化稳定',
          default: 500,
        },
      },
      required: [],
    },
    execute: async (params) => executeScreenshot(params),
    requiresConfirm: false,
  });

  // 获取屏幕尺寸
  registry.register({
    name: 'computer_get_screen_size',
    description: `获取屏幕分辨率。

使用场景：
- 了解当前屏幕分辨率
- 确认坐标是否在有效范围内`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => executeGetScreenSize(),
    requiresConfirm: false,
  });

  // 获取鼠标位置
  registry.register({
    name: 'computer_get_mouse_position',
    description: `获取当前鼠标位置，帮助确定目标元素坐标。

使用场景：
- 不确定目标元素精确坐标时
- 需要确认鼠标是否移动到预期位置
- 逐步调试坐标定位

使用技巧：
- 先用 computer_move 移动到大致位置
- 调用 computer_get_mouse_position 确认实际位置
- 根据需要微调坐标`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => executeGetMousePosition(),
    requiresConfirm: false,
  });

  // 移动鼠标
  registry.register({
    name: 'computer_move',
    description: `将鼠标移动到指定坐标位置 (x, y)。

使用技巧：
- 如果不确定精确坐标，先移动到大致位置，再截图观察
- 可以分步移动：先移到目标附近 → 截图确认 → 微调位置
- 移动后建议短暂等待（computer_wait 0.5）再点击

坐标确定方法：
1. computer 截图获取当前屏幕
2. 在截图上找到目标元素，读取其坐标位置
3. computer_move x=目标X坐标 y=目标Y坐标

安全提示：
- 坐标必须在屏幕范围内
- 超出范围会报错`,
    parameters: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: '目标 X 坐标（像素），从屏幕左上角开始',
        },
        y: {
          type: 'number',
          description: '目标 Y 坐标（像素），从屏幕左上角开始',
        },
      },
      required: ['x', 'y'],
    },
    execute: async (params) => executeMove(params),
    requiresConfirm: true,
  });

  // 鼠标点击
  registry.register({
    name: 'computer_click',
    description: `在指定坐标点击鼠标（左键、右键或双击）。

标准操作流程：
1. computer 截图获取当前屏幕
2. 在截图上找到目标元素的位置，记录坐标 (x, y)
3. computer_click x=目标X坐标 y=目标Y坐标
4. computer 截图验证点击结果

参数说明：
- x, y: 目标坐标（从截图上读取的像素位置）
- button: 'left' 或 'right'（默认 left）
- double: 是否双击（默认 false）

常见用法：
- 单击按钮：computer_click x=500 y=300
- 双击打开：computer_click x=500 y=300 double=true
- 右键菜单：computer_click x=500 y=300 button='right'`,
    parameters: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: '点击位置的 X 坐标（像素），可选',
        },
        y: {
          type: 'number',
          description: '点击位置的 Y 坐标（像素），可选',
        },
        button: {
          type: 'string',
          enum: ['left', 'right'],
          description: '鼠标按钮（左键或右键）',
          default: 'left',
        },
        double: {
          type: 'boolean',
          description: '是否双击',
          default: false,
        },
      },
      required: [],
    },
    execute: async (params) => executeClick(params),
    requiresConfirm: true,
  });

  // 键盘输入文本
  registry.register({
    name: 'computer_type',
    description: `在当前光标位置输入文本。

重要：输入前必须先点击目标输入框获取焦点！

标准操作流程：
1. computer 截图找到输入框位置
2. computer_click 点击输入框获取焦点
3. computer_type 输入文本
4. computer 截图验证输入结果

参数说明：
- text: 要输入的文本内容（字符串）

注意事项：
- 输入特殊字符（如中文）可能需要额外处理
- 输入后会立即生效，无法撤销
- 长文本建议分段输入，中间加适当等待`,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要输入的文本内容',
        },
      },
      required: ['text'],
    },
    execute: async (params) => executeType(params),
    requiresConfirm: true,
  });

  // 按下特殊键
  registry.register({
    name: 'computer_key',
    description: `按下特殊功能键。

使用场景：
- enter: 确认输入、提交表单、换行
- escape: 取消操作、关闭弹窗
- tab: 切换焦点到下一个输入框
- backspace/delete: 删除字符
- arrowup/arrowdown/arrowleft/arrowright: 方向导航
- space: 空格键
- home/end: 跳到行首/行尾
- pageup/pagedown: 翻页

常见组合：
- 提交表单：computer_key key='enter'
- 关闭弹窗：computer_key key='escape'
- 删除字符：computer_key key='backspace'`,
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: ['enter', 'escape', 'tab', 'backspace', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'space', 'delete', 'home', 'end', 'pageup', 'pagedown'],
          description: '要按下的功能键',
        },
      },
      required: ['key'],
    },
    execute: async (params) => executeKey(params),
    requiresConfirm: true,
  });

  // 滚动
  registry.register({
    name: 'computer_scroll',
    description: `在指定位置滚动鼠标滚轮。

使用场景：
- 滚动网页查看内容
- 滚动文档/列表
- 放大/缩小（配合 Ctrl 键，但当前不支持组合键）

参数说明：
- direction: 'up' 或 'down'
- clicks: 滚动次数（默认3）
- x, y: 滚动位置的坐标（可选，不提供则在当前位置滚动）

操作流程：
1. computer_move 移动到要滚动的区域
2. computer_scroll 执行滚动
3. computer 截图查看滚动后的内容`,
    parameters: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: '滚动位置的 X 坐标（像素），可选',
        },
        y: {
          type: 'number',
          description: '滚动位置的 Y 坐标（像素），可选',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: '滚动方向',
        },
        clicks: {
          type: 'number',
          description: '滚动次数（正数）',
          default: 3,
        },
      },
      required: ['direction'],
    },
    execute: async (params) => executeScroll(params),
    requiresConfirm: true,
  });

  // 等待
  registry.register({
    name: 'computer_wait',
    description: `等待一段时间，让界面变化稳定。

使用场景：
- 点击按钮后等待界面响应
- 等待窗口/弹窗加载完成
- 等待页面加载
- 两次操作之间留出缓冲时间

参数说明：
- seconds: 等待秒数（0.5-60，默认2）

使用技巧：
- 网络操作建议等待 3-5 秒
- 本地操作 1-2 秒通常足够
- 等待后务必截图验证结果`,
    parameters: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: '等待秒数（0.5-60）',
          minimum: 0.5,
          maximum: 60,
          default: 2,
        },
      },
      required: [],
    },
    execute: async (params) => executeWait(params),
    requiresConfirm: false,
  });

  // 拖拽
  registry.register({
    name: 'computer_drag',
    description: `从起始坐标拖拽到目标坐标。

使用场景：
- 拖拽文件到文件夹
- 拖拽调整窗口大小
- 拖拽滑块
- 拖拽选择文本

参数说明：
- startX, startY: 起始位置坐标
- endX, endY: 目标位置坐标

操作流程：
1. computer 截图确认起始和目标位置
2. computer_drag 执行拖拽
3. computer 截图验证结果`,
    parameters: {
      type: 'object',
      properties: {
        startX: {
          type: 'number',
          description: '起始 X 坐标',
        },
        startY: {
          type: 'number',
          description: '起始 Y 坐标',
        },
        endX: {
          type: 'number',
          description: '目标 X 坐标',
        },
        endY: {
          type: 'number',
          description: '目标 Y 坐标',
        },
      },
      required: ['startX', 'startY', 'endX', 'endY'],
    },
    execute: async (params) => executeDrag(params),
    requiresConfirm: true,
  });
}

/**
 * 注销 Computer Use 工具
 * @param {ToolRegistry} registry - 工具注册表
 */
function unregisterComputerUseTools(registry) {
  const tools = [
    'computer',
    'computer_get_screen_size',
    'computer_get_mouse_position',
    'computer_move',
    'computer_click',
    'computer_type',
    'computer_key',
    'computer_scroll',
    'computer_wait',
    'computer_drag',
  ];

  for (const toolName of tools) {
    try {
      registry.unregister(toolName);
    } catch {
      // 忽略未注册的工具
    }
  }
}

// ==================== 工具执行函数 ====================

/**
 * 执行截图
 */
async function executeScreenshot(params) {
  const { wait = 500 } = params;

  // 等待屏幕稳定
  if (wait > 0) {
    await sleep(wait);
  }

  try {
    // 优先使用 screenshot-desktop（效果更好）
    if (screenshotDesktop) {
      const screenshot = await screenshotDesktop({ format: 'png' });
      const base64 = screenshot.toString('base64');

      return {
        success: true,
        type: 'image',
        format: 'base64',
        data: base64,
        mediaType: 'image/png',
        description: '屏幕截图',
      };
    }

    // 备选：使用 robotjs 截图
    if (robot) {
      const screenSize = robot.getScreenSize();
      lastScreenshotSize = screenSize;

      return {
        success: true,
        type: 'text',
        content: `屏幕尺寸: ${screenSize.width}x${screenSize.height}\n(截图功能需要 screenshot-desktop 包)`,
        description: '屏幕信息（截图依赖未安装）',
      };
    }

    return {
      error: '截图功能不可用：未安装 screenshot-desktop 或 robotjs',
    };
  } catch (error) {
    return {
      error: `截图失败: ${error.message}`,
    };
  }
}

/**
 * 获取屏幕尺寸
 */
async function executeGetScreenSize() {
  try {
    if (robot) {
      const size = robot.getScreenSize();
      return {
        success: true,
        width: size.width,
        height: size.height,
        message: `屏幕分辨率: ${size.width}x${size.height}`,
      };
    }

    return {
      success: true,
      width: 1920,
      height: 1080,
      message: '屏幕分辨率: 1920x1080 (默认值，robotjs 未安装)',
    };
  } catch (error) {
    return {
      error: `获取屏幕尺寸失败: ${error.message}`,
    };
  }
}

/**
 * 获取鼠标位置
 */
async function executeGetMousePosition() {
  try {
    if (!robot) {
      return { error: '鼠标控制不可用：未安装 robotjs' };
    }

    const pos = robot.getMousePos();
    return {
      success: true,
      x: pos.x,
      y: pos.y,
      message: `鼠标当前位置: (${pos.x}, ${pos.y})`,
    };
  } catch (error) {
    return {
      error: `获取鼠标位置失败: ${error.message}`,
    };
  }
}

/**
 * 移动鼠标
 */
async function executeMove(params) {
  const { x, y } = params;

  if (!robot) {
    return { error: '鼠标控制不可用：未安装 robotjs' };
  }

  try {
    // 验证坐标
    const screenSize = robot.getScreenSize();
    if (x < 0 || x > screenSize.width || y < 0 || y > screenSize.height) {
      return {
        error: `坐标超出屏幕范围。屏幕尺寸: ${screenSize.width}x${screenSize.height}，目标坐标: (${x}, ${y})`,
      };
    }

    robot.moveMouse(x, y);

    return {
      success: true,
      x,
      y,
      message: `鼠标已移动到 (${x}, ${y})`,
    };
  } catch (error) {
    return {
      error: `移动鼠标失败: ${error.message}`,
    };
  }
}

/**
 * 执行鼠标点击
 */
async function executeClick(params) {
  const { x, y, button = 'left', double = false } = params;

  if (!robot) {
    return { error: '鼠标控制不可用：未安装 robotjs' };
  }

  try {
    // 如果指定了坐标，先移动鼠标
    if (x !== undefined && y !== undefined) {
      const screenSize = robot.getScreenSize();
      if (x < 0 || x > screenSize.width || y < 0 || y > screenSize.height) {
        return {
          error: `坐标超出屏幕范围。屏幕尺寸: ${screenSize.width}x${screenSize.height}，目标坐标: (${x}, ${y})`,
        };
      }
      robot.moveMouse(x, y);
    }

    // 执行点击
    robot.mouseClick(button, double);

    return {
      success: true,
      button,
      double,
      x: x ?? '当前位置',
      y: y ?? '当前位置',
      message: `已在 (${x ?? '当前'}, ${y ?? '当前'}) ${double ? '双击' : '点击'}${button === 'right' ? '右键' : '左键'}`,
    };
  } catch (error) {
    return {
      error: `点击失败: ${error.message}`,
    };
  }
}

/**
 * 执行键盘输入
 */
async function executeType(params) {
  const { text } = params;

  if (!robot) {
    return { error: '键盘控制不可用：未安装 robotjs' };
  }

  if (!text || typeof text !== 'string') {
    return { error: '必须提供 text 参数' };
  }

  try {
    robot.typeString(text);

    return {
      success: true,
      typed: text,
      length: text.length,
      message: `已输入 ${text.length} 个字符`,
    };
  } catch (error) {
    return {
      error: `键盘输入失败: ${error.message}`,
    };
  }
}

/**
 * 执行按键
 */
async function executeKey(params) {
  const { key } = params;

  if (!robot) {
    return { error: '键盘控制不可用：未安装 robotjs' };
  }

  // 映射按键名称到 robotjs 格式
  const keyMap = {
    'enter': 'enter',
    'escape': 'escape',
    'tab': 'tab',
    'backspace': 'backspace',
    'space': 'space',
    'delete': 'delete',
    'home': 'home',
    'end': 'end',
    'pageup': 'pageup',
    'pagedown': 'pagedown',
    'arrowup': 'up',
    'arrowdown': 'down',
    'arrowleft': 'left',
    'arrowright': 'right',
  };

  const robotKey = keyMap[key.toLowerCase()];
  if (!robotKey) {
    return { error: `不支持的按键: ${key}` };
  }

  try {
    robot.keyTap(robotKey);

    return {
      success: true,
      key,
      message: `已按下 ${key}`,
    };
  } catch (error) {
    return {
      error: `按键失败: ${error.message}`,
    };
  }
}

/**
 * 执行滚动
 */
async function executeScroll(params) {
  const { x, y, direction, clicks = 3 } = params;

  if (!robot) {
    return { error: '鼠标控制不可用：未安装 robotjs' };
  }

  try {
    // 如果指定了坐标，先移动鼠标
    if (x !== undefined && y !== undefined) {
      robot.moveMouse(x, y);
    }

    // robotjs 的 scroll 需要正负值表示方向
    const scrollAmount = direction === 'up' ? clicks : -clicks;
    robot.scrollMouse(scrollAmount, 'down');

    return {
      success: true,
      direction,
      clicks,
      message: `已向${direction === 'up' ? '上' : '下'}滚动 ${clicks} 次`,
    };
  } catch (error) {
    return {
      error: `滚动失败: ${error.message}`,
    };
  }
}

/**
 * 执行等待
 */
async function executeWait(params) {
  const { seconds = 2 } = params;

  try {
    await sleep(seconds * 1000);

    return {
      success: true,
      waited: seconds,
      message: `已等待 ${seconds} 秒`,
    };
  } catch (error) {
    return {
      error: `等待失败: ${error.message}`,
    };
  }
}

/**
 * 执行拖拽
 */
async function executeDrag(params) {
  const { startX, startY, endX, endY } = params;

  if (!robot) {
    return { error: '鼠标控制不可用：未安装 robotjs' };
  }

  try {
    // 移动到起始位置
    robot.moveMouse(startX, startY);

    // 按下鼠标
    robot.mouseToggle('down', 'left');

    // 移动到目标位置
    robot.moveMouse(endX, endY);

    // 释放鼠标
    robot.mouseToggle('up', 'left');

    return {
      success: true,
      startX,
      startY,
      endX,
      endY,
      message: `已从 (${startX}, ${startY}) 拖拽到 (${endX}, ${endY})`,
    };
  } catch (error) {
    // 确保鼠标释放
    try {
      robot.mouseToggle('up', 'left');
    } catch {
      // 忽略
    }

    return {
      error: `拖拽失败: ${error.message}`,
    };
  }
}

/**
 * 睡眠辅助函数
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  registerComputerUseTools,
  unregisterComputerUseTools,
};
