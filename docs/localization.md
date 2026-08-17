# Documentation localization

**Languages:** English · [Русский](ru/localization.md)

EasyServer keeps one canonical public documentation set in English and publishes translations as locale-specific mirrors. The goal is to make additional languages easy to add without moving the existing English URLs, duplicating the source of truth, or coupling documentation translation to runtime localization.

## Repository layout

English remains at the existing canonical paths:

```text
README.md
CONTRIBUTING.md
SECURITY.md
docs/
  README.md
  getting-started.md
  ...
```

Localized entry points use a language suffix at the repository root, while the documentation tree mirrors the English relative structure under `docs/<locale>/`:

```text
README.ru.md
CONTRIBUTING.ru.md
SECURITY.ru.md

docs/
  localization.md
  ru/
    README.md
    getting-started.md
    connections.md
    providers/
      vastai.md
      intelion.md
    releases/
      v0.2.2.md
      v0.2.1.md
      v0.2.0.md
    ...
```

Use a BCP 47-style locale tag for new translations: a lowercase language code for a language-wide translation (`ru`, `de`, `fr`) and a region/script suffix only when the distinction matters (`pt-BR`, `zh-CN`). Do not create an `en/` mirror: the existing English paths are the canonical source and keeping them in place preserves stable public links.

## Canonical source and translation authority

English documentation is the source of truth for documented behavior, security guarantees, compatibility promises, command contracts, and historical release facts. A translation should preserve those semantics, not create an independent specification.

Translations may temporarily lag behind English. Do not block an otherwise correct English documentation fix solely because every locale cannot be updated in the same change. When a translated page is known to be incomplete or stale, say so visibly in that locale rather than silently presenting it as current.

When English and a translation disagree, treat the English document and the product's actual public behavior as authoritative, then update the translation.

## Translation rules

Translate reader-facing prose naturally for the target language. Do not translate tokens whose exact spelling is part of the product or a public contract, including:

- CLI commands, option names, environment variables, package names, IDs, JSON fields, error codes, and filesystem paths;
- code blocks and machine-readable examples unless only their comments or prose strings are explanatory;
- current TUI labels that a reader must find on screen, unless the product itself has a localized UI;
- provider/product proper names and protocol terms where translation would make the documented interface ambiguous.

Keep the information architecture and progressive-disclosure level equivalent to the English page. A localized Getting Started should still be a Getting Started, not a second reference manual.

Historical material stays historical. Translate the claim that was made for that release; do not silently rewrite old release notes or audits into current-state documentation.

## Linking between languages

The repository README and documentation index provide an obvious language switch. Localized pages should include a compact language line near the top that links back to their canonical English source.

Inside a localized documentation tree, prefer links to the same locale when a translated counterpart exists. Keep external URLs unchanged. When only an English specialist/package surface exists, linking to that English source is acceptable, but the nearest localized guide should remain the primary route for ordinary readers.

## Package and plugin READMEs

Package/plugin READMEs are compact npm/GitHub distribution surfaces and remain canonical English files. They may link directly to localized project, provider, or SDK documentation.

Do not add duplicate localized README files to publishable package directories merely to mirror every repository file. That can change npm tarball contents and creates another prose surface that must stay synchronized. Localized user/provider/SDK guidance belongs in `docs/<locale>/` unless there is a separate release requirement to ship package-local translations.

## Adding a language

To add another locale:

1. Add localized root entry points where relevant: `README.<locale>.md`, `CONTRIBUTING.<locale>.md`, and `SECURITY.<locale>.md`.
2. Create `docs/<locale>/README.md` and mirror the current English `docs/` structure for the pages included in that locale.
3. Add the language to the repository README and `docs/README.md` language navigation.
4. Keep exact product/API tokens unchanged and translate literal UI labels only when that UI is actually localized.
5. Prefer locale-local links throughout the translated tree.
6. Run the repository Markdown link/anchor checks and review code examples for shell correctness on the documented platform.
7. Have a fluent reviewer compare security, compatibility, provider, and automation claims against the English source before declaring the locale complete.

Russian (`ru`) is the first complete locale maintained with this structure.
