import vm from 'vm';
import path from 'path';

/**
 * Pre-Commit Syntax & AST Guard (SWE-agent inspired)
 * Fast in-memory / static syntax validation (0 LLM tokens spent)
 */
export function checkCodeSyntax(code, filename = 'inline.js') {
    if (!code || typeof code !== 'string') {
        return { ok: false, error: 'Empty or invalid code content' };
    }

    const ext = path.extname(filename).toLowerCase();

    // 1. JSON validation
    if (ext === '.json' || filename.endsWith('.json')) {
        try {
            JSON.parse(code);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: `JSON Parse Error: ${err.message}` };
        }
    }

    // 2. JavaScript / Node.js validation
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || filename.endsWith('.js')) {
        try {
            // Check parsing as an ES module or script
            new vm.Script(code, { filename });
            return { ok: true };
        } catch (err) {
            // If Script fails due to import/export statements, try compileFunction or module syntax check
            try {
                // In Node.js vm, imports in top-level script may throw 'Cannot use import statement outside a module'
                // If the error is specifically top-level import/export, wrap or check syntax
                if (err.message.includes('Cannot use import statement') || err.message.includes('Unexpected token \'export\'')) {
                    // Try basic syntax validation for module by wrapping in async function without import or regex check
                    return checkModuleSyntaxHeuristic(code);
                }
                return { ok: false, error: `JS Syntax Error: ${err.message}` };
            } catch (innerErr) {
                return { ok: false, error: `JS Syntax Error: ${innerErr.message}` };
            }
        }
    }

    // 3. Markdown / Text / YAML - general structure check
    if (ext === '.md' || ext === '.txt') {
        // Check for unbalanced code fences
        const codeFenceMatches = code.match(/^```/gm);
        if (codeFenceMatches && codeFenceMatches.length % 2 !== 0) {
            return { ok: false, error: 'Unbalanced markdown code blocks (odd number of ``` fences)' };
        }
        return { ok: true };
    }

    return { ok: true };
}

function checkModuleSyntaxHeuristic(code) {
    try {
        // Replace top-level imports and exports with valid dummy statements to check internal syntax with vm.Script
        const sanitized = code
            .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '// import')
            .replace(/^import\s+['"][^'"]+['"];?/gm, '// import')
            .replace(/^export\s+(?:default\s+)?/gm, '/* export */ ');
        new vm.Script(sanitized, { filename: 'module_check.js' });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: `Module Syntax Error: ${err.message}` };
    }
}
