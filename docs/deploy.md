# ガードの配備（管理者）

この拡張の dev と prod は、MCPWiki と**同じ AWS アカウント**に置きます。dev のパイプラインが侵害されても、prod、MCPWiki、同じアカウントの他のリソースに届かないよう、権限境界 `PersonaChatDevBoundary` と、dev 専用の CDK bootstrap（qualifier `pcdev`）を使います。

ガードと bootstrap は、CI からは実行しません。管理者が手元から実行します。

## 境界が許すもの、拒むもの

定義は [src/infra/guard-stack.ts](../src/infra/guard-stack.ts)、検査は [test/guard.test.ts](../test/guard.test.ts) です。

| 種類 | 内容 |
|---|---|
| 許可（上限） | `apigateway`、`bedrock`、`bedrock-agentcore`、`cloudformation`、`cloudwatch`、`dynamodb`、`execute-api`、`iam`、`kms`、`lambda`、`logs`、`s3`、`sqs`、`ssm`、`sts`、`tag`、`xray` |
| IAM と STS | `PersonaChat-dev*` 以外のロールの作成・変更・受け渡し・引き受けを拒否。境界なしのロールは作れず、境界も外せない |
| 他のスタック | `PersonaChat-dev*` 以外のスタックの操作と、そのリソースの操作を拒否（prod、MCPWiki、他の bootstrap を含む） |
| prod と MCPWiki | タグ `personachat:env=prod` と、タグ `mcpwiki:env` を持つリソースを拒否。名前でも二重に拒否（`personachat-prod-*`、`PersonaChat-prod-*`、`mcpwiki-*`、`MCPWiki-*`、他の bootstrap のアセット用バケット） |
| Bedrock のモデル | `cdk.json` の `devBedrockModels` に書いたモデルだけを呼べる。**既定は空で、dev はどのモデルも呼べない** |
| Bedrock のアカウント単位の操作 | プロビジョンドスループット、カスタマイズ、バッチ推論、呼び出しログの設定、利用規約の同意を拒否 |

許可の一覧は、検証スパイク（計画の Task 2）の結果で確定します。それまでは暫定です。

## 手順

管理者の資格情報で実行します。

```bash
npm ci --ignore-scripts
npm run build

# 1. ガード（権限境界）
npx cdk deploy PersonaChat-guard

# 2. dev 専用の bootstrap（qualifier pcdev、スタック CDKToolkit-persona-chat-dev）
node scripts/bootstrap-dev.mjs
```

- dev で Bedrock を使うときは、モデルの ID（ワイルドカード可）を `cdk.json` の `devBedrockModels` に書き、ガードを配備し直します。例: `["anthropic.claude-haiku-5-5"]`。us-west-2 の Anthropic モデルは推論プロファイル経由でしか呼べません（[docs/spike.md](spike.md)）。基盤モデル（全リージョン）と、US の推論プロファイル（`us.<ID>`）の両方が許可されます。
- Bedrock の Anthropic モデルは、アカウントで 1 回、利用目的の申請が必要です。境界はこの申請を dev に許さないので、管理者がコンソールから行います。
- prod は、既定の bootstrap（MCPWiki の prod と同じもの）を使います。

## 拡張のスタック（dev）

拡張のスタック `PersonaChat-dev` は、ガードと dev 用の bootstrap の後に配備します。今は、バンドルを置くバケットだけのスタックです。MCPWiki の配信が、このバケットの `ext/persona-chat/*` を OAC で読みます（MCPWiki の docs/extensions.md）。

2 つのスタックは、CloudFormation の参照でつなぎません。互いの値は設定として渡します。

| 向き | 値 | 置き場所 |
|---|---|---|
| MCPWiki から拡張へ | MCPWiki の配信の ARN | `config/wiki.local.json`（Git の管理外）。CI ではシークレット `PERSONACHAT_WIKI` |
| 拡張から MCPWiki へ | バケットのドメイン、バンドルのファイル名、SRI | MCPWiki のシークレット `MCPWIKI_EXTENSIONS` |

```bash
# 1. MCPWiki の dev の配信の ARN を、Git の管理外のファイルに書く
D=$(aws cloudformation describe-stack-resource --region us-west-2 --stack-name MCPWiki-dev --logical-resource-id Cdn9963B1AD --query StackResourceDetail.PhysicalResourceId --output text)
A=$(aws sts get-caller-identity --query Account --output text)
printf '{"dev":{"distributionArn":"arn:aws:cloudfront::%s:distribution/%s"}}\n' "$A" "$D" > config/wiki.local.json

# 2. バンドルを作り、拡張のスタックを配備する（境界つきの pcdev の bootstrap を使う）
npm run deploy:dev

# 3. MCPWiki に渡す値（バケットのドメインは、スタックの出力 BundleBucketDomain）
cat dist/bundle.json
```

続けて、MCPWiki のシークレット `MCPWIKI_EXTENSIONS` を、次の形で設定します。設定したら、MCPWiki の Deploy ワークフローを、main で実行し直します（Actions の画面の「Run workflow」）。

```json
{"dev":[{"id":"persona-chat","contract":1,"bucketRegionalDomainName":"<BundleBucketDomain>","script":"<bundle.json の script>","integrity":"<bundle.json の integrity>","connectSrc":[]}]}
```

**外すとき**
1. MCPWiki の `MCPWIKI_EXTENSIONS` から、persona-chat の項目を消します。
2. MCPWiki を配備し直します。
3. `npx cdk destroy PersonaChat-dev` を実行します。

**バンドルを更新するとき**
1. `npm run deploy:dev` を実行します。古いバンドルも、バケットに残ります。
2. MCPWiki の `MCPWIKI_EXTENSIONS` の `script` と `integrity` を、新しい `dist/bundle.json` の値に書き換えます。
3. MCPWiki を配備し直します。
