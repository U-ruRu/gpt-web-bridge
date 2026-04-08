# Использование

[Вернуться к README](../README.md)  
[Перейти к инструкции по установке](./INSTALL.md)

Этот документ описывает рабочий процесс текущей remote-версии `ChatGPT Web Bridge`: запуск сервера, подключение MCP-клиента, поведение сессий и вызов инструментов.

## Перед началом

Предполагается, что вы уже:

- собрали проект;
- запустили сервер;
- загрузили расширение;
- ввели в extension `Server URL`, `Server Access Token` и `User Token`;
- вошли в `chatgpt.com`.

Если это еще не сделано, сначала пройдите [инструкцию по установке](./INSTALL.md).

## Базовый рабочий цикл

1. Поднимите сервер `chatgpt-web-bridge`
2. Убедитесь, что extension показывает статус `ready`
3. Подключите MCP-клиент к `/mcp`
4. Вызовите `chatgpt_web.new_chat`
5. При необходимости вызовите `chatgpt_web.set_temporary`
6. Отправляйте запросы через `chatgpt_web.ask`
7. Когда сессия больше не нужна, вызовите `chatgpt_web.release_session`

## Запуск сервера

Типовой запуск:

```powershell
npm run start:server -- --host=127.0.0.1 --port=8787 --server-access-token=replace-me
```

Проверка состояния:

```powershell
curl http://127.0.0.1:8787/health
```

`/health` полезен для быстрой проверки, что сервер жив, но он не заменяет проверку browser-agent. Для работы tool'ов расширение тоже должно быть подключено.

## Настройка MCP-клиента

Сервер ожидает:

- endpoint `POST/GET/DELETE /mcp`
- заголовок `Authorization: Bearer <server access token>`
- заголовок `x-chatgpt-web-bridge-user-token: <user token>`

Если клиент использует SDK MCP, `mcp-session-id` обычно управляется автоматически транспортом и вручную задавать его не нужно.

### Пример на Node.js

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://127.0.0.1:8787/mcp"),
  {
    requestInit: {
      headers: {
        Authorization: "Bearer replace-me",
        "x-chatgpt-web-bridge-user-token": "user-alpha"
      }
    }
  }
);

const client = new Client(
  { name: "example-client", version: "1.0.0" },
  { capabilities: {} }
);

await client.connect(transport);
```

Если нужен именно пошаговый setup с проверкой после добавления сервера, он описан в [инструкции по установке](./INSTALL.md#7-подключить-mcp-клиент).

### Быстрая проверка после подключения

Сразу после подключения MCP-клиента удобно проверить связку так:

1. Вызвать `listTools`
2. Убедиться, что доступны все 5 `chatgpt_web.*` инструментов
3. Вызвать `chatgpt_web.new_chat`
4. Дождаться открытия новой вкладки ChatGPT
5. Вызвать `chatgpt_web.ask`

Минимальный тест:

```json
{
  "request": "Проверка подключения. Ответь коротко."
}
```

У успешного ответа должен появиться как минимум:

- `content[0].text`
- `structuredContent.responseText`
- `structuredContent.sessionToken`

## Как работает binding пользователя

Система использует два слоя привязки:

- `server access token` разрешает доступ к конкретному серверу;
- `user token` связывает browser-agent и MCP-клиентов одного пользователя.

Практически это означает:

- extension и MCP-клиент должны использовать один и тот же `user token`;
- другой `user token` не увидит ваши browser session'ы;
- если агент переподключится с тем же `user token`, новый agent заменит старый.

## Как работает изоляция session

Изоляция идет на уровне MCP transport session и `sessionToken`.

Правила:

- каждый вызов `chatgpt_web.new_chat` создает новую browser session и новую вкладку;
- новая session становится default session для текущего MCP transport session;
- `chatgpt_web.ask` без явного `sessionToken` пишет в default session именно этого MCP-клиента;
- можно передать `sessionToken` явно и работать с несколькими сессиями одновременно;
- другая MCP transport session не может использовать session, которой она не владеет.

Это и позволяет одному пользователю держать несколько параллельных MCP-agent сессий без смешивания запросов.

## MCP tools

### `chatgpt_web.new_chat`

Создает новую вкладку `chatgpt.com`, ждет готовности automation tab и возвращает `sessionToken`.

Пример:

```json
{}
```

Пример ответа:

```json
{
  "sessionToken": "6be9d6d3-9a07-4231-a8cb-f6c8e3d79f36",
  "status": "ready",
  "mode": "normal",
  "detail": "Chat session is ready.",
  "conversationUrl": null,
  "tabId": 123
}
```

### `chatgpt_web.ask`

Отправляет prompt в уже привязанную session.

Пример:

```json
{
  "request": "Ответь одной короткой фразой."
}
```

Пример ответа:

```json
{
  "sessionToken": "6be9d6d3-9a07-4231-a8cb-f6c8e3d79f36",
  "responseText": "Готово.",
  "conversationUrl": "https://chatgpt.com/c/...",
  "detail": "Assistant response captured.",
  "mode": "normal"
}
```

### `chatgpt_web.set_temporary`

Переключает текущую session в temporary mode.

Пример:

```json
{}
```

### `chatgpt_web.session_info`

Возвращает сведения о текущей или явно указанной session.

Пример:

```json
{}
```

### `chatgpt_web.release_session`

Освобождает session, удаляет server-side binding и закрывает вкладку в агенте.

Пример:

```json
{}
```

## Типовой сценарий

Последовательность вызовов обычно такая:

1. `chatgpt_web.new_chat`
2. `chatgpt_web.set_temporary`, если нужен temporary chat
3. `chatgpt_web.ask`
4. `chatgpt_web.session_info`, если нужно получить текущий статус
5. `chatgpt_web.release_session`, когда работа завершена

## Работа с несколькими сессиями

Если один и тот же MCP-клиент хочет держать несколько чатов одновременно, сохраняйте `sessionToken`, который вернул `new_chat`, и передавайте его явно.

Пример:

```json
{
  "request": "Промпт для второй сессии",
  "sessionToken": "second-session-token"
}
```

Если два разных MCP-клиента подключены с одинаковым `user token`, но каждый создал свой `new_chat`, их запросы будут идти в разные вкладки автоматически.

## Использование в разных топологиях

### Локально

- extension: `http://127.0.0.1:8787`
- MCP-клиент: `http://127.0.0.1:8787/mcp`

### Локально + tunnel

- extension: `http://127.0.0.1:8787`
- MCP-клиент: `https://your-tunnel.example/mcp`

Это работает, если `server access token` и `user token` совпадают с настройками extension.

### Все через публичный адрес

- extension: `https://your-tunnel.example`
- MCP-клиент: `https://your-tunnel.example/mcp`

## Что важно помнить

- без активного browser-agent сервер вернет ошибку о том, что агент offline;
- extension не открывает вкладки заранее: вкладка создается лениво на `new_chat`;
- один `user token` в текущей версии предполагает один активный agent connection;
- для успешной работы браузер должен быть авторизован в ChatGPT;
- если DOM `chatgpt.com` меняется, automation может потребовать обновления.

## Короткая диагностика

### Сервер отвечает `401`

Проверьте `Authorization: Bearer <server access token>`.

### Сервер отвечает `503`

Обычно это значит, что browser-agent для этого `user token` не подключен или extension еще не в статусе `ready`.

### Сессии не находятся

Проверьте:

- одинаковый ли `user token` у extension и MCP-клиента;
- не вызывается ли чужой `sessionToken`;
- не была ли session уже освобождена через `release_session`.

### Таймаут на `new_chat` или `ask`

Проверьте:

- открыт ли и авторизован ли `chatgpt.com`;
- не зависло ли расширение;
- есть ли у extension статус `ready`;
- не блокирует ли браузер открытие вкладки или скрипты страницы.

## Legacy-режимы

В репозитории остаются `bridge` и `stdio` режимы, но для основной эксплуатации текущего приложения используйте серверный режим `start:server`.

Если нужно вернуться к установочным шагам или к способам загрузки расширения, откройте [инструкцию по установке](./INSTALL.md).
