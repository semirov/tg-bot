# [0.16.0](https://github.com/semirov/tg-bot/compare/v0.15.0...v0.16.0) (2026-09-19)


### Features

* **observatory:** парсер шлёт посты напрямую боту, без канала-коллектора ([#59](https://github.com/semirov/tg-bot/issues/59)) ([ab1a6d8](https://github.com/semirov/tg-bot/commit/ab1a6d806044f6eeadc43c91c49f5cfcbecfce6e))

# [0.15.0](https://github.com/semirov/tg-bot/compare/v0.14.5...v0.15.0) (2026-09-19)


### Features

* **observatory:** политика ссылок и атрибуция источника поста ([74d3479](https://github.com/semirov/tg-bot/commit/74d3479f8e306412d58db47cbd80661787abe297))
* **observatory:** политика ссылок и атрибуция источника поста ([#57](https://github.com/semirov/tg-bot/issues/57)) ([17f30a5](https://github.com/semirov/tg-bot/commit/17f30a5bccf81d6f8279ba32b2309d01195b9545))

## [0.14.5](https://github.com/semirov/tg-bot/compare/v0.14.4...v0.14.5) (2026-09-19)


### Bug Fixes

* **config:** секрет Mattermost + getNumber('') ([#55](https://github.com/semirov/tg-bot/issues/55)) ([333a30f](https://github.com/semirov/tg-bot/commit/333a30ff1b4efbfad082a1e329745dc96b6a6aaa))
* **config:** убрать захардкоженный Mattermost-секрет и починить getNumber('') ([4545a47](https://github.com/semirov/tg-bot/commit/4545a478f5b064f7d5147bafaf56a144cac4d8ab))

## [0.14.4](https://github.com/semirov/tg-bot/compare/v0.14.3...v0.14.4) (2026-09-18)


### Bug Fixes

* **ci:** release-job на хост-Node ([#41](https://github.com/semirov/tg-bot/issues/41)) ([a735797](https://github.com/semirov/tg-bot/commit/a735797bdfa4a8f5eb4c878b76eb3b7ff2bb3805))
* **ci:** release-job на хост-Node (bind-mount /home/filipp/dev не виден docker-демону из раннера) ([3d189e4](https://github.com/semirov/tg-bot/commit/3d189e48233f5d172cd3e0b654c0433efeb048f8))


### Performance Improvements

* **ci:** ускорить сборку и деплой ([4476dce](https://github.com/semirov/tg-bot/commit/4476dcefce715112bf59e32275622669178e844d))
* **ci:** ускорить сборку и деплой ([#40](https://github.com/semirov/tg-bot/issues/40)) ([85d329e](https://github.com/semirov/tg-bot/commit/85d329ea8807d5a80165b7bbd53a0ba89d407df3))

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
