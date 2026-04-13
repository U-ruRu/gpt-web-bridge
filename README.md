# ChatGPT Web Bridge

`ChatGPT Web Bridge` поднимает remote MCP-сервер и связывает его с browser-agent в виде Firefox-расширения. MCP-клиенты подключаются к серверу по `Streamable HTTP`, а расширение подключается к тому же серверу по `WebSocket` и исполняет команды в `chatgpt.com` через отдельные вкладки.

## Что это такое

Текущая версия приложения:

- поднимает MCP endpoint на `/mcp`;
- принимает browser-agent на `/agent/ws`;
- связывает агент и MCP-клиентов по общему `user token`;
- адресует чаты простыми номерами `chat`;
- хранит сообщения и ответы на сервере по связке `user + chat + message`;
- поддерживает несколько чатов одного пользователя;
- управляет режимом отправки запросов между чатами через настройку `Parallel Chats`;
- работает через async-only MCP flow: `ask_async` -> `wait` -> `await_response` или `response_status`.

## Архитектура

```text
MCP client
    -> HTTP(S) /mcp
chatgpt-web-bridge server
    -> WebSocket /agent/ws
browser extension background
    -> dedicated ChatGPT tabs
chatgpt.com
```

Поддерживаются одинаковой логикой:

- полностью локальная схема через `localhost`;
- локальный сервер + tunnel/public URL для MCP-клиентов;
- внешний URL и для расширения, и для MCP-клиентов;
- сервер, агент и клиенты на разных устройствах.

## Документация

- [Установка](./docs/INSTALL.md)
- [Использование](./docs/USAGE.md)
- [System Prompt для клиента](./docs/system_prompt.md)

`README` — только обзор приложения.
Пошаговая установка, настройка расширения и подключение MCP-клиента вынесены в [INSTALL.md](./docs/INSTALL.md).
Рабочая модель, tool'ы, batch-операции, статусы чатов и примеры использования вынесены в [USAGE.md](./docs/USAGE.md).
Базовый `system prompt` для клиента, который использует `chatgpt_web.*`, вынесен в [system_prompt.md](./docs/system_prompt.md).

## Токены и изоляция

В системе используются два значения:

- `server access token` разрешает доступ к конкретному серверу;
- `user token` связывает extension и MCP-клиентов одного пользователя.

Изоляция работает так:

- один `user token` видит только своего browser-agent;
- чаты нумеруются как `1`, `2`, `3` и уникальны в рамках пользователя;
- каждый `ask_async` получает собственный номер `message` внутри чата;
- один чат не принимает второй активный запрос, пока предыдущее сообщение находится в `sending` или `pending`.

## Основной transport

Основной документированный сценарий для текущего приложения:

```powershell
npm run start:server
```

Для локальной отладки browser bridge отдельно остается:

- `npm run start:bridge`

## Будущие планы

- добавить поддержку OpenAPI для подключения к custom GPTs;
- добавить возможность закольцевать общение между двумя вкладками;
- добавить поддержку Chrome;
- добавить поддержку Linux-серверов.

## Разработка и проверка

```powershell
npm run build
npm run typecheck
npm test
```

Если вы впервые поднимаете проект, начните с [INSTALL.md](./docs/INSTALL.md). Если установка уже готова и нужно понять рабочий процесс, переходите к [USAGE.md](./docs/USAGE.md).
