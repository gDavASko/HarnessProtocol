/**
 * Sprint Contract Formalizer (Anthropic inspired)
 * Normalizes Definition of Done criteria into deterministic machine-verifiable predicates.
 */
export function formalizeContract(node) {
    const rawDod = Array.isArray(node.dod) ? node.dod : [];
    
    const predicates = rawDod.map((item, index) => {
        const text = typeof item === 'string' ? item : (item.criterion || item.text || '');
        const id = item.id || `dod_${index + 1}`;
        
        let type = 'judge_criteria'; // default fallback
        let target = null;

        // 1. File existence / creation check
        const fileMatch = text.match(/(?:создать|создан|сохранить|файл|file|create)\s+[`"']?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`"']?/i);
        if (fileMatch) {
            type = 'file_exists';
            target = fileMatch[1];
        }

        // 2. Test / Command execution check
        const testMatch = text.match(/(?:тест|test|npm test|pytest|compile|сборка|скомпилир)/i);
        if (testMatch && (node.artifact_kind === 'code' || text.includes('npm') || text.includes('test'))) {
            type = 'test_exit_0';
            target = 'npm test';
        }

        // 3. Syntax / AST validation check
        const syntaxMatch = text.match(/(?:синтаксис|syntax|валидн|ast|json|парсинг)/i);
        if (syntaxMatch && !fileMatch) {
            type = 'ast_valid';
        }

        return {
            id,
            rawCriterion: text,
            predicateType: type,
            target,
            strictness: node.criticality === 'L3' ? 'high' : 'standard'
        };
    });

    return {
        nodeId: node.id,
        title: node.title,
        artifactKind: node.artifact_kind || 'text',
        criticality: node.criticality || 'L1',
        predicates,
        totalItems: predicates.length,
        isFormalized: true
    };
}
