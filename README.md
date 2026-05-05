# project-devkit

Plugin-based CLI toolkit for project infrastructure management.

`devkit` структурирует рутину многосервисного проекта: `.env`-файлы и секреты
(через Infisical), бэкапы БД, Docker-сети, утилиты для Directus и т.д.
Builtin-плагины + внешние RPC-плагины на любом языке.

## Установка

```bash
npm install -g project-devkit
```

## Быстрый старт

В корне твоего проекта:

```bash
devkit init       # создаст .devkit (манифест) и .devkit.d/ (project configs)
# отредактируй .devkit — оставь нужные плагины
devkit setup      # интерактивно соберёт env-переменные, создаст .env-файлы,
                  # подтянет секреты из Infisical, создаст Docker-сети
```

## Команды

```
devkit plugins                List available + enabled plugins
devkit init                   Create .devkit manifest + .devkit.d/
devkit setup [opts]           Full project setup
  --env-name <env>            Infisical environment (default: dev)
  --force                     Re-prompt / overwrite existing values
  --non-interactive           Fail on missing env vars instead of prompting
```

Команды плагинов появляются в `devkit --help` после редактирования `.devkit`.

## Структура проекта

```
your-project/
├── .devkit              # манифест: список включённых плагинов
├── .devkit.d/           # project-specific plugin configs
│   ├── env.yml
│   ├── docker.yml
│   └── backups.yml
├── .env                 # root .env (Infisical creds, OAuth токены и т.п.)
├── .env.example         # template, коммитится в репо
└── ...                  # твой код, docker-compose.yml, etc.
```

## Manifest `.devkit`

Plain text, по одному плагину на строку. `#` — комментарии.

```
# Builtin plugins
env
docker
backups
directus

# External RPC plugins (name=path к директории с plugin.json,
# относительный путь резолвится от project root):
my-plugin=./plugins/my-plugin
```

## Builtin плагины

| Plugin     | Что делает                                                         |
|------------|--------------------------------------------------------------------|
| `env`      | Управление `.env`-файлами + секреты из Infisical (Universal Auth)  |
| `docker`   | Создание external Docker-сетей из compose-файла                    |
| `backups`  | Список/скачивание/создание/накатка дампов БД (SCP, YaDisk, local)  |
| `directus` | Утилиты для проектов на Directus (snapshots, миграции и т.д.)      |

Подробности команд — в README конкретного плагина (`plugins/<name>/README.md`).

## `devkit setup` пошагово

1. **Required env vars** — сканирует декларации `env_vars:` всех включённых
   плагинов, находит отсутствующие/пустые в root `.env`, **спрашивает у тебя
   интерактивно**. Подсказка к каждой переменной показывает где взять токен,
   при необходимости открывает в браузере admin-страницу провайдера.
2. **env init** — копирует `.env.{variant}.example` → `.env.{variant}` для
   всех subprojects, подтягивает секреты из Infisical (если есть creds).
3. **Docker networks** — создаёт external networks, объявленные в compose.
4. **Directories** — создаёт необходимые папки (`uploads/` и т.п.).

После первого `setup` все нужные креды уже в `.env`, повторные запуски —
no-op (или используй `--force` для пересборки).

## Декларация env-переменных в плагине

Любой плагин может в своём `config.yml` (или проект — в
`.devkit.d/<plugin>.yml`, который мерджится с дефолтами) объявить нужные
env-переменные:

```yaml
env_vars:
  MY_API_TOKEN:
    description: Что эта переменная значит
    required: true              # default true
    secret: true                # mask input при наборе
    provider: prompt            # prompt | prompt-with-page | oauth
    hint: |
      Где это взять (admin URL, что нажимать, какие галочки).
    validate: ^[a-zA-Z0-9_-]+$  # опционально regex
    default: some-value         # опционально
```

`devkit setup` подхватит все декларации и спросит только то, чего нет в `.env`.

### Provider: `prompt`

Простой интерактивный input. Поддерживает `secret` (масочный), `default`,
`validate` (regex-строка).

### Provider: `prompt-with-page`

Открывает URL в браузере (где пользователь создаёт/копирует креды), потом prompt.

```yaml
env_vars:
  MY_API_TOKEN:
    description: API-token from admin panel
    secret: true
    provider: prompt-with-page
    open_url: "https://admin.example.com/api-tokens"
    hint: "Создай новый token, выбери права read-only, скопируй сюда."
```

### Provider: `oauth`

OAuth 2.0 implicit flow (`response_type=token`) с CSRF state.

**Manual flow (default)** — провайдер OAuth показывает токен на своей
странице, пользователь копи-пастит:

```yaml
env_vars:
  MY_OAUTH_TOKEN:
    description: OAuth access token
    secret: true
    provider: oauth
    oauth:
      authorize_url: https://oauth.provider.com/authorize
      response_type: token
      client_id_var: MY_CLIENT_ID         # имя env-var с client_id
      verification_url: https://oauth.provider.com/verification_code
      scope: read write                    # optional
```

**Auto flow** — поднимается localhost-listener, отдаёт HTML с JS-bridge,
который читает fragment URL (`#access_token=...`) и передаёт токен в CLI:

```yaml
env_vars:
  MY_OAUTH_TOKEN:
    provider: oauth
    oauth:
      authorize_url: https://oauth.provider.com/authorize
      response_type: token
      client_id_var: MY_CLIENT_ID
      redirect_uri: http://localhost:53682/callback   # ← включает auto flow
      timeout_seconds: 300                             # default 300
```

Auto flow требует, чтобы `redirect_uri` был **зарегистрирован в OAuth-app**
у провайдера (Yandex/Google/etc. не поддерживают wildcard-порты).

### Интерполяция в `open_url` и `hint`

- `{env:VAR}` — значение из `process.env` (загружается из `.env`, на свежем
  клоне fallback на `.env.example`)
- `{a.b.c}` — путь по объединённому config плагина (defaults + project overrides)

Пример:

```yaml
# plugins/env/config.yml — defaults
infisical:
  site_url: ~
  project_id: ~

env_vars:
  MY_TOKEN:
    open_url: "{infisical.site_url}/projects/{infisical.project_id}/admin"
```

```yaml
# .devkit.d/env.yml — project override
infisical:
  site_url: https://infisical.example.com
  project_id: 11111111-2222-3333-4444-555555555555
```

→ итоговый URL `https://infisical.example.com/projects/11111111.../admin`.

## Конфигурация плагина

Project-overrides в `.devkit.d/<plugin>.yml` deep-мерджатся с
`plugins/<plugin>/config.yml`. Пример для встроенного `env`:

```yaml
# .devkit.d/env.yml
infisical:
  site_url: https://infisical.example.com
  project_id: <your-infisical-project-id>

subprojects:
  myapp:
    path: .
    config_dir: config
    variants: [staging, production]
    infisical_path: "/{project}/{variant}"

servers:
  staging:
    ssh: deploy@staging.example.com
    projects_path: /opt/projects
    confirm: false
  production:
    ssh: deploy@prod.example.com
    projects_path: /opt/projects
    confirm: true
```

## Внешние RPC-плагины

Плагин на любом языке. В корне директории — `plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "executable": "python3",
  "args": ["plugin.py"],
  "commands": [
    {
      "name": "do-thing",
      "description": "Does the thing",
      "options": [
        { "long": "verbose", "description": "Verbose output", "type": "boolean" }
      ]
    }
  ]
}
```

Подключение в `.devkit`:
```
my-plugin=./plugins/my-plugin
```

Плагин запускается как subprocess, общается с devkit через JSON-RPC 2.0
по stdin/stdout. Project config из `.devkit.d/my-plugin.yml` приходит в
`params.config`. Команды видны в `devkit my-plugin --help`.

## Переменные окружения

Загружаются из `<projectRoot>/.env` (root проекта, найденного по `.devkit`)
автоматически перед загрузкой плагинов. Это значит ты можешь хранить
INFISICAL_*, YADISK_TOKEN и прочие токены в одном `.env` под git-ignore.

`.env.example` коммитится в репо как template. На свежем клоне `devkit setup`
интерактивно проводит через все обязательные переменные и записывает их
в `.env`.

## Лицензия

MIT.
