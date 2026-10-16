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

- dev で Bedrock を使うときは、モデルの ID（ワイルドカード可）を `cdk.json` の `devBedrockModels` に書き、ガードを配備し直します。例: `["anthropic.claude-haiku-*"]`。基盤モデル（全リージョン）と、US の推論プロファイル（`us.<ID>`）の両方が許可されます。
- Bedrock の Anthropic モデルは、アカウントで 1 回、利用目的の申請が必要です。境界はこの申請を dev に許さないので、管理者がコンソールから行います。
- prod は、既定の bootstrap（MCPWiki の prod と同じもの）を使います。
