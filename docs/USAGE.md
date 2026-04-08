# Использование ChatGPT Web Bridge

Эта инструкция описывает текущий remote API: чаты адресуются простыми номерами `1`, `2`, `3`, новый чат по умолчанию создается как `temporary`, а `ask` и `ask_async` используют общий scheduler отправки в browser-agent.

Если сервер и расширение еще не настроены, начните с [инструкции по установке](./INSTALL.md). Обзор архитектуры и quick start находятся в [README](../README.md).

## Базовый сценарий

1. Вызовите `chatgpt_web.new_chat`
2. Сохраните номер чата
3. Вызовите `chatgpt_web.ask` или `chatgpt_web.ask_async`
4. Если использовали `ask_async`, затем вызовите `chatgpt_web.await_response`
5. Когда чат больше не нужен, вызовите `chatgpt_web.release_chat`

## Модель чатов

- каждый `user token` имеет собственное пространство чатов;
- чаты нумеруются как `1`, `2`, `3` и выдаются сервером;
- `new_chat` возвращает минимальный свободный номер;
- после `release_chat` номер снова становится доступным;
- если параметр `chat` не передан, используется `defaultChat` текущего MCP-сеанса;
- в одном чате одновременно разрешен только один незавершенный запрос.

## MCP tools

### `chatgpt_web.new_chat`

Создает новую вкладку `chatgpt.com`.

По умолчанию:

- сервер ждет готовности новой вкладки;
- через 3 секунды включает `temporary`;
- только после этого возвращает номер чата.

Пример:

```json
{}
```

Ответ:

```json
{
  "chat": 1
}
```

Обычный чат без `temporary`:

```json
{
  "temporary": false
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

Закрывает вкладку и освобождает номер чата.

Пример:

```json
{
  "chat": 1
}
```

Ответ:

```json
{
  "ok": true
}
```

Если по чату еще есть незавершенный запрос, сервер вернет ошибку.

### `chatgpt_web.session_info`

Возвращает `defaultChat` и список всех активных чатов пользователя.

Ответ:

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

Возможные состояния чата:

- `starting`
- `ready`
- `sending`
- `waiting_response`

## Синхронный и асинхронный режим

Синхронный вызов:

1. `chatgpt_web.new_chat`
2. `chatgpt_web.ask`
3. `chatgpt_web.release_chat`

Асинхронный вызов:

1. `chatgpt_web.new_chat`
2. `chatgpt_web.ask_async`
3. `chatgpt_web.await_response`
4. `chatgpt_web.release_chat`

`ask` и `ask_async` используют один и тот же scheduler отправки в расширении. Поэтому их смешивание между чатами подчиняется одной настройке `Parallel Chats`.

## Настройка `Parallel Chats`

В options page расширения есть режим отправки между чатами:

- `Allowed` — разные чаты могут отправляться сразу;
- `Sequential` — следующий чат отправляется только после подтвержденной отправки предыдущего prompt;
- `Sequential + safe timeout` — как `Sequential`, но перед следующим чатом добавляется случайная пауза `3-10 секунд`.

Значение по умолчанию: `Sequential + safe timeout`.

Ограничение действует только между разными чатами. Второй запрос в тот же чат сервер все равно отклонит, пока не завершен предыдущий цикл `ask` или `ask_async` + `await_response`.

## Частые ошибки

### Повторный запрос в тот же чат

Причина:

- по чату уже есть незавершенный запрос;
- ответ еще не был считан через `await_response`.

Что делать:

1. Дождаться `chatgpt_web.await_response`
2. Или использовать другой чат

### `await_response` возвращает ошибку

Причина:

- по чату еще ничего не отправлялось;
- ответ уже был считан ранее;
- браузерный agent потерял соединение или ChatGPT не завершил генерацию успешно.

### `new_chat` работает дольше обычного

Это ожидаемо, если:

- не передан параметр `temporary`;
- в расширении включен осторожный режим отправки;
- ChatGPT долго открывает новую вкладку.

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

await client.callTool({
  name: "chatgpt_web.ask_async",
  arguments: {
    chat,
    request: "Сделай краткое summary."
  }
});

const response = await client.callTool({
  name: "chatgpt_web.await_response",
  arguments: {
    chat
  }
});

console.log(response.structuredContent.response);
```

Если нужна только установка и подключение клиента, вернитесь к [INSTALL.md](./INSTALL.md). Если нужен общий обзор приложения, используйте [README](../README.md).
