# Changelog

## [1.3.0](https://github.com/Fotetsa/hullbay/compare/v1.2.4...v1.3.0) (2026-09-04)


### Features

* **api,web:** nœud database (Postgres/mysql/mongodb/redis) HA  v1 (expansion, rétention, rebuild) ([#112](https://github.com/Fotetsa/hullbay/issues/112)) ([b862cc8](https://github.com/Fotetsa/hullbay/commit/b862cc8c7ca54117073f8333938aa4f14b8ae7bb))
* **api:** remplacer image Patroni par custom GHCR (HA déployable) ([#133](https://github.com/Fotetsa/hullbay/issues/133)) ([5794b29](https://github.com/Fotetsa/hullbay/commit/5794b291138753ec7a1b3f7af6f61c8d938b2542))
* gestion des environnements dev/test/prod ([#126](https://github.com/Fotetsa/hullbay/issues/126)) ([2342edd](https://github.com/Fotetsa/hullbay/commit/2342edd328cb353ed5940e2e70d62a2192ee826e))
* multi cluster ([#77](https://github.com/Fotetsa/hullbay/issues/77)) ([f169c6f](https://github.com/Fotetsa/hullbay/commit/f169c6f9d07302a8a7b8cff36a75abb91be866df))
* pages clusters corrections des conflis ([4a54a91](https://github.com/Fotetsa/hullbay/commit/4a54a916e63b7aa1c7a956a5dbb3fbded393e1d3))
* **updates:** ajouter la mise à jour automatisée de hullbay ([#74](https://github.com/Fotetsa/hullbay/issues/74)) ([4333d9b](https://github.com/Fotetsa/hullbay/commit/4333d9ba3bad7338ec90393ee4f8d16b357ec787))
* **web:** add custom database icon to resolve visual confusion with volume and implement replicas design ([#134](https://github.com/Fotetsa/hullbay/issues/134)) ([a9d22ae](https://github.com/Fotetsa/hullbay/commit/a9d22ae8c60eb4c7c0dcedfd5307ac6760149516))
* **web:** add theme toggle ([#106](https://github.com/Fotetsa/hullbay/issues/106)) ([c3a8878](https://github.com/Fotetsa/hullbay/commit/c3a88780a2abf3c7e541b45cd1ea5ff8065ce798))
* **web:** la base arrive avec son reseau dedie sur le canvas ([#131](https://github.com/Fotetsa/hullbay/issues/131)) ([46f4569](https://github.com/Fotetsa/hullbay/commit/46f456995d3038b1952725550d298c4750bf27fa))


### Bug Fixes

* ameliore integrite des suppressions de cluster db et ui ([#121](https://github.com/Fotetsa/hullbay/issues/121)) ([458c106](https://github.com/Fotetsa/hullbay/commit/458c106dfa4bcd34ff426bd3c6ce34f88ad1fef1))
* **api,infra:** durcissement du provisioning multi-cluster ([#104](https://github.com/Fotetsa/hullbay/issues/104)) ([84b4ba3](https://github.com/Fotetsa/hullbay/commit/84b4ba381cf6d48fe6aa788083d1c1428bd81c1f))
* **api,web:** cluster reliability + i18n updates module ([#136](https://github.com/Fotetsa/hullbay/issues/136)) ([2c07e66](https://github.com/Fotetsa/hullbay/commit/2c07e6633c66fb1918e15b1e401f53ff14ca7319))
* **api,web:** corriger bugs recette (Caddy, pull timeout, clusterId, … ([#122](https://github.com/Fotetsa/hullbay/issues/122)) ([249d209](https://github.com/Fotetsa/hullbay/commit/249d20981091b8d7af25bf5189c9815fc7e3b2c9))
* **api:** corriger le tag d'image (préfixe v) et le pull des updates ([#135](https://github.com/Fotetsa/hullbay/issues/135)) ([5cc3216](https://github.com/Fotetsa/hullbay/commit/5cc3216cdd3049c24f4fb9fcfe8ecdefaf13ebfc))
* **api:** fiabiliser les clusters swarm multi-machines (SSH direct, Caddy) ([#110](https://github.com/Fotetsa/hullbay/issues/110)) ([c4a7b1c](https://github.com/Fotetsa/hullbay/commit/c4a7b1c21e473d4f3502e760d6fd80db51557320))
* **api:** resynchroniser la version deployee et trier les releases par date ([#128](https://github.com/Fotetsa/hullbay/issues/128)) ([d46f153](https://github.com/Fotetsa/hullbay/commit/d46f153d79feac1b156e271e2d6d13c29ab191ed))
* **api:** sortir PATRONI_RESTAPI_PASSWORD de l'env (config-secret + fichier) ([#113](https://github.com/Fotetsa/hullbay/issues/113)) ([300d164](https://github.com/Fotetsa/hullbay/commit/300d164d7d1b6d3fb3c9c144243839b2125ef77f))
* **cluster:** corriger la provision multi-cluster sur machines distantes ([#102](https://github.com/Fotetsa/hullbay/issues/102)) ([c8f6aa3](https://github.com/Fotetsa/hullbay/commit/c8f6aa311fe501a3b79f80be9e96cd3adb9c8781))
* feature/i18n setup ([#76](https://github.com/Fotetsa/hullbay/issues/76)) ([a573253](https://github.com/Fotetsa/hullbay/commit/a5732536e122ee56d54fba199b7f6411e3b804e5))
* parcourt boostrap jusqaua la config du domain ([#38](https://github.com/Fotetsa/hullbay/issues/38)) ([55df685](https://github.com/Fotetsa/hullbay/commit/55df685ad8f4b9a693af9194d5aa4bf2f22c2c40))
* **provisioning:** sécurisation de la création de cluster et garantir l'atomicité des états ([#87](https://github.com/Fotetsa/hullbay/issues/87)) ([cd382c1](https://github.com/Fotetsa/hullbay/commit/cd382c15030d27e62012a0b0fb6d584573c8c1cc))
* refactoriser le service de cluster et resoudre les conflits ([#109](https://github.com/Fotetsa/hullbay/issues/109)) ([1b538f3](https://github.com/Fotetsa/hullbay/commit/1b538f37319cd5fe9be9981b66806bbfa7806fd4))
* **settings:** corriger la route domaine, navigation et badge canal ([#86](https://github.com/Fotetsa/hullbay/issues/86)) ([4cbbca6](https://github.com/Fotetsa/hullbay/commit/4cbbca612b39474b16d00efceeb04b69951d21a2))
* **web:** corriger et compléter l'i18n (détection langue, sélecteur, nav, health) ([9f0e61c](https://github.com/Fotetsa/hullbay/commit/9f0e61c70e6c75c27fe1c16e95e8d828e06bcedc))

## [1.2.4](https://github.com/Fotetsa/hullbay/compare/v1.2.3...v1.2.4) (2026-08-08)


### Bug Fixes

* formatting and update build-beta.yml workflow ([#71](https://github.com/Fotetsa/hullbay/issues/71)) ([bfd77f1](https://github.com/Fotetsa/hullbay/commit/bfd77f19e40a1498be45e488df2faac019285d64))
* update release workflow to include build images ([#68](https://github.com/Fotetsa/hullbay/issues/68)) ([1e8e0c1](https://github.com/Fotetsa/hullbay/commit/1e8e0c1830b16620f79356dfc80dbbec893de9f0))

## [1.2.3](https://github.com/Fotetsa/hullbay/compare/v1.2.2...v1.2.3) (2026-08-08)


### Bug Fixes

* add build-beta workflow for Docker images ([#63](https://github.com/Fotetsa/hullbay/issues/63)) ([b400f8e](https://github.com/Fotetsa/hullbay/commit/b400f8ecea4037101d2052487bace5f2c382b9d9))
* cache-to line in build-beta.yml ([#66](https://github.com/Fotetsa/hullbay/issues/66)) ([e20fd61](https://github.com/Fotetsa/hullbay/commit/e20fd6140a4248e19b443982b2495d4f4b0305cc))
* fix Dockerfile syntax for npm install and build ([#61](https://github.com/Fotetsa/hullbay/issues/61)) ([510bb5d](https://github.com/Fotetsa/hullbay/commit/510bb5de1ede35bda08af621961c123fb4295bd5))
* stabiliser les statuts conteneurs du canvas (anti-flapping) ([#62](https://github.com/Fotetsa/hullbay/issues/62)) ([20fb024](https://github.com/Fotetsa/hullbay/commit/20fb024421dc8c7b78c6b240887cc5f9fda10978))

## [1.2.2](https://github.com/Fotetsa/hullbay/compare/v1.2.1...v1.2.2) (2026-08-07)


### Bug Fixes

* Update GitHub Actions workflow for releases and builds ([#59](https://github.com/Fotetsa/hullbay/issues/59)) ([8db0ac1](https://github.com/Fotetsa/hullbay/commit/8db0ac1f119cc76b6971d5fe1a7703ba2a732bb7))

## [1.2.1](https://github.com/Fotetsa/hullbay/compare/v1.2.0...v1.2.1) (2026-08-07)


### Bug Fixes

* Update release-publish.yml ([#57](https://github.com/Fotetsa/hullbay/issues/57)) ([1d97878](https://github.com/Fotetsa/hullbay/commit/1d9787874b4d1070457aaaab7f4af9c0d986db98))

## [1.2.0](https://github.com/Fotetsa/hullbay/compare/v1.1.0...v1.2.0) (2026-08-07)


### Features

* Add commitlint workflow for pull request validation ([#53](https://github.com/Fotetsa/hullbay/issues/53)) ([b2363f7](https://github.com/Fotetsa/hullbay/commit/b2363f7d2af992cd4f6189cdd2e50576aec6b223))
* **ops-panel:** volumes emboîtés cliquables, nettoyage volumes orphelins, drill-down santé robuste, activité flottante ([40f964f](https://github.com/Fotetsa/hullbay/commit/40f964f6bbf394f5f43f48292db7f52494f94e32))
* **web:** console de prod complète + refonte UX/accessibilité ([330664a](https://github.com/Fotetsa/hullbay/commit/330664a8a544ec8799a11f915681f9a5d2fe6233))


### Bug Fixes

* 18: mfa maintenant obligatoire coté ui lors de la connection et … ([#24](https://github.com/Fotetsa/hullbay/issues/24)) ([5f3c3a1](https://github.com/Fotetsa/hullbay/commit/5f3c3a15ecac6670b47b20ca0cf9ab2d0b6716a6))
* 2: Augmenter la durée des toasts d'erreur de déploiement ([ddf97e2](https://github.com/Fotetsa/hullbay/commit/ddf97e254f5bb0b4c4c6bffaa2c609bf7ddac36b))
* 3: correction et mise en place de l'autocompletion pour l'insertion des secret et registre ([#11](https://github.com/Fotetsa/hullbay/issues/11)) ([79094f8](https://github.com/Fotetsa/hullbay/commit/79094f8ac9bd73561c5f41b05c5496352f3e6345))
* add script to build the initial shared/  state ([#22](https://github.com/Fotetsa/hullbay/issues/22)) ([9a11d34](https://github.com/Fotetsa/hullbay/commit/9a11d34e0cd4732822188e3f5d72d4ee439e920d))
* automatiser le versioning des images GHCR (latest, semver, sha) ([#15](https://github.com/Fotetsa/hullbay/issues/15)) ([065c186](https://github.com/Fotetsa/hullbay/commit/065c1862adda8201c27d46afb8526636417bfa17))
* caddy file ([#35](https://github.com/Fotetsa/hullbay/issues/35)) ([15ed4fa](https://github.com/Fotetsa/hullbay/commit/15ed4fa5d572621b09fd5a462abdf83230202812))
* change github owner ([#13](https://github.com/Fotetsa/hullbay/issues/13)) ([2b85b45](https://github.com/Fotetsa/hullbay/commit/2b85b45a85bd161f764e3c84f90b1f1a34b76d22))
* complete build, test, and functional fixes ([94a8f13](https://github.com/Fotetsa/hullbay/commit/94a8f13d064e60530a8894d4a78f07df3a04588d))
* persister l'état déployé pour vider le badge "à déployer" et allumer réseaux/volumes/passerelles ([c6ce57b](https://github.com/Fotetsa/hullbay/commit/c6ce57bc034c2893c285509556148b5cab62a565))
* trigger CI on PRs targeting master ([#12](https://github.com/Fotetsa/hullbay/issues/12)) ([d5eb11d](https://github.com/Fotetsa/hullbay/commit/d5eb11d0b607f571864519747728d6ba3721b26f))
* **web:** modales lisibles (formulaire centré, largeur contrainte) ([9bfe0f8](https://github.com/Fotetsa/hullbay/commit/9bfe0f8e92c6efefbe114d998682cf2531c65651))

## [1.1.0](https://github.com/Fotetsa/hullbay/compare/hullbay-v1.0.0...hullbay-v1.1.0) (2026-08-07)


### Features

* **ops-panel:** volumes emboîtés cliquables, nettoyage volumes orphelins, drill-down santé robuste, activité flottante ([40f964f](https://github.com/Fotetsa/hullbay/commit/40f964f6bbf394f5f43f48292db7f52494f94e32))
* **web:** console de prod complète + refonte UX/accessibilité ([330664a](https://github.com/Fotetsa/hullbay/commit/330664a8a544ec8799a11f915681f9a5d2fe6233))


### Bug Fixes

* 18: mfa maintenant obligatoire coté ui lors de la connection et … ([#24](https://github.com/Fotetsa/hullbay/issues/24)) ([5f3c3a1](https://github.com/Fotetsa/hullbay/commit/5f3c3a15ecac6670b47b20ca0cf9ab2d0b6716a6))
* 2: Augmenter la durée des toasts d'erreur de déploiement ([ddf97e2](https://github.com/Fotetsa/hullbay/commit/ddf97e254f5bb0b4c4c6bffaa2c609bf7ddac36b))
* 3: correction et mise en place de l'autocompletion pour l'insertion des secret et registre ([#11](https://github.com/Fotetsa/hullbay/issues/11)) ([79094f8](https://github.com/Fotetsa/hullbay/commit/79094f8ac9bd73561c5f41b05c5496352f3e6345))
* add script to build the initial shared/  state ([#22](https://github.com/Fotetsa/hullbay/issues/22)) ([9a11d34](https://github.com/Fotetsa/hullbay/commit/9a11d34e0cd4732822188e3f5d72d4ee439e920d))
* automatiser le versioning des images GHCR (latest, semver, sha) ([#15](https://github.com/Fotetsa/hullbay/issues/15)) ([065c186](https://github.com/Fotetsa/hullbay/commit/065c1862adda8201c27d46afb8526636417bfa17))
* caddy file ([#35](https://github.com/Fotetsa/hullbay/issues/35)) ([15ed4fa](https://github.com/Fotetsa/hullbay/commit/15ed4fa5d572621b09fd5a462abdf83230202812))
* change github owner ([#13](https://github.com/Fotetsa/hullbay/issues/13)) ([2b85b45](https://github.com/Fotetsa/hullbay/commit/2b85b45a85bd161f764e3c84f90b1f1a34b76d22))
* complete build, test, and functional fixes ([94a8f13](https://github.com/Fotetsa/hullbay/commit/94a8f13d064e60530a8894d4a78f07df3a04588d))
* persister l'état déployé pour vider le badge "à déployer" et allumer réseaux/volumes/passerelles ([c6ce57b](https://github.com/Fotetsa/hullbay/commit/c6ce57bc034c2893c285509556148b5cab62a565))
* trigger CI on PRs targeting master ([#12](https://github.com/Fotetsa/hullbay/issues/12)) ([d5eb11d](https://github.com/Fotetsa/hullbay/commit/d5eb11d0b607f571864519747728d6ba3721b26f))
* **web:** modales lisibles (formulaire centré, largeur contrainte) ([9bfe0f8](https://github.com/Fotetsa/hullbay/commit/9bfe0f8e92c6efefbe114d998682cf2531c65651))
