# Передача до live-деплою

Локальна реалізація не створює зовнішніх ресурсів. Для публікації потрібно погодити GitHub owner/name, Supabase project, Railway project і Telegram bot/chat. Секрети передаються через змінні середовища, а не README чи історію AI.

## Порядок

1. Створити GitHub-репозиторій і завантажити перевірений код після дозволу. Налаштувати перевірки PR.
2. Створити окремий Supabase-проєкт для демонстрації. Через CLI link застосувати міграцію (`supabase db push`) до перевіреного project ref. Не запускати `db reset` проти зовнішньої БД.
3. Переконатися, що pgmq доступний, bucket’и приватні, RLS увімкнено, RPC worker недоступні anon/authenticated.
4. У Railway створити web і worker з одного репозиторію. Root directory для обох — корінь репозиторію. Задати Dockerfile.web / Dockerfile.worker у параметрах сервісів. На дату live-деплою API відхиляє railwayConfigFile як deprecated; файли railway.*.json у репозиторії залишені як історична конфігурація, live використовує параметри API.
5. Для web задати NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, NEXT_PUBLIC_APP_URL на build і runtime; SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY лише runtime. Зміна NEXT_PUBLIC_* потребує нової збірки.
6. Для worker задати SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; Telegram потребує окремо погоджених TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID. Для демо Free — одна репліка, ліміт близько 512 MiB на сервіс. Worker не має публічного домену. Free вимагає sleepApplication=true; звичайне опитування Supabase створює вихідний трафік, але тривалу доступність слід контролювати через heartbeat.
7. Видати web Railway-домен, налаштувати Supabase Auth Site URL та redirect URLs: `/auth/callback`, `/auth/callback?next=/reset-password`. Перевірити доставку листів і SMTP-ліміти.
8. Створити два окремі підтверджені акаунти для демонстрації, виконати повний сценарій v1/v2 і review. Локальний seed навмисно відмовляється працювати з зовнішнім Supabase.
9. У погоджений Telegram-чат перевірити реальний alert через завідомо пошкоджений короткий тестовий файл. Перевірити запис error_logs і статус outbox.
10. Зафіксувати GitHub URL, live URL, commit, дату, результати smoke-test і обмеження в README.

## Експлуатація

- Web health: `GET /api/health`. Доступність worker: heartbeat в адмінці, відсутність сигналу понад 60 с показується явно.
- Railway Free вимагає sleepApplication=true; контролювати heartbeat worker. Перед maintenance дати завершитися активному job; при примусовому restart lease відновлює обробку.
- Railway filesystem тимчасовий; жодного постійного відео там немає.
- `SUPABASE_URL` може відрізнятися від `NEXT_PUBLIC_SUPABASE_URL` для внутрішньої мережі контейнерів. SSR зберігає браузерний namespace cookie, підписані посилання повертаються з публічним URL. У звичайному cloud Supabase обидві змінні однакові.
- Контейнерний E2E: запустити web на `127.0.0.1:3100` і один worker з локальним Supabase, потім `npx playwright test --config playwright.docker.config.ts`. Конфігурація не запускає додатковий worker і перевіряє два MP4 та review через production web.
- `npm run cleanup` лише показує незадіяні media-об’єкти старші 24 год. `npm run cleanup -- --apply` видаляє лише показані категорії, зберігаючи всі referenced результати й активні jobs. Source-файли та бізнес-дані не очищаються.
- Перед зміною схеми — резервна копія та перевірка міграції. Нові релізи не повинні автоматично виконувати міграції зі старту сервісу.

## Статус

Live від 2026-09-07: https://amo-web-production.up.railway.app, commit c70f56d.

- Railway: погоджений проєкт grand-purpose (`629efa43-88e3-49a9-899f-5c59f78f7ce4`), production; сервіси amo-web та amo-worker, GitHub main.
- Supabase: окремий amo-video-tasks (`etwuxieyvitrnusykrkr`), Frankfurt, Free; усі три міграції застосовані. Обидва bucket приватні.
- Domain target port **8080**: Railway задає PORT=8080, який має пріоритет над Docker ENV PORT=3000. Початковий маршрут 3000 давав 502, виправлено.
- Site URL і callback URL задані для live-домену. Демо-акаунти створені з підтвердженим email; це не перевірка доставки реальних листів.
- Секрети лише у Railway variables та ignored `.local/live.env`, `.local/live-supabase.json`, `.local/live-api-keys.json`. Кореневий `.env` зберігає локальні налаштування.
- Увага: Supabase CLI тепер linked до live. Для локальних міграцій використовуйте явний `--local`; `db push --linked` змінює live.
- Custom SMTP підключено: Gmail, smtp.gmail.com:465, відправник AMO Studio. Пароль застосунку збережено в налаштуваннях Supabase; він не потрібен Railway. Локальний файл `.local/gmail-smtp.env` виключений із Git. Signup resend та recovery API повернули успіх; доставку обох листів підтверджено власником скриньки, повний браузерний цикл реєстрації, підтвердження email, входу та відновлення пароля пройшов; старий пароль відхиляється, новий працює.
- 2026-09-08: Telegram підключено до amo-worker; реальний INVALID_MEDIA алерт прийнятий Telegram API з першої спроби. 1080p/4K analyze/render у live пройшли на релізі 24d6394. Перезапуск під час активного рендера у live окремо не перевірявся.
