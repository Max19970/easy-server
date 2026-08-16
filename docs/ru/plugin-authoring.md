# Создание Provider Plugin

**Язык:** [English](../plugin-authoring.md) · Русский

Provider Plugins EasyServer добавляют специфичные для провайдера получение вычислительных ресурсов и inventory, переиспользуя общие границы lifecycle, credentials, safety и connections EasyServer.

Поддерживаемая переиспользуемая зависимость — [`@easyai101/easyserver-plugin-sdk`](../../packages/plugin-sdk/README.md). Не импортируйте source files EasyServer или deep paths из `dist/`.

Это руководство поможет загрузить небольшой plugin. Точные контракты identity, mutations, cancellation, credentials, access methods, custom transports, cleanup, trust и compatibility описаны в [Контрактах Provider Plugin и эксплуатационной безопасности](plugin-reference.md).

## Что может предоставлять plugin

Plugin может предоставлять три независимых extension surface:

```text
provider          normalized inventory, lifecycle, and access discovery
features[]        provider-specific product functionality
accessAdapters[]  provider-specific connection transports
```

Реализуйте только те surfaces, которые действительно нужны вашему провайдеру. Например, универсальный SSH transport уже встроен в EasyServer.

## Создание package

Минимальный package должен быть обычным npm package с SDK как runtime dependency:

```json
{
  "name": "@example/easyserver-provider",
  "version": "0.2.0",
  "type": "module",
  "main": "dist/index.js",
  "easyserver": {
    "kind": "provider-plugin",
    "displayName": "Example Provider"
  },
  "dependencies": {
    "@easyai101/easyserver-plugin-sdk": "^0.2.0"
  }
}
```

Package metadata `easyserver` позволяет TUI обнаружить установленного провайдера по понятному человеку имени, не импортируя provider runtime только ради заполнения picker.

В репозитории также есть небольшой scaffold в стиле стороннего плагина: [`examples/minimal-provider-plugin`](../../examples/minimal-provider-plugin).

## Экспорт `ProviderPlugin`

Default export плагина должен соответствовать публичному контракту `ProviderPlugin`:

```ts
import type {
  ProviderAdapter,
  ProviderOperationContext,
  ProviderPlugin,
} from "@easyai101/easyserver-plugin-sdk";

class ExampleProvider implements ProviderAdapter {
  readonly providerId = "example";

  async listInstances(context: ProviderOperationContext) {
    const apiKey = await context.resolveCredential("api-key");
    if (apiKey === undefined) {
      throw new Error("api-key is not configured");
    }

    // Fetch provider inventory and honor context.signal.
    return [];
  }

  async getInstance(_providerExternalId: string, _context: ProviderOperationContext) {
    return undefined;
  }
}

const plugin: ProviderPlugin = {
  manifest: {
    id: "example.provider-plugin",
    displayName: "Example Provider",
    version: "0.2.0",
    compatibility: {
      easyserver: "^0.2.0",
      pluginSdk: "^0.2.0",
    },
    credentials: [
      {
        name: "api-key",
        required: true,
        description: "Example Provider API key",
      },
    ],
    provider: {
      id: "example",
      displayName: "Example Provider",
      capabilities: [],
    },
  },
  provider: new ExampleProvider(),
};

export default plugin;
```

ID провайдера в manifest и `provider.providerId` должны совпадать. Считайте provider/plugin/resource IDs стабильной machine identity, а не display text.

## Консервативное моделирование inventory

EasyServer нормализует небольшой общий lifecycle vocabulary, но отображение состояния провайдера принадлежит plugin.

Важные правила:

- `providerExternalId` должен оставаться стабильным на всём протяжении жизни того же удалённого ресурса;
- сохраняйте raw state провайдера рядом с normalized state;
- неизвестные состояния провайдера отображайте в normalized `unknown`, не угадывая соответствие;
- `availableActions` принадлежит провайдеру и должен быть подмножеством объявленных capabilities;
- `getInstance()` возвращает `undefined` только когда провайдер авторитетно подтверждает, что ресурс больше не существует.

Authentication failures, rate limits, provider outages, transport failures или eventual-consistency gaps не являются авторитетным доказательством удаления.

## Сохраняйте product concepts провайдера в Provider Features

Не придумывайте универсальные Offer, flavor, image, price или provisioning request в EasyServer core.

Provider Features владеют product-specific функциональностью, например:

- поиск/аренда в marketplace Vast.ai;
- конфигурация/создание серверов Intelion.cloud;
- catalog, pricing, image, region или queue operations, уникальные для другого провайдера.

Feature command объявляет, является ли она read или mutation, а рискованные mutations могут правдиво объявлять риск `billable` или `destructive`. EasyServer владеет confirmation UI и non-interactive authorization policy.

Когда подтверждённая feature mutation создаёт или затрагивает compute, верните стабильные resource IDs провайдера в `affectedProviderExternalIds`, чтобы EasyServer мог согласовать их с canonical server identity, не обучая core product schema конкретного провайдера.

См. [Provider Features и acquisition handoff](plugin-reference.md#provider-features-и-acquisition-handoff).

## Объявляйте credentials; разрешайте их только при необходимости

Объявляйте принадлежащие plugin имена credentials в `manifest.credentials`, чтобы EasyServer мог проверить setup и показать readiness без чтения секрета.

Получайте настроенное значение через operation context:

```ts
const apiKey = await context.resolveCredential("api-key");
```

Никогда не помещайте raw API keys, passwords, private keys, bearer tokens или эквивалентные secrets в manifests, snapshots, access discovery, обычные errors или Local State.

См. [Credentials и Secret References](plugin-reference.md#credentials-и-secret-references).

## По возможности переиспользуйте connection transports EasyServer

Если к провайдеру можно подключиться через обычный SSH, верните secret-free SSH Access Method из provider и передайте transport встроенному adapter EasyServer.

Добавляйте `accessAdapters[]` только если провайдеру действительно нужен provider-specific tunnel kind.

Access discovery описывает, **как можно подключиться к серверу**. Итоговый локальный Endpoint `127.0.0.1:<port>` — runtime state, принадлежащий EasyServer, и он не является частью identity inventory провайдера.

См. [Access Methods, adapters и Endpoints](plugin-reference.md#access-methods-adapters-и-endpoints).

## Учитывайте cancellation и неопределённость mutations

Блокирующая provider/feature/access работа получает host-owned `AbortSignal`; передавайте его в network/process operations.

До того как первый удалённый side-effecting request сможет покинуть процесс, mutation должна вызвать `context.markMutationDispatched()`.

Это позволяет EasyServer различать:

- cancellation до dispatch;
- read/setup timeout;
- mutation, итоговый remote outcome которой после dispatch неизвестен.

Никогда не превращайте потерю transport после dispatch в однозначный failure, если provider не доказывает результат. Не повторяйте вслепую `outcome-unknown` операции с риском billable или destructive; вместо этого выполняйте observe/reconcile.

См. [Cancellation, deadlines и uncertain mutations](plugin-reference.md#cancellation-deadlines-и-uncertain-mutations).

## Добавьте side-effect-free CLI help

Package-based providers могут предоставлять declarative provider help через отдельный subpath `./easyserver-help`. Этот module должен оставаться side-effect-free: он не должен разрешать credentials, обращаться к provider APIs, изменять EasyServer state или выполнять provider commands.

Это позволяет пользователям просматривать:

```text
easyserver provider <provider-id> --help
easyserver provider <provider-id> <feature-id> --help
easyserver provider <provider-id> <feature-id> <command> --help
```

без импорта executable provider runtime только ради отображения help.

Точный контракт `ProviderCliHelpContribution` и пример export находятся в [Контрактах Provider Plugin и эксплуатационной безопасности](plugin-reference.md#provider-features-и-acquisition-handoff).

## Установка и тестирование packed plugin

Тестируйте artifact, который будут устанавливать пользователи:

```powershell
npm pack
npm install --global .\your-plugin-0.2.0.tgz
easyserver plugins add @example/easyserver-provider
easyserver plugins list
```

Plugin должен работать из installed package layout, в котором нет checkout с исходниками EasyServer.

Перед публикацией также проверьте:

- compatibility ranges соответствуют протестированным линиям host/SDK;
- malformed/unknown provider states обрабатываются консервативно;
- cancellation для read и mutation работает корректно;
- secrets не попадают в public state/errors;
- provider-specific behavior остаётся вне EasyServer core;
- временный transport material очищается на каждом exit path.

Перед тем как считать provider production-ready, используйте полный [чеклист автора](plugin-reference.md#чеклист-автора).
