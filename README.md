# mcpwiki-persona-chat

[MCPWiki](https://github.com/siseru/mcpwiki) の拡張です。Wiki の記事（店、宿、組織など）を、LLM が演じる登場人物（NPC）と会話できる場にします。

- NPC は人格と記憶を持ち、PC（利用者が所有する記事）との会話を覚えています。
- 本体とは別のリポジトリと AWS スタックで動きます。既定では OFF で、OFF の間は本体にも AWS にも、この拡張のリソースはありません。
- 仕組みは汎用です。世界設定（たとえばグレイホーク）は、Wiki の記事の側に書きます。

**状態: 開発の初期段階です。** 今あるのは、共有アカウント用のガード（権限境界）と、CI の土台だけです。計画は [docs/plan.md](docs/plan.md) にあります。

## 開発

```bash
npm ci --ignore-scripts
npm run lint        # リポジトリの規則の検査
npm run typecheck
npm test            # ガードのテスト
npm run synth       # cdk synth（cdk-nag の AwsSolutions 検査つき）
```

ガードの配備（管理者のみ）は [docs/deploy.md](docs/deploy.md) を見てください。

## English

An extension for [MCPWiki](https://github.com/siseru/mcpwiki) that turns wiki articles (shops, inns, guilds) into places where users talk with LLM-played characters that remember them. It lives in its own repository and AWS stacks and is off by default. Early development: only the shared-account guard (permissions boundary) and the CI groundwork exist so far; see [docs/plan.md](docs/plan.md) (Japanese).

## License

Apache-2.0
