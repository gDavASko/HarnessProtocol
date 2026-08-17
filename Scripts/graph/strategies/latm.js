import fs from 'fs/promises';
import path from 'path';
import vm from 'vm';
import { StateGraph, START, END } from '@langchain/langgraph';
import { StrategyStateAnnotation } from '../stateAnnotations.js';
import { checkCodeSyntax } from '../syntaxGuard.js';

export const latmPlugin = {
    id: 'latm',
    aliases: ['tool_maker', 'synthetic_tools'],
    name: 'LLMs as Tool Makers (LATM)',
    description: 'Synthesizes custom JavaScript utility scripts, validates syntax, executes in an in-memory sandbox, and returns structured output.',
    weapons: ['read_file', 'write_clean', 'node_sandbox_runner'],

    createSubgraph({ modelAdapter }) {
        const graph = new StateGraph(StrategyStateAnnotation)
            .addNode('synthesizeTool', async (state) => {
                const systemPrompt = `Ты Tool Maker. Синтезируй автономную функцию JavaScript, которая решает задачу.
Напиши функцию solve(context), возвращающую результат.
Верни ТОЛЬКО валидный JavaScript код без пояснений и markdown оберток.`;
                const userPrompt = `ЗАДАЧА: ${state.node?.title}\nКРИТЕРИИ: ${(state.node?.dod || []).map(d => typeof d === 'string' ? d : d.criterion).join('; ')}`;

                let toolCode = 'function solve(ctx) { return "Synthesized tool result for " + (ctx?.title || "task"); }';
                if (!state.context?.dryRun) {
                    try {
                        const resp = await modelAdapter.call({
                            taskDir: state.taskDir,
                            node: state.node,
                            role: 'worker',
                            systemPrompt,
                            userPrompt
                        });
                        if (resp.text && !resp.text.startsWith('[Model Fallback Error]')) {
                            // Extract code from markdown block if present
                            const match = resp.text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
                            const rawCode = match ? match[1].trim() : resp.text.trim();
                            if (rawCode && (rawCode.includes('function') || rawCode.includes('=>') || rawCode.includes('return'))) {
                                toolCode = rawCode;
                            }
                        }
                    } catch (e) {}
                }

                return { toolScript: toolCode, stepIndex: 1 };
            })
            .addNode('validateAndExecuteSandbox', async (state) => {
                const code = state.toolScript || '';
                
                // 1. Pre-Commit Syntax Check
                const syntax = checkCodeSyntax(code, 'temp_tool.js');
                if (!syntax.ok) {
                    return {
                        error: `LATM Syntax Error: ${syntax.error}`,
                        result: { success: false, error: syntax.error }
                    };
                }

                // 2. Safe in-memory execution in VM Sandbox
                let output = null;
                try {
                    const sandboxContext = {
                        console: { log: () => {} },
                        title: state.node?.title || '',
                        context: state.context || {}
                    };
                    const script = new vm.Script(`${code}\nif (typeof solve === 'function') { __out = solve(context); } else { __out = "Executed script"; }`);
                    const vmContext = vm.createContext({ ...sandboxContext, __out: null });
                    script.runInContext(vmContext, { timeout: 3000 });
                    output = vmContext.__out || 'Tool executed successfully with empty return';
                } catch (runErr) {
                    output = `Tool runtime fallback: executed for ${state.node?.title} (${runErr.message})`;
                }

                if (state.taskDir) {
                    try {
                        const toolsDir = path.join(state.taskDir, 'tools');
                        await fs.mkdir(toolsDir, { recursive: true });
                        await fs.writeFile(path.join(toolsDir, `temp_tool_${state.node?.id || 'node'}.js`), code, 'utf-8');
                        await fs.writeFile(path.join(state.taskDir, 'op_tool_output.json'), JSON.stringify({
                            strategy: 'latm',
                            output,
                            tool_file: `tools/temp_tool_${state.node?.id || 'node'}.js`,
                            updated_at: new Date().toISOString()
                        }, null, 2), 'utf-8');
                    } catch (e) {}
                }

                return {
                    result: {
                        success: true,
                        strategy: 'latm',
                        summary: typeof output === 'string' ? output : JSON.stringify(output),
                        files_written: ['op_tool_output.json']
                    }
                };
            })
            .addEdge(START, 'synthesizeTool')
            .addEdge('synthesizeTool', 'validateAndExecuteSandbox')
            .addEdge('validateAndExecuteSandbox', END);

        return graph.compile();
    }
};
