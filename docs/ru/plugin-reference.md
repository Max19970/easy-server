# Контракты Provider Plugin и эксплуатационная безопасность

**Язык:** [English](../plugin-reference.md) · Русский

Это подробный reference по поведению EasyServer Provider Plugin в линии совместимости `0.2.x`. Если вы пишете первого провайдера, начните с [Создания Provider Plugin](plugin-authoring.md).

Публичные TypeScript/runtime contracts предоставляются пакетом [`@easyai101/easyserver-plugin-sdk`](../../packages/plugin-sdk/README.md). Более общая политика совместимости описана в [Версионировании и совместимости](versioning-and-compatibility.md).

EasyServer нормализует только действительно общие для провайдеров понятия: стабильную identity сервера, небольшой lifecycle vocabulary и connectivity для caller. Специфичная для провайдера семантика marketplace/configuration/product остаётся внутри Provider Features.

## Package и manifest identity

Provider package обычно предоставляет default export `ProviderPlugin` и объявляет metadata для обнаружения TUI в `package.json`:

```json
{
  "easyserver": {
    "kind": "provider-plugin",
    "displayName": "Example Provider"
  }
}
```

Package metadata используется только для discovery. EasyServer может показать установленный package в **Add installed provider**, не импортируя executable runtime. Фактическая регистрация после выбора package всё равно проходит через обычный validation/import path.

Manifest plugin объявляет стабильную identity и compatibility:

```ts
{
  id: "example.provider-plugin",
  displayName: "Example Provider",
  version: "0.2.0",
  compatibility: {
    easyserver: "^0.2.0",
    pluginSdk: "^0.2.0",
  },
  provider: {
    id: "example",
    displayName: "Example Provider",
    capabilities: [],
  },
}
```

`manifest.provider.id` и `provider.providerId` должны совпадать. IDs — стабильная machine identity; display names — нет.

Plugins выполняются in-process с правами текущего пользователя OS. Contract validation не является sandbox для вредоносного кода. Установка/регистрация недоверенного plugin эквивалентна запуску недоверенного Node.js code от имени этого пользователя.

## Provider inventory и lifecycle

### Стабильная identity провайдера

Каждый provider snapshot использует `providerExternalId` как стабильную identity одного и того же remote resource между повторными reads. Не формируйте его из позиции в списке, display name, временного IP или изменяемой metadata.

EasyServer согласует эту provider identity со своей canonical identity `instance:<uuid>`.

### Граница удаления `getInstance()`

`ProviderAdapter.getInstance()` возвращает `undefined` только когда provider может авторитетно подтвердить, что запрошенный remote resource больше не существует.

Не возвращайте `undefined` при:

- authentication failure;
- rate limiting;
- provider outage;
- network/transport failure;
- timeout;
- eventual-consistency gap;
- неизвестном provider response.

В этих случаях операция должна завершаться соответствующей normalized failure. Неубедительные reads не должны молча удалять canonical identity EasyServer.

### Capabilities и available actions

Manifest capabilities указывают, какие классы normalized operations provider вообще реализует:

```text
instance.start
instance.stop
instance.restart
instance.destroy
```

Отдельный snapshot конкретного сервера объявляет `availableActions`, допустимые **прямо сейчас**. Решение принадлежит plugin, а `availableActions` должен быть подмножеством manifest capabilities.

Не выводите actions централизованно из normalized state. У разных провайдеров различаются transition rules и policy.

Сохраняйте raw state провайдера рядом с normalized state. Если провайдер вводит неизвестное значение, используйте normalized `unknown` и сохраняйте raw value вместо выдуманного mapping.

### Порядок обновления inventory

EasyServer сериализует полное inventory refresh/reconciliation одного и того же провайдера, чтобы более старое in-flight observation не могло закоммититься после более нового observation этого же провайдера. Разные провайдеры остаются независимыми.

Полный авторитетный refresh может удалить действительно отсутствующую binding. Частичное/неудачное observation нельзя считать доказательством отсутствия.

## Management intent и destructive ownership

Видимость у провайдера не означает destructive ownership.

Ресурс, который просто присутствует в provider inventory, имеет `management=discovered`, если не соответствует явному EasyServer acquisition/adoption intent. Provider snapshots не объявляют флаг EasyServer-managed.

Успешный acquisition через EasyServer записывает management intent для затронутых provider identities. Пользователь также может явно adopt уже обнаруженный canonical instance без его пересоздания.

EasyServer блокирует destructive `instance.destroy` для discovered resources, пока не существует host-owned management intent. Обратимые provider-declared actions по-прежнему определяются текущим snapshot.

## Provider Features и acquisition handoff

Provider-specific product concepts относятся к Provider Features, а не к EasyServer core.

Feature CLI command объявляет:

- стабильные command name/description;
- `operation: "read" | "mutation"`;
- необязательную host-owned risk metadata (`billable`, `destructive`) для mutations;
- необязательную declarative help metadata;
- executable `run(args, context)` logic, принадлежащую провайдеру.

Host монтирует команды по пути:

```text
easyserver provider <provider-id> <feature-id> <command> [args...]
```

EasyServer владеет confirmation policy для рискованных mutations. Plugin только правдиво классифицирует риск.

### CLI usage errors

Если provider-specific CLI arguments некорректны, выбрасывайте SDK `providerCliUsageError(message)`. Используйте его только для проблем command usage, а не для authentication/provider outages/remote API failures/mutation outcomes.

### Side-effect-free provider help

Package-based providers могут экспортировать `ProviderCliHelpContribution` из `./easyserver-help`:

```ts
import type { ProviderCliHelpContribution } from "@easyai101/easyserver-plugin-sdk";

export const easyserverCliHelp: ProviderCliHelpContribution = {
  pluginId: "example.provider-plugin",
  providerId: "example",
  displayName: "Example Provider",
  features: [
    {
      id: "marketplace",
      displayName: "Marketplace",
      commands: [
        {
          name: "rent",
          description: "Rent one provider offer",
          operation: "mutation",
          risks: ["billable"],
        },
      ],
    },
  ],
};
```

Экспортируйте его независимо от executable entry point:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./easyserver-help": "./dist/easyserver-help.js"
  }
}
```

Выполнение этого help-only module не должно разрешать credentials, читать secrets, обращаться к provider APIs, изменять EasyServer Local State или dispatch provider work. Help command objects декларативны; executable `run` functions на этой границе отклоняются.

### Acquisition handoff

Когда подтверждённая Provider Feature mutation создаёт/арендует/затрагивает compute, который должен попасть в общий inventory, верните стабильные provider identities:

```ts
return {
  refreshProviderInventory: true,
  affectedProviderExternalIds: [result.providerExternalId],
};
```

`affectedProviderExternalIds` намеренно узок. Не помещайте туда provider pricing, image, region, flavor или другую product schema.

Как только сама provider mutation успешно завершается, EasyServer считает её подтверждённой. Он записывает management intent для затронутых provider IDs и может обновить inventory, чтобы согласовать их с canonical EasyServer identities.

Mutation outcome и handoff outcome остаются раздельными:

- mutation неопределённа после dispatch → `outcome-unknown`;
- mutation подтверждена, refresh не удался → mutation остаётся успешной; handoff остаётся pending/failed;
- refresh успешен, но затронутый resource ещё не виден → partial handoff;
- более поздний inventory refresh может завершить reconciliation без повтора mutation.

Для нескольких затронутых resources сохраняйте порядок, возвращённый provider. Пустые/дублирующиеся IDs недопустимы.

## Cancellation, deadlines и uncertain mutations

Каждая потенциально блокирующая host-invoked provider, feature и connection-setup operation получает host-owned `AbortSignal`. Передавайте его в network/process work и по возможности останавливайтесь кооперативно.

Mutation context дополнительно предоставляет `markMutationDispatched()`.

Вызывайте этот marker идемпотентно **непосредственно перед** тем, как первый remote side-effecting request может быть отправлен, после credential resolution и local preflight. Read operations не должны его вызывать.

Host использует эту границу, чтобы различать:

- `cancelled` — read отменён или mutation гарантированно остановлена до dispatch;
- `timeout` — read/setup превысил deadline;
- `outcome-unknown` — mutation могла быть dispatch'нута, но финальный remote result нельзя считать достоверным.

Timeout/cancellation после dispatch не доказывает, что provider выполнил rollback. Потеря transport после dispatch не должна сообщаться как однозначный mutation failure, если provider не предоставляет доказательство.

Никогда не повторяйте вслепую `outcome-unknown` billable/destructive mutation. Согласуйте provider state или используйте настоящий provider idempotency mechanism, если он существует.

## Normalized errors

Используйте normalized EasyServer error category, когда свидетельства провайдера её обосновывают:

```text
authentication
not-found
unsupported-operation
conflict
rate-limited
provider-unavailable
cancelled
timeout
outcome-unknown
plugin-failure
host-trust-required
unknown-provider-error
```

Provider-specific HTTP/payload parsing остаётся внутри provider plugin.

При включении provider-originated detail в public error:

- проверяйте только bounded payloads;
- принимайте только явно распознанные shapes/fields;
- отдельно ограничивайте итоговое message;
- отклоняйте HTML, malformed payloads, secret-like data или отражённые configured credentials;
- не прикрепляйте raw response bodies/headers/secret-bearing causes для обычного rendering.

Стабильное generic message лучше утечки небезопасного provider response.

## Credentials и Secret References

По возможности объявляйте принадлежащие provider имена credentials в `manifest.credentials`:

```ts
credentials: [
  {
    name: "api-key",
    required: true,
    description: "Example Provider API key",
  },
]
```

EasyServer может проверять имена и сообщать readiness по настроенным **Secret References**, не разрешая значения.

Plugin разрешает именованный credential только внутри operation:

```ts
const apiKey = await context.resolveCredential("api-key");
```

Обычное state EasyServer никогда не должно содержать raw:

- API keys/tokens;
- passwords;
- private keys;
- bearer tokens.

Не помещайте secret material в manifests, instance snapshots, Access Methods, Local State, обычные logs/errors/Diagnostics или provider command arguments, если существует более безопасный credential channel.

## Access Methods, adapters и Endpoints

`getAccessMethods()` описывает, как EasyServer **может подключиться** к provider resource. Discovery должен оставаться secret-free.

Access Method может содержать routing metadata, opaque Secret References или provider-deferred credential IDs, но не сам разрешённый secret.

Пример:

```ts
{
  id: "ssh",
  kind: "ssh",
  mode: "tcp-forward",
  credentialSources: [
    { kind: "provider-deferred", id: "ssh-password" },
  ],
  ssh: {
    host: "203.0.113.42",
    port: 22,
    username: "root",
    passwordCredentialId: "ssh-password",
  },
}
```

Если провайдеру нужно получать short-lived credential только после выбора method, реализуйте `resolveAccessCredential()`.

Access Adapter превращает один поддерживаемый method kind в transport. Generic SSH принадлежит EasyServer; добавляйте custom adapter только для действительно provider-specific tunnel kind.

Method discovery для caller санитизируется. Credential sources и Secret References остаются внутри connection boundary.

Если method ID не запрошен, EasyServer детерминированно выбирает поддерживаемый method с лексикографически наименьшим стабильным ID. Явно запрошенный недоступный ID завершается ошибкой вместо молчаливого fallback.

Локальный Endpoint — отдельный runtime state:

```text
Provider Access Method → Access Adapter → 127.0.0.1:<local-port>
```

Provider identity не должна зависеть от этого local port.

## Cleanup Access Adapter

Connection setup создаёт cleanup scope до материализации credentials или child processes выбранного path.

Custom adapters должны регистрировать setup-owned resources через `context.registerCleanup()` сразу после их создания, включая temporary credential files, helpers, child processes и provider-specific tunnel resources.

Cleanup должен покрывать:

- setup failure до публикации local Endpoint;
- cancellation/deadline во время setup;
- failure публикации local listener;
- внезапное завершение channel/process;
- явное закрытие Session;
- shutdown daemon.

После публикации local Endpoint lifetime transport/channel принадлежит live Session. Setup deadline не должен случайно превращаться в жёсткий maximum lifetime уже опубликованного connection.

## SSH trust

Встроенный SSH path EasyServer использует системный OpenSSH client и собственный trust store.

First-use host trust всегда явный:

- EasyServer наблюдает preferred host key и предоставляет точные host/port/key type/SHA-256 fingerprint evidence;
- interactive callers могут просмотреть/подтвердить эти данные;
- перед enrollment approval повторно проверяет тот же preferred key;
- сохранённое background connection может предоставлять то же typed trust evidence для TUI approval/retry;
- JSON automation может подтвердить точное evidence через `host-trust approve`, а затем повторить исходный Session/intent;
- изменённый key уже доверенного host остаётся fail-closed authentication/trust mismatch.

Private identity/password material разрешается только после успешного host trust.

Не реализуйте provider-side shortcuts «trust on first use», обходящие host trust boundary.

## Lifecycle state — не billing state

Никогда не выводите provider billing semantics из normalized lifecycle state.

```text
stopped != not billed
```

Провайдеры могут взимать плату за зарезервированные GPU, disk, IP addresses или сам server даже когда compute остановлен. Pricing/billing/storage policy остаётся provider-owned, пока намеренно не добавлен доказанный cross-provider contract.

## Compatibility

Plugin независимо объявляет совместимость host и SDK:

```ts
compatibility: {
  easyserver: "^0.2.0",
  pluginSdk: "^0.2.0",
}
```

Для pre-1.0 версий `^0.2.0` намеренно принимает `0.2.x` и отклоняет `0.3.0`.

Используйте только package-root SDK exports. EasyServer source paths и package `dist/` deep imports не являются поддерживаемыми plugin APIs.

Расширяйте compatibility только после проверки на этой линии host/SDK.

## Семантика disable

Отключение настроенного plugin останавливает **новый admission** после linearization операции disable:

- новые provider operations не могут его получить;
- новые feature invocations не могут его получить;
- новый connection setup не может его получить.

Уже допущенная работа может завершиться, а уже опубликованный connection может продолжать drain до закрытия. Disable — это не физическая выгрузка JavaScript module.

Load/import plugin ограничен host deadline для асинхронного завершения, но EasyServer не способен прервать вредоносный/синхронно блокирующий in-process code.

## Проверка packaged plugin

Проверяйте package layout, который будут использовать пользователи:

```powershell
npm pack
npm install --global .\your-plugin-0.2.0.tgz
easyserver plugins add @example/easyserver-provider
easyserver plugins list
```

Plugin должен работать без наличия checkout с исходниками EasyServer.

Используйте SDK runtime validators и public seams вместо импорта host internals.

## Чеклист автора

Перед тем как считать provider пригодным к использованию:

1. Manifest и adapter проходят SDK validation.
2. Manifest provider ID и `providerId` совпадают.
3. Каждый `providerExternalId` стабилен на протяжении жизни remote resource.
4. Неизвестные provider states отображаются в normalized `unknown` с сохранением raw state.
5. `availableActions` — plugin-owned подмножество объявленных capabilities.
6. `getInstance()` возвращает `undefined` только при авторитетно подтверждённом отсутствии.
7. Блокирующая работа соблюдает host `AbortSignal`.
8. Mutation dispatch отмечается непосредственно перед первым side-effecting remote request.
9. Неопределённость после dispatch становится `outcome-unknown`, а не слепым retry.
10. Provider-specific acquisition/configuration остаётся в Provider Features.
11. Подтверждённый acquisition при необходимости возвращает стабильные affected provider IDs для handoff.
12. Credentials объявляются/разрешаются через boundary Secret Reference.
13. Access discovery не содержит resolved secrets.
14. Provider-deferred access credentials разрешаются только внутри connection setup.
15. Resources custom Access Adapter немедленно регистрируют cleanup.
16. First-use SSH trust остаётся явной host boundary EasyServer.
17. Disable останавливает новый admission, не изображая выгрузку уже допущенного code.
18. Packed plugin загружается без provider-specific branches или source/deep imports из EasyServer core.
