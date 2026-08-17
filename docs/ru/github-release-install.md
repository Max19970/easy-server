# Установка из GitHub Releases

**Язык:** [English](../github-release-install.md) · Русский

Начиная с EasyServer `0.2.2`, каждый release-qualified client target получает проверенный переносимый артефакт в GitHub Release. Этот способ подходит, если нужен версионированный каталог с ядром EasyServer без установки основного пакета в обычный глобальный npm prefix.

Переносимые артефакты — **не** автономные нативные исполняемые файлы. Они содержат EasyServer CLI и production runtime-зависимости, но намеренно не содержат ни Node.js, ни Provider Plugins.

## Требования

Используйте артефакт, соответствующий официально квалифицированному target:

| Платформа | Артефакт |
| --- | --- |
| Windows 11 x64 | `easyserver-<version>-windows-x64.zip` |
| Ubuntu 24.04 x64 | `easyserver-<version>-linux-x64.tar.gz` |
| macOS 15 arm64 | `easyserver-<version>-macos-arm64.tar.gz` |

Для каждой переносимой установки требуются:

- Node.js `24.18.1`, доступный как `node` в `PATH`;
- системный OpenSSH client при использовании подключений через SSH;
- npm `11.16.0` только если вы хотите добавить распространяемые через npm Provider Plugins в распакованный prefix.

Авторитетная граница поддержки платформ и Secret Store описана в документе [Поддерживаемые платформы](supported-platforms.md).

## Скачайте файлы релиза

Для релиза `v0.2.2` скачайте артефакт своей платформы и общий checksum manifest:

```text
easyserver-0.2.2-windows-x64.zip
easyserver-0.2.2-linux-x64.tar.gz
easyserver-0.2.2-macos-arm64.tar.gz
easyserver-0.2.2-SHA256SUMS.txt
```

Checksum manifest содержит по одной SHA-256 записи для каждого переносимого артефакта.

## Проверьте контрольную сумму

### Windows

Выполните это в Windows PowerShell из каталога, где лежат ZIP и checksum manifest:

```powershell
$artifact = 'easyserver-0.2.2-windows-x64.zip'
$line = Get-Content .\easyserver-0.2.2-SHA256SUMS.txt |
  Where-Object { $_ -match "  $([regex]::Escape($artifact))$" } |
  Select-Object -Single
if (-not $line) { throw 'EasyServer release checksum entry is missing' }
$expected = ($line -split '\s+')[0]
$stream = [IO.File]::OpenRead((Resolve-Path $artifact))
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $actual = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $stream.Dispose()
}
if ($actual -ne $expected) { throw 'EasyServer release checksum mismatch' }
```

### Ubuntu

```sh
artifact='easyserver-0.2.2-linux-x64.tar.gz'
grep "  $artifact$" easyserver-0.2.2-SHA256SUMS.txt | sha256sum --check -
```

### macOS

```sh
artifact='easyserver-0.2.2-macos-arm64.tar.gz'
expected=$(awk -v name="$artifact" '$2 == name { print $1 }' easyserver-0.2.2-SHA256SUMS.txt)
actual=$(shasum -a 256 "$artifact" | awk '{ print $1 }')
[ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo 'EasyServer release checksum mismatch' >&2; exit 1; }
```

Не продолжайте работу с артефактом, если его контрольная сумма не совпадает с опубликованным manifest.

## Распакуйте и запустите EasyServer

### Windows

```powershell
$easyserver = Join-Path $PWD 'easyserver-0.2.2-windows-x64'
New-Item -ItemType Directory -Force $easyserver | Out-Null
Expand-Archive .\easyserver-0.2.2-windows-x64.zip -DestinationPath $easyserver -Force
& "$easyserver\easyserver.cmd" --version
& "$easyserver\easyserver.cmd" plugins list
```

Запустите TUI:

```powershell
& "$easyserver\easyserver.cmd"
```

### Ubuntu

```sh
easyserver="$PWD/easyserver-0.2.2-linux-x64"
mkdir -p "$easyserver"
tar -xzf easyserver-0.2.2-linux-x64.tar.gz -C "$easyserver"
"$easyserver/bin/easyserver" --version
"$easyserver/bin/easyserver" plugins list
```

Запустите TUI:

```sh
"$easyserver/bin/easyserver"
```

### macOS

```sh
easyserver="$PWD/easyserver-0.2.2-macos-arm64"
mkdir -p "$easyserver"
tar -xzf easyserver-0.2.2-macos-arm64.tar.gz -C "$easyserver"
"$easyserver/bin/easyserver" --version
"$easyserver/bin/easyserver" plugins list
```

Запустите TUI:

```sh
"$easyserver/bin/easyserver"
```

Свежий bundle `0.2.2` на каждой платформе сообщает версию `0.2.2` и:

```text
No provider plugins configured.
```

Распакованный bundle можно хранить в любом удобном месте и запускать по пути либо добавить его каталог с launcher в свой `PATH`.

## Добавьте Provider Plugin позже

Provider Plugins подключаются по желанию. Устанавливайте их в **тот же распакованный prefix EasyServer**, чтобы эта переносимая CLI могла их обнаружить.

### Windows

Vast.ai:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-vastai@0.2.2
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-vastai
```

Intelion.cloud:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-intelion@0.2.2
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-intelion
```

### Ubuntu и macOS

Vast.ai:

```sh
npm install --global --prefix "$easyserver" @easyai101/easyserver-plugin-vastai@0.2.2
"$easyserver/bin/easyserver" plugins add @easyai101/easyserver-plugin-vastai
```

Intelion.cloud:

```sh
npm install --global --prefix "$easyserver" @easyai101/easyserver-plugin-intelion@0.2.2
"$easyserver/bin/easyserver" plugins add @easyai101/easyserver-plugin-intelion
```

После этого запустите переносимый TUI и настройте провайдера обычным способом.

Установка плагина в обычный глобальный npm prefix не добавляет его в отдельный переносимый каталог EasyServer. Аналогично, установка плагина в распакованный prefix изменяет только эту распакованную копию и не меняет исходный артефакт релиза.

## Обновление до более нового переносимого релиза

Считайте каждый версионированный артефакт отдельным каталогом установки:

1. Скачайте новый артефакт своей платформы и checksum manifest.
2. Проверьте контрольную сумму нового артефакта.
3. Распакуйте его в новый версионированный каталог.
4. Переустановите только нужные Provider Plugins в новый prefix.
5. Запустите новую версию и проверьте ожидаемое поведение настроенных провайдеров/состояния.

Не копируйте `node_modules` или `lib/node_modules` из старого bundle поверх нового.

Local State EasyServer и данные Secret Store обычно находятся вне bundle, в профиле пользователя, поэтому распаковка новой версии сама по себе их не сбрасывает. Документы [Жизненный цикл пакетов](package-lifecycle.md) и [Версионирование и совместимость](versioning-and-compatibility.md) определяют поддерживаемый контракт сохранения состояния.

## Что находится в переносимом артефакте

Каждый платформенный артефакт содержит:

- platform-native npm launcher (`easyserver.cmd` на Windows, `bin/easyserver` на Ubuntu/macOS);
- упакованные пакеты `@easyai101/easyserver` и `@easyai101/easyserver-plugin-sdk`;
- production runtime-зависимости CLI, включая квалифицированный keyring binary этой платформы;
- краткий README bundle и лицензию MIT.

В нём намеренно отсутствуют:

- Node.js;
- Provider Plugins Vast.ai или Intelion.cloud;
- исходные файлы репозитория, workspace symlinks и development dependencies;
- maintainer/private release state.

Исторические релизы остаются неизменяемыми: `v0.2.1` и более ранние версии сохраняют те assets, с которыми они были опубликованы. Кроссплатформенные portable-артефакты GitHub Release начинаются с `v0.2.2`.
