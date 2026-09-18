## [0.14.3](https://github.com/semirov/tg-bot/compare/v0.14.2...v0.14.3) (2026-09-18)


### Bug Fixes

* **e2e:** валидный jest-e2e конфиг и mock axios (ESM) ([b34d7ef](https://github.com/semirov/tg-bot/commit/b34d7ef245c74f562f9568ec25c1a7036398d2ca))


### Performance Improvements

* **ci:** базовый образ зависимостей + fix(e2e) конфиг ([#39](https://github.com/semirov/tg-bot/issues/39)) ([65606ea](https://github.com/semirov/tg-bot/commit/65606ea5f3c6a6501fb0e9ebb1d6ee78ec875df7))
* **ci:** базовый образ зависимостей и сборка только кода ([4c7778c](https://github.com/semirov/tg-bot/commit/4c7778ce5d25383625819283ced82c770d9e55ce))

## [0.14.2](https://github.com/semirov/tg-bot/compare/v0.14.1...v0.14.2) (2026-09-18)


### Bug Fixes

* **ci:** askpass через DISPLAY для OpenSSH < 8.4 ([#38](https://github.com/semirov/tg-bot/issues/38)) ([70b7e2f](https://github.com/semirov/tg-bot/commit/70b7e2f436eab6c6a94ecf193fdce8e71252323e))
* **ci:** askpass через DISPLAY для OpenSSH < 8.4 в раннере ([f78ec90](https://github.com/semirov/tg-bot/commit/f78ec90f27cdd3c9441647afbdd06a0897cb45c1))

## [0.14.1](https://github.com/semirov/tg-bot/compare/v0.14.0...v0.14.1) (2026-09-18)


### Bug Fixes

* **ci:** writable DOCKER_CONFIG при деплое ([#37](https://github.com/semirov/tg-bot/issues/37)) ([1d6eed3](https://github.com/semirov/tg-bot/commit/1d6eed38f1e5bc488c97d3b182c2e98be0a9c0ef))
* **ci:** writable DOCKER_CONFIG при деплое (read-only /deploy-secrets) ([2615aca](https://github.com/semirov/tg-bot/commit/2615aca7c62883f94d0d4eca0d7e51d8ebc40575))

# [0.14.0](https://github.com/semirov/tg-bot/compare/v0.13.4...v0.14.0) (2026-09-18)


### Bug Fixes

* **build:** исключить test/ из сборки приложения ([e34425b](https://github.com/semirov/tg-bot/commit/e34425b85ac9af681595d3a706b0294d43fed9ce))
* **build:** исключить test/ из сборки приложения ([#35](https://github.com/semirov/tg-bot/issues/35)) ([0e0b1c9](https://github.com/semirov/tg-bot/commit/0e0b1c9edd3c021b74d5532f06f75841a3019751))
* **ci:** release-job на Node 22 ([#36](https://github.com/semirov/tg-bot/issues/36)) ([18aaeda](https://github.com/semirov/tg-bot/commit/18aaedac1b1dbc803a2975140a5b0bea6ce38470))
* **ci:** release-job на Node 22 (semantic-release требует >=22.14) ([547a3d0](https://github.com/semirov/tg-bot/commit/547a3d030bc2c45efc5acf2275bb85585f020758))


### Features

* **bot:** уведомление админу о старте с версией ([d06f104](https://github.com/semirov/tg-bot/commit/d06f104ba8950811a2db31d8fe0d0605206d48ea))
* **bot:** уведомление о старте + CI/CD и docker-тесты ([#34](https://github.com/semirov/tg-bot/issues/34)) ([457abe9](https://github.com/semirov/tg-bot/commit/457abe9c0c084e1acbbd7ce5882f0c41ae44b5e5))
