# TAPFORGE — Telegram sync version

## Важливо про токен
Ти показав bot token у чаті. З міркувань безпеки старий токен треба перевипустити:

1. Відкрий `@BotFather`
2. `/mybots`
3. Обери TAPFORGE
4. `API Token`
5. `Revoke current token`
6. Скопіюй новий токен

## Запуск локально

```powershell
npm.cmd install
copy .env.example .env
notepad .env
npm.cmd start
```

У `.env` встав:
```env
BOT_TOKEN=НОВИЙ_ТОКЕН
BOT_USERNAME=твій_bot_username_без_@
WEBAPP_URL=https://твій-https-домен
PORT=3000
```

Локальна перевірка сервера:
```text
http://localhost:3000/api/health
http://localhost:3000/api/me
http://localhost:3000
```

## Як працює синхронізація

- У Telegram Mini App фронтенд відправляє `Telegram.WebApp.initData` на сервер.
- Сервер перевіряє `initData` через `BOT_TOKEN`.
- Після перевірки бере реальний Telegram ID користувача.
- Прогрес зберігається у `db.json` окремо для кожного Telegram ID.

## /start у боті

Коли користувач пише `/start`, бот відправляє повідомлення з кнопкою:

`🚀 Play TAPFORGE`

Кнопка відкриває Mini App через `WEBAPP_URL`.

## Рефералка

Посилання користувача:
```text
https://t.me/BOT_USERNAME?start=TFUSERID
```

Коли новий користувач відкриває гру з цим параметром, сервер:
- записує `referredBy`
- дає бонус запрошувачу
- показує кількість рефералів на екрані друзів
