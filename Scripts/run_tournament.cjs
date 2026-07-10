const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONCEPTS_DIR = path.join(__dirname, '../../../../../memory/tactical/TACT-006/concepts');
const LOG_FILE = path.join(__dirname, '../../../../../memory/tactical/TACT-006/tournament_log.md');
const CONFIG_FILE = path.join(__dirname, 'llm-config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
const TIERS = config.capability_tiers;

function getCmdForModel(modelName) {
    if (modelName.toLowerCase().includes('gemini')) return 'agy';
    if (modelName.toLowerCase().includes('claude')) return 'claude';
    if (modelName.toLowerCase().includes('gpt')) return 'codex';
    return null;
}

function callCLI(modelName, promptText) {
    const cmd = getCmdForModel(modelName);
    let result;
    
    if (cmd === 'agy') {
        result = spawnSync('agy', ['--model', modelName, '-p', promptText], { cwd: 'C:\\Users\\DavASko', encoding: 'utf-8', shell: false, timeout: 120000 });
        
        let outputText = "";
        try {
            const brainDir = 'C:\\Users\\DavASko\\.gemini\\antigravity-cli\\brain';
            const folders = fs.readdirSync(brainDir)
                .map(name => ({ name, time: fs.statSync(path.join(brainDir, name)).mtime.getTime() }))
                .sort((a, b) => b.time - a.time);
            if (folders.length > 0) {
                const transcriptPath = path.join(brainDir, folders[0].name, '.system_generated', 'logs', 'transcript.jsonl');
                if (fs.existsSync(transcriptPath)) {
                    const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
                    for (const line of lines) {
                        try {
                            const obj = JSON.parse(line);
                            if (obj.type === 'PLANNER_RESPONSE') outputText = obj.content;
                        } catch(e) {}
                    }
                }
            }
        } catch(e) {}
        
        result = { status: result.status, stdout: outputText, stderr: result.stderr };
    } else if (cmd === 'claude') {
        result = spawnSync('claude', ['--model', modelName, '-p', promptText], { encoding: 'utf-8', shell: false, timeout: 120000 });
    } else if (cmd === 'codex') {
        result = spawnSync('codex', ['exec', '-m', modelName, '-'], { input: promptText, encoding: 'utf-8', shell: false, timeout: 120000 });
    } else {
        return { success: false, output: `Unsupported model ${modelName}` };
    }

    let output = (result.stdout || "").trim();
    let errOut = (result.stderr || "").trim();
    let fullLog = output + "\n" + errOut;
    
    console.log(`[DEBUG] model: ${modelName}, status: ${result.status}`);
    console.log(`[DEBUG] output len: ${output.length}, err len: ${errOut.length}`);
    if (output.length === 0 && errOut.length > 0) {
         console.log(`[DEBUG] stderr dump: ${errOut.substring(0, 200)}`);
    }

    // Check for obvious API quota or timeout errors or empty output
    if (result.status !== 0 || fullLog.includes("error") || fullLog.includes("limit") || fullLog.includes("RESOURCE_EXHAUSTED") || output === "") {
         return { success: false, output: `[ОШИБКА АПИ / ЛИМИТЫ]: ${fullLog.substring(0, 150)}... (код ${result.status})` };
    }
    
    return { success: true, output: output.substring(0, 800) + "..." };
}

function runJudgeWithFallback(targetModel, tierName, promptText) {
    let tierLevels = ['frontier', 'advanced', 'medium', 'light'];
    let startIdx = tierLevels.indexOf(tierName);
    
    let tried = [];
    
    for (let i = startIdx; i < tierLevels.length; i++) {
        let currentTier = tierLevels[i];
        let modelsInTier = [...TIERS[currentTier]];
        
        // Ensure targetModel is tried first if it's in this tier
        if (modelsInTier.includes(targetModel)) {
            modelsInTier = [targetModel, ...modelsInTier.filter(m => m !== targetModel)];
        }
        
        for (let model of modelsInTier) {
            console.log(`Calling ${model} (Tier: ${currentTier})...`);
            let res = callCLI(model, promptText);
            
            if (res.success) {
                return { 
                    actualModel: model, 
                    response: res.output,
                    tier: currentTier,
                    history: tried
                };
            } else {
                console.log(`Failed ${model}: ${res.output}`);
                tried.push(`${model} -> ОШИБКА`);
            }
        }
    }
    
    return { actualModel: "NONE", response: "[КРИТИЧЕСКАЯ ОШИБКА]: Все модели во всех тирах недоступны.", tier: "none", history: tried };
}

function getConceptContent(file) {
    if (!fs.existsSync(file)) return "Файл не найден";
    return fs.readFileSync(file, 'utf-8');
}

function runMatch(conceptA_file, conceptB_file, matchName) {
    const textA = getConceptContent(path.join(CONCEPTS_DIR, conceptA_file));
    const textB = getConceptContent(path.join(CONCEPTS_DIR, conceptB_file));
    
    const prompt = `Ты строгий судья архитектурного Олимпийского турнира ИИ-агентов.
Сравни две концепции и выбери победителя. Оценивай латентность, надежность, реализуемость (Black-box vs White-box).

КОНЦЕПЦИЯ A:
${textA}

КОНЦЕПЦИЯ B:
${textB}

Твой ответ должен начинаться со слов "ПОБЕДИТЕЛЬ: КОНЦЕПЦИЯ [A/B]". Затем кратко обоснуй почему.`;

    let log = `\n### ${matchName} (${conceptA_file} vs ${conceptB_file})\n\n`;
    
    let votesA = 0;
    let votesB = 0;
    
    // User requested models: Gemini 3.5 Flash (medium), Gemini 3.1 Pro (advanced), Gemini 3.5 Pro (frontier)
    const requiredJudges = [
        { model: "Gemini 3.5 Flash", tier: "medium" },
        { model: "Gemini 3.1 Pro", tier: "advanced" },
        { model: "Gemini 3.5 Pro", tier: "frontier" }
    ];
    
    for (const req of requiredJudges) {
        log += `#### Судья: Запрос на ${req.model} (${req.tier})\n`;
        const res = runJudgeWithFallback(req.model, req.tier, prompt);
        
        if (res.actualModel !== req.model) {
             log += `> ВНИМАНИЕ: Фолбек Харнесс-Протокола! Изначальная модель недоступна. Использована: **${res.actualModel}** (Тир: ${res.tier})\n`;
             if (res.history.length > 0) log += `> Лог попыток: ${res.history.join(', ')}\n\n`;
        } else {
             log += `> Модель успешно ответила: **${res.actualModel}**\n\n`;
        }
        
        log += `> ${res.response.replace(/\n/g, '\n> ')}\n\n`;
        
        const answer = res.response;
        if (answer.includes("ОШИБКА")) {
             votesA += 1; 
        } else {
             if (answer.includes("ПОБЕДИТЕЛЬ: КОНЦЕПЦИЯ A")) votesA++;
             else if (answer.includes("ПОБЕДИТЕЛЬ: КОНЦЕПЦИЯ B")) votesB++;
             else votesA++; // default
        }
    }
    
    const winner = votesA >= votesB ? conceptA_file : conceptB_file;
    log += `**Итог матча:** Победила ${winner} (Голосов: ${Math.max(votesA, votesB)}/3)\n`;
    return { log, winner };
}

function runTournament() {
    let mainLog = "# Олимпийский Турнир Концепций (УЗЕЛ-04)\n\n";
    mainLog += "Повторный турнир с участием элитных судей: Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3.5 Pro.\n\n";
    mainLog += "ПРИМЕНЕН ПРОТОКОЛ ФОЛБЕКА (Harness Protocol Fallback). В случае недоступности (квоты/таймауты) модель автоматически заменяется на доступную из того же тира.\n\n";
    
    // 1/8 Финала (Group Stage)
    mainLog += "## 1/8 Финала (Групповая стадия)\n";
    const winners1 = [];
    let r1 = runMatch("concept_1.md", "concept_2.md", "Матч 1");
    mainLog += r1.log; winners1.push(r1.winner);
    
    let r2 = runMatch("concept_3.md", "concept_4.md", "Матч 2");
    mainLog += r2.log; winners1.push(r2.winner);
    
    let r3 = runMatch("concept_5.md", "concept_6.md", "Матч 3");
    mainLog += r3.log; winners1.push(r3.winner);
    
    let r4 = runMatch("concept_7.md", "concept_8.md", "Матч 4");
    mainLog += r4.log; winners1.push(r4.winner);
    
    let r5 = runMatch("concept_9.md", "concept_10.md", "Матч 5");
    mainLog += r5.log; winners1.push(r5.winner);
    
    // Quarterfinals
    mainLog += "\n## Четвертьфиналы\n";
    const winners2 = [];
    let r6 = runMatch(winners1[0], winners1[1], "Матч 6");
    mainLog += r6.log; winners2.push(r6.winner);
    
    let r7 = runMatch(winners1[2], winners1[3], "Матч 7");
    mainLog += r7.log; winners2.push(r7.winner);
    
    mainLog += `*Концепция ${winners1[4]} проходит в полуфинал автоматом (Bye).*\n`;
    winners2.push(winners1[4]);
    
    // Semifinals
    mainLog += "\n## Полуфиналы\n";
    const winners3 = [];
    let r8 = runMatch(winners2[0], winners2[1], "Матч 8 (Полуфинал 1)");
    mainLog += r8.log; winners3.push(r8.winner);
    
    mainLog += `*Концепция ${winners2[2]} проходит в финал автоматом.*\n`;
    winners3.push(winners2[2]);
    
    // Finals
    mainLog += "\n## ФИНАЛ\n";
    let r10 = runMatch(winners3[0], winners3[1], "Матч 10 (Гранд-Финал)");
    mainLog += r10.log;
    
    mainLog += `\n# АБСОЛЮТНЫЙ ПОБЕДИТЕЛЬ ТУРНИРА: ${r10.winner} 🏆\n`;
    
    fs.writeFileSync(LOG_FILE, mainLog, 'utf-8');
    console.log("Tournament completed. Log saved to tournament_log.md");
}

runTournament();
