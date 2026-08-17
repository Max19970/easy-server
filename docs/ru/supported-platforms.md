# Поддерживаемые платформы

**Язык:** [English](../supported-platforms.md) · Русский

Матрица поддержки EasyServer `0.2.x` зависит от версии. **EasyServer 0.2.0 был квалифицирован только для Windows 11 x64. Начиная с 0.2.1, к Windows 11 x64 как release-qualified client targets добавляются Ubuntu 24.04 x64 и macOS 15 arm64.**

Граница поддержки намеренно точная: устанавливаемость на похожей ОС или архитектуре не считается эквивалентным свидетельством поддержки. Новые квалифицированные targets Ubuntu и macOS непрерывно проверяются в CI: установка пакетов, полный test gate, реальный round trip через OS Secret Store и реальные системные проверки OpenSSH/`ssh-keyscan`. Windows 11 x64 сохраняет ранее установленный контракт поддержки; его автоматизированный release gate непрерывно проверяет полный test suite, packaged install, release artifact, TUI surface и реальную OS keyring integration.

## Матрица поддержки

| Платформа | Архитектура | Квалифицированные релизы | Secret Store | Требование для SSH |
| --- | --- | --- | --- | --- |
| Windows 11 | x64 | `0.2.0+` | Windows Credential Manager через интеграцию EasyServer с OS keyring | Windows OpenSSH Client; `ssh` в `PATH` |
| Ubuntu 24.04 | x64 | `0.2.1+` | Linux Secret Service, если он доступен, с fallback на kernel keyutils | Системный OpenSSH client; `ssh` в `PATH` |
| macOS 15 | arm64 | `0.2.1+` | macOS Keychain через интеграцию EasyServer с OS keyring | Системный OpenSSH client; `ssh` в `PATH` |

Квалифицированный runtime для линии релизов `0.2.x`:

- Node.js `24.18.1`;
- npm `11.16.0` для установки через npm и установки пакетов Provider Plugin.

Опубликованный package engine range принимает Node.js начиная с `24.18.1` и до, но не включая, Node 25. При диагностике поведения, специфичного для релиза, сначала используйте указанный выше квалифицированный runtime, прежде чем считать другую версию Node эквивалентным свидетельством.

## Требование OpenSSH

Встроенный SSH connection path EasyServer использует системный OpenSSH client, а не встроенную реализацию SSH.

Проверьте client командой:

```text
ssh -V
```

Для обнаружения host key при первом подключении предпочтителен `ssh-keyscan`; он присутствует во всех трёх квалифицированных release environments. Например, в Windows PowerShell:

```powershell
Get-Command ssh-keyscan
```

В Ubuntu или macOS:

```sh
command -v ssh-keyscan
```

Если `ssh-keyscan` отсутствует или не может согласовать соединение с конкретным сервером, EasyServer может выполнить один ограниченный commandless `ssh` handshake с изолированным временным known-hosts file. Этот fallback получает только публичное свидетельство host key для проверки; постоянное доверие он не создаёт.

Если недоступен сам `ssh`, установите или включите OpenSSH client своей платформы и убедитесь, что executable доступен через `PATH`.

См. [Подключения](connections.md#доверие-ssh-host-при-первом-использовании) для описания trust flow.

## Требование к Secret Store

Credentials провайдера хранятся через Secret Store операционной системы, а не в обычном EasyServer Local State. Рабочий native keyring path является частью контракта поддержки: машина, на которой нельзя выполнить create/read/delete credential, не считается эквивалентной квалифицированному окружению, даже если JavaScript package успешно устанавливается.

Квалифицированные backends:

- **Windows 11 x64:** Windows Credential Manager;
- **macOS 15 arm64:** macOS Keychain;
- **Ubuntu 24.04 x64:** `@napi-rs/keyring` сначала пытается использовать D-Bus Secret Service, а если он недоступен — переходит на Linux kernel keyring через keyutils.

Ubuntu release gate выполняет реальный create/read/delete round trip через Secret Store на GitHub-hosted runner Ubuntu 24.04 x64. В headless-окружении Ubuntu 24.04 x64 процессу EasyServer должен быть доступен хотя бы один из этих Linux backends. Для Secret Service нужен доступный D-Bus Secret Service в пользовательской сессии; иначе должен работать fallback через kernel keyring/keyutils. Containers и WSL остаются отдельными неквалифицированными client environments, потому что их session, D-Bus и kernel-keyring поведение может отличаться от квалифицированного Ubuntu host.

См. [Модель безопасности](security-model.md#credentials-провайдера-и-secret-store) для описания trust boundary.

## Установка через npm

Основной package path на каждой квалифицированной платформе:

```text
npm install --global @easyai101/easyserver
```

Provider Plugins — отдельные opt-in packages, устанавливаемые в то же package environment. См. [Начало работы](getting-started.md).

## Portable GitHub Release ZIP

Portable GitHub Release ZIP остаётся дистрибутивом **только для Windows x64**:

```text
easyserver-<version>-windows-x64.zip
easyserver-<version>-SHA256SUMS.txt
```

ZIP содержит core CLI/runtime dependencies, но не Node.js и не Provider Plugins. Это не самостоятельный native executable. Пользователям Ubuntu и macOS следует использовать npm package path выше.

Следуйте [Установке из GitHub Releases](github-release-install.md) для проверки checksum, распаковки и prefix-aware установки плагинов на Windows.

## Что не поддерживается текущим контрактом `0.2.x`

Следующие client targets сейчас не квалифицированы на уровне релиза:

- Linux distributions или версии, отличные от Ubuntu 24.04 x64;
- версии или архитектуры macOS, отличные от macOS 15 arm64;
- Windows on ARM64;
- версии Windows, отличные от Windows 11;
- WSL и containers как отдельные контракты client platform;
- Node 25 и новее.

«Не поддерживается» не обязательно означает «заведомо несовместимо». Это означает, что проект сейчас не обещает поддержку этого окружения на уровне релиза.
