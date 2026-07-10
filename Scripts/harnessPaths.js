import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Единый резолвер путей Harness ───────────────────────────────────────────
// Все пути якорятся от КОРНЯ РЕПОЗИТОРИЯ, найденного по маркеру, а НЕ от
// process.cwd(). Это гарантирует одинаковое поведение при запуске из IDE-агента,
// из CLI-судьи, из под-процессов оркестратора и из тестов — независимо от того,
// какой рабочий каталог унаследовал дочерний node-процесс.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Уникальный маркер КОРНЯ Unity-проекта (имеет приоритет: не встречается в
// сабмодулях). `.git` — вторичный маркер, но он есть и у сабмодулей
// (например, Assets/KBPro/kbpro-ai-docs/.git), поэтому по нему НЕЛЬЗЯ якориться
// напрямую — иначе корень определится неверно.
const PROJECT_MARKER = 'ProjectSettings/ProjectVersion.txt';
const GIT_MARKER = '.git';

let cachedRoot = null;

/**
 * Ищет корень репозитория, поднимаясь вверх от стартового каталога.
 * Приоритет — маркер Unity-проекта (ProjectSettings/ProjectVersion.txt);
 * `.git` используется лишь как фоллбэк, если проектный маркер не найден вовсе.
 * Поиск независим от process.cwd() (стартует от расположения скрипта).
 * @param {string} [startDir]
 * @returns {string} абсолютный путь к корню репозитория
 */
export function findRepoRoot(startDir = __dirname) {
    if (cachedRoot && startDir === __dirname) {
        return cachedRoot;
    }

    let dir = path.resolve(startDir);
    let firstGitRoot = null;

    // Предохранитель от бесконечного цикла на корне диска.
    for (let depth = 0; depth < 40; depth++) {
        if (fs.existsSync(path.join(dir, PROJECT_MARKER))) {
            if (startDir === __dirname) cachedRoot = dir;
            return dir;
        }
        if (!firstGitRoot && fs.existsSync(path.join(dir, GIT_MARKER))) {
            firstGitRoot = dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    // Проектный маркер не найден — берём ближайший git-корень, иначе безопасный
    // дефолт по фиксированной глубине (Scripts → на 5 уровней выше = корень репо).
    const result = firstGitRoot || path.resolve(__dirname, '../../../../..');
    if (startDir === __dirname) cachedRoot = result;
    return result;
}

/**
 * Базовый каталог тактической памяти L2 (memory/tactical) от корня репозитория.
 * Переопределяется переменной окружения TACTICAL_DIR (тоже резолвится от корня,
 * если путь относительный).
 * @returns {string}
 */
export function tacticalBase() {
    const override = process.env.TACTICAL_DIR;
    if (override) {
        return path.isAbsolute(override)
            ? override
            : path.resolve(findRepoRoot(), override);
    }
    return path.resolve(findRepoRoot(), 'memory/tactical');
}

/**
 * Приводит переданный аргумент к абсолютному пути каталога задачи.
 * Принимает как путь (относительный/абсолютный), так и голый идентификатор
 * задачи (TACT-045). Относительные пути якорятся к корню репозитория, а не к
 * cwd — иначе поведение зависело бы от места запуска.
 * @param {string} arg
 * @returns {string|null}
 */
export function resolveTaskDir(arg) {
    if (!arg) return null;

    if (path.isAbsolute(arg)) return path.normalize(arg);

    // 1. Существует относительно корня репозитория?
    const fromRoot = path.resolve(findRepoRoot(), arg);
    if (fs.existsSync(fromRoot)) return fromRoot;

    // 2. Существует относительно cwd? (обратная совместимость с ручными вызовами)
    const fromCwd = path.resolve(process.cwd(), arg);
    if (fs.existsSync(fromCwd)) return fromCwd;

    // 3. Похоже на идентификатор задачи (TACT-*, УЗЕЛ не сюда) → memory/tactical/<id>
    if (/^[A-Za-zА-Яа-я][\w.-]*$/.test(arg) && !arg.includes('/') && !arg.includes('\\')) {
        return path.join(tacticalBase(), arg);
    }

    // 4. Дефолт: якорь на корень репозитория (детерминированно).
    return fromRoot;
}

/**
 * Каталог временных файлов Harness внутри директории задачи.
 * Используется CLI-транспортом и кросс-валидацией для промпт/дифф файлов.
 * @param {string} taskDir
 * @returns {string}
 */
export function resolveTmp(taskDir) {
    return path.join(taskDir, '.harness_tmp');
}
