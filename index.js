// Happy-Image - Smart AI-Driven Image Generation Plugin
// Main extension file

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    appendMediaToMessage,
    generateRaw
} from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

// Extension constants
const extensionName = 'Happy-Image';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// Insertion types
const INSERT_TYPE = {
    DISABLED: 'disabled',
    MANUAL: 'manual',
    KEYWORD: 'keyword',
    AUTO: 'auto',
    REPLACE: 'replace',
    NEW_MESSAGE: 'new_message',
    END_OF_MESSAGE: 'end_of_message',
    BEGINNING: 'beginning'
};

// Task trigger modes
const TASK_TRIGGER = {
    MANUAL: 'manual',    // Clicking a floating button to process last message
    KEYWORD: 'keyword',  // Detecting keywords in messages
    AUTO: 'auto'         // Process every new message automatically
};

// Default settings
const defaultSettings = {
    // General Settings
    enabled: true,
    taskTrigger: TASK_TRIGGER.MANUAL,
    keywordList: ['image', 'pic'],
    
    // API Configuration for API2 (for generating prompts)
    api2Config: {
        source: 'tavern', // 'tavern', 'preset', 'custom'
        selectedPreset: null,
        customConfig: {
            apiUrl: '',
            apiKey: '',
            model: 'gpt-4o',
            source: 'openai'
        }
    },
    
    // API Configuration for API3 (for actual image generation via Tavern SD)
    api3Config: {
        enabled: true
    },
    
    // Insertion settings
    insertionType: INSERT_TYPE.END_OF_MESSAGE,
    
    // Prompt engineering settings
    promptTemplate: `<IMAGE_PROMPT_TEMPLATE>
你是一个专门用于AI视觉小说应用的图像提示词工程师。你的任务是根据以下输入内容生成图像生成的提示词:

输入: {{message_content}}

说明:
1. 每次请求最多生成3个提示词（如果消息中出现多个不同场景）
2. 每个提示词应同时包含英文和中文（英文用于图像生成，中文作为注释）
3. 每个提示词英文最多使用50个单词
4. 确保生成的提示词符合输入中提到的风格和特征
5. 强调使用提供的角色描述和注释中的特征信息
6. 提示词结构如下:
   - 英文: [场景], [角色描述], [表情], [服装], [动作], [背景], [艺术风格]
   - 中文: [英文提示词的中文翻译]

每个提示词的格式:
\`\`\`json
{
  "tasks": [
    {
      "english_prompt": "这里放英文提示词",
      "chinese_prompt": "这里放中文提示词",
      "position": "end_of_message"
    }
  ]
}
\`\`\`

重要提示: 只返回带有结构化提示词的JSON数据，不要包含JSON以外的其他文本内容。
</IMAGE_PROMPT_TEMPLATE>`,
    
    // Image saving settings
    saveImages: {
        enabled: false,
        saveToPath: './user_images',
        byCharacterName: true
    },
    
    // Debugging settings
    debug: {
        enabled: true,
        logLevel: 'info',
        showToasts: true
    }
};

// API Source Types
const API_SOURCE = {
    TAVERN: 'tavern',
    PRESET: 'preset',
    CUSTOM: 'custom'
};

// Current extension settings
let extSettings = {};
let isTaskRunning = false;
let lastProcessedMessageId = -1;

// Initialize extension
$(function() {
    (async function() {
        await loadSettings();
        addExtensionMenu();
        addFloatingButton();
        await setupSettingsPanel();
        registerEventListeners();
        logDebug('Happy-Image extension loaded successfully');
    })();
});

// Load and initialize settings
async function loadSettings() {
    extSettings = extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    if (Object.keys(extSettings).length === 0) {
        Object.assign(extSettings, defaultSettings);
    } else {
        Object.entries(defaultSettings).forEach(([key, value]) => {
            if (extSettings[key] === undefined) {
                extSettings[key] = deepClone(value);
            } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                Object.entries(value).forEach(([subKey, subValue]) => {
                    if (extSettings[key][subKey] === undefined) {
                        extSettings[key][subKey] = deepClone(subValue);
                    }
                });
            }
        });
    }
    
    logDebug('Settings loaded:', extSettings);
    extSettings.lastSave = Date.now();
}

// Get Tavern presets from global context
function getTavernPresets() {
    try {
        const context = getContext();
        
        // Try multiple ways to get presets
        let presets = [];
        
        // Try 1: Look in extension settings for common preset storage
        if (context?.extensionSettings) {
            // Look for common preset extensions
            const commonPresetExts = ['api_config', 'api_presets', 'presets'];
            for (const extName of commonPresetExts) {
                if (context.extensionSettings[extName]) {
                    const extSettings = context.extensionSettings[extName];
                    if (extSettings.presets && Array.isArray(extSettings.presets)) {
                        presets = extSettings.presets;
                        break;
                    }
                    if (extSettings.llmPresets && Array.isArray(extSettings.llmPresets)) {
                        presets = extSettings.llmPresets;
                        break;
                    }
                }
            }
        }
        
        // Try 2: Look for window global presets
        if (presets.length === 0 && window.TavernAI) {
            if (window.TavernAI.presets) {
                presets = window.TavernAI.presets;
            }
        }
        
        // Try 3: Look in Engram settings format (for reference)
        if (presets.length === 0 && context?.extensionSettings?.engram?.apiSettings?.llmPresets) {
            presets = context.extensionSettings.engram.apiSettings.llmPresets;
        }
        
        // If no presets found, try to create some from existing config
        if (presets.length === 0) {
            // Check if we can access main API config
            const hasTavernApi = checkTavernApiAvailable();
            if (hasTavernApi) {
                presets = [{
                    id: 'default_tavern',
                    name: '酒馆主 API (默认)',
                    source: 'tavern'
                }];
            }
        }
        
        logDebug('Found presets:', presets);
        return presets;
    } catch (e) {
        logError('Error getting presets:', e);
        return [];
    }
}

// Check if Tavern API is available
function checkTavernApiAvailable() {
    try {
        // Check for TavernHelper - this is the main one to use
        if (typeof window.TavernHelper !== 'undefined' && window.TavernHelper) {
            if (window.TavernHelper.generate || window.TavernHelper.generateRaw) {
                return true;
            }
        }
        
        // Fallback checks
        if (typeof window.generate !== 'undefined' || typeof window.generateRaw !== 'undefined') {
            return true;
        }
        
        // Check context
        const context = getContext();
        if (context && context.api) {
            return true;
        }
        
        return false;
    } catch (e) {
        logError('Error checking Tavern API:', e);
        return false;
    }
}

// Add floating button for manual trigger
function addFloatingButton() {
    if ($('#happy-image-floating-btn').length > 0) {
        return;
    }
    
    const buttonHtml = `
        <div id="happy-image-floating-btn" class="happy-image-floating-btn" title="生成图像">
            <i class="fa-solid fa-image"></i>
        </div>
    `;
    
    $('body').append(buttonHtml);
    
    $('#happy-image-floating-btn').on('click', async function() {
        if (!extSettings.enabled) {
            showToast('插件未启用，请先启用插件', 'warning');
            return;
        }
        
        const context = getContext();
        if (!context || !context.chat || context.chat.length === 0) {
            showToast('没有消息可处理', 'warning');
            return;
        }
        
        const lastMessageIndex = context.chat.length - 1;
        const lastMessage = context.chat[lastMessageIndex];
        if (!lastMessage || !lastMessage.mes) {
            showToast('最后一条消息没有内容', 'warning');
            return;
        }
        
        await processMessageForImages(lastMessage, lastMessageIndex);
    });
}

// Add extension menu items
function addExtensionMenu() {
    if ($('#extensionsMenu').length === 0) {
        setTimeout(addExtensionMenu, 250);
        return;
    }

    if ($(`.${extensionName}`).length) return;

    const menuHtml = `
        <div id="happy-image-menu" class="${extensionName} list-group-item flex-container flexGap5">
            <div class="fa-solid fa-image"></div>
            <span data-i18n="Happy-Image">Happy-Image</span>
        </div>`;
    
    const $menuItem = $(menuHtml);
    $('#extensionsMenu').append($menuItem);
    
    $menuItem.on('click', function() {
        const settingsContainerId = `${extensionName}-settings-container`;
        const $container = $(`#${settingsContainerId}`);
        
        if (!$('#rm_extensions_block').hasClass('closedDrawer')) {
            $('#extensions-settings-button .drawer-toggle').click();
        }
        
        setTimeout(() => {
            $('#extensions-settings-button .drawer-toggle').click();
            
            setTimeout(() => {
                if ($container.length) {
                    $container[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    
                    const $drawerHeader = $container.find('.inline-drawer-header');
                    if ($container.find('.inline-drawer-content').is(':not(:visible)')) {
                        $drawerHeader.click();
                    }
                }
            }, 100);
        }, 100);
    });
}

// Setup settings panel
async function setupSettingsPanel() {
    const settingsHtml = await loadSettingsTemplate();
    
    const containerId = `${extensionName}-settings-container`;
    if ($(`#${containerId}`).length === 0) {
        const containerHtml = `<div id="${containerId}" class="extension_container"></div>`;
        $('#extensions_settings2').append(containerHtml);
    }
    
    const $container = $(`#${containerId}`);
    $container.empty().append(settingsHtml);
    
    initializeSettingsUI();
    attachSettingsEventListeners();
}

// Load settings template HTML
async function loadSettingsTemplate() {
    return `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b data-i18n="Happy-Image">Happy-Image</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="happy-image-settings-section">
                <h4>常规设置</h4>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-enabled">启用插件:</label>
                    <input type="checkbox" id="happy-image-enabled" class="checkbox">
                </div>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-task-trigger">任务触发方式:</label>
                    <select id="happy-image-task-trigger" class="select">
                        <option value="manual">手动 (浮动按钮)</option>
                        <option value="keyword">关键词检测</option>
                        <option value="auto">自动 (所有消息)</option>
                    </select>
                </div>
                
                <div id="keyword-settings" class="sub-settings">
                    <div class="flex-container flexGap5">
                        <label for="happy-image-keywords">关键词 (逗号分隔):</label>
                        <input type="text" id="happy-image-keywords" class="text_pole" placeholder="图片, 图像, 生图, 插图">
                    </div>
                </div>
            </div>
            
            <div class="happy-image-settings-section">
                <h4>API2 配置 (提示词生成)</h4>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-api2-source">API 源:</label>
                    <select id="happy-image-api2-source" class="select">
                        <option value="tavern">使用当前 Tavern API</option>
                        <option value="preset">使用连接预设</option>
                        <option value="custom">自定义配置</option>
                    </select>
                </div>
                
                <div id="api2-preset-config" class="sub-settings">
                    <div class="flex-container flexGap5">
                        <label for="happy-image-api2-preset">选择预设:</label>
                        <select id="happy-image-api2-preset" class="select">
                            <option value="">加载预设中...</option>
                        </select>
                    </div>
                </div>
                
                <div id="api2-custom-config" class="sub-settings">
                    <div class="flex-container flexGap5">
                        <label for="happy-image-api2-api-url">API 地址:</label>
                        <input type="text" id="happy-image-api2-api-url" class="text_pole" placeholder="https://api.openai.com/v1/chat/completions">
                    </div>
                    
                    <div class="flex-container flexGap5">
                        <label for="happy-image-api2-api-key">API 密钥:</label>
                        <input type="password" id="happy-image-api2-api-key" class="text_pole" placeholder="输入您的 API 密钥">
                    </div>
                    
                    <div class="flex-container flexGap5">
                        <label for="happy-image-api2-model">模型:</label>
                        <input type="text" id="happy-image-api2-model" class="text_pole" placeholder="gpt-4o">
                    </div>
                </div>
            </div>
            
            <div class="happy-image-settings-section">
                <h4>提示词模板 (用于提示词生成)</h4>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-prompt-template">提示词模板:</label>
                    <textarea id="happy-image-prompt-template" class="text_pole textarea_compact" rows="10"></textarea>
                </div>
            </div>
            
            <div class="happy-image-settings-section">
                <h4>插入设置</h4>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-insertion-type">插入类型:</label>
                    <select id="happy-image-insertion-type" class="select">
                        <option value="end_of_message">消息末尾</option>
                        <option value="new_message">新消息</option>
                        <option value="beginning">消息开头</option>
                    </select>
                </div>
            </div>
            
            <div class="happy-image-settings-section">
                <h4>图像保存设置</h4>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-save-enabled">启用保存:</label>
                    <input type="checkbox" id="happy-image-save-enabled" class="checkbox">
                </div>
                
                <div id="save-path-settings" class="sub-settings">
                    <div class="flex-container flexGap5">
                        <label for="happy-image-save-path">保存路径:</label>
                        <input type="text" id="happy-image-save-path" class="text_pole" placeholder="./user_images">
                    </div>
                    
                    <div class="flex-container flexGap5">
                        <label for="happy-image-save-by-character">按角色名组织文件夹:</label>
                        <input type="checkbox" id="happy-image-save-by-character" class="checkbox">
                    </div>
                </div>
            </div>
            
            <div class="happy-image-settings-section">
                <h4>调试与日志</h4>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-debug-enabled">启用调试:</label>
                    <input type="checkbox" id="happy-image-debug-enabled" class="checkbox">
                </div>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-debug-level">日志等级:</label>
                    <select id="happy-image-debug-level" class="select">
                        <option value="debug">调试</option>
                        <option value="info" selected>信息</option>
                        <option value="warn">警告</option>
                        <option value="error">错误</option>
                    </select>
                </div>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-show-toasts">显示弹窗通知:</label>
                    <input type="checkbox" id="happy-image-show-toasts" class="checkbox">
                </div>
            </div>
            
            <div class="flex-container flexGap5">
                <button id="happy-image-save-settings" class="menu_button">保存设置</button>
                <button id="happy-image-test-api" class="menu_button">测试APIs</button>
                <button id="happy-image-reset-to-default" class="menu_button">重置为默认值</button>
            </div>
        </div>
    </div>`;
}

// Initialize UI elements with current settings
function initializeSettingsUI() {
    $('#happy-image-enabled').prop('checked', extSettings.enabled);
    $('#happy-image-task-trigger').val(extSettings.taskTrigger);
    $('#happy-image-keywords').val(extSettings.keywordList.join(', '));
    
    $('#happy-image-api2-source').val(extSettings.api2Config.source);
    $('#happy-image-api2-preset').val(extSettings.api2Config.selectedPreset);
    $('#happy-image-api2-api-url').val(extSettings.api2Config.customConfig.apiUrl);
    $('#happy-image-api2-api-key').val(extSettings.api2Config.customConfig.apiKey);
    $('#happy-image-api2-model').val(extSettings.api2Config.customConfig.model);
    
    toggleApiElements();
    loadPresetsIntoDropdown();
    
    $('#happy-image-prompt-template').val(extSettings.promptTemplate);
    $('#happy-image-insertion-type').val(extSettings.insertionType);
    
    $('#happy-image-save-enabled').prop('checked', extSettings.saveImages.enabled);
    $('#happy-image-save-path').val(extSettings.saveImages.saveToPath);
    $('#happy-image-save-by-character').prop('checked', extSettings.saveImages.byCharacterName);
    
    $('#happy-image-debug-enabled').prop('checked', extSettings.debug.enabled);
    $('#happy-image-debug-level').val(extSettings.debug.logLevel);
    $('#happy-image-show-toasts').prop('checked', extSettings.debug.showToasts);
    
    toggleSubSettings();
}

// Load presets into dropdown
function loadPresetsIntoDropdown() {
    const $presetSelect = $('#happy-image-api2-preset');
    $presetSelect.empty();
    
    const presets = getTavernPresets();
    
    if (presets.length === 0) {
        $presetSelect.append(`<option value="">未找到预设</option>`);
        logDebug('No presets found');
        return;
    }
    
    $presetSelect.append(`<option value="">选择一个预设...</option>`);
    
    presets.forEach(preset => {
        const presetId = preset.id || preset.name;
        const presetName = preset.name || preset.id || '未知预设';
        $presetSelect.append(`<option value="${presetId}">${presetName}</option>`);
    });
    
    // Restore selected preset if it exists
    if (extSettings.api2Config.selectedPreset) {
        $presetSelect.val(extSettings.api2Config.selectedPreset);
    }
    
    logDebug(`Loaded ${presets.length} presets`);
}

// Attach event listeners to UI elements
function attachSettingsEventListeners() {
    $('#happy-image-enabled').on('change', function() {
        extSettings.enabled = $(this).is(':checked');
    });
    
    $('#happy-image-task-trigger').on('change', function() {
        extSettings.taskTrigger = $(this).val();
        toggleSubSettings();
    });
    
    $('#happy-image-keywords').on('input', function() {
        const keywords = $(this).val().split(',').map(k => k.trim()).filter(k => k);
        extSettings.keywordList = keywords;
    });
    
    $('#happy-image-api2-source').on('change', function() {
        extSettings.api2Config.source = $(this).val();
        toggleApiElements();
    });
    
    $('#happy-image-api2-preset').on('change', function() {
        extSettings.api2Config.selectedPreset = $(this).val();
    });
    
    $('#happy-image-api2-api-url').on('input', function() {
        extSettings.api2Config.customConfig.apiUrl = $(this).val();
    });
    
    $('#happy-image-api2-api-key').on('input', function() {
        extSettings.api2Config.customConfig.apiKey = $(this).val();
    });
    
    $('#happy-image-api2-model').on('input', function() {
        extSettings.api2Config.customConfig.model = $(this).val();
    });
    
    $('#happy-image-prompt-template').on('input', function() {
        extSettings.promptTemplate = $(this).val();
    });
    
    $('#happy-image-insertion-type').on('change', function() {
        extSettings.insertionType = $(this).val();
    });
    
    $('#happy-image-save-enabled').on('change', function() {
        extSettings.saveImages.enabled = $(this).is(':checked');
        toggleSubSettings();
    });
    
    $('#happy-image-save-path').on('input', function() {
        extSettings.saveImages.saveToPath = $(this).val();
    });
    
    $('#happy-image-save-by-character').on('change', function() {
        extSettings.saveImages.byCharacterName = $(this).is(':checked');
    });
    
    $('#happy-image-debug-enabled').on('change', function() {
        extSettings.debug.enabled = $(this).is(':checked');
    });
    
    $('#happy-image-debug-level').on('change', function() {
        extSettings.debug.logLevel = $(this).val();
    });
    
    $('#happy-image-show-toasts').on('change', function() {
        extSettings.debug.showToasts = $(this).is(':checked');
    });
    
    $('#happy-image-save-settings').on('click', async function() {
        await saveSettings();
        showToast('Settings saved successfully!', 'success');
    });
    
    $('#happy-image-test-api').on('click', async function() {
        await testApiConnections();
    });
    
    $('#happy-image-reset-to-default').on('click', function() {
        if (confirm('Are you sure you want to reset all settings to default values? This cannot be undone.')) {
            extSettings = deepClone(defaultSettings);
            initializeSettingsUI();
            showToast('Settings reset to default!', 'success');
        }
    });
}

// Toggle UI elements based on selected options
function toggleSubSettings() {
    const taskTrigger = extSettings.taskTrigger;
    
    if (taskTrigger === TASK_TRIGGER.KEYWORD) {
        $('#keyword-settings').show();
    } else {
        $('#keyword-settings').hide();
    }
    
    if (extSettings.saveImages.enabled) {
        $('#save-path-settings').show();
    } else {
        $('#save-path-settings').hide();
    }
}

function toggleApiElements() {
    const apiSource = $('#happy-image-api2-source').val();
    
    if (apiSource === 'preset') {
        $('#api2-preset-config').show();
        $('#api2-custom-config').hide();
        loadPresetsIntoDropdown();
    } else if (apiSource === 'custom') {
        $('#api2-preset-config').hide();
        $('#api2-custom-config').show();
    } else { // tavern
        $('#api2-preset-config').hide();
        $('#api2-custom-config').hide();
    }
}

// Save settings to persistent storage
async function saveSettings() {
    try {
        await saveSettingsDebounced();
        logDebug('Settings saved', extSettings);
    } catch (e) {
        logError('Failed to save settings:', e);
        showToast('Failed to save settings', 'error');
    }
}

// Log messages based on debug settings
function logDebug(message, ...args) {
    if (!extSettings.debug || !extSettings.debug.enabled) return;
    
    const logLevel = extSettings.debug.logLevel;
    const shouldLog = ['debug', 'info', 'warn', 'error'].indexOf(logLevel) <= ['debug', 'info', 'warn', 'error'].indexOf(extSettings.debug.logLevel);
    
    if (shouldLog) {
        console.log(`[Happy-Image DEBUG]`, message, ...args);
    }
}

function logInfo(message, ...args) {
    if (!extSettings.debug || !extSettings.debug.enabled) return;
    if (['info', 'warn', 'error'].indexOf(extSettings.debug.logLevel) > 0) return;
    console.log(`[Happy-Image INFO]`, message, ...args);
}

function logWarn(message, ...args) {
    if (!extSettings.debug || !extSettings.debug.enabled) return;
    if (['warn', 'error'].indexOf(extSettings.debug.logLevel) > 0) return;
    console.warn(`[Happy-Image WARN]`, message, ...args);
}

function logError(message, ...args) {
    if (!extSettings.debug || !extSettings.debug.enabled) return;
    if (extSettings.debug.logLevel !== 'error') return;
    console.error(`[Happy-Image ERROR]`, message, ...args);
}

// Create a toast notification if enabled
function showToast(message, type = 'info') {
    if (!extSettings.debug || !extSettings.debug.showToasts) return;
    
    if (typeof toastr !== 'undefined') {
        switch (type) {
            case 'success':
                toastr.success(message, 'Happy-Image');
                break;
            case 'error':
                toastr.error(message, 'Happy-Image');
                break;
            case 'warning':
                toastr.warning(message, 'Happy-Image');
                break;
            default:
                toastr.info(message, 'Happy-Image');
        }
    } else {
        alert(`Happy-Image: ${message}`);
    }
}

// Validate API configuration is complete
function validateApiConfigComplete() {
    if (extSettings.api2Config.source === API_SOURCE.CUSTOM) {
        const { apiUrl, apiKey, model } = extSettings.api2Config.customConfig;
        if (!apiUrl || !apiKey || !model) {
            return { valid: false, message: '自定义API配置不完整，请填写API地址、API密钥和模型' };
        }
        return { valid: true };
    } else if (extSettings.api2Config.source === API_SOURCE.PRESET) {
        if (!extSettings.api2Config.selectedPreset) {
            return { valid: false, message: '请选择一个API预设' };
        }
        return { valid: true };
    } else { // tavern
        const hasTavernApi = checkTavernApiAvailable();
        if (!hasTavernApi) {
            return { valid: false, message: '酒馆主API不可用，请先在酒馆中配置主API' };
        }
        return { valid: true };
    }
}

// Test API connections with actual API call
async function testApiConnections() {
    try {
        // First, validate configuration completeness
        const configValidation = validateApiConfigComplete();
        if (!configValidation.valid) {
            showToast(configValidation.message, 'warning');
            return;
        }

        showToast('正在发送测试请求...', 'info');
        
        const testPrompt = `<IMAGE_PROMPT_TEMPLATE>
这是一个API测试请求。请返回以下格式的JSON:

\`\`\`json
{
  "tasks": [
    {
      "english_prompt": "test prompt",
      "chinese_prompt": "测试提示词",
      "position": "end_of_message"
    }
  ]
}
\`\`\`

只返回JSON，不要包含其他内容。
</IMAGE_PROMPT_TEMPLATE>`;
        
        const result = await callApiWithConfig(testPrompt);
        
        logInfo('API测试调用完成，原始结果:', result);
        
        const parsedResult = parseApiResult(result);
        
        if (!parsedResult || !parsedResult.tasks || parsedResult.tasks.length === 0) {
            throw new Error('API返回结果格式不正确');
        }
        
        showToast('✓ API配置生效！测试成功通过', 'success');
        logInfo('API连接测试成功');
        
    } catch (e) {
        logError('API测试错误:', e);
        showToast(`✗ API测试失败: ${e.message}`, 'error');
    }
}

// Call API with current configuration
async function callApiWithConfig(prompt) {
    let customApi = null;
    
    if (extSettings.api2Config.source === API_SOURCE.CUSTOM) {
        customApi = extSettings.api2Config.customConfig;
        logInfo('使用自定义API配置进行调用');
    } else if (extSettings.api2Config.source === API_SOURCE.TAVERN) {
        logInfo('使用Tavern当前API配置');
        customApi = null;
    } else if (extSettings.api2Config.source === API_SOURCE.PRESET) {
        logInfo('使用预设配置');
        customApi = null;
    }
    
    // Try to get TavernHelper
    const helper = typeof window.TavernHelper !== 'undefined' ? window.TavernHelper : null;
    
    let result;
    
    if (customApi) {
        const customApiConfig = {
            apiurl: customApi.apiUrl,
            key: customApi.apiKey,
            model: customApi.model,
            source: customApi.source || 'openai'
        };
        
        if (helper && helper.generateRaw) {
            logInfo('使用 TavernHelper.generateRaw 进行调用');
            result = await helper.generateRaw({
                user_input: prompt,
                custom_api: customApiConfig,
                should_silence: true
            });
        } else if (helper && helper.generate) {
            logInfo('使用 TavernHelper.generate 进行调用');
            result = await helper.generate({
                user_input: prompt,
                custom_api: customApiConfig,
                should_silence: true
            });
        } else {
            logInfo('使用全局 generateRaw 进行调用');
            result = await generateRaw({
                user_input: prompt,
                custom_api: customApiConfig
            });
        }
    } else {
        if (helper && helper.generateRaw) {
            logInfo('使用 TavernHelper.generateRaw (默认配置)');
            result = await helper.generateRaw({
                user_input: prompt,
                should_silence: true
            });
        } else if (helper && helper.generate) {
            logInfo('使用 TavernHelper.generate (默认配置)');
            result = await helper.generate({
                user_input: prompt,
                should_silence: true
            });
        } else {
            logInfo('使用全局 generateRaw (默认配置)');
            result = await generateRaw({
                user_input: prompt
            });
        }
    }
    
    return result;
}

// Check if we need to validate before generating prompts
function validateBeforeGeneration() {
    const configValidation = validateApiConfigComplete();
    if (!configValidation.valid) {
        showToast(configValidation.message, 'warning');
        return false;
    }
    return true;
}

// Register event listeners for tavern events
function registerEventListeners() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async function() {
        logInfo('收到来自Tavern的消息事件.');
        if (!extSettings.enabled) {
            logInfo('插件已禁用，跳过图像生成.');
            return;
        }
        
        const triggerMode = extSettings.taskTrigger;
        logInfo(`触发模式: ${triggerMode}, 扩展已启用: ${extSettings.enabled}`);
        
        if (triggerMode === TASK_TRIGGER.AUTO) {
            logInfo('自动模式启用，开始处理最后一条消息.');
            await handleAutoImageGeneration();
        } else {
            logInfo(`当前触发模式为 ${triggerMode}，跳过自动处理.`);
        }
    });
    
    eventSource.on(event_types.CHAT_CHANGED, async function() {
        logDebug('Chat changed, reloading settings');
        isTaskRunning = false;
        lastProcessedMessageId = -1;
        await loadSettings();
    });
    
    eventSource.on(event_types.MESSAGE_UPDATED, async function(mesId) {
        logInfo(`收到消息更新事件，消息ID: ${mesId}, 检查是否包含关键词.`);
        logInfo(`插件状态: ${extSettings.enabled}, 触发模式: ${extSettings.taskTrigger}`);
        
        if (extSettings.enabled && extSettings.taskTrigger === TASK_TRIGGER.KEYWORD) {
            logInfo('关键词模式启用，开始处理关键词触发.');
            await handleKeywordBasedImageGeneration(mesId);
        } else {
            logInfo(`不满足关键词处理条件，跳过处理. 启用: ${extSettings.enabled}, 触发: ${extSettings.taskTrigger}`);
        }
    });
}

// Handle auto image generation for new messages
async function handleAutoImageGeneration() {
    try {
        const context = getContext();
        if (!context || !context.chat) {
            return;
        }
        
        const messageIndex = context.chat.length - 1;
        const message = context.chat[messageIndex];
        if (!message || !message.mes) {
            return;
        }
        
        await processMessageForImages(message, messageIndex);
    } catch (e) {
        logError('Auto image generation error:', e);
        showToast(`Error during auto image generation: ${e.message}`, 'error');
    }
}

// Handle keyword-based image generation
async function handleKeywordBasedImageGeneration(mesId) {
    try {
        const context = getContext();
        if (!context || !context.chat || mesId === undefined || context.chat[mesId] === undefined) {
            return;
        }
        
        const message = context.chat[mesId];
        if (!message || !message.mes) {
            return;
        }
        
        const messageContent = message.mes.toLowerCase();
        const containsKeyword = extSettings.keywordList.some(keyword => 
            messageContent.includes(keyword.toLowerCase())
        );
        
        if (containsKeyword) {
            await processMessageForImages(message, mesId);
        }
    } catch (e) {
        logError('Keyword-based image generation error:', e);
        showToast(`Error during keyword-based image generation: ${e.message}`, 'error');
    }
}

// Process a message to generate images based on its content
async function processMessageForImages(message, messageIndex) {
    if (isTaskRunning) {
        logInfo('已有任务正在执行，跳过本次请求');
        return;
    }
    
    if (messageIndex !== undefined && messageIndex === lastProcessedMessageId) {
        logInfo(`消息 ${messageIndex} 已处理过，跳过`);
        return;
    }
    
    isTaskRunning = true;
    
    try {
        logInfo('开始处理消息以生成图像', message);
        showToast('开始处理图像生成...', 'info');
        
        const promptTasks = await generateImagePrompts(message.mes);
        
        if (!promptTasks || promptTasks.length === 0) {
            logInfo('消息未生成图像提示词:');
            logInfo('消息内容: ' + message.mes.substring(0, 100) + '...');
            showToast('未找到需要生成的图像提示词', 'warning');
            if (messageIndex !== undefined) {
                lastProcessedMessageId = messageIndex;
            }
            return;
        }
        
        logInfo('生成的图像提示词任务数量:', promptTasks.length);
        logInfo('生成的图像提示词任务详情:', promptTasks);
        
        for (let i = 0; i < promptTasks.length; i++) {
            const task = promptTasks[i];
            logInfo(`处理提示词任务 ${i + 1}/${promptTasks.length}: ${task.english_prompt.substring(0, 50)}...`);
            showToast(`正在生成第 ${i + 1}/${promptTasks.length} 张图像...`, 'info');
            await generateImageFromPrompt(task);
        }
        showToast(`完成${promptTasks.length}个图像的生成请求`, 'success');
        
        if (messageIndex !== undefined) {
            lastProcessedMessageId = messageIndex;
        }
    } catch (e) {
        logError('处理消息生成图像时出错:', e);
        showToast(`处理图像生成时出错: ${e.message}`, 'error');
    } finally {
        isTaskRunning = false;
    }
}

// Generate image prompts using API2 based on message content
async function generateImagePrompts(messageContent) {
    try {
        if (!validateBeforeGeneration()) {
            return [];
        }
        
        logInfo('开始使用API2从内容生成提示词:', messageContent.substring(0, 100) + '...');
        showToast('正在生成图像提示词...', 'info');
        
        const promptTemplate = extSettings.promptTemplate;
        const prompt = promptTemplate.replace('{{message_content}}', messageContent);
        logDebug('完整API调用提示词:', prompt);
        
        logInfo('正在调用API生成提示词...');
        showToast('调用AI生成提示词...', 'info');
        
        const result = await callApiWithConfig(prompt);
        
        logInfo('API调用完成，收到原始结果.');
        logInfo('原始API结果:', result);
        showToast('提示词生成完成，正在解析结果...', 'info');
        
        const parsedResult = parseApiResult(result);
        logInfo('解析后的API结果:', parsedResult);
        return parsedResult.tasks || [];
    } catch (e) {
        logError('生成提示词时出错:', e);
        showToast(`生成图像提示词时出错: ${e.message}`, 'error');
        return [];
    }
}

// Parse the API result to extract prompts and positions
function parseApiResult(apiResult) {
    if (!apiResult) return { tasks: [] };
    
    try {
        if (typeof apiResult === 'object' && apiResult !== null) {
            if (apiResult.tasks) {
                return apiResult;
            }
            // Maybe the result is already the tasks array
            if (Array.isArray(apiResult)) {
                return { tasks: apiResult };
            }
        }
        
        let jsonString = String(apiResult);
        
        // Try multiple parsing strategies
        let parsed = null;
        
        // Strategy 1: Try to find JSON in triple backticks
        const jsonMatch = jsonString.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            try {
                parsed = JSON.parse(jsonMatch[1].trim());
            } catch (e) {
                logDebug('Strategy 1 failed:', e);
            }
        }
        
        // Strategy 2: Try to find just code blocks
        if (!parsed) {
            const codeMatch = jsonString.match(/```\s*([\s\S]*?)\s*```/);
            if (codeMatch) {
                try {
                    parsed = JSON.parse(codeMatch[1].trim());
                } catch (e) {
                    logDebug('Strategy 2 failed:', e);
                }
            }
        }
        
        // Strategy 3: Try to find anything that looks like JSON
        if (!parsed) {
            const objMatch = jsonString.match(/\{[\s\S]*\}/);
            if (objMatch) {
                try {
                    parsed = JSON.parse(objMatch[0].trim());
                } catch (e) {
                    logDebug('Strategy 3 failed:', e);
                }
            }
        }
        
        // Strategy 4: Try to clean the string and parse
        if (!parsed) {
            try {
                const cleaned = jsonString.trim();
                if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
                    parsed = JSON.parse(cleaned);
                }
            } catch (e) {
                logDebug('Strategy 4 failed:', e);
            }
        }
        
        if (!parsed) {
            throw new Error('无法从API返回结果中解析JSON');
        }
        
        // Normalize the result
        if (Array.isArray(parsed)) {
            return { tasks: parsed };
        } else if (parsed.tasks && Array.isArray(parsed.tasks)) {
            return parsed;
        } else {
            // If it's a single task object, wrap it
            return { tasks: [parsed] };
        }
    } catch (e) {
        logError(`Error parsing API result: ${e.message}`);
        logDebug(`API result content was:`, apiResult);
        return { tasks: [] }; 
    }
}

// Generate an actual image from a prompt using Tavern's image generation system (API3)
async function generateImageFromPrompt(task) {
    if (!task.english_prompt) {
        logDebug('No English prompt provided, skipping image generation');
        return '';
    }
    
    try {
        const prompt = task.english_prompt;
        const chineseCommentary = task.chinese_prompt || '';
        
        logDebug(`Generating image: prompt="${prompt}", pos="${task.position}"`);
        
        try {
            const result = await SlashCommandParser.commands['sd']?.callback?.(
                {},
                prompt
            );
            
            if (!result) {
                throw new Error('No result from Tavern SD command');
            }
            
            logDebug(`Image generated URL: ${result}`);
            
            const formattedResult = {
                imageUrl: result,
                englishPrompt: prompt,
                chineseCommentary: chineseCommentary,
                position: task.position
            };
            
            await insertImageIntoMessage(formattedResult);
            
            if (extSettings.saveImages.enabled) {
                await saveImageToDisk(result, task);
            }
            
            return formattedResult;
        } catch (e) {
            logError(`Tavern SD command error: ${e.message}`);
            showToast(`Error generating image: ${e.message}`, 'error');
            return null;
        }
    } catch (e) {
        logError('Image generation error:', e);
        showToast(`Error generating image: ${e.message}`, 'error');
        return null;
    }
}

// Insert image into message based on position
async function insertImageIntoMessage(imageData) {
    const { imageUrl, position } = imageData;
    
    if (!imageUrl) {
        logDebug('No image URL to insert');
        return;
    }
    
    try {
        const context = getContext();
        if (!context || !context.chat) {
            logError('No context to insert image into');
            return;
        }
        
        const message = context.chat[context.chat.length - 1];
        if (!message) {
            logError('No message to insert image into');
            return;
        }
        
        switch (extSettings.insertionType) {
            case INSERT_TYPE.BEGINNING:
                if (imageData.chineseCommentary) {
                    message.mes = `<br><img src="${imageUrl}" alt="${imageData.chineseCommentary}"><br><em>${imageData.chineseCommentary}</em>` + message.mes;
                } else {
                    message.mes = `<br><img src="${imageUrl}">` + message.mes;
                }
                break;
                
            case INSERT_TYPE.NEW_MESSAGE:
                const newMes = {
                    name: message.name,
                    is_user: false,
                    is_system: false,
                    send_delay: 0,
                    mes: `<img src="${imageUrl}"><br><em>${imageData.chineseCommentary}</em>`,
                    extra: {
                        image: imageUrl,
                        title: imageData.chineseCommentary
                    }
                };
                
                context.chat.push(newMes);
                break;
                
            case INSERT_TYPE.END_OF_MESSAGE:
            default:
                if (imageData.chineseCommentary) {
                    message.mes = message.mes + `<br><img src="${imageUrl}" alt="${imageData.chineseCommentary}"><br><em>${imageData.chineseCommentary}</em>`;
                } else {
                    message.mes = message.mes + `<br><img src="${imageUrl}">`;
                }
        }
        
        if (!message.extra) {
            message.extra = {};
        }
        
        if (!Array.isArray(message.extra.image_swipes)) {
            message.extra.image_swipes = [];
        }
        
        message.extra.image_swipes.push(imageUrl);
        message.extra.image = imageUrl;
        message.extra.title = imageData.chineseCommentary;
        
        await context.saveChat();
        
        const $mesDiv = $(`.mes[mesid="${context.chat.length - 1}"]`);
        if ($mesDiv.length) {
            appendMediaToMessage(message, $mesDiv);
        }
        
        await eventSource.emit(event_types.MESSAGE_UPDATED, context.chat.length - 1);
        
        logDebug(`Image inserted: ${imageUrl} at position "${position}"`);
    } catch (e) {
        logError('Error inserting image into message:', e);
        showToast(`Error inserting image: ${e.message}`, 'error');
    }
}

// Save image to disk if possible
async function saveImageToDisk(imageUrl, promptTask) {
    try {
        if (!extSettings.saveImages.enabled) return;
        logDebug('Image saving not implemented due to browser restrictions');
    } catch (e) {
        logError('Error saving image to disk:', e);
    }
}

// Helper function for deep cloning
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof Array) return obj.map(item => deepClone(item));
    if (typeof obj === 'object') {
        const cloned = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                cloned[key] = deepClone(obj[key]);
            }
        }
        return cloned;
    }
}

window.HappyImage = {
    processMessageForImages,
    generateImagePrompts,
    generateImageFromPrompt
};
