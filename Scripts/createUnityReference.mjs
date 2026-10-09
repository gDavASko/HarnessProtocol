#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function createUnityReference(destination, editorVersion) {
    if (!path.isAbsolute(destination) || !/^6000\.\d+\.\d+[fabp]\d+$/.test(editorVersion || '')) throw new Error('An absolute new destination and exact Unity 6 Editor version are required');
    const root = path.resolve(destination);
    await fs.mkdir(root); // Never reuse or overwrite an existing project.
    const source = fileURLToPath(new URL('../Tests/UnityReference/', import.meta.url));
    for (const dir of ['Assets/Editor', 'Assets/Plugins', 'Assets/Tests/Editor', 'Packages', 'ProjectSettings']) await fs.mkdir(path.join(root, dir), { recursive: true });
    for (const [name, target] of [['HarnessReference.cs', 'Assets/HarnessReference.cs'], ['HarnessReference.jslib', 'Assets/Plugins/HarnessReference.jslib'], ['HarnessReferenceSetup.cs', 'Assets/Editor/HarnessReferenceSetup.cs']]) await fs.copyFile(path.join(source, name), path.join(root, target));
    await fs.copyFile(fileURLToPath(new URL('./unityHarnessAdapter.cs', import.meta.url)), path.join(root, 'Assets/Editor/HarnessUnityAdapter.cs'));
    for (const name of ['HarnessReferenceEditorTests.cs', 'HarnessReference.Tests.asmdef']) await fs.copyFile(path.join(source, name), path.join(root, 'Assets/Tests/Editor', name));
    await fs.writeFile(path.join(root, 'Packages/manifest.json'), JSON.stringify({dependencies:{'com.unity.modules.imgui':'1.0.0','com.unity.modules.jsonserialize':'1.0.0','com.unity.test-framework':'1.7.0'}}, null, 2));
    await fs.writeFile(path.join(root, 'ProjectSettings/ProjectVersion.txt'), `m_EditorVersion: ${editorVersion}\n`);
    return {projectPath:root, editorVersion, setupMethod:'HarnessReferenceSetup.Execute', scene:'Assets/Reference.unity'};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    try { console.log(JSON.stringify(await createUnityReference(process.argv[2], process.argv[3]), null, 2)); }
    catch(error) { console.error(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; }
}
