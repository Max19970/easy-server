# Использование EasyServer с Intelion.cloud

**Язык:** [English](../../providers/intelion.md) · Русский

Плагин провайдера Intelion.cloud оставляет модель каталога/конфигурации серверов Intelion специфичной для провайдера, а затем предоставляет созданные серверы через общий жизненный цикл EasyServer и локальные сценарии подключения.

Это руководство описывает специфичные для Intelion подготовку аккаунта, поля конфигурации, учётные данные подключения и правила очистки.

## Подготовьте аккаунт Intelion.cloud

Вам нужны:

- аккаунт Intelion.cloud с разрешением/квотой на конфигурацию сервера, которую вы планируете создать;
- API token Intelion.

Зарегистрированные в Intelion публичные SSH-ключи — необязательные входные данные при создании ресурса на стороне провайдера. Они **не** являются учётными данными, которые обычный SSH-туннель EasyServer для Intelion использует в `0.2.x`.

Для SSH-доступа под управлением EasyServer плагин получает выданный провайдером пароль конкретного сервера через аутентифицированный API Intelion **после** успешной проверки доверия к SSH host. Настроенный API token авторизует этот запрос, но никогда не передаётся OpenSSH как сам SSH-пароль.

## Установите и добавьте плагин

Для глобальной npm-установки:

```powershell
npm install --global @easyai101/easyserver-plugin-intelion
easyserver
```

Затем откройте **Settings & Support → Providers → Add installed provider** и выберите **Intelion.cloud**.

Если вы используете переносимый ZIP из GitHub Release, установите плагин в этот распакованный prefix EasyServer. Следуйте разделу [Установка из GitHub Releases](../github-release-install.md#добавьте-provider-plugin-позже).

Для настройки через CLI/автоматизацию:

```powershell
easyserver plugins add @easyai101/easyserver-plugin-intelion
```

## Настройте API token

TUI показывает объявленные провайдером учётные данные `api-token` в меню **Actions** и сохраняет значение через Secret Store операционной системы, используемый EasyServer.

Для автоматизации импортируйте token через переменную окружения:

```powershell
$env:INTELION_API_TOKEN = '<your-api-token>'
easyserver plugins credential set @easyai101/easyserver-plugin-intelion api-token --env INTELION_API_TOKEN
Remove-Item Env:INTELION_API_TOKEN
```

Проверьте готовность:

```powershell
easyserver plugins list
```

До настройки провайдер сообщает `credentials=missing:api-token`; после — `credentials=ready`, не выводя token.

## Создайте сервер

В TUI выберите **Rent a server**, затем Intelion.cloud.

Configurator, которым владеет провайдер, проводит вас через доступные в Intelion варианты сервера, а не пытается втиснуть их в универсальную форму создания для всех провайдеров. Платное создание проходит через экран подтверждения EasyServer host.

### Изучите каталог через CLI

У каждой команды configurator есть собственная справка:

```powershell
easyserver provider intelion server-configurator flavors --help
easyserver provider intelion server-configurator os-images --help
easyserver provider intelion server-configurator ssh-keys --help
easyserver provider intelion server-configurator create --help
```

Список flavors:

```powershell
easyserver provider intelion server-configurator flavors
```

Список OS images:

```powershell
easyserver provider intelion server-configurator os-images
```

При необходимости отфильтруйте images по flavor:

```powershell
easyserver provider intelion server-configurator os-images --flavor <flavor-id>
```

Список записей публичных SSH-ключей, уже зарегистрированных в Intelion:

```powershell
easyserver provider intelion server-configurator ssh-keys
```

При проверке или создании сервера используйте ID, возвращённые каталогом провайдера.

### Проверка перед созданием

Configurator `0.2.x` требует:

```text
--name <name>
--flavor <id>
--disk <gb>
--os <id>
```

Необязательные поля:

```text
--price-plan <id>
--promocode <id>
--queue
--addon <id>       # repeatable
--ssh-key <id>     # repeatable
```

По текущему контракту плагина размер сетевого диска должен быть не меньше 30 GB.

Проверьте конфигурацию без создания платного сервера:

```powershell
easyserver provider intelion server-configurator validate `
  --name easyserver-demo `
  --flavor <flavor-id> `
  --disk 30 `
  --os <os-image-id>
```

### Создание через CLI

Используйте те же поля с `create`:

```powershell
easyserver provider intelion server-configurator create `
  --name easyserver-demo `
  --flavor <flavor-id> `
  --disk 30 `
  --os <os-image-id>
```

Интерактивный командный режим запрашивает подтверждение платной операции. Неинтерактивная автоматизация должна явно согласиться:

```powershell
easyserver provider intelion server-configurator create --yes `
  --name easyserver-demo `
  --flavor <flavor-id> `
  --disk 30 `
  --os <os-image-id>
```

Если EasyServer сообщает `outcome-unknown`, запрос создания уже мог дойти до Intelion. **Не** создавайте второй сервер вслепую; сначала согласуйте состояние с inventory:

```powershell
easyserver instances list
```

Переходы состояния у провайдера могут быть асинхронными, поэтому не считайте, что только что созданный сервер сразу готов ко всем действиям жизненного цикла или подключения.

## Управляйте сервером

После того как refresh провайдера увидит сервер, он появится в **Servers** и в общем CLI inventory:

```powershell
easyserver instances list
easyserver instances inspect <instance-id>
```

Используйте только те действия жизненного цикла, которые показывает текущий snapshot:

```powershell
easyserver instances start <instance-id>
easyserver instances stop <instance-id>
easyserver instances restart <instance-id>
easyserver instances destroy <instance-id>
```

Состояние жизненного цикла провайдера и состояние биллинга — разные вещи. Не считайте, что `stopped` означает отсутствие дальнейших начислений за ресурс Intelion.

## Подключение к сервису

Когда рабочая нагрузка слушает на сервере, выберите **Connect** у сервера в TUI и укажите порт приложения/сервиса рабочей нагрузки.

Пример CLI для удалённого порта `8188`:

```powershell
easyserver connect <instance-id> --port 8188
```

Пока подключение активно, EasyServer публикует локальный loopback-адрес, например `127.0.0.1:54321`.

### Поведение учётных данных подключения Intelion

При первом SSH-backed доступе EasyServer сначала получает/показывает fingerprint SSH host key сервера. Только после успешного подтверждения доверия к host плагин запрашивает пароль конкретного сервера через аутентифицированный API Intelion.

Поэтому ошибка получения/использования этого пароля отличается от ситуации «API token отсутствует или отклонён». EasyServer сохраняет эти уровни ошибок раздельными при восстановлении подключения.

Выданный провайдером SSH-пароль не выводится и не сохраняется как обычный EasyServer Local State.

Полная модель описана в разделе [Подключение к удалённому сервису](../connections.md), а доступ под управлением daemon — в разделе [Фоновые подключения](../background-connections.md).

## Очистка сервера

Когда платный ресурс больше не нужен:

1. Закройте ненужные foreground/background подключения EasyServer.
2. Уничтожьте сервер, если ваша цель — удалить cloud resource Intelion.
3. Обновите inventory и убедитесь, что состояние у провайдера сошлось к ожидаемому конечному/отсутствующему состоянию.
4. Только после этого при желании удалите или отключите локальную конфигурацию провайдера.

```powershell
easyserver instances destroy <instance-id>
easyserver instances list
```

Отключение плагина, удаление ссылки на API token, остановка daemon EasyServer или простое закрытие TUI **не** уничтожают сервер Intelion.
