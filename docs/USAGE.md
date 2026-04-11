# Использование

[Вернуться к README](../README.md)  
[Перейти к инструкции по установке](./INSTALL.md)  
[Перейти к базовому system prompt](./system_prompt.md)

Этот документ описывает рабочую модель `chatgpt_web.*`: чаты, сообщения, статусы и типовой async-only сценарий.

## Базовый сценарий

1. Вызовите `chatgpt_web.new_chat`
2. Сохраните номер чата
3. Вызовите `chatgpt_web.ask_async`
4. При необходимости вызовите `chatgpt_web.wait`
5. Проверяйте готовность через `chatgpt_web.await_response` или `chatgpt_web.response_status`
6. Когда чат больше не нужен, вызовите `chatgpt_web.release_chat`

Ответы теперь сохраняются на сервере. Финальный результат можно забрать позже по связке `chat + message`, а не только в рамках одного длинного tool call.

## Модель чатов и сообщений

- каждый `user token` имеет собственное пространство чатов;
- чаты нумеруются как `1`, `2`, `3` и больше не переиспользуются;
- `release_chat` закрывает live-вкладку, но retained история сообщений остается доступной;
- каждый `ask_async` создает сообщение внутри чата с монотонным номером `message`;
- в одном чате одновременно разрешено только одно активное сообщение в статусе `sending` или `pending`;
- после того как расширение вернуло финальный результат на сервер, чат снова становится `ready`, даже если клиент еще не считал ответ через `await_response`.

## MCP tools

### `chatgpt_web.new_chat`

Открывает один или несколько новых чатов.

По умолчанию:

- создается `temporary` чат;
- сервер ждет, пока вкладка станет готовой;
- перед включением temporary mode используется задержка из настроек расширения;
- значение по умолчанию для этой задержки: `5` секунд.

Открыть один чат:

```json
{}
```

Ответ:

```json
{
  "chat": 1
}
```

Открыть обычный чат без `temporary`:

```json
{
  "temporary": false
}
```

Открыть несколько чатов сразу:

```json
{
  "count": 3,
  "temporary": false
}
```

Ответ:

```json
{
  "chats": [1, 2, 3]
}
```

### `chatgpt_web.ask_async`

Отправляет prompt и сразу возвращает идентификатор сообщения.

Пример:

```json
{
  "chat": 1,
  "request": "Подготовь краткое резюме."
}
```

Ответ:

```json
{
  "chat": 1,
  "message": 7,
  "etaMinMs": 120000,
  "etaMaxMs": 300000
}
```

`etaMinMs` и `etaMaxMs` строятся по retained-статистике завершенных сообщений: это ориентир, а не SLA.

Если `chat` не передан, используется `defaultChat` текущего MCP-сеанса.

### `chatgpt_web.await_response`

Возвращает текущее состояние конкретного сообщения по `chat + message`.

Пример:

```json
{
  "chat": 1,
  "message": 7
}
```

Ответ, пока генерация еще идет:

```json
{
  "status": "pending",
  "chat": 1,
  "message": 7,
  "elapsedMs": 18342
}
```

Ответ при успехе:

```json
{
  "status": "completed",
  "chat": 1,
  "message": 7,
  "response": "Краткое резюме готово.",
  "read": true
}
```

Ответ при ошибке:

```json
{
  "status": "failed",
  "chat": 1,
  "message": 7,
  "detail": "The browser agent lost the session.",
  "elapsedMs": 24511
}
```

`await_response` идемпотентен: повторный вызов по уже завершенному сообщению вернет тот же terminal result.

### `chatgpt_web.response_status`

Возвращает retained состояние чатов и сообщений без тел ответов.

Пример ответа:

```json
{
  "defaultChat": 2,
  "averageGenerationMs": 91437,
  "chats": [
    {
      "chat": 1,
      "state": "released",
      "temporary": true,
      "messages": [
        {
          "message": 3,
          "status": "completed",
          "read": true,
          "createdAt": "2026-04-09T10:00:00.000Z",
          "completedAt": "2026-04-09T10:01:12.000Z",
          "elapsedMs": 72000,
          "generationMs": 68000
        }
      ]
    },
    {
      "chat": 2,
      "state": "waiting_response",
      "temporary": false,
      "messages": [
        {
          "message": 7,
          "status": "pending",
          "read": false,
          "createdAt": "2026-04-09T10:02:00.000Z",
          "completedAt": null,
          "elapsedMs": 18342,
          "generationMs": null
        }
      ]
    }
  ]
}
```

`averageGenerationMs`:

- в remote-сервере считается по всем retained completed сообщениям всех пользователей;
- в stdio-режиме считается по retained completed сообщениям текущего локального data root.

### `chatgpt_web.wait`

Удобный backoff-tool для polling.

Пример:

```json
{
  "seconds": 5
}
```

Ответ:

```json
{
  "waitedSec": 5
}
```

Текстовый content tool-а будет `waited 5`.

### `chatgpt_web.release_chat`

Закрывает live-чат, но не удаляет retained историю.

Освободить один чат:

```json
{
  "chat": 1
}
```

Освободить несколько чатов:

```json
{
  "chats": [1, 3]
}
```

Ответ:

```json
{
  "ok": true
}
```

## Статусы чатов

`response_status` возвращает следующие состояния:

- `starting` — чат создается, вкладка еще не готова;
- `ready` — чат готов принимать новый запрос;
- `sending` — prompt еще отправляется в UI;
- `waiting_response` — prompt уже принят ChatGPT, идет генерация;
- `released` — live-сессия закрыта, но история сохранена.

## Параллельные чаты

Расширение управляет отправкой prompt-ов между разными чатами через настройку `Parallel Chats`.

Режимы:

- `Allowed` — разные чаты могут отправляться сразу;
- `Sequential` — следующий чат отправляется только после подтвержденной отправки предыдущего prompt;
- `Sequential + safe timeout` — как `Sequential`, но перед следующим чатом добавляется случайная пауза `3-10 секунд`.

Ограничение действует только между разными чатами. Внутри одного чата второй `ask_async` будет отклонен, пока предыдущее сообщение находится в `sending` или `pending`.

## Типовые ошибки

### Повторный запрос в тот же чат

Причина:

- в чате уже есть активное сообщение;
- чат еще не вернулся в `ready`.

### Запрос в чат, который еще не готов

Причина:

- чат находится в состоянии `starting`.

### `await_response` возвращает `failed`

Причина:

- сообщение завершилось ошибкой;
- remote server или browser-agent потеряли активную сессию;
- сервер перезапустился до захвата ответа и перевел незавершенное сообщение в terminal `failed`.

### `await_response` возвращает `pending`

Причина:

- запрос еще выполняется;
- имеет смысл сделать `chatgpt_web.wait`, а затем повторить `await_response`.

## Node.js пример

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
  requestInit: {
    headers: {
      Authorization: "Bearer replace-me",
      "x-chatgpt-web-bridge-user-token": "user-alpha"
    }
  }
});

const client = new Client(
  { name: "demo-client", version: "1.0.0" },
  { capabilities: {} }
);

await client.connect(transport);

const newChat = await client.callTool({
  name: "chatgpt_web.new_chat",
  arguments: {}
});

const chat = newChat.structuredContent.chat;

const queued = await client.callTool({
  name: "chatgpt_web.ask_async",
  arguments: {
    chat,
    request: "Сделай краткое summary."
  }
});

const message = queued.structuredContent.message;

while (true) {
  const response = await client.callTool({
    name: "chatgpt_web.await_response",
    arguments: { chat, message }
  });

  const result = response.structuredContent;
  if (result.status === "completed") {
    console.log(result.response);
    break;
  }

  if (result.status === "failed") {
    throw new Error(result.detail);
  }

  await client.callTool({
    name: "chatgpt_web.wait",
    arguments: { seconds: 5 }
  });
}
```

Если нужна установка и подключение, вернитесь к [INSTALL.md](./INSTALL.md). Если нужен общий обзор приложения, используйте [README](../README.md).
