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
    taskTrigger: TASK_TRIGGER.MANUAL, // Manual, keyword, auto
    keywordList: ['image', 'pic'], // Keywords that trigger image generation
    
    // API Configuration for API2 (for generating prompts)
    api2Config: {
        source: 'tavern', // 'tavern', 'preset', 'custom'
        selectedPreset: null, // For 'preset' source
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
      "position": "end_of_message" // 位置选项: after_paragraph_1, after_paragraph_2, end_of_message, beginning_of_message
    }
  ]
}
\`\`\`

重要提示: 只返回带有结构化提示词的JSON数据，不要包含JSON以外的其他文本内容。
</IMAGE_PROMPT_TEMPLATE>`,
    
    // Image saving settings
    saveImages: {
        enabled: false, // Due to permission issues, might not work in all browsers
        saveToPath: './user_images',
        byCharacterName: true
    },
    
    // Debugging settings
    debug: {
        enabled: true,
        logLevel: 'info', // debug, info, warn, error
        showToasts: true
    }
};

// API Source Types
const API_SOURCE = {
    TAVERN: 'tavern', // Use current Tavern API
    PRESET: 'preset', // Use predefined preset
    CUSTOM: 'custom'  // Custom API configuration
};

// Current extension settings
let extSettings = {};
// Task lock to prevent concurrent execution
let isTaskRunning = false;
// Track last processed message ID to avoid duplicates
let lastProcessedMessageId = -1;

// Initialize extension
$(function() {
    (async function() {
        // Load settings
        await loadSettings();
        
        // Add extension menu item
        addExtensionMenu();
        
        // Add floating button for manual trigger
        addFloatingButton();
        
        // Add settings panel
        await setupSettingsPanel();
        
        // Register event listeners
        registerEventListeners();
        
        // Log extension loaded
        logDebug('Happy-Image extension loaded successfully');
    })();
});

// Load and initialize settings
async function loadSettings() {
    // Initialize the extension settings object
    extSettings = extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    // Check if settings exist and if not, use defaults
    if (Object.keys(extSettings).length === 0) {
        Object.assign(extSettings, defaultSettings);
    } else {
        // For existing configs, ensure new fields are added
        Object.entries(defaultSettings).forEach(([key, value]) => {
            if (extSettings[key] === undefined) {
                extSettings[key] = deepClone(value);
            } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                // For objects, merge default properties if not present
                Object.entries(value).forEach(([subKey, subValue]) => {
                    if (extSettings[key][subKey] === undefined) {
                        extSettings[key][subKey] = deepClone(subValue);
                    }
                });
            }
        });
    }
    
    logDebug('Settings loaded:', extSettings);
    extSettings.lastSave = Date.now(); // Track when this was last modified
}

// Add floating button for manual trigger
function addFloatingButton() {
    // Check if button already exists
    if ($('#happy-image-floating-btn').length > 0) {
        return;
    }
    
    // Create floating button HTML
    const buttonHtml = `
        <div id="happy-image-floating-btn" class="happy-image-floating-btn" title="生成图像">
            <i class="fa-solid fa-image"></i>
        </div>
    `;
    
    // Add button to body
    $('body').append(buttonHtml);
    
    // Add click event
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
        
        // Process the last message
        await processMessageForImages(lastMessage, lastMessageIndex);
    });
}

// Add extension menu items
function addExtensionMenu() {
    if ($('#extensionsMenu').length === 0) {
        setTimeout(addExtensionMenu, 250);
        return;
    }

    // Check if menu item already exists (for reload prevention)
    if ($(`.${extensionName}`).length) return;

    const menuHtml = `
        <div id="happy-image-menu" class="${extensionName} list-group-item flex-container flexGap5">
            <div class="fa-solid fa-image"></div>
            <span data-i18n="Happy-Image">Happy-Image</span>
        </div>`;
    
    const $menuItem = $(menuHtml);
    $('#extensionsMenu').append($menuItem);
    
    // Add click event for the menu item
    $menuItem.on('click', function() {
        const settingsContainerId = `${extensionName}-settings-container`;
        const $container = $(`#${settingsContainerId}`);
        
        // Close drawer if it's open
        if (!$('#rm_extensions_block').hasClass('closedDrawer')) {
            $('#extensions-settings-button .drawer-toggle').click();
        }
        
        // Open it again in 100ms
        setTimeout(() => {
            $('#extensions-settings-button .drawer-toggle').click();
            
            // Scroll to the settings container
            setTimeout(() => {
                if ($container.length) {
                    $container[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    
                    // If it's collapsed, expand it
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
    // Get settings HTML
    const settingsHtml = await loadSettingsTemplate();
    
    // Create and add settings container if it doesn't exist
    const containerId = `${extensionName}-settings-container`;
    if ($(`#${containerId}`).length === 0) {
        const containerHtml = `<div id="${containerId}" class="extension_container"></div>`;
        $('#extensions_settings2').append(containerHtml);
    }
    
    const $container = $(`#${containerId}`);
    $container.empty().append(settingsHtml);
    
    // Initialize UI elements with current settings
    initializeSettingsUI();
    
    // Add event listeners to UI elements
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
            <!-- General Settings Panel -->
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
            
            <!-- API Configuration Panel -->
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
                            <option value="">选择一个预设...</option>
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
            
            <!-- Prompt Template Panel -->
            <div class="happy-image-settings-section">
                <h4>提示词模板 (用于提示词生成)</h4>
                
                <div class="flex-container flexGap5">
                    <label for="happy-image-prompt-template">提示词模板:</label>
                    <textarea id="happy-image-prompt-template" class="text_pole textarea_compact" rows="10"></textarea>
                </div>
            </div>
            
            <!-- Insertion Settings Panel -->
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
            
            <!-- Image Saving Panel -->
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
            
            <!-- Debugging Panel -->
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
            
            <!-- Control Buttons -->
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
    // General settings
    $('#happy-image-enabled').prop('checked', extSettings.enabled);
    $('#happy-image-task-trigger').val(extSettings.taskTrigger);
    $('#happy-image-keywords').val(extSettings.keywordList.join(', '));
    
    // API configs
    $('#happy-image-api2-source').val(extSettings.api2Config.source);
    $('#happy-image-api2-preset').val(extSettings.api2Config.selectedPreset);
    $('#happy-image-api2-api-url').val(extSettings.api2Config.customConfig.apiUrl);
    $('#happy-image-api2-api-key').val(extSettings.api2Config.customConfig.apiKey);
    $('#happy-image-api2-model').val(extSettings.api2Config.customConfig.model);
    
    // Toggle UI elements based on selected API source
    toggleApiElements();
    
    // Prompt template
    $('#happy-image-prompt-template').val(extSettings.promptTemplate);
    
    // Insertion settings
    $('#happy-image-insertion-type').val(extSettings.insertionType);
    
    // Image saving
    $('#happy-image-save-enabled').prop('checked', extSettings.saveImages.enabled);
    $('#happy-image-save-path').val(extSettings.saveImages.saveToPath);
    $('#happy-image-save-by-character').prop('checked', extSettings.saveImages.byCharacterName);
    
    // Debug settings
    $('#happy-image-debug-enabled').prop('checked', extSettings.debug.enabled);
    $('#happy-image-debug-level').val(extSettings.debug.logLevel);
    $('#happy-image-show-toasts').prop('checked', extSettings.debug.showToasts);
    
    // Toggle sub-settings visibility
    toggleSubSettings();
}

// Attach event listeners to UI elements
function attachSettingsEventListeners() {
    // General settings listeners
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
    
    // API2 source listener
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
    
    // Prompt template
    $('#happy-image-prompt-template').on('input', function() {
        extSettings.promptTemplate = $(this).val();
    });
    
    // Insertion settings
    $('#happy-image-insertion-type').on('change', function() {
        extSettings.insertionType = $(this).val();
    });
    
    // Image saving settings
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
    
    // Debugging settings
    $('#happy-image-debug-enabled').on('change', function() {
        extSettings.debug.enabled = $(this).is(':checked');
    });
    
    $('#happy-image-debug-level').on('change', function() {
        extSettings.debug.logLevel = $(this).val();
    });
    
    $('#happy-image-show-toasts').on('change', function() {
        extSettings.debug.showToasts = $(this).is(':checked');
    });
    
    // Save button
    $('#happy-image-save-settings').on('click', async function() {
        // Save the settings to the extension settings object and localStorage
        await saveSettings();
        showToast('Settings saved successfully!', 'success');
    });
    
    // Test API button
    $('#happy-image-test-api').on('click', async function() {
        await testApiConnections();
    });
    
    // Reset to default button
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
    if (['info', 'warn', 'error'].indexOf(extSettings.debug.logLevel) > 0) return; // Only log if level is info or more
    console.log(`[Happy-Image INFO]`, message, ...args);
}

function logWarn(message, ...args) {
    if (!extSettings.debug || !extSettings.debug.enabled) return;
    if (['warn', 'error'].indexOf(extSettings.debug.logLevel) > 0) return; // Only log if level is warn or more
    console.warn(`[Happy-Image WARN]`, message, ...args);
}

function logError(message, ...args) {
    if (!extSettings.debug || !extSettings.debug.enabled) return;
    if (extSettings.debug.logLevel !== 'error') return; // Only log if level is error
    console.error(`[Happy-Image ERROR]`, message, ...args);
}

// Create a toast notification if enabled
function showToast(message, type = 'info') {
    if (!extSettings.debug || !extSettings.debug.showToasts) return;
    
    // Use the available toast notification system in tavern
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
        // Fallback to alert if toastr is not available
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
        // Check if Tavern API is available
        const hasTavernApi = typeof window.generate !== 'undefined' || 
                            typeof window.generateRaw !== 'undefined' ||
                            (typeof window.TavernHelper !== 'undefined' && window.TavernHelper.generate);
        if (!hasTavernApi) {
            return { valid: false, message: '酒馆主API未配置，请先在酒馆中配置主API' };
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

        // Show testing status
        showToast('正在发送测试请求...', 'info');
        
        // Create a simple test prompt
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
        
        // Get custom API config if using custom source
        let customApi = null;
        let result;
        
        if (extSettings.api2Config.source === API_SOURCE.CUSTOM) {
            customApi = extSettings.api2Config.customConfig;
            logInfo('使用自定义API配置进行测试');
            
            result = await window.TavernHelper?.generate?.({
                generate: testPrompt,
                custom_api: {
                    apiurl: customApi.apiUrl,
                    key: customApi.apiKey,
                    model: customApi.model,
                    source: customApi.source
                }
            }) || await generateRaw({
                user_input: testPrompt,
                custom_api: {
                    apiurl: customApi.apiUrl,
                    key: customApi.apiKey,
                    model: customApi.model,
                    source: customApi.source
                }
            });
        } else if (extSettings.api2Config.source === API_SOURCE.TAVERN) {
            logInfo('使用Tavern当前API配置进行测试');
            
            result = await window.TavernHelper?.generate?.({
                generate: testPrompt
            }) || await generateRaw({
                user_input: testPrompt
            });
        } else { // preset
            logInfo('使用预设配置进行测试');
            // For preset, we'll use Tavern's default for now
            result = await window.TavernHelper?.generate?.({
                generate: testPrompt
            }) || await generateRaw({
                user_input: testPrompt
            });
        }
        
        logInfo('API测试调用完成，原始结果:', result);
        
        // Try to parse the result to verify it's valid
        const parsedResult = parseApiResult(result);
        
        if (!parsedResult || !parsedResult.tasks || parsedResult.tasks.length === 0) {
            throw new Error('API返回结果格式不正确');
        }
        
        // If we got here, the test passed!
        showToast('✓ API配置生效！测试成功通过', 'success');
        logInfo('API连接测试成功');
        
    } catch (e) {
        logError('API测试错误:', e);
        showToast(`✗ API测试失败: ${e.message}`, 'error');
    }
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
    // Listen to message events to trigger image generation based on settings
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
            // Automatically trigger image generation on each message
            await handleAutoImageGeneration();
        } else {
            logInfo(`当前触发模式为 ${triggerMode}，跳过自动处理.`);
        }
        // For keyword-triggered generation, we'll check in the message itself
    });
    
    eventSource.on(event_types.CHAT_CHANGED, async function() {
        logDebug('Chat changed, reloading settings');
        isTaskRunning = false;
        lastProcessedMessageId = -1;
        await loadSettings();
    });
    
    // For message updates (e.g., when model responses stream in)
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
        
        // Get the last message
        const messageIndex = context.chat.length - 1;
        const message = context.chat[messageIndex];
        if (!message || !message.mes) {
            return;
        }
        
        // Generate images for this message
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
        
        // Check if message contains any of the trigger keywords
        const messageContent = message.mes.toLowerCase();
        const containsKeyword = extSettings.keywordList.some(keyword => 
            messageContent.includes(keyword.toLowerCase())
        );
        
        if (containsKeyword) {
            // Generate images for this message
            await processMessageForImages(message, mesId);
        }
    } catch (e) {
        logError('Keyword-based image generation error:', e);
        showToast(`Error during keyword-based image generation: ${e.message}`, 'error');
    }
}

// Process a message to generate images based on its content
async function processMessageForImages(message, messageIndex) {
    // Check if a task is already running
    if (isTaskRunning) {
        logInfo('已有任务正在执行，跳过本次请求');
        return;
    }
    
    // Check if we've already processed this message
    if (messageIndex !== undefined && messageIndex === lastProcessedMessageId) {
        logInfo(`消息 ${messageIndex} 已处理过，跳过`);
        return;
    }
    
    // Acquire lock
    isTaskRunning = true;
    
    try {
        logInfo('开始处理消息以生成图像', message);
        showToast('开始处理图像生成...', 'info');
        
        // First, generate prompts using API2
        const promptTasks = await generateImagePrompts(message.mes);
        
        if (!promptTasks || promptTasks.length === 0) {
            logInfo('消息未生成图像提示词:');
            logInfo('消息内容: ' + message.mes.substring(0, 100) + '...');
            showToast('未找到需要生成的图像提示词', 'warning');
            // Update last processed message ID even if no prompts were generated
            if (messageIndex !== undefined) {
                lastProcessedMessageId = messageIndex;
            }
            return;
        }
        
        logInfo('生成的图像提示词任务数量:', promptTasks.length);
        logInfo('生成的图像提示词任务详情:', promptTasks);
        
        // Then, for each prompt, generate an actual image using API3 (Tavern's SD)
        for (let i = 0; i < promptTasks.length; i++) {
            const task = promptTasks[i];
            logInfo(`处理提示词任务 ${i + 1}/${promptTasks.length}: ${task.english_prompt.substring(0, 50)}...`);
            showToast(`正在生成第 ${i + 1}/${promptTasks.length} 张图像...`, 'info');
            await generateImageFromPrompt(task);
        }
        showToast(`完成${promptTasks.length}个图像的生成请求`, 'success');
        
        // Update last processed message ID
        if (messageIndex !== undefined) {
            lastProcessedMessageId = messageIndex;
        }
    } catch (e) {
        logError('处理消息生成图像时出错:', e);
        showToast(`处理图像生成时出错: ${e.message}`, 'error');
    } finally {
        // Release lock
        isTaskRunning = false;
    }
}

// Generate image prompts using API2 based on message content
async function generateImagePrompts(messageContent) {
    try {
        // Validate configuration before proceeding
        if (!validateBeforeGeneration()) {
            return [];
        }
        
        logInfo('开始使用API2从内容生成提示词:', messageContent.substring(0, 100) + '...');
        showToast('正在生成图像提示词...', 'info');
        
        // Get custom API config if using custom source
        let customApi = null;
        logInfo('API2 配置来源:', extSettings.api2Config.source);
        
        if (extSettings.api2Config.source === API_SOURCE.CUSTOM) {
            customApi = extSettings.api2Config.customConfig;
            logInfo('使用自定义API配置:', { model: customApi.model, apiUrl: customApi.apiUrl });
        } else if (extSettings.api2Config.source === API_SOURCE.TAVERN) {
            logInfo('使用Tavern当前API配置');
            // If using tavern API, pass null so tavern uses its default settings
            customApi = null;
        } else if (extSettings.api2Config.source === API_SOURCE.PRESET) {
            // Using preset - implementation depends on how Tavern handles presets
            // For now using null and letting tavern decide
            customApi = null;
            logInfo('使用预设配置');
        }
        
        // Format the prompt template with the message content
        const promptTemplate = extSettings.promptTemplate;
        const prompt = promptTemplate.replace('{{message_content}}', messageContent);
        logDebug('完整API调用提示词:', prompt);
        
        // Use TavernHelper to call the API with a custom config if needed
        let result;
        logInfo('正在调用API生成提示词...');
        showToast('调用AI生成提示词...', 'info');
        
        if (customApi) {
            // Use custom API
            logInfo('使用自定义API配置进行调用');
            result = await window.TavernHelper?.generate?.({
                generate: prompt,
                custom_api: {
                    apiurl: customApi.apiUrl,
                    key: customApi.apiKey,
                    model: customApi.model,
                    source: customApi.source
                }
            }) || await generateRaw({
                user_input: prompt,
                custom_api: {
                    apiurl: customApi.apiUrl,
                    key: customApi.apiKey,
                    model: customApi.model,
                    source: customApi.source
                }
            });
        } else {
            // Use tavern's configured API
            logInfo('使用Tavern默认API进行调用');
            result = await window.TavernHelper?.generate?.({
                generate: prompt
            }) || await generateRaw({
                user_input: prompt
            });
        }
        
        logInfo('API调用完成，收到原始结果.');
        logInfo('原始API结果:', result);
        showToast('提示词生成完成，正在解析结果...', 'info');
        
        // Parse the result to extract English and Chinese prompts
        // The result should be in the format specified in the prompt template
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
    
    // Try to find and parse JSON from the response
    try {
        // First, try as is if it's already an object
        if (typeof apiResult === 'object' && apiResult !== null) {
            return apiResult;
        }
        
        // If API result is string, look for JSON structure within
        let jsonString = apiResult;
        
        // Look for JSON within triple backticks and code type
        const jsonMatch = apiResult.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            jsonString = jsonMatch[1].trim();
        } else {
            // Just look for JSON structure without triple backticks
            const objMatch = apiResult.match(/\{[\s\S]*\}/);
            if (objMatch) {
                jsonString = objMatch[0].trim();
            }
        }
        
        if (!jsonString) {
            throw new Error('No JSON found in API response');
        }
        
        const parsed = JSON.parse(jsonString);
        return parsed;
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
        
        // Call tavern's built-in image generation via slash command system
        // This assumes that Tavern has working SD integration
        try {
            const result = await SlashCommandParser.commands['sd']?.callback?.(
                {}, // options object
                prompt
            );
            
            if (!result) {
                throw new Error('No result from Tavern SD command');
            }
            
            logDebug(`Image generated URL: ${result}`);
            
            // Format to include both image URL and Chinese commentary depending on user options 
            const formattedResult = {
                imageUrl: result,
                englishPrompt: prompt,
                chineseCommentary: chineseCommentary,
                position: task.position
            };
            
            // Insert image into message based on position preference
            await insertImageIntoMessage(formattedResult);
            
            // If image saving is enabled, try to save it
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
        
        // Get the last message (where the image should be inserted)
        const message = context.chat[context.chat.length - 1];
        if (!message) {
            logError('No message to insert image into');
            return;
        }
        
        // Depending on insertion type, handle differently
        switch (extSettings.insertionType) {
            case INSERT_TYPE.BEGINNING:
                // Add image at beginning of last message
                if (imageData.chineseCommentary) {
                    message.mes = `<br><img src="${imageUrl}" alt="${imageData.chineseCommentary}"><br><em>${imageData.chineseCommentary}</em>` + message.mes;
                } else {
                    message.mes = `<br><img src="${imageUrl}">` + message.mes;
                }
                break;
                
            case INSERT_TYPE.NEW_MESSAGE:
                // Create a new message with the image
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
                
                // Add to chat array
                context.chat.push(newMes);
                break;
                
            case INSERT_TYPE.END_OF_MESSAGE:
            default:
                // Add image at end of last message
                if (imageData.chineseCommentary) {
                    message.mes = message.mes + `<br><img src="${imageUrl}" alt="${imageData.chineseCommentary}"><br><em>${imageData.chineseCommentary}</em>`;
                } else {
                    message.mes = message.mes + `<br><img src="${imageUrl}">`;
                }
        }
        
        // Add to message's extra field for tavern's image system
        if (!message.extra) {
            message.extra = {};
        }
        
        if (!Array.isArray(message.extra.image_swipes)) {
            message.extra.image_swipes = [];
        }
        
        message.extra.image_swipes.push(imageUrl);
        message.extra.image = imageUrl;
        message.extra.title = imageData.chineseCommentary;
        
        // Save the chat
        await context.saveChat();
        
        // Update the message display
        const $mesDiv = $(`.mes[mesid="${context.chat.length - 1}"]`);
        if ($mesDiv.length) {
            // Use Tavern's built-in function to update the message display
            appendMediaToMessage(message, $mesDiv);
        }
        
        // Trigger message update event
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
        // Check if we can access to save to file system
        if (!extSettings.saveImages.enabled) return;
        
        // Skip if we can't save due to browser restrictions
        // (Browsers typically don't allow direct file system writes)
        logDebug('Image saving not implemented due to browser restrictions');
        
        // Optional: In the future, we could implement via backend endpoint if available
    } catch (e) {
        logError('Error saving image to disk:', e);
        // Don't show error toasts for this since it's likely a browser security limitation
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


// Expose utility functions globally if needed
window.HappyImage = {
    processMessageForImages,
    generateImagePrompts,
    generateImageFromPrompt
};
