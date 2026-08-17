# Машиночитаемый вывод CLI

**Язык:** [English](../cli-json.md) · Русский

По умолчанию EasyServer сохраняет CLI output, ориентированный на человека. Автоматизация может явно выбрать стабильный machine-readable contract, поместив принадлежащий host флаг `--json` **перед** командой:

```powershell
easyserver --json instances list
easyserver --json plugins list
easyserver --json sessions list
```

`--json` намеренно является префиксом, а не аргументом provider command. EasyServer обрабатывает его до dispatch команды, поэтому Provider Plugin по-прежнему может определять собственные provider-specific arguments, не опасаясь, что host перехватит аргумент с именем `--json` дальше в command line.

Одиночный `easyserver --json` — это command mode, а не TUI mode, и он завершается структурированной usage error, поскольку команда не была передана.

## Envelope version 1

Каждая успешная команда в JSON mode записывает ровно один компактный JSON document в stdout:

```json
{"schemaVersion":1,"ok":true,"data":{"version":"0.2.3"}}
```

Каждая terminal command error записывает ровно один компактный JSON document в stderr и оставляет stdout пустым:

```json
{"schemaVersion":1,"ok":false,"error":{"code":"not-found","message":"Compute Instance not found: instance:..."}}
```

Usage errors используют стабильный host code `usage-error` и включают `helpCommand`, когда EasyServer знает соответствующий contextual help path:

```json
{"schemaVersion":1,"ok":false,"error":{"code":"usage-error","message":"Unknown instances command: wat","helpCommand":"easyserver instances --help"}}
```

Неожиданные ненормализованные command failures используют `command-failed`. Нормализованные failures EasyServer/provider сохраняют свой публичный normalized error code, например `authentication`, `not-found`, `conflict`, `rate-limited`, `provider-unavailable`, `cancelled`, `timeout`, `outcome-unknown`, `plugin-failure`, `host-trust-required` или `unknown-provider-error`.

Raw internal `cause` normalized error не сериализуется в JSON error envelope. Автоматизация должна ветвиться по `error.code`, а не разбирать `error.message`.

Требование first-use SSH trust дополнительно раскрывает только публичное verification evidence, необходимое для явного решения:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "host-trust-required",
    "message": "SSH host trust is required for ssh.example.test:22",
    "hostTrust": {
      "target": { "host": "ssh.example.test", "port": 22 },
      "key": { "type": "ssh-ed25519", "fingerprint": "SHA256:..." }
    }
  }
}
```

`hostTrust.target` — точная SSH host/port identity, используемая выбранным Access Method. `hostTrust.key.type` вместе с SHA256 `fingerprint` идентифицируют наблюдаемый public host-key material, не раскрывая private credentials или raw SSH diagnostics.

## Данные команд

Внешний envelope единообразен; `data` остаётся command-specific, чтобы EasyServer не вводил одну универсальную модель с потерями для несвязанных понятий.

Распространённые core shapes:

- `plugins list` → `data.plugins`;
- `instances list` → `data.inventory`, включая состояние полноты/failure по каждому провайдеру. Каждая запись `data.inventory.instances[]` раскрывает стабильные поля recovery identity: canonical `id`, `providerId`, `providerExternalId`, `management` и `freshness`; `name` присутствует, когда provider передал normalized display name. Fresh entries дополнительно раскрывают текущие normalized `state`, `observedAt` и `availableActions`. Stale entries сохраняют только last-known normalized observation data и не имеют available actions; unobserved entries содержат только identity/management. Автоматизация, использующая provider-side ownership marker, должна требовать ровно одного **fresh** совпадения `providerId` + `name`. Stale/unobserved match или `data.inventory.complete: false` не являются авторитетным доказательством отсутствия ресурса;
- `instances inspect` → `data.instance`;
- одиночные lifecycle mutations → `data.action`, `data.instanceId`, `data.status` и любые host warnings;
- bulk lifecycle mutations → `data.result` плюс любые host warnings, с сохранением каждого per-target result и summary;
- `sessions list` → `data.sessions`;
- Endpoint-intent commands → `data.endpointIntents` или `data.endpointIntent`. Каждый persisted intent status раскрывает стабильные definition fields `name`, `enabled`, `instanceId`, `remoteHost` и `remotePort`, а также запрошенные `localPort` / `accessMethodId`, если они были указаны. `state` имеет одно из значений `starting`, `live`, `error` или `disabled`. Только `live` содержит пригодный к использованию `endpoint` (`host`, `port`) и выбранный `accessMethod` (`id`, `kind`, `mode`); `error` вместо этого содержит `failure.code` и `failure.message`. Когда `failure.code` равен `host-trust-required`, `failure.hostTrust` содержит то же структурированное target/key evidence, что и terminal error shape выше, поэтому автоматизация может подтвердить точный key и вызвать `sessions intents retry`, не разбирая prose. `starting` и `disabled` не содержат ни live endpoint, ни realization access method. `sessions intents remove` возвращает `data.endpointIntent` с удалённым `name` и `removed: true`. Автоматизация может находить intent по стабильному `name` и проверять `instanceId`, но должна считать реализованный localhost endpoint runtime state: если фиксированный `localPort` не был запрошен, он может измениться после restart daemon;
- provider-feature discovery → `data.features` или provider/feature command descriptors;
- daemon commands → `data.daemon`;
- `connect` → опубликованный `data.endpoint` и выбранный `data.accessMethod` после готовности foreground Endpoint.

В JSON mode есть один канал success: envelope с `ok: true` завершается status `0`, а terminal command failure с `ok: false` — ненулевым status. Degraded-but-successful state остаётся явно представленным в `data`, а не конфликтует с envelope через ненулевой exit code. Например, partial inventory сохраняет `data.inventory.complete: false` и failures по провайдерам; partial bulk results сохраняют каждый per-target result; daemon status сохраняет `stopped` или `stale` в `data.daemon.status`.

При запуске репозитория через npm development script npm может дописать собственные lifecycle diagnostics после неуспешной EasyServer command. Эти строки не являются частью JSON contract EasyServer. Установленный `easyserver` владеет только своим JSON document и process exit status.

## Provider-specific команды

Provider Plugins владеют семантикой provider-specific commands. Поэтому EasyServer не пытается разбирать произвольный provider text в вымышленные normalized fields.

В JSON mode выполненная provider command возвращает host-owned execution/handoff result плюс namespaced raw transcript:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "data": {
    "provider": {
      "providerId": "example",
      "featureId": "marketplace",
      "commandName": "search",
      "stdout": "provider-owned output\n",
      "stderr": ""
    },
    "execution": {
      "operation": "read",
      "mutationOutcome": "not-applicable",
      "handoff": {
        "status": "not-requested",
        "affectedProviderExternalIds": [],
        "canonicalInstances": [],
        "unresolvedProviderExternalIds": []
      }
    }
  }
}
```

Строки `provider.stdout` и `provider.stderr` — **raw command output, принадлежащий провайдеру**. Их содержимое не является стабильной EasyServer schema и может меняться вместе с Provider Plugin. Host-owned fields, такие как provider/feature/command identity и `execution`, сохраняют документированные правила совместимости EasyServer.

## Явное доверие SSH host для автоматизации

JSON mode никогда не выводит interactive confirmation/trust prompts в machine-readable stream. Если первое подключение завершается `error.code: "host-trust-required"`, автоматизация может показать или записать `error.hostTrust` для внешнего решения, а затем авторизовать ровно это evidence отдельным действием:

```powershell
easyserver --json host-trust approve `
  --host ssh.example.test `
  --port 22 `
  --key-type ssh-ed25519 `
  --fingerprint SHA256:...
```

Успех возвращает то же `data.hostTrust` evidence плюс `data.approved: true`. Сама approval command является явной authorization; у неё нет shortcut `--yes`, и EasyServer никогда автоматически не выполняет trust-on-first-use. Перед записью `known_hosts` EasyServer заново сканирует target, детерминированно выбирает тот же preferred host key, который использовался при first-use observation, и требует точного совпадения host, port, key type и fingerprint. Повторная approval того же всё ещё актуального key идемпотентна. Stale evidence, другой currently advertised non-preferred key или уже доверенный другой key отклоняются без замены trust.

После approval повторите исходный daemon-owned Session request или вызовите `sessions intents retry <name>` для Endpoint intent, чей structured `failure.hostTrust` сообщил то же first-use requirement. Изменённый key для host, который уже имеет trust, является `authentication` failure, а не новой возможностью first-use approval.

Другие операции, требующие явной non-interactive authorization, по-прежнему требуют своих существующих command inputs, например `--yes` для risky mutations.

Human CLI output остаётся неизменным, когда global prefix отсутствует:

```powershell
easyserver instances list
easyserver provider vastai marketplace search --gpu "RTX 4090"
```

Не разбирайте spacing, display text вида `key=value` или prose из human mode для автоматизации.

## Контракт совместимости

Для линии `0.2.x`:

- `schemaVersion` равен `1`;
- envelope fields `schemaVersion`, `ok`, `data` и `error` имеют значения, описанные выше;
- документированные core `data` fields и стабильные error codes являются частью публичного CLI compatibility contract;
- для `host-trust-required` поля `error.hostTrust` и Endpoint-intent `failure.hostTrust` используют стабильную shape `{ target: { host, port }, key: { type, fingerprint } }`; `host-trust approve` принимает эти четыре точных значения, а успешная approval возвращает ту же shape в `data.hostTrust` вместе с `data.approved: true`;
- patch releases могут добавлять fields, не меняя значение существующих, поэтому consumers должны игнорировать неизвестные fields;
- удаление, переименование или изменение назначения документированного field является compatibility-breaking change и требует более поздней pre-1.0 minor line согласно versioning policy EasyServer;
- содержимое provider-owned raw transcript находится за пределами core schema compatibility promise.

`easyserver doctor` остаётся privacy-safe support/diagnostic payload, описанным в документации поддержки. JSON command mode не превращает обычные raw logs или произвольный provider text в privacy-safe diagnostic bundle.
