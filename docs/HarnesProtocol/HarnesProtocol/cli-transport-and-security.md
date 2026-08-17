# 🛡️ CLI Transport & Security Sandbox

---

## 1. Три правила надежности CLI-транспорта (`cliTransport.js`)

1. **File/Stdin Invariant:** Контент (промпты, диффы) **никогда не передается в argv**. Передача строго через временные файлы или `stdin`, что исключает ошибки `ENAMETOOLONG` на Windows и шелл-инъекции.
2. **Прямой запуск без PowerShell:** Исключено использование PowerShell как промежуточного лаунчера для предотвращения порчи кодировки UTF-8.
3. **Process Completion Contract:** Успех вызова подтверждается только при `exit code === 0` **И** наличии непустого выходного файла (с маркером `<<<HARNESS_DONE>>>` в instruct-режиме).

---

## 2. Preflight Quarantining (`aiProbe.js`)

- **Проверка авторизации через Nonce:** Зондирование с уникальным одноразовым токеном (`HNONCE-XXXX`) в `os.tmpdir()`. Ответ "Not logged in" или справочный вывод бракуются.
- **24-часовой карантин:** Бинарники с постоянными ошибками конфигурации (`IneligibleTierError`) помещаются в карантин на 24 часа.
- **Адаптивные таймауты:** $\max(40\text{с}, 2 \times \text{last\_latency})$.
- **Cross-Family Rule:** Приоритет судей из других семейств (`google`, `anthropic`, `openai`) относительно воркера.

---

## 3. Детерминированная политика безопасности (`llm-security-policy.json`)

- **Белый список бинарников (`allowed_binaries`):** Разрешены только доверенные CLI.
- **Фильтр запрещенных команд (`forbidden_commands`):** Блокировка деструктивных системных операций.
- **Ограничения MCP (`allowed_mcp_servers`):** Контроль подключаемых MCP-серверов.

### Связанные ADR:
- [[../adr/0009-preflight-judge-quarantining-and-cross-family-evaluation|ADR-0009: Preflight Judge Quarantining and Cross-Family Evaluation]]
- [[../adr/0011-marker-based-repository-anchor|ADR-0011: Marker-Based Repository Anchor]]
- [[../adr/0013-file-stdin-content-isolation-in-cli-transport|ADR-0013: File/Stdin Content Isolation in CLI Transport]]
- [[../adr/0014-deterministic-llm-security-policy-and-binary-whitelisting|ADR-0014: Deterministic LLM Security Policy and Binary Whitelisting]]
