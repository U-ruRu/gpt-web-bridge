# ChatGPT Web Bridge

Локальный проект для автоматизации `chatgpt.com` через Firefox extension и отдельный bridge-процесс. Сейчас у проекта два режима:

- `bridge` — локальный HTTP API для ручных тестов и отладки;
- `stdio` — нормальный MCP-сервер для подключения из клиента, который спаунит отдельный процесс на каждое подключение.

Главная идея текущей версии: **один MCP-процесс = одна внутренняя сессия = один localhost bridge-порт = одна automation-вкладка ChatGPT**. Это дает изоляцию между параллельными запусками и не заставляет прокидывать `sessionId` в каждый MCP tool-вызов.

## Что уже умеет проект

- поднимать MCP server по `stdio`;
- поднимать внутренний localhost bridge на случайном порту;
- изолировать вкладки ChatGPT по `bridgeClaim + bridgePort + bridgeSessionId`;
- открывать новый обычный чат;
- переводить уже открытую automation-вкладку во временный чат;
- отправлять запрос в Web UI и возвращать plain text ответа модели;
- восстанавливать беседу по `conversationUrl`, если у процесса есть стабильный `sessionId`;
- писать историю успешных обменов в отдельные log-файлы.

## Архитектура

```text
MCP client / local app
    ->
chatgpt-web-bridge process
    ->
session-local HTTP bridge on 127.0.0.1:<random-port>
    ->
Firefox extension background
    ->
claimed ChatGPT tab
    ->
ChatGPT Web UI
```

### Как работает изоляция

В режиме `stdio` каждый клиентский коннект запускает отдельный процесс `chatgpt-web-bridge`.

У этого процесса есть:

- свой `sessionId`;
- свой bridge на случайном порту `127.0.0.1:0 -> 127.0.0.1:<real-port>`;
- свой `bridgeClaim` token;
- своя automation-вкладка, которая claim'ится extension'ом;
- свое состояние чата и своя история.

Поэтому два параллельных запуска не должны перепутывать вкладки и ответы между собой.

## Структура проекта

```text
chatgpt-web-bridge/
  extension/
    manifest.json
    background.js
    content-script.js
  src/
    bridge/
      server.ts
      store.ts
      types.ts
    mcp/
      server.ts
    index.ts
  package.json
  tsconfig.json
  README.md
```

## Установка

```powershell
cd D:\development\projects\chatgpt-web-bridge
npm install
npm run build
```

## Тесты

Быстрый полный прогон автотестов:

```powershell
npm test
```

Что сейчас покрыто:

- runtime-логика `new_chat`, `set_temporary`, `ask`;
- запись и восстановление `conversationUrl`;
- история чатов `sessionId-chatId-chatHistory.log`;
- HTTP bridge endpoints `/health` и `/ask`;
- `stdio MCP` tools `chatgpt_web.ask` и `chatgpt_web.set_temporary`, плюс регистрация всех tool'ов.

## Загрузка extension в Firefox

1. Открой `about:debugging#/runtime/this-firefox`
2. Нажми `Load Temporary Add-on...`
3. Выбери `D:\development\projects\chatgpt-web-bridge\extension\manifest.json`
4. Вручную залогинься в ChatGPT в Firefox.
5. После любого изменения файлов в `extension/` нажимай `Reload` у дополнения.

### Автозапуск bridge вместе с extension

Теперь extension умеет поднимать локальный bridge автоматически через Firefox Native Messaging.

Установка native host на Windows:

```powershell
cd D:\development\projects\chatgpt-web-bridge
npm run install:firefox-host
```

Это:

- собирает проект;
- регистрирует native host в `HKCU\Software\Mozilla\NativeMessagingHosts\chatgpt_web_bridge_host`;
- кладет manifest и wrapper в `%LOCALAPPDATA%\chatgpt-web-bridge\native-host\firefox\`.

После этого достаточно перезагрузить extension в `about:debugging`, и bridge на `http://127.0.0.1:4545` будет запускаться вместе с extension.

Удаление native host:

```powershell
npm run uninstall:firefox-host
```

Важно:

- браузером по умолчанию должен быть Firefox с этим extension;
- extension теперь умеет работать не только с `127.0.0.1:4545`, а с любым `http://127.0.0.1:<port>`.

## Неподписанный addon для Waterfox dev-mode

Для dev-проверки теперь есть отдельный workflow с неподписанным `.xpi` и выделенным профилем Waterfox.

Сборка неподписанного `.xpi`:

```powershell
cd D:\development\projects\chatgpt-web-bridge
npm run build:addon:unsigned
```

Готовый файл появится здесь:

```text
D:\development\projects\chatgpt-web-bridge\artifacts\unsigned-addon\
```

Подготовка dev-профиля Waterfox:

```powershell
npm run install:waterfox-dev
```

Эта команда:

- собирает проект;
- собирает неподписанный `.xpi`;
- устанавливает native host;
- создает отдельный профиль в `%LOCALAPPDATA%\chatgpt-web-bridge\waterfox-dev-profile`;
- прописывает в `user.js` dev-настройки, включая `xpinstall.signatures.required=false`;
- кладет addon в `extensions\chatgpt-web-bridge@example.local.xpi` внутри этого профиля.

Запуск Waterfox с этим dev-профилем:

```powershell
npm run run:waterfox-dev
```

Поиск Waterfox идет так:

- сначала `WATERFOX_EXE`, если переменная задана;
- потом `waterfox` из `PATH`;
- потом стандартные пути `C:\Program Files\Waterfox\...`.

Если Waterfox стоит в нестандартном месте, можно явно задать путь:

```powershell
$env:WATERFOX_EXE = "D:\Apps\Waterfox\waterfox.exe"
npm run run:waterfox-dev
```

Примечание:

- это именно dev-режим для локальной проверки неподписанного addon;
- для обычной постоянной установки в ежедневный профиль Waterfox все равно лучше использовать подписанный `.xpi`.

## Режимы запуска

### 1. Bridge mode

Для ручных тестов и отладки:

```powershell
npm run start:bridge
```

Если установлен native host, ручной запуск `start:bridge` больше не обязателен: extension сам поднимет bridge при старте.

Это запустит HTTP bridge на `127.0.0.1:4545`.

Можно указать свои параметры:

```powershell
node dist/index.js --transport=bridge --host=127.0.0.1 --port=4545 --session-id=api
```

### 2. MCP stdio mode

Для подключения как MCP-сервера:

```powershell
npm run start:mcp
```

Эквивалент:

```powershell
node dist/index.js --transport=stdio
```

В этом режиме процесс:

- поднимает bridge на случайном локальном порту;
- подключает MCP tools по `stdin/stdout`;
- пишет логи только в `stderr`.

## MCP tools

Сервер регистрирует 3 tool'а:

- `chatgpt_web.new_chat`
- `chatgpt_web.set_temporary`
- `chatgpt_web.ask`

### `chatgpt_web.new_chat`

Открывает новый обычный чат и возвращается только после того, как вкладка реально готова к вводу.

### `chatgpt_web.set_temporary`

Переводит уже открытую automation-вкладку в режим временного чата.

### `chatgpt_web.ask`

Принимает:

```json
{ "request": "..." }
```

Возвращает plain text ответа и служебные поля, включая `conversationUrl`.

## Пример MCP-конфигурации

Если клиент умеет поднимать MCP по `stdio`, конфигурация будет такого типа:

```json
{
  "command": "node",
  "args": [
    "D:/development/projects/chatgpt-web-bridge/dist/index.js",
    "--transport=stdio"
  ]
}
```

Если нужен устойчивый restore одной и той же логической сессии между рестартами, лучше задавать стабильный `sessionId`:

```json
{
  "command": "node",
  "args": [
    "D:/development/projects/chatgpt-web-bridge/dist/index.js",
    "--transport=stdio",
    "--session-id=codex-main"
  ]
}
```

## Пошаговый запуск MCP

Ниже сценарий именно для первого живого запуска MCP через `stdio`.

### 1. Подготовить проект

```powershell
cd D:\development\projects\chatgpt-web-bridge
npm install
npm run build
```

### 2. Подготовить Firefox

1. Открой `about:debugging#/runtime/this-firefox`
2. Нажми `Load Temporary Add-on...`
3. Выбери `D:\development\projects\chatgpt-web-bridge\extension\manifest.json`
4. Открой `https://chatgpt.com/` в Firefox
5. Убедись, что ты уже залогинен
6. Если код extension менялся, нажми `Reload`

### 3. Подключить сервер как MCP по `stdio`

В MCP-клиенте укажи такую конфигурацию:

```json
{
  "command": "node",
  "args": [
    "D:/development/projects/chatgpt-web-bridge/dist/index.js",
    "--transport=stdio",
    "--session-id=codex-main"
  ]
}
```

`--session-id=codex-main` не обязателен, но полезен, если ты хочешь восстановление того же чата между рестартами.

### 4. Перезапустить MCP-клиент

После добавления конфигурации:

1. перезапусти клиент, который подключает MCP;
2. убедись, что он увидел инструменты:
   - `chatgpt_web.new_chat`
   - `chatgpt_web.set_temporary`
   - `chatgpt_web.ask`

### 5. Первый рабочий прогон

Вызови tools в таком порядке:

1. `chatgpt_web.new_chat`
2. при необходимости `chatgpt_web.set_temporary`
3. `chatgpt_web.ask` с телом:

```json
{
  "request": "Привет! Ответь одной короткой фразой."
}
```

Ожидаемое поведение:

- Firefox откроет новую automation-вкладку ChatGPT;
- вкладка дождется готовности composer;
- если был вызван `set_temporary`, чат переключится во временный режим;
- `ask` введет текст и вернет `responseText`.

### 6. Проверить, что ответ реально пришел

У успешного вызова `chatgpt_web.ask` должны быть:

- текстовый `content` с ответом модели;
- `structuredContent.responseText`;
- `structuredContent.conversationUrl`.

### 7. Проверить историю чата

После первого успешного ответа должен появиться файл:

```text
%LOCALAPPDATA%\chatgpt-web-bridge\chat-history\sessionId-chatId-chatHistory.log
```

Пример содержимого:

```text
Request: "Привет! Ответь одной короткой фразой."
Answer: "Привет. Что нужно?"
```

### 8. Если нужно проверить восстановление

1. останови MCP-клиент;
2. снова запусти его с тем же `--session-id`;
3. вызови `chatgpt_web.ask` еще раз.

Если у прошлого чата уже был `conversationUrl`, процесс должен восстановить ту же беседу.

## Локальный HTTP API

Это в первую очередь debug-интерфейс и внутренний bridge для extension. Основные внешние endpoints для ручной работы:

### `GET /health`

```powershell
curl http://127.0.0.1:4545/health
```

Пример ответа:

```json
{
  "ok": true,
  "sessionId": "api"
}
```

### `GET /newchat`

Открывает новый обычный чат и отвечает только после готовности вкладки.

```powershell
curl "http://127.0.0.1:4545/newchat"
```

Пример ответа:

```json
{
  "ok": true,
  "sessionId": "api",
  "isTemporary": false,
  "status": "ready",
  "detail": "Fresh chat is ready.",
  "launchUrl": "https://chatgpt.com/?bridgeClaim=..."
}
```

Для пошаговой диагностики можно не ждать `ready`, а только инициировать запуск:

```powershell
curl "http://127.0.0.1:4545/newchat?waitForReady=false"
```

В этом режиме bridge сразу вернет `202 Accepted` с `launchToken` и `launchUrl`, а дальше состояние можно смотреть через `GET /debug/state`.

### `GET /setTemporary`

Переводит текущую automation-вкладку в temporary mode.

```powershell
curl "http://127.0.0.1:4545/setTemporary"
```

### `POST /ask`

Отправляет запрос и ждет текстовый ответ модели.

```powershell
$response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4545/ask" `
  -ContentType "application/json; charset=utf-8" `
  -Body '{"request":"Привет!"}'

$response.responseText
```

Пример ответа:

```json
{
  "responseText": "Привет. Что нужно?",
  "conversationUrl": "https://chatgpt.com/c/...",
  "detail": "Prompt was submitted and the assistant response was captured.",
  "jobId": "b7109020-de77-480c-ad5d-e52accca69c8",
  "status": "sent",
  "mode": "normal",
  "sessionId": "api"
}
```

### Внутренние endpoints

Extension использует также внутренние маршруты:

- `/automation/pending`
- `/automation/claim`
- `/automation/command`
- `/automation/command/status`
- `/session/active`
- `/session/next`
- `/jobs`
- `/jobs/:id`
- `/jobs/:id/status`

Они нужны для транспорта между bridge и content script.

### `GET /debug/state`

Возвращает снимок текущего состояния runtime:

- активную session;
- pending launch/command;
- список jobs;
- пути к директориям данных и к session runtime-log.

Пример:

```powershell
curl "http://127.0.0.1:4545/debug/state"
```

## Восстановление после рестарта

После первого успешного `ask()` у чата появляется `conversationUrl` вида:

```text
https://chatgpt.com/c/<chatId>
```

Этот URL сохраняется и используется для восстановления после рестарта процесса.

Ограничения:

- если чат еще пустой и `chatId` не появился, восстанавливать нечего;
- temporary mode сам по себе устойчиво не хранится как отдельная сущность;
- для осмысленного restore нужен стабильный `sessionId`, иначе новый процесс получит новый идентификатор и новое состояние.

## История чатов

История хранится в профиле пользователя, не в репозитории.

Для Windows путь такой:

```text
%LOCALAPPDATA%\chatgpt-web-bridge\chat-history\
```

Для каждого чата создается отдельный файл:

```text
sessionId-chatId-chatHistory.log
```

Формат записи:

```text
Request: "text"
Answer: "text"
```

Правила:

- в файл пишутся только успешные пары `Request/Answer`;
- до появления `chatId` история держится в памяти процесса;
- после первого успешного ответа накопленная история сбрасывается в нужный файл;
- кодировка файлов — UTF-8;
- кавычки экранируются как `\"`;
- переводы строк внутри текста нормализуются в `\n`.

### Ограничение размера истории

Вся папка `chat-history` ограничена `100 MB`.

После каждой успешной записи runtime:

- пересчитывает суммарный размер;
- если лимит превышен, удаляет самые старые log-файлы по `mtime`;
- продолжает, пока общий объем не станет `<= 100 MB`.

## Диагностические логи

Для каждой runtime-сессии теперь пишется отдельный лог:

```text
%LOCALAPPDATA%\chatgpt-web-bridge\logs\<sessionId>-runtime.log
```

Туда попадают:

- события bridge и runtime;
- статусы `new_chat`, `set_temporary`, `ask`;
- таймауты ожидания;
- диагностические события из `background.js`;
- диагностические события из `content-script.js`.

Это основной файл, который нужно смотреть, если `new_chat` или `ask` зависают.

В новых версиях лог теперь подробнее показывает стадии ожидания:

- queued -> running -> sent/failed для job;
- pending -> claimed -> ready/failed для launch;
- pending -> running/completed/failed для automation command.

## Полезные параметры запуска

CLI:

```text
--transport=bridge|stdio
--host=127.0.0.1
--port=4545
--session-id=<value>
--data-dir=<path>
```

Environment variables:

```text
CHATGPT_WEB_BRIDGE_HOST
CHATGPT_WEB_BRIDGE_PORT
CHATGPT_WEB_BRIDGE_SESSION_ID
CHATGPT_WEB_BRIDGE_DATA_DIR
```

## Smoke test

### Bridge mode

```powershell
curl http://127.0.0.1:4545/health
curl "http://127.0.0.1:4545/newchat"
curl "http://127.0.0.1:4545/setTemporary"
```

```powershell
$response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4545/ask" `
  -ContentType "application/json; charset=utf-8" `
  -Body '{"request":"Привет!"}'

$response.responseText
```

### Диагностика

Runtime-логи bridge пишутся в:

```text
%LOCALAPPDATA%\chatgpt-web-bridge\logs\<sessionId>-runtime.log
```

Локальные логи самого extension пишутся в `browser.storage.local` под ключом `debugLogs`.

Как посмотреть их в Firefox/Waterfox:

1. Открой `about:debugging#/runtime/this-firefox`
2. Найди `ChatGPT Web Bridge MVP`
3. Нажми `Inspect`
4. В консоли background page выполни:

```js
browser.storage.local.get("debugLogs")
```

Это особенно полезно, когда вкладка не claim'ится и в bridge runtime-log не появляются события `background`/`content-script`.

### MCP stdio

Минимальная проверка: MCP-клиент должен увидеть tools:

- `chatgpt_web.new_chat`
- `chatgpt_web.set_temporary`
- `chatgpt_web.ask`

## Ограничения текущей версии

- Firefox-only.
- Логин в ChatGPT остается ручным.
- Автоматизация все еще зависит от актуального DOM `chatgpt.com`.
- Открытие вкладок идет через браузер по умолчанию ОС.
- Для полноценного многоклиентского HTTP/OpenAPI слоя нужен следующий этап с явными `sessionId` в публичном API.
- Streamable HTTP и OpenAPI еще не реализованы; пока есть только `stdio MCP` и debug bridge.

## Что дальше

Следующий этап поверх этого ядра:

- `Streamable HTTP` transport;
- публичные session-aware HTTP endpoints;
- OpenAPI-описание для внешнего вызова;
- инструмент для собственного GPT или другого клиента, который будет ходить уже в session-aware API, а не в debug bridge.
