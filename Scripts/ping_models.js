import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { callLLMDirect } from './llmClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function pingModels() {
    console.log('=== Запуск PING для проверки доступности моделей ===\n');
    
    // The model catalog is a sibling file (extracted out of llm-config.json).
    const configPath = path.resolve(__dirname, 'llm-models-catalog.json');
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content.replace(/^﻿/, ''));

    console.log(`Найдено ${config.available_models.length} моделей в каталоге. Начинаем опрос...\n`);
    
    let availableCount = 0;
    
    for (const model of config.available_models) {
        let startTime = Date.now();
        try {
            // Обернем вызов в Promise.race для таймаута 15 секунд
            const timeoutMs = 15000;
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`PING Timeout (${timeoutMs/1000}s)`)), timeoutMs)
            );
            
            // Вызываем модель напрямую
            const pingPromise = callLLMDirect(
                model, 
                "You are a ping bot. Reply only with 'pong'.",
                "ping",
                { temperature: 0 }
            );

            await Promise.race([pingPromise, timeoutPromise]);
            
            let latency = Date.now() - startTime;
            model.status = "online";
            model.latency_ms = latency;
            model.error = null;
            model.last_checked = new Date().toISOString();
            
            availableCount++;
            console.log(`[+] ${model.name.padEnd(30)} ONLINE  (${latency}ms)`);
            
            // Задержка 1с для избежания 429 Too Many Requests
            await new Promise(r => setTimeout(r, 1000));
            
        } catch (e) {
            let latency = Date.now() - startTime;
            model.status = "offline";
            model.latency_ms = null;
            
            let errMsg = e.message || String(e);
            
            model.error = errMsg.replace(/\r?\n/g, " ");
            model.last_checked = new Date().toISOString();
            
            console.log(`[-] ${model.name.padEnd(30)} OFFLINE (${latency}ms) - ${model.error}`);
        }
        // Задержка 1с для избежания 429 Too Many Requests
        await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log(`\n=== Пинг завершен. Доступно: ${availableCount} / ${config.available_models.length} ===`);
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log("Статусы сохранены в llm-models-catalog.json. Движок LLMClient теперь будет использовать их при выборе.");
}

pingModels().catch(err => {
    console.error('Ошибка скрипта ping:', err);
    process.exit(1);
});
