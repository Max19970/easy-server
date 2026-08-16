# Поддерживаемые платформы

**Язык:** [English](../supported-platforms.md) · Русский

Для EasyServer `0.2.x` сейчас действует одно обещание поддержки клиентской платформы на уровне релиза: **Windows 11 x64**.

На других операционных системах отдельные части проекта могут работать, но сама по себе устанавливаемость не означает наличие поддержки. Linux и macOS остаются неквалифицированными, пока их package, Secret Store, terminal, provider и connection paths не будут проверены по тому же стандарту.

## Матрица поддержки

| Платформа | Архитектура | Статус | Secret Store | Требование для SSH |
| --- | --- | --- | --- | --- |
| Windows 11 | x64 | Поддерживается | Windows Credential Manager через интеграцию EasyServer с OS keyring | Windows OpenSSH Client; `ssh` в `PATH` |

Квалифицированный runtime для линии релизов `0.2.x`:

- Node.js `24.18.1`;
- npm `11.16.0` для установки через npm и установки пакетов Provider Plugin.

Опубликованный package engine range принимает Node.js начиная с `24.18.1` и до, но не включая, Node 25. При диагностике поведения, специфичного для релиза, прежде чем считать другую версию Node эквивалентным свидетельством, используйте указанный выше квалифицированный runtime.

## Windows OpenSSH

Встроенный SSH connection path EasyServer использует системный OpenSSH client, а не встроенную реализацию SSH.

Проверьте client командой:

```powershell
ssh -V
```

Для обнаружения host key при первом подключении предпочтителен `ssh-keyscan`, если он доступен:

```powershell
Get-Command ssh-keyscan
```

Если `ssh-keyscan` отсутствует или не может согласовать соединение с конкретным сервером, EasyServer может выполнить один ограниченный commandless `ssh` handshake с изолированным временным known-hosts file. Этот fallback получает только публичное свидетельство host key для проверки; постоянное доверие он не создаёт.

Если недоступен сам `ssh`, включите/установите Windows OpenSSH Client и убедитесь, что executable доступен через `PATH`.

См. [Подключения](connections.md#доверие-ssh-host-при-первом-использовании) для описания trust flow.

## Требование к Secret Store

Credentials провайдера хранятся через Secret Store операционной системы, а не в обычном EasyServer Local State.

На поддерживаемом Windows path EasyServer использует Windows Credential Manager через свою keyring integration. Рабочая native keyring integration является частью контракта поддержки; машина, на которой эта интеграция не работает, не считается эквивалентной квалифицированному окружению, даже если JavaScript package успешно устанавливается.

См. [Модель безопасности](security-model.md#credentials-провайдера-и-secret-store) для описания trust boundary.

## Установка через npm

Основной package path:

```powershell
npm install --global @easyai101/easyserver
```

Provider Plugins — отдельные opt-in packages, устанавливаемые в то же package environment. См. [Начало работы](getting-started.md).

## Portable GitHub Release ZIP

Windows-релизы также предоставляют:

```text
easyserver-<version>-windows-x64.zip
easyserver-<version>-SHA256SUMS.txt
```

ZIP содержит core CLI/runtime dependencies, но не Node.js и не Provider Plugins. Это не самостоятельный native executable.

Следуйте [Установке из GitHub Releases](github-release-install.md) для проверки checksum, распаковки и prefix-aware установки плагинов.

## Что не поддерживается текущим контрактом `0.2.x`

Следующие client targets сейчас не квалифицированы на уровне релиза:

- Linux distributions;
- macOS;
- Windows on ARM64;
- версии Windows, отличные от Windows 11;
- WSL/containers/headless environments как отдельные контракты client platform;
- Node 25 и новее.

«Не поддерживается» не обязательно означает «заведомо несовместимо». Это означает, что проект сейчас не обещает поддержку этого окружения на уровне релиза.

Квалификация Linux/macOS отслеживается отдельно в [GitHub issue #39](https://github.com/Max19970/easy-server/issues/39).
