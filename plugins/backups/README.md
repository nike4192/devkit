# Backups Plugin

Управление бэкапами базы данных — список, скачивание, создание и накатка дампов.

## Команды

| Команда | Описание |
|---------|----------|
| `devkit backups ls` | Показать локальные дампы (скачанные и созданные) |
| `devkit backups list --env test` | Доступные дампы на сервере |
| `devkit backups pull --env test` | Скачать дамп с сервера |
| `devkit backups dump` | Создать локальный дамп БД |
| `devkit backups load` | Накатить дамп в локальный контейнер |

## Конфигурация

Плагин настраивается через `config.yml` внутри плагина и может быть переопределён в `devkit.yml` проекта:

```yaml
# devkit.yml
plugins:
  backups:
    yadisk:
      folders:
        test: /Projects/crosses/backups/test
        stage: /Projects/crosses/backups/stage
    
    servers:
      test:
        ssh: root@45.86.182.200
      stage:
        ssh: root@185.93.108.63
```

## Источники дампов

- **server** — скачивание через SCP с удалённого сервера
- **yadisk** — скачивание через YaDisk API (требуется `YADISK_TOKEN`)
- **local** — дампы, созданные через `devkit backups dump`

## Формат имён файлов

```
dump-{env}-{type}-{date}_{time}.sql.gz

Примеры:
  dump-test-inner-2026-04-03_14_30_00.sql.gz
  dump-stage-outer-2026-04-02_04_00_00.sql.gz
  dump-local-inner-2026-04-03_15_00_00.sql.gz
```

## Примеры использования

```bash
# Посмотреть локальные дампы
devkit backups ls

# Список дампов на тестовом сервере
devkit backups list --env test

# Список на stage, только с YaDisk
devkit backups list --env stage --source yadisk

# Скачать свежий дамп со stage
devkit backups pull --env stage

# Создать дамп локальной БД
devkit backups dump

# Накатить свежий дамп
devkit backups load

# Накатить конкретный файл
devkit backups load --src backups/dump-test-inner-2026-04-03_14_30_00.sql.gz
```

## Переменные окружения

| Переменная | Описание |
|-----------|----------|
| `YADISK_TOKEN` | Токен Яндекс.Диска для скачивания бэкапов |
| `COMPOSE_FILE` | Путь к docker-compose файлу (по умолчанию `docker-compose.dev.yml`) |

## Зависимости

- Docker + docker-compose
- SSH доступ к серверам (test/stage)
- YaDisk API (опционально, как fallback)
