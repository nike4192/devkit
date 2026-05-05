# Backups Plugin

Управление бэкапами базы данных — список, скачивание, создание и накатка дампов.

## Команды

| Команда                              | Описание                                       |
|--------------------------------------|------------------------------------------------|
| `devkit backups ls`                  | Локальные дампы (скачанные и созданные)        |
| `devkit backups list --env <name>`   | Дампы на сервере (SSH или YaDisk)              |
| `devkit backups pull --env <name>`   | Скачать дамп с сервера                         |
| `devkit backups dump`                | Создать локальный дамп БД через docker exec    |
| `devkit backups load`                | Накатить дамп в локальный контейнер postgres   |

## Конфигурация

Project-overrides в `.devkit.d/backups.yml` мерджатся с дефолтами плагина:

```yaml
# .devkit.d/backups.yml
compose_file: docker-compose.dev.yml

yadisk:
  token_env: YADISK_TOKEN
  client_id_env: YADISK_CLIENT_ID
  folders:
    staging:    /backups/myapp/staging
    production: /backups/myapp/production

dump:
  info_script: /opt/get_dump_info.sh

servers:
  staging:
    ssh: deploy@staging.example.com
    projects_path: /opt/projects
    confirm: false
  production:
    ssh: deploy@prod.example.com
    projects_path: /opt/projects
    confirm: true                # ask before destructive ops
```

## Источники дампов (`--source`)

- `server` — скачивание через `scp` с удалённого хоста
- `yadisk` — скачивание через YaDisk API (требуется `YADISK_TOKEN`)
- `local`  — дампы, созданные через `devkit backups dump`

## Формат имён файлов

```
dump-{env}-{type}-{date}_{time}.sql.gz
```

Примеры:
```
dump-staging-inner-2026-04-03_14_30_00.sql.gz
dump-production-outer-2026-04-02_04_00_00.sql.gz
dump-local-inner-2026-04-03_15_00_00.sql.gz
```

## Примеры

```bash
# Локальные дампы
devkit backups ls

# Дампы на staging-сервере
devkit backups list --env staging

# Только из YaDisk
devkit backups list --env staging --source yadisk

# Скачать свежий дамп
devkit backups pull --env staging

# Создать дамп локальной БД
devkit backups dump

# Накатить свежий
devkit backups load

# Накатить конкретный файл
devkit backups load --src backups/dump-staging-inner-2026-04-03_14_30_00.sql.gz
```

## Переменные окружения

| Переменная        | Описание                                          |
|-------------------|---------------------------------------------------|
| `YADISK_TOKEN`    | OAuth-токен Яндекс.Диска (собирается через oauth provider в `devkit setup`) |
| `YADISK_CLIENT_ID`| OAuth Client ID Яндекс-приложения (для построения authorize URL) |
| `COMPOSE_FILE`    | Путь к docker-compose файлу (default `docker-compose.dev.yml`) |

`YADISK_TOKEN` объявлен в плагине как `provider: oauth` с manual flow по
умолчанию — `devkit setup` откроет authorize-страницу Яндекса, после
«Разрешить» Yandex покажет токен на своей `verification_code` странице,
ты копируешь и вставляешь в CLI.

Чтобы включить **auto-flow** (one-click без копи-пасте) — попроси владельца
OAuth-приложения зарегистрировать `http://localhost:<port>/callback`
в redirect URIs, затем добавь в `.devkit.d/backups.yml`:

```yaml
env_vars:
  YADISK_TOKEN:
    oauth:
      redirect_uri: http://localhost:53682/callback
```

## Зависимости

- Docker + docker-compose (для локального dump/load)
- SSH-доступ к серверам (для server-source)
- YaDisk API token (опционально, для yadisk-source)
