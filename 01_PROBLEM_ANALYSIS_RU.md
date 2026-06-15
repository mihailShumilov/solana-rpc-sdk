# Анализ проблем: надёжность RPC и транзакций в Solana

**Для:** баунти Superteam Ukraine — *Создать systems-grade SDK, повышающий надёжность RPC и транзакций для Solana dApps*
**Дата:** 15 июня 2026
**Цель:** на актуальных данных установить, что именно сломано в RPC/транзакционном слое Solana, где существующие инструменты не дотягивают и где новый SDK может выиграть. Это подготовительная база перед разработкой; архитектура и реализация вытекают из неё.

---

## 1. Краткое резюме

Проблемы надёжности Solana — это не случайные баги, а прямые и предсказуемые следствия архитектуры. Поскольку у сети **нет публичного мемпула**, транзакция нигде не «висит в ожидании»: RPC-узел пересылает её напрямую текущему/следующему лидеру слота по QUIC, и если она не доходит и не попадает в блок до истечения её blockhash (~150 блоков, примерно 60–90 секунд) — она просто исчезает без следа в ончейне. Поверх этого наложены: нормирование ёмкости соединений (stake-weighted QoS), аукционы локальных комиссионных рынков, RPC-узлы, которые незаметно отстают от кластера, агрессивные лимиты провайдеров и активная MEV/сэндвич-экономика. Каждый из этих факторов — отдельный режим отказа, и каждый требует отдельного клиентского решения.

Главный вывод из обзора существующих решений: **каждое надёжное средство, которое есть сегодня, либо (a) намеренно оставлено официальным SDK как задача «сделай сам», либо (b) заперто внутри экосистемы одного провайдера или серверного сервиса.** `@solana/kit` (переименованный `@solana/web3.js v2`) поставляет failover, round-robin и retry лишь как сниппеты транспорта для копипасты, а не как функции. Helius, QuickNode, Triton и Jito решают надёжность хорошо — но только на своём шлюзе и со своими API-ключами. Экосистема wallet-adapter отвечает за подпись, а не за устойчивость. Solana-специфичной инструментовки для OpenTelemetry/Datadog не существует вовсе.

Остаётся реальная, «фундируемая» белая зона: **вендор-нейтральный, клиентский, systems-grade слой устойчивости + наблюдаемости**, который объединяет multi-RPC failover, маршрутизацию с учётом свежести узла, корректный retry/ребродкаст, динамическую оценку комиссий/CU, Jito/MEV-маршрутизацию с fallback и стандартизированную телеметрию — за одним чистым API поверх `@solana/kit` и любого набора провайдеров. По сути, баунти просит ровно ту библиотеку, которой экосистеме не хватает.

---

## 2. Почему это сложно: архитектура, порождающая боль

Четыре структурных факта объясняют почти все проблемы ниже:

1. **Нет мемпула.** RPC-узлы пересылают транзакции напрямую ближайшему лидеру; общего пула ожидающих транзакций нет, поэтому у дропнутой транзакции нет ни записи, ни автоматической подстраховки. ([Solana docs — Retry](https://solana.com/developers/guides/advanced/retry))
2. **Истечение blockhash.** Свежий blockhash действителен лишь ~150 блоков (~60–90 с). После этого транзакция отклоняется навсегда и не может исполниться. ([Helius](https://www.helius.dev/blog/how-to-land-transactions-on-solana), [Solana docs — Confirmation](https://solana.com/developers/guides/advanced/confirmation))
3. **Stake-weighted QoS (SWQoS).** Лидер ограничивает входящие QUIC-соединения, резервируя ~80% (~2000) для валидаторов со стейком и ~20% (~500) на *всех* безстейковых узлов вместе — поэтому отправка без стейка структурно проигрывает при перегрузке. ([Helius — SWQoS](https://www.helius.dev/blog/stake-weighted-quality-of-service-everything-you-need-to-know))
4. **Локальные комиссионные рынки.** Конкуренция привязана к конкретным write-locked аккаунтам, поэтому транзакция, затрагивающая «горячий» аккаунт, может голодать, даже когда сеть в целом выглядит спокойной — и глобальное число комиссии плохо отражает то, что нужно *вашей* транзакции. ([Helius — local fee markets](https://www.helius.dev/blog/solana-local-fee-markets))

Эпизод перегрузки 2024 года — поучительный пример: в конце марта — начале апреля 2024 доля неуспешных не-голосующих транзакций **достигала ~75%**, причиной стало узкое место в QUIC-сети клиента Agave, позволившее спаму вытеснить легитимный трафик. Патчи (v1.17.31) улучшили обработку пакетов со стейком/без и снизили пик, но доля отказов оставалась заметно повышенной месяцами. ([Cointelegraph](https://cointelegraph.com/news/solana-struggling-record-seventy-five-percent-trasnactions-fail-memecoin-mania), [The Block](https://www.theblock.co/post/286868/solana-network-congestion)) К началу 2025 сеть стала намного здоровее — медиана подтверждения ~450 мс, ~100% аптайма больше года — но *режимы отказа никуда не делись*; они дремлют до следующего всплеска спроса. ([Helius — Agave v2.1](https://www.helius.dev/blog/agave-v21-update-all-you-need-to-know))

> **Вывод для SDK:** надёжность не может быть «как получится». Её нужно инженерно выстраивать вокруг каждого из этих четырёх фактов явно. Именно это здесь означает «systems-grade», и это напрямую ложится на критерии судейства *Correctness* (вес 40%) и *Resilience* (вес 25%).

---

## 3. Каталог болевых точек

Каждая боль оценена по **серьёзности**, **кого затрагивает** и подкреплена актуальными источниками.

### 3.1 Транзакции молча дропаются (без ошибки, без следа)

Успешный ответ `sendTransaction` означает лишь, что RPC-узел *получил* транзакцию, — а не что она попадёт в блок. ([Solana docs — Retry](https://solana.com/developers/guides/advanced/retry)) Транзакции гибнут из-за: потери пакетов QUIC/UDP без гарантий доставки; пути лидера `tpu_forwards`, ограниченного одним хопом и объёмом под нагрузкой; того, что RPC-узел отбрасывает новые отправки, когда его очередь ребродкаста превышает **10 000**; или blockhash, живший лишь на заброшенном миноритарном форке. Это самая болезненная UX-проблема Solana именно потому, что она *молчаливая*.

- **Серьёзность:** Высокая · **Затрагивает:** конечных пользователей, разработчиков dApps · **Источник:** [Solana — Retry](https://solana.com/developers/guides/advanced/retry)

### 3.2 Истечение blockhash и ловушки уровня commitment

`getLatestBlockhash` по умолчанию использует `finalized`, который отстаёт от `confirmed` на ≥32 слота — фактически срезая ~13 секунд из окна валидности ещё до того, как пользователь подписал. Возьмёте `processed` ради более длинного окна — рискуете blockhash с форка (~5% блоков не финализируются), который никогда не подтвердится. Официальная золотая середина — `confirmed`, и `preflightCommitment` должен совпадать с commitment у blockhash, иначе получите ложные ошибки «Blockhash not found». ([Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation)) Тонкая, но дорогая ловушка: **повторная подпись транзакции до истечения её blockhash может привести к тому, что обе копии попадут в блок, дважды списав средства** — безопасная повторная подпись возможна только после того, как высота блока превысит `lastValidBlockHeight`. ([Solana — Retry](https://solana.com/developers/guides/advanced/retry))

- **Серьёзность:** Высокая · **Затрагивает:** конечных пользователей, разработчиков dApps · **Источник:** [Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation)

### 3.3 Лимитирование RPC (HTTP 429) и исчерпание кредитов

Публичный mainnet-эндпоинт допускает лишь ~100 запросов / 10 с на IP (40 / 10 с на метод) и явно «не предназначен для продакшена». ([Solana — Clusters](https://solana.com/docs/references/clusters)) Ошибка 429 — это ошибка *шлюза* балансировщика провайдера: запрос вообще не дошёл до сети, поэтому разработчики часто отлаживают не тот слой. ([Carbium](https://carbium.io/blog/fixing-429-too-many-requests-on-solana-why-rpcs-fail/)) Провайдеры тарифицируют по **взвешенным кредитам**, где тяжёлые методы вроде `getProgramAccounts` стоят ~10× от `getBalance`, поэтому плотный цикл опроса может за минуты исчерпать многомиллионную квоту. Эффект «шумного соседа» на общих узлах душит вас из-за *чужого* трафика.

- **Серьёзность:** Высокая · **Затрагивает:** любые dApps на публичных/бесплатных/общих эндпоинтах, индексаторы, ботов · **Источник:** [Carbium](https://carbium.io/blog/fixing-429-too-many-requests-on-solana-why-rpcs-fail/)

### 3.4 Несогласованность состояния узлов в RPC-пуле

RPC-узлы естественно отстают от кластера (≥1 блок, больше под нагрузкой), и узел перестаёт отвечать только когда отстал **>150 слотов** — значит, чуть ниже этого порога он всё ещё раздаёт blockhash, которые вот-вот истекут. Классический баг multi-RPC: взять свежий blockhash у «продвинутого» узла, отправить «отстающему», который его ещё не знает, — и транзакция молча дропается. Поэтому надёжный failover **обязан проверять свежесть узла** (сравнивать контекст `getSlot` между узлами) и привязывать получение blockhash + отправку к одному и тому же или проверенному по свежести узлу — это не опция. ([Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation), [Solana — Retry](https://solana.com/developers/guides/advanced/retry))

- **Серьёзность:** Высокая · **Затрагивает:** любые multi-provider / балансируемые dApps · **Источник:** [Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation)

### 3.5 Оценка priority fee и compute units

Priority fee = **цена за CU × лимит CU**, начисляется на *запрошенный* лимит, а не на потреблённые CU. Дефолтный бюджет 200 000 CU на инструкцию — это ~30× от того, что реально нужно простому переводу (~6000 CU), поэтому оставленные дефолты прямо ведут к переплате — а priority fees сейчас составляют **>97,5% полной стоимости транзакции**. ([Anza](https://www.anza.xyz/blog/why-solana-transaction-costs-and-compute-units-matter-for-developers), [Helius — fees](https://www.helius.dev/blog/solana-fees-in-theory-and-practice)) Оценка сложна, потому что нативный `getRecentPrioritizationFees` — это ретроспективный минимум за ~150 блоков, а локальные рынки означают, что общесетевое число промахивается мимо вашего конкретного «горячего» аккаунта. Слишком мало → дроп при перегрузке; слишком много или переразмеренный CU → переплата. Канонический фикс — **симулировать, чтобы прочитать `unitsConsumed`, добавить ~10%, и брать перцентильные оценки с учётом аккаунтов** (Helius `getPriorityFeeEstimate`, QuickNode `qn_estimatePriorityFees`).

- **Серьёзность:** Высокая · **Затрагивает:** всех разработчиков, кошельки, трейдеров · **Источник:** [Anza](https://www.anza.xyz/blog/why-solana-transaction-costs-and-compute-units-matter-for-developers)

### 3.6 MEV / фронтраннинг и решение о маршрутизации через Jito

Даже без публичного мемпула сэндвич-атаки прибыльны: один бот провёл ~1,55 млн сэндвич-транзакций за 30 дней на **~65 880 SOL (~$13,4 млн)**, по данным MEV-отчёта Helius. Jito отключил свой публичный мемпул в марте 2024, но MEV-акторы теперь держат приватные мемпулы, так что угроза сохраняется — и трейдеры мемкоинов с высоким slippage наиболее уязвимы. ([Helius — MEV report](https://www.helius.dev/blog/solana-mev-report), [CoinDesk](https://www.coindesk.com/business/2024/03/08/solana-client-developer-jito-announces-end-of-mempool-function)) Бандлы Jito (≤5 транзакций, атомарные, с tip) дают MEV/revert-защиту и сейчас критически важны: **>90% стейка Solana работает на клиенте Jito-Solana.** ([Helius — MEV report](https://www.helius.dev/blog/solana-mev-report)) Но `bundle_id` — не гарантия попадания в блок, дефолтный лимит Jito — 1 запрос/с на IP/регион, а «uncle-bandit» ребродкасты могут сломать атомарность — поэтому любая интеграция Jito **требует динамического подбора tip (перцентили `tip_floor`), опроса статуса и автоматического fallback на обычный RPC.**

- **Серьёзность:** Высокая · **Затрагивает:** свопперов на DEX/мемкоинах, арбитражных/ликвидационных ботов · **Источник:** [Helius — MEV report](https://www.helius.dev/blog/solana-mev-report), [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

### 3.7 Слепое пятно наблюдаемости

Важные метрики — доля ошибок, отставание по слотам, латентность подтверждения, успешность попадания в блок, переподключения WebSocket, распределения латентности по методам — каждая команда переписывает вручную, потому что ни `@solana/web3.js`, ни `@solana/kit` не отдают структурированную клиентскую телеметрию. У OpenTelemetry есть общие семантические соглашения для JSON-RPC, и Datadog принимает OTLP, но **Solana-специфичного OTel-экспортера или авто-инструментовки не существует**. Худшее: деградация RPC обычно проявляется как *молчаливый* отказ (подпись, которая никогда не попадает в блок), и провайдерские дашборды и серверный мониторинг это не ловят.

- **Серьёзность:** Высокая (это ядро белой зоны по диагностике) · **Затрагивает:** инженеров инфраструктуры/фронтенда dApps, кошельки · **Источник:** [Solana RPC observability (практик)](https://yavorovych.medium.com/solana-rpc-observability-what-i-actually-monitor-in-production-ebdf52a70243), [OTel JSON-RPC conventions](https://opentelemetry.io/docs/specs/semconv/rpc/json-rpc/)

---

## 4. Ландшафт существующих решений — и белая зона

| Инструмент / слой | Что решает | В чём не дотягивает |
|---|---|---|
| **`@solana/kit` (web3.js v2)** | Композируемые транспорты; лучшие примитивы подтверждения; tree-shaking | Failover / round-robin / retry поставляются только как **рецепты «сделай сам»**; нет Jito-маршрутизации, нет health-aware multi-RPC, нет телеметрии ([kit README](https://github.com/anza-xyz/kit)) |
| **Helius SDK** (`sendSmartTransaction`, staked send) | Отличное попадание в блок через staked-соединения + priority-fee API | **Вендор-лок** — нужен ключ Helius + RPC Helius ([helius-sdk](https://github.com/helius-labs/helius-sdk)) |
| **QuickNode / Triton** аддоны | Умная маршрутизация, staked send, симуляция бандлов | Серверные / привязаны к шлюзу; лок; не объединяют разных провайдеров |
| **Jito** (бандлы, low-latency send) | MEV-защита, атомарность, tips | Сервис провайдера; `bundle_id` ≠ попадание в блок; нужен fallback + логика tip, которую разработчик пишет сам ([Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)) |
| **`@solana/wallet-adapter`** | Подключение кошелька / подпись / отправка | **Нет устойчивости** — failover/retry/подтверждение явно задача приложения |
| **OSS multi-RPC библиотеки** (`solana-fallback-connection`, AurFlow) | Тонкая обёртка failover / инфра-балансировщик | Узкие; ни одна не объединяет retry + подтверждение + Jito + наблюдаемость ([npm](https://www.npmjs.com/package/solana-fallback-connection)) |
| **OTel / Datadog** | Общие JSON-RPC спаны, приём OTLP | **Solana-специфичной клиентской инструментовки нет** |

**Вывод — зона, которую можно занять:** *вендор-нейтральный, клиентский, systems-grade* SDK, объединяющий за одним чистым API поверх `@solana/kit`: (1) health-/freshness-aware multi-RPC failover и хеджирование запросов; (2) корректный retry/ребродкаст с границей по `lastValidBlockHeight` и безопасной (без двойного списания) повторной отправкой; (3) подбор размера CU на основе симуляции + динамическую оценку комиссий с учётом аккаунтов (подключаемо: Helius/QuickNode/нативно); (4) Jito/MEV-маршрутизацию с динамическими tip и автоматическим RPC-fallback; (5) стандартизированную клиентскую телеметрию OTel/Datadog и диагностический CLI. Ни один существующий инструмент не делает всё это без лока.

---

## 5. Как SDK закрывает каждую боль (привязка к scope баунти)

| Пункт scope баунти | На какую боль отвечает (§) | Архитектурный ответ SDK |
|---|---|---|
| **Совместимость с web3.js v2.0 / kit** | фундамент | Строим нативно на композируемом `RpcTransport` из `@solana/kit`; добавляем слой устойчивости, который kit намеренно опускает |
| **Интеграция wallet adapter** | 3.1, 3.6 | Plug-and-play адаптер, чтобы подписанные кошельком транзакции шли через пайплайн устойчивости + Jito (wallet-adapter этого не даёт) |
| **MEV-маршрутизация + авто RPC-fallback** | 3.6 | Маршрут через Jito (с привязкой к региону), опрос `getInflightBundleStatuses`, fallback на обычный `sendTransaction` до истечения blockhash; динамические tip из перцентилей `tip_floor` |
| **Динамические внешние оценки комиссий** | 3.5 | Подключаемый fee-oracle (Helius/QuickNode/нативно) + подбор CU по схеме «симулировать-и-добавить» |
| **Умное распределение трафика по здоровым узлам** | 3.3, 3.4 | Маршрутизация с учётом свежести (сравнение контекста `getSlot`), взвешенные/хеджированные запросы, rate limiting с учётом кредитов (по весу метода) против 429 |
| **Экспорт метрик RPC в OpenTelemetry / Datadog** | 3.7 | Полноценная OTel-инструментовка: латентность, отказы, отставание по слотам, успешность попадания — недостающая клиентская телеметрия Solana |
| **Реал-тайм мониторинг RPC и статуса транзакций** | 3.1, 3.4, 3.7 | Живой монитор здоровья + диагностика, вскрывающая молчаливые дропы |
| **Диагностический CLI** | 3.1–3.7 | CLI для проверки здоровья провайдеров, симуляции отказов и объяснения, почему транзакция не попала в блок |
| **90%+ покрытие через симуляцию дропов/латентности сети** | всё | Детерминированный харнесс инъекции отказов (drop, lag, 429, fork, истечение blockhash) как основа тестов |

---

## 6. Привязка к критериям судейства

- **Correctness (40%).** Условие победы — точно реализовать *тонкие* механики там, где большинство заявок ошибётся: blockhash на commitment `confirmed` + совпадающий `preflightCommitment`; `maxRetries: 0` + кастомный ребродкаст с границей по `lastValidBlockHeight`; никогда не переподписывать до истечения (без двойного списания); привязка blockhash+отправки к узлу, проверенному по свежести. Каждое — задокументировано и тестируемо.
- **Resilience quality (25%).** Прямо закрывается health-aware failover, хеджированными запросами, rate limiting с учётом кредитов и Jito-с-fallback — и *доказывается* под симуляционным харнессом, а не декларируется.
- **Developer experience (20%).** Отличие от провайдерских SDK — **вендор-нейтральность + один чистый API**: разработчик добавляет слой устойчивости, не переписывая всё под одного провайдера, и получает телеметрию бесплатно.
- **Test & simulation quality (15%).** Харнесс инъекции отказов (drop/latency/429/fork/expiry) — это и путь к 90% покрытия, *и* доказательная база для оценок Correctness и Resilience — он работает на две задачи сразу.

> Стратегическая заметка: поскольку Correctness + Resilience = 65% оценки, наибольший рычаг — это **sender транзакций + state-machine подтверждения** и **харнесс инъекции отказов**, а не широта функций. Их и довести до профессионального уровня в первую очередь.

---

## 7. Рекомендуемый следующий шаг

Перейти к проектированию архитектуры и поэтапному плану сборки, упорядочив модули по рычагу для судейства: (1) RPC-клиент на kit с failover, учитывающим свежесть, + хуки телеметрии; (2) sender/state-machine подтверждения с корректной семантикой retry; (3) оценка комиссий/CU; (4) Jito-маршрутизация + fallback; (5) wallet adapter; (6) экспортеры наблюдаемости + диагностический CLI; (7) симуляционный харнесс, пронизывающий всё, чтобы выйти на 90% покрытия. Каждый модуль выходит с симуляционными тестами, чтобы Correctness и Resilience были демонстрируемы, а не заявлены.

---

## Источники

**Попадание транзакций в блок и архитектура**
- [Solana — Retrying Transactions](https://solana.com/developers/guides/advanced/retry)
- [Solana — Transaction Confirmation & Expiration](https://solana.com/developers/guides/advanced/confirmation)
- [Helius — How to Land Transactions on Solana](https://www.helius.dev/blog/how-to-land-transactions-on-solana)
- [Helius — Stake-Weighted QoS](https://www.helius.dev/blog/stake-weighted-quality-of-service-everything-you-need-to-know)
- [Helius — Agave v2.1 Update](https://www.helius.dev/blog/agave-v21-update-all-you-need-to-know)
- [Cointelegraph — 75% транзакций Solana с ошибкой (апр. 2024)](https://cointelegraph.com/news/solana-struggling-record-seventy-five-percent-trasnactions-fail-memecoin-mania)
- [The Block — Перегрузка сети Solana](https://www.theblock.co/post/286868/solana-network-congestion)

**RPC-слой**
- [Solana — Clusters / публичные эндпоинты](https://solana.com/docs/references/clusters)
- [Carbium — Fixing 429 Too Many Requests on Solana](https://carbium.io/blog/fixing-429-too-many-requests-on-solana-why-rpcs-fail/)
- [Chainstack — Несколько RPC-эндпоинтов](https://docs.chainstack.com/docs/solana-how-to-use-multiple-rpc-endpoints-optimize-dapp-performance)
- [QuickNode — Лучшие RPC-провайдеры Solana 2026](https://blog.quicknode.com/best-solana-rpc-providers-2026/)
- [QuickNode — Транспорт web3.js 2.0](https://blog.quicknode.com/solana-web3-js-2-0-a-new-chapter-in-solana-development/)

**Комиссии и compute units**
- [Anza — Почему важны стоимость транзакций и compute units](https://www.anza.xyz/blog/why-solana-transaction-costs-and-compute-units-matter-for-developers)
- [Helius — Solana Fees in Theory and Practice](https://www.helius.dev/blog/solana-fees-in-theory-and-practice)
- [Helius — getPriorityFeeEstimate](https://helius.mintlify.app/api-reference/priority-fee/getpriorityfeeestimate)
- [QuickNode — qn_estimatePriorityFees](https://www.quicknode.com/docs/solana/qn_estimatePriorityFees)
- [Helius — Локальные комиссионные рынки](https://www.helius.dev/blog/solana-local-fee-markets)

**MEV и Jito**
- [Jito — Low Latency Transaction Send](https://docs.jito.wtf/lowlatencytxnsend/)
- [Helius — Solana MEV Report](https://www.helius.dev/blog/solana-mev-report)
- [CoinDesk — Jito прекращает работу мемпула](https://www.coindesk.com/business/2024/03/08/solana-client-developer-jito-announces-end-of-mempool-function)
- [Solana — MEV-защита через jitodontfront](https://solana.com/developers/guides/advanced/mev-protection)
- [QuickNode — Jito Bundles](https://www.quicknode.com/guides/solana-development/transactions/jito-bundles)

**Наблюдаемость и существующие решения**
- [Solana RPC observability в продакшене (практик)](https://yavorovych.medium.com/solana-rpc-observability-what-i-actually-monitor-in-production-ebdf52a70243)
- [OpenTelemetry — семантические соглашения JSON-RPC](https://opentelemetry.io/docs/specs/semconv/rpc/json-rpc/)
- [Datadog — Что такое OpenTelemetry](https://www.datadoghq.com/knowledge-center/opentelemetry/)
- [anza-xyz/kit (GitHub README)](https://github.com/anza-xyz/kit)
- [helius-labs/helius-sdk (GitHub)](https://github.com/helius-labs/helius-sdk)
- [solana-fallback-connection (npm)](https://www.npmjs.com/package/solana-fallback-connection)
- [Triton — Введение в новый Solana Kit](https://blog.triton.one/intro-to-the-new-solana-kit-formerly-web3-js-2/)

*Оговорки по цифрам: пик ~75% (апрель 2024) и среднее ~39% взяты из разных окон измерения и напрямую не сопоставимы; доля стейка Jito-Solana >90% и цифра ~$13,4 млн за 30 дней сэндвичей — точечные статистики из MEV-отчёта Helius. Все воспринимать как ориентировочные, не точные.*
