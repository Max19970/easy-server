# Модель безопасности EasyServer

**Язык:** [English](../security-model.md) · Русский

EasyServer управляет credentials провайдера, identity удалённых вычислительных ресурсов, SSH access, Local State и loopback TCP listeners. Этот документ описывает trust boundaries этих поверхностей для текущей линии `0.2.x`.

Для сообщения об уязвимостях используйте [SECURITY.ru.md](../../SECURITY.ru.md). Приведённые ниже platform-specific guarantees предполагают текущее квалифицированное client environment из [Поддерживаемых платформ](supported-platforms.md).

## Trust boundaries

```text
                          remote / untrusted input

 Provider API  <──── HTTPS ────>  Provider Plugin
      │                                  │
      │                                  │ trusted in-process extension
      ▼                                  ▼
 remote compute  <── provider / SSH ── EasyServer core
      │                                  │
      │                                  ├── OS Secret Store
      │                                  ├── Local State (no raw credentials)
      │                                  └── local daemon control channel
      │                                              │
      └──── remote TCP service ── connection path ───┴─> 127.0.0.1:<port>
                                                        local client process
```

EasyServer различает:

- remote/provider-controlled data;
- доверенный in-process code Provider Plugin;
- принадлежащие core Local State и credential references;
- границу локального OS user;
- локальные приложения, использующие loopback connections EasyServer.

Некоторые из этих границ являются validation/isolation boundaries; Provider Plugins — явно **trust** boundary, а не sandbox.

## Provider Plugins — доверенный код

EasyServer core и установленные Provider Plugins выполняются с правами текущего пользователя OS.

Plugin SDK проверяет документированные contracts и помогает изолировать обычные failures plugin, но in-process plugin всё равно может использовать стандартные возможности Node.js/OS, доступные этому пользователю. Поэтому вредоносный plugin способен выполнять действия за пределами контракта EasyServer.

Устанавливайте Provider Plugins только из источников, которым доверяете. Проверка compatibility не является проверкой authenticity или sandbox для вредоносного кода.

## Граница локального OS user

Для локальной конфиденциальности EasyServer опирается на границу пользователя операционной системы.

На поддерживаемом Windows path:

- долговременные credentials провайдера хранятся через Windows Credential Manager;
- временный SSH credential material ограничивается ACL текущего пользователя до записи secret bytes;
- EasyServer Local State и daemon/trust files по умолчанию находятся в profile пользователя.

Другой непривилегированный OS user находится за пределами предполагаемой trust boundary. Враждебный process, уже запущенный от имени **того же** OS user, находится внутри неё: такой process потенциально может читать пользовательские files/credential facilities и подключаться к loopback Endpoints EasyServer.

EasyServer не пытается sandbox'ить взаимно враждебные processes одного и того же вошедшего в систему пользователя.

## Credentials провайдера и Secret Store

Credentials провайдера импортируются в OS-backed Secret Store, а не сохраняются как обычные command arguments или plaintext Local State.

Пример:

```powershell
$env:VAST_API_KEY = '<value>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

EasyServer сохраняет в Local State opaque reference вида `secret:<uuid>`. Значение secret остаётся в OS Secret Store.

Provider operation contexts получают resolver только для настроенных имён credentials этого plugin, а не неограниченный доступ к Secret Store. Access setup может разрешать только credential references/sources, объявленные выбранным connection method.

Эти границы уменьшают риск случайной утечки secrets; они не превращают вредоносный Provider Plugin в недоверенный код, изолированный от пользователя.

## Secret-free access discovery

Provider описывает, как можно подключиться к серверу, не возвращая resolved private credentials в обычном discovery state.

SSH Access Method может содержать публичную routing metadata и opaque/provider-deferred credential identifiers. Private-key/password material разрешается только внутри setup выбранного connection.

Во встроенном SSH path EasyServer host trust устанавливается до разрешения private identity/password material. Provider-deferred server password Intelion аналогично запрашивается только после успешного host trust.

См. [Контракты Provider Plugin](plugin-reference.md#access-methods-adapters-и-endpoints) для extension contract.

## SSH host trust

EasyServer поддерживает собственный SSH trust store вместо использования окружающего пользовательского global `known_hosts` file.

Managed OpenSSH path запускается со strict host-key checking по known-host file EasyServer, с отключённым global host trust, отключённым host-key update и без host-IP substitution.

### Первое использование

Для неизвестного host EasyServer получает public host-key evidence и показывает точные:

- host;
- port;
- key type;
- SHA-256 fingerprint.

Interactive approval явный и fail-safe. Перед enrollment EasyServer повторно наблюдает текущий preferred key и записывает trust только если он всё ещё совпадает с проверенным evidence.

Обычно first-use evidence получается через `ssh-keyscan`. Если все scanners завершаются неудачно, но настроенный OpenSSH client всё ещё способен выполнить key exchange, EasyServer может использовать один bounded commandless handshake с отключёнными всеми authentication methods и изолированным временным `known_hosts` file. Этот temporary file используется только для observation и затем удаляется; сам по себе он никогда не становится permanent trust.

### Background и automation flows

Daemon connection setup остаётся неинтерактивным и никогда молча не доверяет неизвестному host. Решение о trust принимает caller, имеющий evidence:

- TUI может показать typed host-trust evidence сохранённого background connection, подтвердить его и повторить ту же definition;
- JSON automation получает `hostTrust` evidence и может вызвать `easyserver --json host-trust approve ...`, после чего повторяет исходный Session/saved definition.

См. [Подключения](connections.md#доверие-ssh-host-при-первом-использовании) и [Машиночитаемый вывод CLI](cli-json.md#явное-доверие-ssh-host-для-автоматизации).

### Изменение уже доверенных keys

Если уже доверенный host предъявляет другой key, EasyServer завершается fail-closed. Изменённый key не превращается в новый first-use prompt и никогда молча не заменяется.

Перед изменением существующей trust entry убедитесь, что сервер действительно был законно заменён/переустановлен.

## Временный SSH credential material

OpenSSH иногда требует credentials в файловой/helper форме. При необходимости EasyServer материализует временные private-key/password-helper данные в случайной per-setup директории внутри своей sessions area.

На Windows ACL hardening завершается до записи secret bytes. Secret contents не помещаются напрямую в argument list OpenSSH: private-key arguments содержат только путь к временному file, а password authentication использует helper, читающий защищённый material.

EasyServer хранит non-secret ownership metadata вне credential directory, которая удаляется рекурсивно. Ownership record содержит process identity, достаточно сильную для поддерживаемого Windows path, чтобы отличить всё ещё живой совпадающий process от reused PID.

Cleanup сначала помечает credential directory abandoned, затем рекурсивно удаляет secret material, затем удаляет ownership metadata. Последующий startup/setup scavenging удаляет только directories, для которых ownership/death можно доказать. Если process identity нельзя проверить, cleanup завершается fail-closed, оставляя directory на месте вместо риска гонки с live process.

Legacy temporary directories до `0.2.0` без надёжного ownership evidence автоматически не очищаются. Удаляйте такие остатки только когда точно остановлены старые processes EasyServer.

## Локальный daemon control channel

Daemon EasyServer владеет background Sessions и реализацией saved connections.

Его control API:

- слушает только `127.0.0.1` на динамически выделенном port;
- требует свежий случайный bearer token;
- проверяет tokens через constant-time comparison после проверки одинаковой длины;
- ограничивает request bodies;
- принимает только loopback descriptor addresses;
- при shutdown прерывает pending setup и очищает принадлежащие ему live Sessions.

Daemon descriptor отделён от обычного Local State и содержит local endpoint/token, необходимые для управления конкретным daemon instance.

Bearer token — **локальная capability**, а не encryption key. Control traffic — обычный HTTP поверх loopback. Same-user process, способный читать descriptor, уже находится внутри local-user trust boundary EasyServer.

Если вы переопределяете путь daemon descriptor, размещайте его там, где он недоступен для чтения пользователям вне предполагаемой OS-user boundary.

## Локальные Endpoints

Caller-facing TCP listeners EasyServer привязаны к IPv4 loopback:

```text
127.0.0.1:<port>
```

EasyServer не предоставляет option для bind этих Endpoints к `0.0.0.0`, LAN interface или public address.

У Endpoints нет отдельного client-authentication layer EasyServer. Любой local process, способный подключиться к этому loopback port, может отправлять через него traffic.

Используйте собственную authentication туннелируемого workload, если локальные applications/pages не должны иметь неограниченный доступ, и закрывайте EasyServer connection, когда он больше не нужен.

EasyServer пересылает raw TCP и не анализирует/не авторизует application-layer traffic.

## Local State и recovery

Local State содержит configuration и provider/resource identity, но не raw credentials.

Он может сохранять минимальное last-known normalized server observation, чтобы inventory оставался полезным при временной недоступности провайдера. Raw provider responses, raw secret material и provider error payloads не сохраняются как это observation.

Writes используют temporary files и atomic replacement с coordinated ownership/generation locking. EasyServer также поддерживает validated recovery generation. Если primary отсутствует/повреждён, но recovery generation валиден, состояние можно восстановить без ротации canonical identities или Secret References.

Если наличие предыдущего state очевидно, но ни primary, ни recovery не валидны, EasyServer завершается fail-closed вместо молчаливого сброса пользователя к пустой установке.

Local State **не зашифрован**. Считайте provider/resource names, IDs, plugin package specifiers и другую non-secret operational metadata видимыми текущему OS user. Callers, переопределяющие state path, сами отвечают за безопасность этой директории.

## Provider APIs и error data

First-party Provider Plugins помещают API credentials в request authorization headers, а не в URLs.

Provider/API responses — untrusted input. Когда provider-originated detail попадает в обычный EasyServer error, plugins должны принимать только распознанные/ограниченные fields и отклонять небезопасные/raw bodies вместо их rendering.

Mutations, которые могли дойти до provider без достоверного финального результата, сообщаются как `outcome-unknown`. EasyServer предлагает callers согласовать provider state вместо слепого повторения потенциально billable/destructive request.

См. [Контракты Provider Plugin](plugin-reference.md#normalized-errors).

## Diagnostics и публичные support data

Обычная поверхность Diagnostics EasyServer намеренно sanitised. Она сообщает ограниченную информацию о готовности product/runtime вместо raw logs, credentials, provider payloads или произвольных exception bodies.

Тем не менее перед публикацией Diagnostics payload в public issue просмотрите его, особенно если установлены third-party Provider Plugins.

См. [Поддержка и сопровождение](support-and-maintenance.md#использование-безопасной-для-публикации-diagnostics).

## Граница packages и extensions

Core CLI package не включает Provider Plugins. Провайдеры устанавливаются и добавляются явно.

Published package shape ограничивает содержимое поддерживаемой package surface, но установка/регистрация Provider Plugin всё равно импортирует и выполняет доверенный third-party code. Разделение packages — ecosystem/ownership boundary, а не process isolation.

## Явные non-goals и остаточные риски

Модель безопасности `0.2.x` **не** заявляет:

- sandboxing вредоносных Provider Plugins;
- изоляцию от враждебных processes, работающих от имени того же OS user;
- per-client authentication на локальных loopback Endpoints;
- application-layer TLS/authentication для туннелируемого workload;
- автоматическое удаление legacy temporary credential directories, если нельзя доказать отсутствие live owner;
- release-level client support вне платформ из [Поддерживаемых платформ](supported-platforms.md).

## Сообщение об уязвимостях

Следуйте [SECURITY.ru.md](../../SECURITY.ru.md). Не публикуйте предполагаемые уязвимости, secrets или private reproduction material в публичном GitHub issue.
