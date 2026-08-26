import fs from 'fs';
import path from 'path';
import { classifyNode, requiredRungs } from './evidenceLadder.js';

// ─── Turnkey-оракулы (Lever 1′, вспомогательное) ─────────────────────────────
// Детектит тип проекта и предлагает КОНКРЕТНЫЕ команды рунгов лестницы, чтобы
// исполнитель не выдумывал их и не подсовывал `echo ok`. Это подсказка, а не
// принуждение: реальные --cmd всё равно передаёт исполнитель. Гейт oracle_floor
// проверяет фактические зелёные рецепты, а не эти строки.
//
// CLI: node oracleSuggest.js <projectDirOrTaskDir> [--class code.behavioral]

export function detectProjectType(dir) {
    const has = (rel) => fs.existsSync(path.join(dir, rel));
    // Ищем и в самом каталоге, и на пару уровней выше (task_dir лежит в memory/tactical).
    const roots = [dir, path.resolve(dir, '..'), path.resolve(dir, '../..'), path.resolve(dir, '../../..')];
    const anyHas = (rel) => roots.some(r => fs.existsSync(path.join(r, rel)));
    const anyGlob = (ext) => roots.some(r => {
        try { return fs.readdirSync(r).some(f => f.endsWith(ext)); } catch { return false; }
    });

    if (anyHas('ProjectSettings/ProjectVersion.txt')) return 'unity';
    if (anyGlob('.csproj') || anyGlob('.sln')) return 'dotnet';
    if (anyHas('package.json')) return has('tsconfig.json') || anyHas('tsconfig.json') ? 'node-ts' : 'node';
    if (anyHas('pyproject.toml') || anyHas('setup.py') || anyGlob('.py')) return 'python';
    if (anyHas('go.mod')) return 'go';
    if (anyHas('Cargo.toml')) return 'rust';
    return 'generic';
}

// Предложения команд по типу проекта. console_clean — только для behavioral.
const SUGGESTIONS = {
    'node':    { compile: 'node --check <file.js>',        tests: 'npm test',                 console_clean: 'node <scripted-sim.mjs>' },
    'node-ts': { compile: 'npx tsc --noEmit',              tests: 'npm test',                 console_clean: 'node <scripted-sim.mjs>' },
    'dotnet':  { compile: 'dotnet build -warnaserror',     tests: 'dotnet test',              console_clean: 'dotnet run --project <smoke>' },
    'unity':   {
        compile: 'Unity -batchmode -quit -projectPath . -logFile compile.log && ! grep -E "error CS" compile.log',
        tests:   'Unity -batchmode -runTests -testPlatform PlayMode -testResults results.xml -logFile - && node Scripts/parseUnityTestResults.mjs results.xml',
        console_clean: 'Unity -batchmode -quit -projectPath . -executeMethod HarnessSmoke.Boot -logFile play.log && ! grep -E "Exception|error|NullReference" play.log'
    },
    'python':  { compile: 'python -m py_compile <file.py>', tests: 'pytest -q',               console_clean: 'python <scripted_sim.py>' },
    'go':      { compile: 'go build ./...',                 tests: 'go test ./...',            console_clean: 'go run ./cmd/smoke' },
    'rust':    { compile: 'cargo build',                    tests: 'cargo test',              console_clean: 'cargo run --bin smoke' },
    'generic': { compile: '<команда сборки/typecheck>',     tests: '<команда тестов>',        console_clean: '<скриптовый прогон, ассерт чистого лога>' }
};

/**
 * Возвращает предложенные команды рунгов для узла: только обязательные рунги его
 * класса, с командами под обнаруженный тип проекта.
 */
export function suggestOracles(node, projectType) {
    const cls = classifyNode(node);
    const rungs = requiredRungs(cls);
    const table = SUGGESTIONS[projectType] || SUGGESTIONS.generic;
    const nid = node.id || '<ID>';
    return {
        artifact_class: cls,
        project_type: projectType,
        rungs: rungs.map(r => {
            // security — встроенный скан секретов/опасных паттернов, без --cmd.
            if (r === 'security') {
                return {
                    rung: r,
                    suggested_cmd: '(встроенный скан секретов/опасных паттернов)',
                    cli: `validator.js <dir> --node ${nid} --type oracle --rung security`
                };
            }
            return {
                rung: r,
                suggested_cmd: table[r] || '<нет предложения>',
                cli: `validator.js <dir> --node ${nid} --type oracle --rung ${r} --cmd "${table[r] || '...'}"`
            };
        })
    };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('oracleSuggest.js')) {
    const dir = process.argv[2] || process.cwd();
    const clsIdx = process.argv.indexOf('--class');
    const artifactClass = clsIdx >= 0 ? process.argv[clsIdx + 1] : null;
    const projectType = detectProjectType(dir);
    const node = { id: process.argv.includes('--node') ? process.argv[process.argv.indexOf('--node') + 1] : '<ID>', artifact_kind: 'code', artifact_class: artifactClass };
    console.log(JSON.stringify(suggestOracles(node, projectType), null, 2));
}
