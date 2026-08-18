# Плагин провайдера Vast.ai

First-party интеграция Vast.ai поддерживается и выпускается независимо от EasyServer.

- Репозиторий и документация провайдера: https://github.com/Max19970/easy-server-plugin-vastai
- npm-пакет: `@easyai101/easyserver-plugin-vastai`

Установите плагин в то же npm-окружение или portable prefix, что и EasyServer, затем добавьте его через **Settings & Support → Providers → Add installed provider** или командой:

```powershell
easyserver plugins add @easyai101/easyserver-plugin-vastai
```

При загрузке EasyServer проверяет объявленные плагином диапазоны совместимости с host и Plugin SDK. Версия пакета плагина не обязана совпадать с версией EasyServer.
