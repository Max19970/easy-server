# Версионирование и совместимость

**Язык:** [English](../versioning-and-compatibility.md) · Русский

Пакеты EasyServer используют Semantic Versioning. Поскольку проект всё ещё находится до `1.0`, minor-версия определяет линию совместимости, а patch-релизы внутри этой линии несут более сильное обещание стабильности, чем требует чистый SemVer.

## Линии совместимости до 1.0

Для линии вида `0.2.x`:

- patch-релизы являются обратно совместимыми maintenance releases;
- patch-релиз не должен сознательно требовать изменений от существующих пользователей, скриптов, валидного Local State или совместимых Provider Plugins этой линии;
- breaking changes поддерживаемых публичных контрактов требуют как минимум следующей minor-линии (`0.3.0` после `0.2.x`);
- существенные новые контракты обычно ждут следующей minor-линии, тогда как небольшие аддитивные изменения могут выйти в patch-релизе, если смысл существующего поведения не меняется;
- новый `0.y.0` может содержать breaking changes, но release notes должны явно их перечислять и давать рекомендации по миграции, если от пользователей требуются действия.

Начиная с `1.0.0`, EasyServer будет следовать обычной стабильной модели SemVer: breaking changes требуют major-релиза, обратно совместимые features — minor-релиза, обратно совместимые fixes — patch-релиза.

## Поддерживаемые публичные контракты

Совместимость применяется только к тем поверхностям, которые проект намеренно документирует как публичные.

### Поведение CLI

Документированные имена команд, options/arguments, семантика success/failure и явно документированный machine-readable output являются публичными контрактами.

Ориентированный на человека текст, пробелы и представление не являются побайтовыми API, если другой документ явно не утверждает обратное.

Версионируемый контракт `--json` описан в [Машиночитаемом выводе CLI](cli-json.md).

### Provider Plugin SDK

Публичные exports из package root `@easyai101/easyserver-plugin-sdk` — поддерживаемый программный extension API.

Пути к source files, внутренние API EasyServer core и deep imports из `dist/` не являются поддерживаемыми plugin APIs.

См. [Создание Provider Plugin](plugin-authoring.md) и [Контракты Provider Plugin и эксплуатационная безопасность](plugin-reference.md).

### Manifests и contributions Provider Plugin

Документированные manifest fields, compatibility ranges, контракты Provider/Feature/Access Adapter и side-effect-free provider-help contribution являются частью plugin contract.

First-party plugins подчиняются тем же правилам совместимости, что и third-party plugins.

### EasyServer Local State

Более поздний patch-релиз той же линии совместимости должен продолжать принимать валидное state, созданное ранее в этой линии.

Поэтому изменения state на уровне patch должны быть аддитивными или прозрачно обратно совместимыми. Breaking state transition в будущей minor-линии требует явной миграции/безопасного перехода; молчаливое удаление пользовательского state не является стратегией миграции.

EasyServer `0.2.0` также принимает валидный Local State `0.1.x`.

См. [Жизненный цикл пакетов](package-lifecycle.md) для поведения при upgrade/reinstall/uninstall.

### Поведение first-party провайдеров

Публичные команды конкретных провайдеров и поведение интеграций с провайдерами, документированные для линии совместимости, покрываются тем же ожиданием patch-стабильности при условии, что upstream API/политики провайдера остаются работоспособными.

Provider-owned raw API shapes или недокументированное содержимое raw transcript не становятся частью совместимости EasyServer core только потому, что их можно наблюдать.

### Идентичность пакетов и модель установки

Документированные роли пакетов являются частью публичной модели распространения:

- `@easyai101/easyserver` — CLI/TUI product;
- `@easyai101/easyserver-plugin-sdk` — переиспользуемый публичный Provider Plugin API;
- first-party Provider Plugins — отдельно устанавливаемые opt-in packages.

`@easyai101/easyserver` не позиционируется как general-purpose программная библиотека. Plugin SDK — поддерживаемая переиспользуемая зависимость для provider extensions.

## Диапазоны совместимости Provider Plugin

Plugin линии `0.2.x` обычно объявляет совместимость и с host, и с SDK:

```ts
compatibility: {
  easyserver: "^0.2.0",
  pluginSdk: "^0.2.0",
}
```

Для pre-1.0 SemVer диапазон `^0.2.0` принимает совместимые релизы `0.2.x` и исключает `0.3.0`.

Package dependency ranges и runtime manifest ranges проверяются отдельно:

- npm dependency ranges управляют разрешением/установкой пакетов;
- manifest compatibility ranges проверяются EasyServer до допуска plugin.

Опубликованный plugin должен расширять любой из диапазонов только после проверки на новой принимаемой линии.

## Что по умолчанию не является стабильным

Если другой публичный документ явно не делает это контрактом, не полагайтесь на:

- пути source files монорепозитория или layout репозитория;
- private classes/helpers/registries;
- deep imports из package `dist/`;
- test fixtures/internal test utilities;
- точные формулировки human-facing diagnostics или форматирование debug logs;
- недокументированные provider-originated payload fields;
- maintainer release procedures или private development state.

Техническая доступность не равна статусу публичного API.

## Deprecation и release notes

До 1.0 разные minor-линии не обещают длительных deprecation windows, но устранимые breaking changes всё равно следует по возможности объявлять до удаления.

Release notes должны отмечать изменения, важные для совместимости, например:

- изменения CLI, влияющие на документированные scripts/workflows;
- изменения Plugin SDK/manifest;
- изменения compatibility ranges Provider Plugin;
- миграции Local State и последствия для совместимости;
- изменения package/distribution;
- изменения поддержки платформ/runtime;
- security fixes, существенно меняющие публичное поведение.

Если релиз не содержит изменений, влияющих на совместимость, release notes должны явно это сказать, а не оставлять статус неоднозначным.

Для снимков выпущенных пакетов/версий и migration notes используйте документы в разделе [История релизов](README.md#история-релизов), а не превращайте эту policy-page в changelog.
