# Установка

[Вернуться к README](../README.md)  
[Перейти к инструкции по использованию](./USAGE.md)

Этот документ отвечает только за установку и подключение: сборку проекта, запуск сервера, загрузку расширения, настройку browser-agent и подключение MCP-клиента.

## Требования

- Windows с PowerShell;
- Node.js `24+`;
- Firefox `121+` или совместимый Gecko-браузер;
- действующая авторизация в `https://chatgpt.com/`;
- MCP-клиент, умеющий работать со `Streamable HTTP`.

## 1. Подготовить проект

```powershell
npm install
npm run build
```

Проверка:

```powershell
npm run typecheck
npm test
```

## 2. Выбрать токены

Перед запуском определите два значения:

- `server access token` — секрет конкретного серверного инстанса;
- `user token` — общий пользовательский токен для extension и MCP-клиентов этого пользователя.

Рекомендации:

- используйте длинные случайные значения;
- не публикуйте их в логах и примерах;
- для разных пользователей используйте разные `user token`.

## 3. Запустить сервер

Минимальный запуск на `localhost`:

```powershell
npm run start:server -- --host=127.0.0.1 --port=8787 --server-access-token=replace-me
```

Эквивалент напрямую:

```powershell
node dist/index.js --transport=server --host=127.0.0.1 --port=8787 --server-access-token=replace-me
```

Ожидаемый вывод:

```text
[server] Listening on http://127.0.0.1:8787
```

Быстрая проверка доступности:

```powershell
curl http://127.0.0.1:8787/health
```

## 4. Установить расширение

### Вариант A. Временная загрузка в Firefox

1. Откройте `about:debugging#/runtime/this-firefox`
2. Нажмите `Load Temporary Add-on...`
3. Выберите файл `...\chatgpt-web-bridge\extension\manifest.json`
4. Откройте `https://chatgpt.com/`
5. Убедитесь, что вы уже вошли в аккаунт

### Вариант B. Сборка одним файлом `.xpi`

```powershell
npm run build:addon:unsigned
```

После этого появится unsigned `.xpi`:

```text
...\chatgpt-web-bridge\artifacts\unsigned-addon\chatgpt-web-bridge-0.1.0-unsigned.xpi
```

Важно:

- это unsigned addon;
- для Firefox stable он подходит только для временной загрузки и отладки;
- для dev-установки в отдельный профиль в репозитории есть Waterfox workflow.

### Вариант C. Waterfox dev-профиль

```powershell
npm run install:waterfox-dev
npm run run:waterfox-dev
```

## 5. Настроить browser-agent

После загрузки расширения нажмите на его иконку и откройте `Open Settings`.

Если конфигурации еще нет, расширение тоже приведет вас на страницу настроек автоматически.

Заполните:

- `Server URL`
- `Server Access Token`
- `User Token`
- `Parallel Chats`

Для локальной схемы значения обычно такие:

- `Server URL`: `http://127.0.0.1:8787`
- `Server Access Token`: тот же токен, что вы передали серверу
- `User Token`: ваш пользовательский токен

Режим `Parallel Chats`:

- `Allowed` — разные чаты могут отправляться сразу;
- `Sequential` — следующий чат отправляется только после отправки предыдущего prompt;
- `Sequential + safe timeout` — как `Sequential`, но с дополнительной случайной задержкой `3-10 секунд`.

Значение по умолчанию: `Sequential + safe timeout`.

После сохранения в статусе расширения должно появиться состояние `ready`.

## 6. Выбрать схему подключения

### Полностью локально

- сервер: `http://127.0.0.1:8787`
- extension: `http://127.0.0.1:8787`
- MCP-клиенты: `http://127.0.0.1:8787/mcp`

### Локальный сервер + tunnel

- сервер слушает локально, например `127.0.0.1:8787`
- extension может подключаться к `http://127.0.0.1:8787`
- MCP-клиенты могут подключаться к tunnel/public URL того же сервера

### Все через внешний URL

- extension использует внешний URL сервера
- MCP-клиенты используют тот же внешний URL

## 7. Подключить MCP-клиент

Для подключения нужны:

- MCP URL: `http://127.0.0.1:8787/mcp` или внешний URL вида `https://your-tunnel.example/mcp`
- заголовок `Authorization: Bearer <server access token>`
- заголовок `x-chatgpt-web-bridge-user-token: <user token>`

Что важно:

- `user token` в MCP-клиенте должен совпадать с `User Token` в настройках расширения;
- `server access token` должен совпадать с токеном, с которым запущен сервер;
- `mcp-session-id` вручную обычно задавать не нужно.

Базовая конфигурация:

```json
{
  "url": "http://127.0.0.1:8787/mcp",
  "headers": {
    "Authorization": "Bearer replace-me",
    "x-chatgpt-web-bridge-user-token": "user-alpha"
  }
}
```

Для tunnel меняется только URL:

```json
{
  "url": "https://your-tunnel.example/mcp",
  "headers": {
    "Authorization": "Bearer replace-me",
    "x-chatgpt-web-bridge-user-token": "user-alpha"
  }
}
```

## 8. Проверить установку

После добавления MCP-сервера в клиент:

1. Перезапустите MCP-клиент или обновите список серверов
2. Убедитесь, что клиент видит инструменты:
   - `chatgpt_web.new_chat`
   - `chatgpt_web.ask`
   - `chatgpt_web.ask_async`
   - `chatgpt_web.await_response`
   - `chatgpt_web.release_chat`
   - `chatgpt_web.session_info`
3. Вызовите `chatgpt_web.new_chat`
4. Убедитесь, что браузер открыл новую вкладку `chatgpt.com`
5. Вызовите `chatgpt_web.ask` с простым тестовым запросом

Минимальный тестовый запрос:

```json
{
  "request": "Ответь одной короткой фразой."
}
```

Если все настроено правильно:

- расширение остается в статусе `ready`;
- сервер не возвращает `401` или `503`;
- `new_chat` отрабатывает успешно;
- `ask` возвращает текст ответа.

## После установки

Следующий шаг — рабочее использование tool'ов, чатов и статусов. Это описано в [USAGE.md](./USAGE.md).
