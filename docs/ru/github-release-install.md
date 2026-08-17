# Установка из GitHub Releases

**Язык:** [English](../github-release-install.md) · Русский

EasyServer публикует переносимый ZIP для Windows x64 вместе с npm-пакетами. Используйте его, если нужен версионированный каталог с ядром EasyServer без установки основного пакета в глобальный npm prefix.

ZIP — **не** автономный нативный исполняемый файл. В нём есть основная CLI и runtime-зависимости, но намеренно нет ни Node.js, ни Provider Plugins.

## Требования

Для EasyServer `0.2.1` нужны:

- Windows 11 x64;
- Node.js `24.18.1`, доступный как `node` в `PATH`;
- Windows OpenSSH Client при использовании подключений через SSH.

npm не нужен, чтобы просто запускать распакованное ядро. Он требуется только при добавлении распространяемых через npm Provider Plugins в этот распакованный prefix.

Актуальная граница поддержки платформ описана в разделе [Поддерживаемые платформы](supported-platforms.md).

## Скачайте файлы релиза

Из GitHub Release `v0.2.1` скачайте:

```text
easyserver-0.2.1-windows-x64.zip
easyserver-0.2.1-SHA256SUMS.txt
```

## Проверьте контрольную сумму

Выполните это в Windows PowerShell из каталога, где лежат оба скачанных файла:

```powershell
$expected = ((Get-Content .\easyserver-0.2.1-SHA256SUMS.txt) -split '\s+')[0]
$stream = [IO.File]::OpenRead((Resolve-Path .\easyserver-0.2.1-windows-x64.zip))
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $actual = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $stream.Dispose()
}
if ($actual -ne $expected) { throw 'EasyServer release checksum mismatch' }
```

Не продолжайте работу с артефактом, если его контрольная сумма не совпадает с опубликованным файлом.

## Распакуйте и запустите EasyServer

Выберите каталог для этой версии:

```powershell
$easyserver = Join-Path $PWD 'easyserver-0.2.1-windows-x64'
New-Item -ItemType Directory -Force $easyserver | Out-Null
Expand-Archive .\easyserver-0.2.1-windows-x64.zip -DestinationPath $easyserver -Force
```

Проверьте распакованную CLI:

```powershell
& "$easyserver\easyserver.cmd" --version
& "$easyserver\easyserver.cmd" plugins list
```

Свежий bundle `0.2.1` сообщает версию `0.2.1` и:

```text
No provider plugins configured.
```

Запустите TUI:

```powershell
& "$easyserver\easyserver.cmd"
```

Bundle можно хранить в любом удобном месте и запускать по пути либо добавить этот каталог в свой `PATH`.

## Добавьте Provider Plugin позже

Provider Plugins подключаются по желанию. Устанавливайте их в **тот же распакованный prefix EasyServer**, чтобы эта переносимая CLI могла их обнаружить.

Vast.ai:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-vastai@0.2.1
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-vastai
```

Intelion.cloud:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-intelion@0.2.1
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-intelion
```

После этого запустите переносимый TUI и настройте провайдера обычным способом.

Установка плагина в обычный глобальный npm prefix не добавляет его в отдельный переносимый каталог EasyServer. Аналогично, установка плагина в этот prefix изменяет только эту распакованную копию и не меняет исходный артефакт релиза.

## Обновление до более нового переносимого релиза

Считайте каждый версионированный ZIP отдельным каталогом установки:

1. Скачайте ZIP и контрольную сумму нового релиза.
2. Проверьте новую контрольную сумму.
3. Распакуйте в новый версионированный каталог.
4. Переустановите только нужные Provider Plugins в новый prefix.
5. Запустите новую версию и проверьте ожидаемое поведение настроенных провайдеров/состояния.

Не копируйте `node_modules` из старого bundle поверх нового.

Local State EasyServer и данные Secret Store обычно находятся вне bundle, в профиле пользователя, поэтому распаковка новой версии сама по себе их не сбрасывает. Документы [Жизненный цикл пакетов](package-lifecycle.md) и [Версионирование и совместимость](versioning-and-compatibility.md) определяют поддерживаемый контракт сохранения состояния.

## Что находится в ZIP

Переносимый артефакт содержит:

- `easyserver.cmd` и PowerShell launch shim;
- упакованные пакеты `@easyai101/easyserver` и `@easyai101/easyserver-plugin-sdk`;
- production runtime-зависимости CLI, включая квалифицированный Windows keyring binary;
- краткий README bundle и лицензию MIT.

В нём намеренно отсутствуют:

- Node.js;
- Provider Plugins Vast.ai или Intelion.cloud;
- исходные файлы репозитория, workspace symlinks и development dependencies;
- maintainer/private release state.
