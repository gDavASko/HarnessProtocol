import { getUnfinishedTasks, getPureOutputs } from './tacticalTools.js';

async function showDashboard() {
    console.log("=== ТАКТИЧЕСКИЙ СРЕЗ ОКРУЖЕНИЯ ===");
    
    const unfinished = await getUnfinishedTasks();
    console.log("\n Задачи в работе или зависшие:", unfinished);

    const pureResults = await getPureOutputs();
    console.log("\n Чистые результаты готовых задач:", JSON.stringify(pureResults, null, 2));
}

showDashboard();
