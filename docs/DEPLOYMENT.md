# Передача до live-деплою

Локальна реалізація не створює зовнішніх ресурсів. Для публікації потрібно погодити GitHub owner/name, Supabase project, Railway project і Telegram bot/chat. Секрети передаються через змінні середовища, а не README чи історію AI.

## Порядок

1. Створити GitHub-репозиторій і завантажити перевірений код після дозволу. Налаштувати перевірки PR.
2. Створити окремий Supabase-проєкт для демонстрації. Через CLI link застосувати міграцію (`supabase db push`) до перевіреного project ref. Не запускати `db reset` проти зовнішньої БД.
3. Переконатися, що pgmq доступний, bucket’и приватні, RLS увімкнено, RPC worker недоступні anon/authenticated.
4. У Railway створити web і worker з одного репозиторію. Root directory для обох — корінь репозиторію. Вказати окремі конфігурації `railway.web.json` / `railway.worker.json`.
5. Для web задати NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, NEXT_PUBLIC_APP_URL на build і runtime; SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY лише runtime. Зміна NEXT_PUBLIC_* потребує нової збірки.
6. Для worker задати SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Почати з однієї репліки й 2 GiB RAM; перевірити фактичне використання на тестовому ролику. Worker не має публічного домену.
7. Видати web Railway-домен, налаштувати Supabase Auth Site URL та redirect URLs: `/auth/callback`, `/auth/callback?next=/reset-password`. Перевірити доставку листів і SMTP-ліміти.
8. Створити два окремі підтверджені акаунти для демонстрації, виконати повний сценарій v1/v2 і review. Локальний seed навмисно відмовляється працювати з зовнішнім Supabase.
9. У погоджений Telegram-чат перевірити реальний alert через завідомо пошкоджений короткий тестовий файл. Перевірити запис error_logs і статус outbox.
10. Зафіксувати GitHub URL, live URL, commit, дату, результати smoke-test і обмеження в README.

## Експлуатація

- Web health: `GET /api/health`. Доступність worker: heartbeat в адмінці, відсутність сигналу понад 60 с показується явно.
- Не вмикати сон worker: він має постійно опитувати чергу. Перед maintenance дати завершитися активному job; при примусовому restart lease відновлює обробку.
- Railway filesystem тимчасовий; жодного постійного відео там немає.
- `SUPABASE_URL` може відрізнятися від `NEXT_PUBLIC_SUPABASE_URL` для внутрішньої мережі контейнерів. SSR зберігає браузерний namespace cookie, підписані посилання повертаються з публічним URL. У звичайному cloud Supabase обидві змінні однакові.
- Контейнерний E2E: запустити web на `127.0.0.1:3100` і один worker з локальним Supabase, потім `npx playwright test --config playwright.docker.config.ts`. Конфігурація не запускає додатковий worker і перевіряє два MP4 та review через production web.
- `npm run cleanup` лише показує незадіяні media-об’єкти старші 24 год. `npm run cleanup -- --apply` видаляє лише показані категорії, зберігаючи всі referenced результати й активні jobs. Source-файли та бізнес-дані не очищаються.
- Перед зміною схеми — резервна копія та перевірка міграції. Нові релізи не повинні автоматично виконувати міграції зі старту сервісу.

## Статус

Live-ресурси не створено, URL не видано, реальний Telegram не перевірено. Це зовнішні кроки після дозволу і надання конфігурації.
