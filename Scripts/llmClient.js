import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadEnv(dirPath) {
    try {
        const envPath = path.resolve(dirPath, '.env');
        const content = await fs.readFile(envPath, 'utf-8');
        for (const line of content.split(/\r?\n/)) {
            const match = line.match(/^\s*([\w_]+)\s*=\s*(.+?)\s*$/);
            if (match) {
                process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
            }
        }
    } catch {
        // Игнорируем, если .env нет (возможно ключи уже в окружении)
    }
}

// Model catalog lives in a sibling file so llm-config.json stays lean for the
// judge/probe hot path (aiProbe). Only the model-calling engine loads it.
async function loadModelsCatalog() {
    try {
        const raw = await fs.readFile(path.resolve(__dirname, 'llm-models-catalog.json'), 'utf-8');
        return JSON.parse(raw.replace(/^﻿/, '')).available_models || [];
    } catch {
        return [];
    }
}

async function loadConfig() {
    const configPath = path.resolve(__dirname, 'llm-config.json');
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    config.available_models = await loadModelsCatalog();
    return config;
}

export async function callLLM(role, systemPrompt, userPrompt, options = {}) {
    // Поднимаемся на уровень kbpro-ai-docs (2 папки вверх от Scripts), чтобы найти .env
    await loadEnv(path.resolve(__dirname, '../../..')); 
    await loadEnv(path.resolve(__dirname, '../..'));
    await loadEnv(process.cwd());

    const config = await loadConfig();
    const modelConfig = config.roles[role];
    if (!modelConfig) {
        throw new Error(`Роль '${role}' не найдена в llm-config.json`);
    }

    if (modelConfig.provider === 'gemini') {
        // Герметичность: HARNESS_OFFLINE=1 запрещает живые HTTP-вызовы (тесты,
        // офлайн-прогоны). Ошибка ловится штатным фолбэком, а не роняет прогон.
        if (process.env.HARNESS_OFFLINE === '1') {
            throw new Error(`[offline] живые LLM-вызовы отключены (HARNESS_OFFLINE=1), роль ${role}`);
        }
        const apiKey = process.env[modelConfig.env_var];
        if (!apiKey) {
            throw new Error(`Не задана переменная окружения ${modelConfig.env_var} для роли ${role}`);
        }

        // Модель HTTP-Gemini выносится в env, чтобы не хардкодить протухший ID
        // (gemini-2.0-flash → 404). GEMINI_HTTP_MODEL перекрывает конфиг.
        const httpModelId = process.env.GEMINI_HTTP_MODEL || modelConfig.model_id;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${httpModelId}:generateContent?key=${apiKey}`;
        
        const payload = {
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
            contents: [
                { parts: [{ text: userPrompt }] }
            ],
            generationConfig: {
                temperature: modelConfig.temperature || 0.2
            }
        };

        if (options.jsonMode) {
            payload.generationConfig.responseMimeType = "application/json";
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Ошибка Gemini API: ${response.status} ${response.statusText} - ${errText}`);
        }

        const data = await response.json();
        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!textResponse) {
            throw new Error(`Пустой ответ от модели: ${JSON.stringify(data)}`);
        }

        return textResponse;
    }

    if (modelConfig.access_type === 'cli') {
        return new Promise((resolve, reject) => {
            let cmdStr = modelConfig.cli_command;
            if (!cmdStr) {
                return reject(new Error(`cli_command не задан для роли ${role}`));
            }

            cmdStr = cmdStr.replace('{model_id}', modelConfig.model_id);
            
            // Формируем полный промпт
            let fullPrompt = systemPrompt ? systemPrompt + '\n\n' + userPrompt : userPrompt;
            if (options.jsonMode) {
                fullPrompt += '\n\nОтветь СТРОГО в формате JSON без markdown-кода.';
            }

            const passPromptInStdin = !cmdStr.includes('{prompt}');
            if (!passPromptInStdin) {
                const escapedPrompt = fullPrompt.replace(/"/g, '\\"');
                cmdStr = cmdStr.replace('{prompt}', escapedPrompt);
            }
            
            // Если в ОС Windows, используем powershell
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'powershell.exe' : true;
            
            // Разбиваем команду на бинарник и аргументы (упрощенно)
            const parts = cmdStr.match(/(?:[^\s"]+|"[^"]*")+/g).map(p => p.replace(/^"|"$/g, ''));
            const command = parts[0];
            const args = parts.slice(1);

            const child = spawn(command, args, { shell });

            let stdoutData = '';
            let stderrData = '';

            child.stdout.on('data', (data) => {
                stdoutData += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderrData += data.toString();
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`Команда завершилась с ошибкой ${code}: ${stderrData}`));
                }
                resolve(stdoutData.trim());
            });

            child.on('error', (err) => {
                reject(new Error(`Не удалось запустить CLI: ${err.message}`));
            });

            if (passPromptInStdin) {
                child.stdin.write(fullPrompt);
            }
            child.stdin.end();
        });
    }

    throw new Error(`Тип доступа '${modelConfig.access_type}' пока не поддерживается скриптом`);
}

// ─── Каскадный fallback ──────────────────────────────────────────────────────

/**
 * Определяет, является ли ошибка повторяемой (можно переключиться на другую модель)
 */
function isRetryableError(err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('429') ||
           msg.includes('500') ||
           msg.includes('502') ||
           msg.includes('503') ||
           msg.includes('timeout') ||
           msg.includes('econnrefused') ||
           msg.includes('enotfound') ||
           msg.includes('rate') ||
           msg.includes('overloaded') ||
           msg.includes('resource_exhausted');
}

/**
 * Маппинг человекочитаемого имени модели → Gemini API model id
 */
function mapToGeminiApiId(humanName) {
    const map = {
        'Gemini 3.5 Pro': 'gemini-3.5-pro',
        'Gemini 3.5 Flash': 'gemini-3.5-flash',
        'Gemini 3.1 Pro': 'gemini-3.1-pro',
        'Gemini 3.1 Flash-Lite': 'gemini-3.1-flash-lite',
        'Gemini 2.0 Flash': 'gemini-2.0-flash',
        'Gemini 2.0 Pro': 'gemini-2.0-pro',
        'Gemini 1.5 Pro': 'gemini-1.5-pro',
        'Gemini 1.5 Flash': 'gemini-1.5-flash'
    };
    return map[humanName] || humanName.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Возвращает модели для указанного tier, отсортированные по приоритету
 * @param {object} config - llm-config.json parsed
 * @param {string} tier - 'frontier' | 'advanced' | 'medium' | 'light'
 * @param {boolean} preferFree - если true, бесплатные модели первыми
 * @returns {Array} массив моделей из available_models
 */
export function getModelsForTier(config, tier, preferFree = false) {
    const tierNames = config.capability_tiers?.[tier] || [];
    const models = (config.available_models || []).filter(m => tierNames.includes(m.name));

    return models.sort((a, b) => {
        // Приоритет 1: status === 'online'
        const aOnline = a.status === 'online';
        const bOnline = b.status === 'online';
        if (aOnline !== bOnline) return aOnline ? -1 : 1;

        // Приоритет 2: isFree (если включен preferFree)
        if (preferFree && a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        if (!preferFree && a.isFree !== b.isFree) return a.isFree ? 1 : -1;
        
        return 0;
    });
}

/**
 * Прямой вызов конкретной модели (минуя систему ролей)
 * @param {object} modelEntry - объект из available_models
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} options - { temperature, jsonMode }
 * @returns {Promise<string>}
 */
export async function callLLMDirect(modelEntry, systemPrompt, userPrompt, options = {}) {
    await loadEnv(path.resolve(__dirname, '../../..'));
    await loadEnv(path.resolve(__dirname, '../..'));
    await loadEnv(process.cwd());

    const name = modelEntry.name;
    const temperature = options.temperature ?? 0.2;

    // Попытка 1: Gemini HTTP API (если есть ключ)
    if (name.startsWith('Gemini') || name.startsWith('gemini')) {
        if (process.env.HARNESS_OFFLINE === '1') {
            throw new Error(`[offline] живые LLM-вызовы отключены (HARNESS_OFFLINE=1) для ${name}`);
        }
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
            // GEMINI_HTTP_MODEL перекрывает маппинг вымышленного имени на API-ID —
            // чтобы протухший дефолт (gemini-2.0-flash → 404) правился без кода.
            const modelId = process.env.GEMINI_HTTP_MODEL || mapToGeminiApiId(name);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
            const payload = {
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ parts: [{ text: userPrompt }] }],
                generationConfig: { temperature }
            };
            if (options.jsonMode) {
                payload.generationConfig.responseMimeType = "application/json";
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(60000)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Gemini HTTP ${response.status}: ${errText.slice(0, 200)}`);
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error(`Пустой ответ от ${modelId}`);
            return text;
        }
    }

    // Попытка 2: CLI
    if (name.startsWith('Claude') || name.startsWith('claude')) {
        return callCliDirect('claude', name, systemPrompt, userPrompt, options);
    }
    if (name.startsWith('GPT') || name.startsWith('o1') || name.startsWith('o3')) {
        return callCliDirect('codex', name, systemPrompt, userPrompt, options);
    }
    if ((name.startsWith('Gemini') || name.startsWith('gemini'))) {
        return callCliDirect('gemini', name, systemPrompt, userPrompt, options);
    }

    throw new Error(`Нет доступного провайдера для модели: ${name}`);
}

/**
 * Вспомогательная: вызов модели через CLI
 */
async function callCliDirect(provider, modelName, systemPrompt, userPrompt, options = {}) {
    const configPath = path.resolve(__dirname, 'llm-config.json');
    let config = {};
    try {
        const content = await fs.readFile(configPath, 'utf-8');
        config = JSON.parse(content);
    } catch (e) {
        // Fallback если не смогли прочитать
    }

    let cmdTemplate = config.cli_templates?.[provider];
    if (!cmdTemplate) {
        if (provider === 'claude') cmdTemplate = 'claude -p "{prompt}"';
        else if (provider === 'codex') cmdTemplate = 'codex exec -m "{model_id}" -';
        else if (provider === 'gemini') cmdTemplate = 'gemini "{prompt}"';
    }

    let fullPrompt = (systemPrompt ? systemPrompt + '\n' : '') + userPrompt;
    cmdTemplate = cmdTemplate.replace('{model_id}', modelName);

    const passPromptInStdin = !cmdTemplate.includes('{prompt}');
    if (!passPromptInStdin) {
        const escapedPrompt = fullPrompt.replace(/"/g, '\\"');
        cmdTemplate = cmdTemplate.replace('{prompt}', escapedPrompt);
    }

    return new Promise((resolve, reject) => {
        const isWin = process.platform === 'win32';
        
        // Разбиваем команду (упрощенно)
        let command, args, shell;
        if (isWin) {
            command = 'powershell.exe';
            args = ['-Command', cmdTemplate];
            shell = false;
        } else {
            command = cmdTemplate;
            args = [];
            shell = true;
        }

        const child = spawn(command, args, { shell });

        let stdoutData = '';
        let stderrData = '';

        child.stdout.on('data', (data) => { stdoutData += data.toString(); });
        child.stderr.on('data', (data) => { stderrData += data.toString(); });

        if (passPromptInStdin) {
            let p = systemPrompt ? systemPrompt + '\n\n' + userPrompt : userPrompt;
            if (options.jsonMode) {
                p += '\n\nОтветь СТРОГО в формате JSON без markdown-кода.';
            }
            child.stdin.write(p);
            child.stdin.end();
        }

        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`CLI завершился с кодом ${code}: ${stderrData}`));
            }
            resolve(stdoutData.trim());
        });

        child.on('error', (err) => {
            reject(new Error(`Не удалось запустить CLI: ${err.message}`));
        });
    });
}

/**
 * Каскадный вызов LLM с автоматическим переключением модели при ошибках.
 * Порядок:
 * 1. Основная модель роли
 * 2. Альтернативные модели из того же tier
 * 3. Модели из более низкого tier (бесплатные в приоритете)
 *
 * @param {string} role - имя роли из llm-config.json
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} options - { jsonMode, temperature }
 * @returns {Promise<string>}
 */
export async function callLLMWithFallback(role, systemPrompt, userPrompt, options = {}) {
    const config = await loadConfig();
    const roleConfig = config.roles[role];
    if (!roleConfig) throw new Error(`Роль '${role}' не найдена в llm-config.json`);

    const tier = roleConfig.tier || 'medium';
    const preferFree = roleConfig.prefer_free || false;

    // Шаг 1: Попробовать основную модель роли
    try {
        return await callLLM(role, systemPrompt, userPrompt, options);
    } catch (primaryErr) {
        if (!isRetryableError(primaryErr)) throw primaryErr;
        console.warn(`[llmClient] Основная модель ${roleConfig.model_id} недоступна: ${primaryErr.message}`);
    }

    // Шаг 2: Каскад по моделям из того же tier
    const candidates = getModelsForTier(config, tier, preferFree);
    for (const candidate of candidates) {
        if (candidate.name === roleConfig.model_id) continue;
        try {
            console.warn(`[llmClient] Fallback → ${candidate.name}`);
            return await callLLMDirect(candidate, systemPrompt, userPrompt, {
                ...options,
                temperature: options.temperature ?? roleConfig.temperature
            });
        } catch (fallbackErr) {
            if (!isRetryableError(fallbackErr)) throw fallbackErr;
            console.warn(`[llmClient] Модель ${candidate.name} тоже недоступна: ${fallbackErr.message}`);
            continue;
        }
    }

    // Шаг 3: Каскад вниз по tier'ам
    const tierOrder = ['frontier', 'advanced', 'medium', 'light'];
    const currentTierIdx = tierOrder.indexOf(tier);

    for (let i = currentTierIdx + 1; i < tierOrder.length; i++) {
        const lowerCandidates = getModelsForTier(config, tierOrder[i], true);
        for (const candidate of lowerCandidates) {
            try {
                console.warn(`[llmClient] Каскад вниз → ${tierOrder[i]}:${candidate.name}`);
                return await callLLMDirect(candidate, systemPrompt, userPrompt, {
                    ...options,
                    temperature: options.temperature ?? roleConfig.temperature
                });
            } catch { continue; }
        }
    }

    throw new Error(`[llmClient] Все модели недоступны для роли '${role}'. Каскад исчерпан.`);
}
