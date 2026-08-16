# Использование EasyServer с Vast.ai

**Язык:** [English](../../providers/vastai.md) · Русский

Плагин провайдера Vast.ai оставляет поиск по marketplace и аренду внутри провайдера, а затем предоставляет арендованные машины через общий жизненный цикл серверов EasyServer и локальные сценарии подключения.

Это руководство описывает специфичные для Vast.ai подготовку аккаунта, параметры аренды, требования SSH и правила очистки.

## Подготовьте аккаунт Vast.ai

Вам нужны:

- аккаунт Vast.ai с возможностью арендовать instances;
- API key Vast.ai с правами, необходимыми для операций, которые вы планируете использовать;
- публичный SSH-ключ, зарегистрированный **на уровне аккаунта** до аренды SSH-backed instances, к которым EasyServer должен получать доступ.

Настройка SSH-ключа на уровне аккаунта — обычная разовая подготовка. После аренды не должно требоваться вручную прикреплять тот же ключ к каждой новой instance.

Соответствующий private key должен оставаться на вашем клиентском компьютере. SSH-маршрут Vast.ai в EasyServer рассчитывает, что системный клиент OpenSSH найдёт этот identity через стандартный identity file (например `~/.ssh/id_ed25519`) или `ssh-agent`.

Управляемый SSH-путь EasyServer не читает пользовательский `~/.ssh/config`, поэтому одного `IdentityFile`, настроенного только там, недостаточно.

Если вы меняете SSH-ключ аккаунта после того, как instance уже существует, для этой существующей instance может потребоваться обработка на стороне провайдера. Обычный сценарий EasyServer предполагает, что подготовка аккаунта выполняется до аренды.

## Установите и добавьте плагин

Для глобальной npm-установки:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai
easyserver
```

Затем откройте **Settings & Support → Providers → Add installed provider** и выберите **Vast.ai**.

Если вы используете переносимый ZIP из GitHub Release, установите плагин в этот распакованный prefix EasyServer. Следуйте разделу [Установка из GitHub Releases](../github-release-install.md#добавьте-provider-plugin-позже).

Для настройки через CLI/автоматизацию явно зарегистрируйте установленный пакет:

```powershell
easyserver plugins add @easyai101/easyserver-plugin-vastai
```

## Настройте API key

TUI показывает объявленные провайдером учётные данные `api-key` в меню **Actions** и сохраняет значение через Secret Store операционной системы, используемый EasyServer.

Для автоматизации импортируйте ключ из переменной окружения вместо передачи его в обычных аргументах команды:

```powershell
$env:VAST_API_KEY = '<your-api-key>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

Проверьте готовность:

```powershell
easyserver plugins list
```

До настройки провайдер сообщает `credentials=missing:api-key`; после — `credentials=ready`, не выводя секретное значение.

## Арендуйте сервер на marketplace

В TUI выберите **Rent a server**, затем Vast.ai.

Пошаговый marketplace-flow поддерживает:

- модель GPU;
- минимальное количество GPU;
- максимальную общую почасовую цену;
- минимальную reliability;
- только verified hosts;
- ограничение количества результатов.

**Choose GPU model** может загрузить актуальные названия доступных для аренды GPU, чтобы в обычной работе не приходилось помнить точное написание. Ручной ввод остаётся доступен, если live suggestions недоступны или в них нет нужной модели.

После выбора offer поток аренды показывает image, disk size, runtype и label. TUI использует `ubuntu:22.04` как практичный image по умолчанию; измените его, если вашей рабочей нагрузке нужен другой Docker/OCI image.

Любая платная аренда проходит через экран подтверждения, которым владеет EasyServer host.

### Поиск по marketplace через CLI

Текущий контракт команд можно посмотреть так:

```powershell
easyserver provider vastai marketplace search --help
easyserver provider vastai marketplace rent --help
```

Пример поиска:

```powershell
easyserver provider vastai marketplace search `
  --gpu 'RTX 4090' `
  --min-gpus 1 `
  --max-hourly 0.50 `
  --min-reliability 0.95 `
  --verified `
  --limit 10
```

Все эти фильтры специфичны для Vast.ai. `--min-reliability` принимает значение от `0` до `1`; `--max-hourly` — максимальная общая почасовая цена, которую принимает плагин.

### Аренда через CLI

Арендуйте offer, возвращённый marketplace Vast.ai:

```powershell
easyserver provider vastai marketplace rent <offer-id> `
  --image ubuntu:22.04 `
  --disk 40 `
  --runtype ssh `
  --label easyserver-demo
```

Поддерживаемые значения runtype в плагине `0.2.x` включают:

```text
ssh
jupyter
args
ssh_proxy
ssh_direct
jupyter_proxy
jupyter_direct
```

Интерактивный командный режим запрашивает подтверждение. Неинтерактивная автоматизация должна явно согласиться:

```powershell
easyserver provider vastai marketplace rent --yes <offer-id> --image ubuntu:22.04
```

Если EasyServer сообщает `outcome-unknown`, запрос мог дойти до Vast.ai, даже если финальный ответ был потерян. **Не** повторяйте платную аренду вслепую; сначала обновите inventory:

```powershell
easyserver instances list
```

## Управляйте арендованным сервером

После того как refresh провайдера увидит аренду, она появится в **Servers** и в общем CLI inventory:

```powershell
easyserver instances list
easyserver instances inspect <instance-id>
```

Используйте только те действия жизненного цикла, которые показывает текущий snapshot сервера. В зависимости от состояния провайдера это могут быть:

```powershell
easyserver instances start <instance-id>
easyserver instances stop <instance-id>
easyserver instances restart <instance-id>
easyserver instances destroy <instance-id>
```

Остановленная allocation Vast.ai всё ещё может иметь последствия для биллинга/ресурса. Считайте состояние провайдера и состояние биллинга разными понятиями.

## Подключение к сервису

Когда рабочая нагрузка слушает на арендованной машине, выберите **Connect** у сервера в TUI и укажите порт приложения/сервиса рабочей нагрузки.

Пример CLI для удалённого порта `8188`:

```powershell
easyserver connect <instance-id> --port 8188
```

Пока подключение активно, EasyServer публикует локальный loopback-адрес, например `127.0.0.1:54321`.

### Требование к SSH identity Vast.ai

Рабочий API key Vast.ai не доказывает, что SSH login identity доступен локально. Публичному ключу на уровне аккаунта должен соответствовать private key, который системный OpenSSH-клиент действительно может использовать из стандартного identity location или через `ssh-agent`.

При первом использовании EasyServer показывает точный fingerprint SSH host key маршрута провайдера и требует явного доверия. Хранилище доверия EasyServer отделено от fingerprint, принятого независимой командой `ssh`.

Если SSH работает, а порт приложения — нет, EasyServer отдельно сообщает об ошибке на уровне сервиса и позволяет изменить service port или повторить сохранённый запрос.

Полная модель описана в разделе [Подключение к удалённому сервису](../connections.md), а доступ под управлением daemon — в разделе [Фоновые подключения](../background-connections.md).

## Очистка аренды

Когда платный ресурс больше не нужен:

1. Закройте ненужные foreground/background подключения EasyServer.
2. Уничтожьте сервер, если ваша цель — освободить аренду Vast.ai.
3. Обновите inventory и убедитесь, что состояние у провайдера сошлось к ожидаемому конечному/отсутствующему состоянию.
4. Только после этого при желании удалите или отключите локальную конфигурацию провайдера.

```powershell
easyserver instances destroy <instance-id>
easyserver instances list
```

Отключение плагина, удаление ссылки на API key, остановка daemon EasyServer или простое закрытие TUI **не** уничтожают аренду Vast.ai.
