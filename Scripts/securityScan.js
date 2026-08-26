// ─── Встроенный security-оракул (рунг `security` лестницы доказательств) ──────
// Детерминированный скан доказательств узла (git diff / артефакты) на утечку
// секретов и явно опасные паттерны. Реализует «security-floor = auto-FAIL»
// (идея из openclaw-harness): auth-bypass / утечка секрета роняют пол. Высокий
// сигнал, низкий шум — ловим то, что почти всегда реальная проблема.

const SECRET_RULES = [
    { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, desc: 'приватный ключ в коде' },
    { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, desc: 'AWS Access Key ID' },
    { id: 'aws-secret', re: /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+]{40}\b/gi, desc: 'AWS Secret Access Key' },
    { id: 'gh-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, desc: 'GitHub token' },
    { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, desc: 'OpenAI-подобный API-ключ (sk-…)' },
    { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, desc: 'Slack token' },
    { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, desc: 'Google API key' },
    { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, desc: 'JWT-токен' },
    { id: 'generic-secret-assign', re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*["'][^"'\s]{8,}["']/gi, desc: 'захардкоженный секрет в присваивании' }
];

// Опасные конструкции (auth-bypass / RCE-поверхность). Осторожно, чтобы не шуметь:
// только явные красные флаги.
const DANGER_RULES = [
    { id: 'shell-eval', re: /\b(?:eval|exec)\s*\(\s*(?:req|request|input|process\.argv|params|body|query)\b/gi, desc: 'выполнение недоверенного ввода (eval/exec)' },
    { id: 'auth-bypass', re: /\b(?:auth|isAuthenticated|isAdmin|checkAuth|verify(?:Token|Auth))\s*=\s*(?:true|\(\)\s*=>\s*true)\b/gi, desc: 'жёсткий обход авторизации (=true)' },
    { id: 'tls-disable', re: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized\s*:\s*false/gi, desc: 'отключение проверки TLS-сертификата' }
];

function redact(match) {
    const s = String(match);
    if (s.length <= 12) return s.slice(0, 3) + '…';
    return s.slice(0, 6) + '…' + s.slice(-3);
}

/**
 * Сканирует текст (diff/артефакты) на секреты и опасные паттерны.
 * @returns {{clean:boolean, findings:Array<{rule:string, desc:string, severity:'secret'|'danger', sample:string}>}}
 */
export function scanText(text) {
    const src = String(text || '');
    const findings = [];
    for (const rule of SECRET_RULES) {
        rule.re.lastIndex = 0;
        const m = src.match(rule.re);
        if (m) findings.push({ rule: rule.id, desc: rule.desc, severity: 'secret', sample: redact(m[0]) });
    }
    for (const rule of DANGER_RULES) {
        rule.re.lastIndex = 0;
        const m = src.match(rule.re);
        if (m) findings.push({ rule: rule.id, desc: rule.desc, severity: 'danger', sample: redact(m[0]) });
    }
    return { clean: findings.length === 0, findings };
}
