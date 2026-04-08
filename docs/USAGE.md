# Использование

[Вернуться к README](../README.md)  
[Перейти к инструкции по установке](./INSTALL.md)

Этот документ отвечает только за использование: рабочую модель чатов, MCP tool'ы, статусы, batch-операции и типовые сценарии.

## Базовый сценарий

1. Вызовите `chatgpt_web.new_chat`
2. Сохраните номер чата
3. Вызовите `chatgpt_web.ask` или `chatgpt_web.ask_async`
4. Если использовали `ask_async`, затем вызовите `chatgpt_web.await_response`
5. Когда чат больше не нужен, вызовите `chatgpt_web.release_chat`

## Модель чатов

- каждый `user token` имеет собственное пространство чатов;
- чаты нумеруются как `1`, `2`, `3` и выдаются сервером;
- `new_chat` возвращает минимальный свободный номер, а при batch-вызове массив минимальных свободных номеров;
- после `release_chat` номер снова становится доступным;
- если параметр `chat` не передан, используется `defaultChat` текущего MCP-сеанса;
- в одном чате одновременно разрешен только один незавершенный запрос.

## MCP tools

### `chatgpt_web.new_chat`

Создает один или несколько новых чатов.

По умолчанию:

- сервер ждет готовности новой вкладки;
- через 3 секунды включает `temporary`;
- только после этого возвращает результат.

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

### `chatgpt_web.ask`

Отправляет запрос и ждет финальный ответ.

Пример:

```json
{
  "chat": 1,
  "request": "Ответь одним словом."
}
```

Ответ:

```json
{
  "response": "Готово"
}
```

Если `chat` не передан, запрос уйдет в `defaultChat`.

### `chatgpt_web.ask_async`

Отправляет запрос, но возвращается сразу после того, как prompt реально отправлен в ChatGPT.

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
  "chat": 1
}
```

Пока ответ по чату не считан через `await_response`, повторный `ask` или `ask_async` в тот же чат вернет ошибку.

### `chatgpt_web.await_response`

Ждет финальный ответ по уже отправленному запросу.

Пример:

```json
{
  "chat": 1
}
```

Ответ:

```json
{
  "response": "Краткое резюме готово."
}
```

### `chatgpt_web.release_chat`

Закрывает чат и освобождает его номер.

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

Если по любому из выбранных чатов еще есть незавершенный запрос, сервер вернет ошибку.

### `chatgpt_web.session_info`

Возвращает `defaultChat` и список всех активных чатов пользователя.

Пример ответа:

```json
{
  "defaultChat": 2,
  "chats": [
    {
      "chat": 1,
      "state": "waiting_response",
      "temporary": true
    },
    {
      "chat": 2,
      "state": "ready",
      "temporary": false
    }
  ]
}
```

## Статусы чатов

Возможные состояния в `session_info`:

- `starting` — чат создается, вкладка еще не готова;
- `ready` — чат готов принимать запросы;
- `sending` — prompt еще отправляется;
- `waiting_response` — prompt уже отправлен, идет ожидание финального ответа.

Важно:

- в чат со статусом `starting` нельзя отправлять запрос;
- в чат со статусом `sending` или `waiting_response` нельзя отправлять второй запрос;
- после успешного `await_response` чат возвращается в `ready`.

## Синхронный и асинхронный сценарий

Синхронный:

1. `chatgpt_web.new_chat`
2. `chatgpt_web.ask`
3. `chatgpt_web.release_chat`

Асинхронный:

1. `chatgpt_web.new_chat`
2. `chatgpt_web.ask_async`
3. `chatgpt_web.await_response`
4. `chatgpt_web.release_chat`

## Параллельные чаты

`ask` и `ask_async` используют один и тот же scheduler отправки в расширении. Их смешивание между чатами подчиняется настройке `Parallel Chats`.

Режимы:

- `Allowed` — разные чаты могут отправляться сразу;
- `Sequential` — следующий чат отправляется только после подтвержденной отправки предыдущего prompt;
- `Sequential + safe timeout` — как `Sequential`, но перед следующим чатом добавляется случайная пауза `3-10 секунд`.

Ограничение действует только между разными чатами. Второй запрос в тот же чат сервер все равно отклонит, пока не завершен предыдущий цикл `ask` или `ask_async` + `await_response`.

## Типовые ошибки

### Повторный запрос в тот же чат

Причина:

- по чату уже есть незавершенный запрос;
- ответ еще не был считан через `await_response`.

### Запрос в чат, который еще не готов

Причина:

- чат находится в состоянии `starting`.

Практически это означает, что `new_chat` уже начал создавать вкладку, но чат еще не дошел до `ready`.

### `await_response` возвращает ошибку

Причина:

- по чату еще ничего не отправлялось;
- ответ уже был считан ранее;
- браузерный agent потерял соединение или ChatGPT не завершил генерацию успешно.

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
  arguments: { count: 2, temporary: false }
});

const firstChat = newChat.structuredContent.chats[0];

await client.callTool({
  name: "chatgpt_web.ask_async",
  arguments: {
    chat: firstChat,
    request: "Сделай краткое summary."
  }
});

const response = await client.callTool({
  name: "chatgpt_web.await_response",
  arguments: {
    chat: firstChat
  }
});

console.log(response.structuredContent.response);
```

Если нужна установка и подключение, вернитесь к [INSTALL.md](./INSTALL.md). Если нужен общий обзор приложения, используйте [README](../README.md).
