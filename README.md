# ChatGPT Web Bridge

`ChatGPT Web Bridge` поднимает session-aware MCP-сервер и связывает его с браузерным agent'ом в виде Firefox-расширения. MCP-клиенты подключаются к серверу по `Streamable HTTP`, а расширение подключается к тому же серверу по `WebSocket` и исполняет команды в `chatgpt.com` через отдельные вкладки.

Основной сценарий текущей версии:

- пользователь запускает сервер локально или на отдельной машине;
- пользователь настраивает расширение с тем же `server access token` и `user token`;
- один `user token` связывает MCP-клиентов и browser-agent в общий namespace;
- каждая MCP-сессия получает собственные chat session'ы, поэтому параллельные запросы не смешиваются.

## Документация

- [Инструкция по установке](./docs/INSTALL.md)
- [Инструкция по использованию](./docs/USAGE.md)

## Что делает приложение

- поднимает MCP endpoint на `/mcp` через `Streamable HTTP`;
- принимает browser-agent на `/agent/ws`;
- связывает агент и MCP-клиентов по общему `user token`;
- изолирует chat session'ы по `sessionToken`;
- открывает новую вкладку ChatGPT на каждый `new_chat`;
- поддерживает несколько параллельных MCP-сессий одного пользователя;
- позволяет работать как через `localhost`, так и через tunnel/public URL.

## Архитектура

```text
MCP client
    -> HTTP(S) /mcp
chatgpt-web-bridge server
    -> WebSocket /agent/ws
browser extension background
    -> dedicated ChatGPT tab
chatgpt.com
```

Сервер не зависит от конкретной топологии. Поддерживаются одинаковой логикой:

- `server + extension + MCP client` на одной машине через `localhost`;
- сервер локально, extension на `localhost`, MCP-клиенты через Cloudflare Tunnel;
- и extension, и MCP-клиенты через внешний адрес сервера;
- сервер, агент и MCP-клиенты на разных устройствах.

## Быстрый старт

1. Установите зависимости и соберите проект:

```powershell
npm install
npm run build
```

2. Запустите сервер:

```powershell
npm run start:server -- --host=127.0.0.1 --port=8787 --server-access-token=replace-me
```

3. Загрузите расширение из папки `extension/` в Firefox и в его настройках укажите:

- `Server URL`: `http://127.0.0.1:8787`
- `Server Access Token`: тот же токен, что у сервера
- `User Token`: ваш общий пользовательский токен

4. Подключите MCP-клиент к `http://127.0.0.1:8787/mcp` и передавайте заголовки:

- `Authorization: Bearer replace-me`
- `x-chatgpt-web-bridge-user-token: <ваш user token>`

Полный пошаговый процесс описан в [инструкции по установке](./docs/INSTALL.md), отдельный блок по подключению MCP-клиента находится [здесь](./docs/INSTALL.md#7-подключить-mcp-клиент), а рабочий сценарий с tool'ами и сессиями описан в [инструкции по использованию](./docs/USAGE.md).

## MCP tools

Сервер регистрирует 5 инструментов:

- `chatgpt_web.new_chat`
- `chatgpt_web.ask`
- `chatgpt_web.set_temporary`
- `chatgpt_web.release_session`
- `chatgpt_web.session_info`

Коротко:

- `new_chat` создает новую вкладку и новую chat session;
- `ask` отправляет запрос в уже привязанную session;
- `set_temporary` переводит текущую session во временный режим;
- `session_info` возвращает состояние привязанной session;
- `release_session` освобождает session и закрывает вкладку.

Подробности и примеры есть в [инструкции по использованию](./docs/USAGE.md#mcp-tools).

## Токены и изоляция

В системе участвуют два разных токена:

- `server access token` подтверждает право подключаться к конкретному серверу;
- `user token` связывает extension и MCP-клиентов одного пользователя.

Изоляция работает так:

- один `user token` видит только своего browser-agent;
- одна MCP transport session владеет только своими `sessionToken`;
- две параллельные MCP-сессии одного пользователя не пишут в одни и те же вкладки, если не используют один и тот же `sessionToken`.

## Расширение и установка одним файлом

Текущая codebase уже умеет собирать unsigned `.xpi`:

```powershell
npm run build:addon:unsigned
```

Файл появится в `artifacts/unsigned-addon/`. Для Firefox stable unsigned addon подходит только для временной загрузки, а для dev-установки в отдельный профиль предусмотрен сценарий Waterfox. Подробные шаги вынесены в [инструкцию по установке](./docs/INSTALL.md#установка-расширения).

## Legacy-режимы

В репозитории все еще есть legacy-режимы:

- `npm run start:bridge`
- `npm run start:mcp`

Они нужны для обратной совместимости и локальной отладки. Основной документированный сценарий для текущего приложения теперь серверный: `npm run start:server`.

## Разработка и проверка

```powershell
npm run typecheck
npm test
```

Если вы впервые поднимаете проект, начните с [инструкции по установке](./docs/INSTALL.md). Если установка уже готова и нужно понять рабочий процесс, переходите к [инструкции по использованию](./docs/USAGE.md).
