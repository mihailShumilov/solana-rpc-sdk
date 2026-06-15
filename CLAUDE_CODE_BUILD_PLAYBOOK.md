# Build Playbook — solana-resilience-kit (для консольного Claude Code)

Единый документ для запуска проекта в **console Claude Code**. Покрывает: организацию репозитория, детальный README, настройку скилов/агентов/команд Claude Code, и пошаговую настройку локального окружения (которое уже собрано в этом репозитории).

Порядок чтения: §0 → §4 → §3 → §1 → §2 → §5. То есть: понять состояние → поднять окружение → настроить Claude Code → довести README/репо → реализовывать по плану.

---

## §0. Текущее состояние репозитория (что уже сделано)

Репозиторий уже инициализирован в режиме **test-first**: симуляционное окружение и полный набор спеков написаны до реализации.

```
.
├── 01_PROBLEM_ANALYSIS.md / _RU.md   # анализ проблем + источники (готово)
├── README.md                         # черновой README (расширить — см. §2)
├── package.json / tsconfig.json / vitest.config.ts
├── src/**                            # публичный API — ЗАГЛУШКИ (throw NotImplementedError)
└── test/
    ├── harness/**                    # симулятор кластера — РЕАЛИЗОВАН + self-tested
    └── **/*.test.ts                  # поведенческие спеки — КРАСНЫЕ (ждут реализации)
```

Проверенное состояние тестов:
- `npx tsc --noEmit` → **0 ошибок**
- `npm test` → **16 зелёных** (13 self-test харнесса + 3 метрики), **27 красных** (спеки модулей, каждый падает с `NotImplementedError`)

Задача реализации = превратить каждый красный спек в зелёный, не ослабляя тесты, и довести покрытие до 90% (порог уже в `vitest.config.ts`).

---

## §1. Организация и настройка репозитория

### 1.1 Структура (целевая)
```
src/
  rpc/        pool.ts · health.ts · rate-limit.ts
  tx/         sender.ts · confirmation.ts
  fees/       estimator.ts · oracles.ts
  jito/       router.ts · tips.ts
  observability/ metrics.ts
  wallet/     adapter.ts
  cli/        diagnose.ts          # ДОБАВИТЬ на шаге 7 (диагностический CLI)
  index.ts
test/
  harness/    mock-cluster.ts · mock-endpoint.ts · mock-jito.ts · rng.ts · base58.ts · faults.ts · index.ts
  <module>/*.test.ts
examples/
  devnet-demo.ts                    # ДОБАВИТЬ: один живой пример на devnet
.claude/                            # конфигурация Claude Code (см. §3)
.github/workflows/ci.yml            # CI (см. 1.4)
```

### 1.2 Git и GitHub
```bash
# репозиторий уже инициализирован и есть первый коммит
git remote add origin git@github.com:<you>/solana-resilience-kit.git
git branch -M main
git push -u origin main
```
- Соглашение о коммитах: Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Ветки по модулям: `feat/health-monitor`, `feat/tx-sender` и т.д. Один модуль = одна ветка = один PR с зелёными спеками.
- Каждый PR обязан: (а) сделать целевые спеки зелёными, (б) не трогать/не ослаблять харнесс и существующие спеки, (в) держать `tsc --noEmit` чистым.

### 1.3 Гейты качества (определение "готово" для модуля)
1. Все спеки модуля зелёные.
2. Все ранее зелёные тесты остаются зелёными (харнесс не изменён по смыслу).
3. `npm run typecheck` — 0 ошибок.
4. Покрытие модуля ≥ 90% строк.

### 1.4 CI (GitHub Actions) — добавить `.github/workflows/ci.yml`
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test:cov
```
CI с прогоном симуляционных тестов и покрытием — прямой сигнал судьям по критерию Test & Simulation Quality (15%).

---

## §2. Детальный README (что должно быть внутри)

Текущий `README.md` — каркас. Финальный README должен содержать разделы ниже. Контент по проблемам/решениям брать из `01_PROBLEM_ANALYSIS.md` (там же все источники).

**Промпт для Claude Code:**
> Прочитай `01_PROBLEM_ANALYSIS.md` и текущий `README.md`. Перепиши `README.md`, включив разделы из §2 плейбука. Сохрани ссылки на источники. Тон — инженерный, без воды. Таблицы там, где они яснее прозы.

Обязательные разделы README:

1. **Заголовок + одно-абзацный pitch** — vendor-neutral клиентский слой надёжности+наблюдаемости на `@solana/kit`.
2. **Problem** — почему транзакции/RPC ненадёжны (4 архитектурных факта: нет мемпула; истечение blockhash ~150 блоков; SWQoS; локальные комиссионные рынки). Кратко, со ссылками.
3. **Pain points** (таблица: боль · кого затрагивает · что делает SDK):

   | Боль | SDK-ответ |
   |---|---|
   | Тихий drop транзакций | sender с ребродкастом, подтверждение по высоте блока |
   | Истечение blockhash / двойное списание | граница по `lastValidBlockHeight`, без повторной подписи |
   | 429 / исчерпание кредитов | `CreditRateLimiter` (вес по методам) + failover |
   | Рассинхрон узлов в пуле | `HealthMonitor` (свежесть по слотам), routing к свежему |
   | Оценка priority fee / CU | simulate→unitsConsumed+10%, перцентильный fee-oracle |
   | MEV / фронтран | Jito-роутинг + динамический tip + авто-fallback на RPC |
   | Слепое пятно наблюдаемости | клиентская телеметрия → OpenTelemetry/Datadog |

4. **Existing solutions & their shortcomings** (таблица из анализа): `@solana/kit` (failover только как DIY-рецепты), Helius/QuickNode/Triton (vendor-lock, серверные), Jito (provider-сервис, нужен fallback), `@solana/wallet-adapter` (без устойчивости), OSS multi-RPC либы (тонкие обёртки), OTel/Datadog (нет Solana-специфичной клиентской инструментовки). **Вывод: белая зона = vendor-neutral клиентский systems-grade слой.**
5. **What this repo does** — список модулей (§1.1) с одной строкой назначения.
6. **Architecture** — диаграмма потока: `dApp → WalletAdapter → TransactionSender ↔ ResilientRpcPool(HealthMonitor, RateLimiter, failover) → endpoints` и параллельная ветка `JitoRouter → Block Engine ⇢ fallback на sender`. (Сгенерировать через скилл diagram-creation или Mermaid.)
7. **Quickstart** — установка, минимальный пример: создать пул из 2 RPC, отправить транзакцию с подтверждением.
8. **Testing & simulation** — как устроен харнесс (детерминированные часы, seeded faults, реальная интеграция с kit), как гонять, что значит 90%.
9. **Mapping to bounty** — таблица: пункт сабмишена → где реализовано → каким тестом покрыто.
10. **Roadmap / status** — отметки готовности модулей.
11. **License (MIT).**

---

## §3. Скилы, агенты и команды Claude Code

Создать каталог `.claude/`. Ниже — готовые к вставке файлы (проверены по актуальной документации Claude Code).

### 3.1 `CLAUDE.md` (память проекта, автозагрузка) — в корень репозитория
```markdown
# Project: solana-resilience-kit

Vendor-neutral, client-side resilience + observability layer for Solana dApps,
built on @solana/kit (web3.js v2). Developed TEST-FIRST.

## Commands
- npm test            # run all tests (harness green, module specs red until implemented)
- npm run test:cov    # coverage (90% thresholds in vitest.config.ts)
- npm run typecheck   # tsc --noEmit, must stay at 0 errors

## Layout
- src/**            public API (implement here)
- test/harness/**   deterministic Solana cluster simulator (DO NOT weaken)
- test/**/*.test.ts behavioral specs = the source of truth

## The TDD rule (non-negotiable)
- The way to "make progress" is: pick a red spec, implement src/ until it is green.
- NEVER edit a test to make it pass. NEVER weaken the harness. If a spec seems wrong,
  flag it explicitly and explain before changing it.
- Keep typecheck at 0 errors and never regress a green test.

## Solana correctness invariants (most submissions get these wrong)
- Fetch blockhash at `confirmed`; preflightCommitment must match the blockhash commitment.
- Send with `maxRetries: 0`; run our own rebroadcast loop.
- Bound the rebroadcast/confirm loop by `lastValidBlockHeight` — never poll forever.
- NEVER re-sign or mutate a transaction (double-charge risk). Outcome is decided by
  current block height vs lastValidBlockHeight.
- Pool must avoid the "fresh blockhash from advanced node, send to lagging node" drop:
  route by slot freshness (HealthMonitor).
- A Jito bundle_id is a receipt, not a landing guarantee — always fall back to RPC.

## Code conventions
- Strict TypeScript, ESM. Relative imports use the `.js` extension.
- Unimplemented surface throws `NotImplementedError` (src/errors.ts).
- Time-based loops take an injected `sleep` so tests advance the mock clock.
```

### 3.2 House skill — `.claude/skills/solana-resilience/SKILL.md`
```markdown
---
name: solana-resilience
description: House skill for the solana-resilience-kit SDK. Use whenever implementing or reviewing any src/ module, writing tests, or reasoning about Solana RPC/transaction reliability. Encodes the Solana correctness invariants, the simulation-harness contract, and the test-first workflow so every implementation run agrees.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
effort: medium
---

# solana-resilience house skill

Read this before touching any module so implementation stays consistent.

## Workflow (test-first)
1. Run `npm test` to see current red/green state.
2. Pick ONE red spec file. Read it fully — it is the contract.
3. Implement the corresponding src/ file until that spec is green.
4. Run `npm test` + `npm run typecheck`. Do not regress any green test.
5. Never edit tests or the harness to pass. Flag genuinely-wrong specs instead.

## Harness contract (test/harness)
- `MockCluster` — manual clock via `advanceSlots(n)`; issues blockhashes with
  lastValidBlockHeight = blockHeight + 150; tracks tx landing / silent-drop / expiry.
- `MockEndpoint(cluster, { faults })` — exposes a real @solana/kit `RpcTransport`;
  faults: latencyMs, dropRate, errorRate, rate429Rate, slotLag, offline.
  `endpoint.lastSendParams` captures the last sendTransaction config (assert maxRetries:0).
- `MockJitoEngine` — getTipAccounts / getTipFloor / sendBundle / getInflightBundleStatuses;
  `scheduleBundleNeverLands(id)` drives the fallback path.
- Tests inject `sleep = async () => cluster.advanceSlots(1)` so loops run instantly
  and deterministically. Implement loops to accept that injected `sleep`.

## Solana invariants
(see CLAUDE.md "Solana correctness invariants" — they are authoritative)

## Implementation order (by judging leverage: Correctness 40% + Resilience 25%)
HealthMonitor → CreditRateLimiter → ResilientRpcPool → ConfirmationTracker →
TransactionSender → FeeEstimator/oracles → JitoRouter/TipEstimator →
ResilientWalletAdapter → OtelMetrics → CLI.
```

### 3.3 Субагент-исполнитель — `.claude/agents/tdd-implementer.md`
```markdown
---
name: tdd-implementer
description: Implements one red spec to green for the solana-resilience-kit. Use when asked to implement a specific module/spec. Reads the spec, implements the src/ file, runs tests and typecheck, and reports without weakening any test.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

You implement Solana SDK modules test-first.

Rules:
- Treat the target *.test.ts as an immutable contract. Implement src/ to satisfy it.
- NEVER modify tests or test/harness/** to make things pass. If a spec looks wrong,
  stop and report with reasoning instead of changing it.
- After implementing: run `npm test` and `npm run typecheck`. Confirm the target spec
  is green AND no previously-green test regressed AND typecheck is 0 errors.
- Honor the Solana invariants in CLAUDE.md / the solana-resilience skill.
- Report: what you implemented, which specs went green, coverage delta if available.
```

### 3.4 Субагент-ревьюер (adversarial) — `.claude/agents/spec-verifier.md`
```markdown
---
name: spec-verifier
description: Adversarially reviews a freshly-implemented module against its spec and the Solana correctness invariants. Use after tdd-implementer finishes a module. Checks that no test was weakened, edge cases hold (expiry, drop, 429 failover), and reports risks.
tools: Read, Bash, Grep, Glob
model: inherit
---

You are a skeptical reviewer. For the named module:
- Diff the implementation against the spec; verify behavior, not just green checks.
- Confirm no test file or harness file was edited to pass (git diff test/).
- Probe the hard cases: blockhash expiry termination, silent-drop -> expired,
  no re-sign, 429 failover, freshness routing, Jito fallback.
- Re-run `npm test` and `npm run test:cov`. Report coverage and any gaps.
- Output: PASS/CONCERNS with a concise, prioritized list. Do not edit code.
```

### 3.5 Субагент-исследователь доков — `.claude/agents/solana-docs.md`
```markdown
---
name: solana-docs
description: Fetches current @solana/kit, Jito, and Solana RPC documentation when an API detail is uncertain. Use before implementing against an unfamiliar kit/Jito API to avoid stale-knowledge errors.
tools: Read, WebFetch, WebSearch
model: inherit
---

You retrieve and summarize CURRENT Solana/kit/Jito API details. Prefer official docs
(solana.com, docs.jito.wtf, anza-xyz/kit). Return exact function signatures and the
minimal usage snippet needed. Never guess an API shape — verify it.
```

### 3.6 Слэш-команды
`.claude/commands/next.md`
```markdown
---
description: Find the next red spec and propose an implementation plan
allowed-tools: Bash, Read, Grep
---
Run `npm test 2>&1 | tail -40` to see failing specs. Pick the next module by the
implementation order in the solana-resilience skill. Read its spec and src/ stub,
then propose a concise implementation plan. Do not write code yet.
```

`.claude/commands/green.md`
```markdown
---
description: Run typecheck + tests and summarize red/green
allowed-tools: Bash
---
Run `npm run typecheck` then `npm test`. Summarize: typecheck errors, count of
green vs red, and which specs are still red.
```

`.claude/commands/cov.md`
```markdown
---
description: Run coverage and report per-file gaps
allowed-tools: Bash
---
Run `npm run test:cov`. Report overall coverage and any src/ file below 90% lines.
```

`.claude/commands/implement.md`
```markdown
---
description: Implement a named module to green (delegates to tdd-implementer)
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---
Implement the module: $ARGUMENTS. Follow the solana-resilience skill and CLAUDE.md
invariants. Make its spec green without weakening any test, then run the spec-verifier
agent on it.
```

### 3.7 Права — `.claude/settings.json`
```json
{
  "permissions": {
    "allow": [
      "Read",
      "Edit",
      "Write",
      "Bash(npm:*)",
      "Bash(npx vitest:*)",
      "Bash(npx tsc:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)"
    ],
    "deny": [
      "Bash(git push:*)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Write(node_modules/**)"
    ],
    "defaultMode": "default"
  },
  "enableAllProjectMcpServers": false,
  "enabledMcpjsonServers": ["context7"]
}
```

### 3.8 Docs MCP (опционально, но полезно) — `.mcp.json` в корне
```json
{
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```
Context7 отдаёт актуальные доки библиотек (использовался при подготовке репо для `@solana/kit`). После добавления — `/mcp` в Claude Code, чтобы проверить подключение.

---

## §4. Пошаговая настройка локального окружения

Окружение уже собрано в этом репозитории — шаги ниже его поднимают и проверяют (используя существующий код).

### 4.1 Предусловия
- Node.js ≥ 20 (рекомендовано 22), npm ≥ 10. Проверить: `node -v && npm -v`.

### 4.2 Установка и проверка
```bash
npm install          # ставит @solana/kit, @opentelemetry/api, vitest, typescript, @types/node
npm run typecheck    # ожидаемо: 0 ошибок
npm test             # ожидаемо: 16 зелёных (харнесс+метрики), 27 красных (NotImplementedError)
```
Если видишь именно это — окружение корректно: **симулятор зелёный, спеки модулей красные**. Это и есть точка старта реализации.

### 4.3 Что уже есть (не пересоздавать)
- `test/harness/` — детерминированный симулятор кластера Solana (`MockCluster`/`MockEndpoint`/`MockJitoEngine`), seeded RNG, base58/wire-парсер. Self-test `test/harness/harness.test.ts` доказывает интеграцию с реальным `@solana/kit` (подпись настоящей kit-транзакции совпадает с нашим извлечением сигнатуры из wire).
- `src/**` — публичный API c сигнатурами и JSDoc; тела бросают `NotImplementedError`.
- `vitest.config.ts` — покрытие v8 с порогом 90% (включится, когда модули реализованы).

### 4.4 Цикл разработки в Claude Code
```
/green                      # увидеть текущее состояние
/next                       # выбрать следующий красный спек + план
/implement HealthMonitor    # реализовать модуль до зелёного (→ tdd-implementer → spec-verifier)
... повторять по порядку из §3.2 ...
/cov                        # когда модулей много — проверять покрытие
```
Полезно держать `npm run test:watch` в отдельном терминале.

---

## §5. План реализации (порядок = рычаг для судейства)

Correctness (40%) + Resilience (25%) = 65% оценки, поэтому ядро — первым.

| # | Модуль | Спек | Ключевая корректность |
|---|---|---|---|
| 1 | `HealthMonitor` | `test/rpc/health.test.ts` | ранжирование по свежести слота; эжект по порогу отказов; лаггард>maxSlotLag нездоров |
| 2 | `CreditRateLimiter` | `test/rpc/rate-limit.test.ts` | вес по методам; осушение и долив по окну (инъекция `now`) |
| 3 | `ResilientRpcPool` | `test/rpc/pool.test.ts` | failover при 429; `AllEndpointsFailedError`; freshness-routing; метрики |
| 4 | `ConfirmationTracker` | `test/tx/confirmation.test.ts` | исход по высоте блока vs `lastValidBlockHeight`; ограниченное число опросов |
| 5 | `TransactionSender` | `test/tx/sender.test.ts` | `maxRetries:0`; ребродкаст; expired при drop; без повторной подписи; метрики |
| 6 | `FeeEstimator` + `NativeFeeOracle` | `test/fees/estimator.test.ts` | unitsConsumed; запас CU 1.1; медиана→medium; расчёт priorityFeeLamports |
| 7 | `JitoRouter` + `TipEstimator` | `test/jito/router.test.ts` | route 'jito' при посадке бандла; авто-fallback 'rpc' если не сел |
| 8 | `ResilientWalletAdapter` | `test/wallet/adapter.test.ts` | подпись кошельком → отправка через sender |
| 9 | `OtelMetrics` | (добавить спек) | экспорт latency/failures/slot-lag/landing в OTel/Datadog |
| 10 | Diagnostics CLI (`src/cli/diagnose.ts`) | (добавить спек) | probe здоровья провайдеров; «почему транзакция не села» |

После всех зелёных: добавить `examples/devnet-demo.ts` (живой прогон на devnet), поднять покрытие до 90% порога, дописать README (§2) и запушить на GitHub с зелёным CI.

### Контрольный список сабмишена
- [ ] Публичный GitHub-репозиторий со всем кодом
- [ ] Совместимость с `web3.js v2.0` подтверждена тестами (harness уже это делает)
- [ ] Интеграция wallet adapter (≥1 кошелёк)
- [ ] Jito/MEV-роутинг реализован и задокументирован
- [ ] Экспорт наблюдаемости работает (OpenTelemetry или Datadog)
- [ ] Диагностический CLI функционален
- [ ] 90%+ покрытие с симуляционными тестами сети

---

## §6. Docker (воспроизводимое автоматизированное окружение)

Файлы уже в репозитории: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `Makefile`.
Цель — любой (включая судей) поднимает идентичное окружение и гоняет тесты одной командой, без локального Node.

### Дизайн
- `Dockerfile` — multi-stage на `node:22-bookworm-slim` (slim, не alpine, чтобы избежать
  проблем с нативными/wasm-зависимостями `@solana/kit`). Слой `deps` кэшируется по
  `package-lock.json`; `npm ci` даёт детерминированную установку.
- `docker-compose.yml` — сервисы `test` / `verify` / `watch` / `cov` / `shell`. Исходники
  bind-mount (`.:/app`), а `node_modules` сохраняется анонимным volume (`/app/node_modules`),
  чтобы бинарники хоста не перекрывали контейнерные. `coverage/` пишется на хост.
- `Makefile` — короткие обёртки: `make build|verify|test|watch|cov|shell|clean`.

### Команды
```bash
make build     # собрать образ
make verify    # typecheck + ВСЕГДА-зелёные тесты харнесса/метрик -> exit 0 (проверка, что env ок)
make test      # typecheck + весь набор (спеки модулей КРАСНЫЕ, пока не реализованы — это норма)
make watch     # vitest watch для TDD-цикла
make cov       # отчёт покрытия в ./coverage
make shell     # интерактивная оболочка внутри окружения
```
Без `make` — то же через `docker compose run --rm <service>` (см. шапку `docker-compose.yml`).

Важно: `make test` завершается ненулевым кодом, пока модули не реализованы (красные спеки —
ожидаемый TDD-сигнал). Для проверки самого Docker-окружения используй `make verify` — он зелёный.

### CI на Docker (опционально)
Можно заменить шаги `npm ci/test` в `.github/workflows/ci.yml` (§1.4) на:
```yaml
      - run: docker compose build
      - run: docker compose run --rm test
```
Это гарантирует, что CI и локалка гоняют ровно один и тот же образ.
```
