# 検証スパイクの結果（Task 2）

計画（[docs/plan.md](plan.md)）の「未確認の点」を確かめた結果です。

- 実施: 2026-10-16。us-west-2 で、管理者の資格情報を使った。
- 使ったもの: AWS CLI 2.35.6 と、AWS SDK for JavaScript 3.1148.0（`@aws-sdk/client-bedrock-agentcore` と `-control`）。
- 作った Memory は 2 つで、どちらも試験の後に削除した。費用は数セント程度。
- 「実機」は実際に呼び出して確かめた結果、「文書」は AWS の文書による裏付けで、実機ではまだ確かめていないものを指す。

## まとめ

| 項目 | 結果 | 根拠 |
|---|---|---|
| NPC × PC の記憶の保存・検索・1 件の撤回 | **できる**。撤回（削除）、修正、DM による追加が、どれも検索にすぐ反映される | 実機 |
| 名前空間のカスタム変数 | **使える**（`namespaceKeys`）。`{npc}` と `{pc}` に正規表現の検証を付けられる。ただし CLI 2.35.6 には引数がなく、SDK 3.1148.0 と CloudFormation は対応している | 実機（SDK） |
| 階層でのまとめての取得 | `namespacePath` で取れる。`namespace` は完全一致 | 実機（SDK） |
| Bedrock のモデル | us-west-2 の Anthropic モデルは、**すべて推論プロファイル経由でしか呼べない**。`us.anthropic.claude-haiku-5-5` で呼べた | 実機 |
| 指示文を差し替える抽出（custom 戦略） | **未確認**。実行用の IAM ロールが要り、作成が権限の判定で止められたため | – |
| バンドル用 S3 と CloudFront の権限の循環 | **起きない形がある**（下記） | 文書 |
| WebSocket の認証方式 | **短命チケットを query string で渡す**のがよい（下記） | 文書 |
| web エディタでの `extra` の編集 | できない。REST か OKF のインポートで書く（計画の見直しで確認済み） | コード |

## 1. AgentCore Memory

### 試した構成

1 つ目の Memory には、組み込みの戦略を 2 つ置いた。実行用ロールは要らない。

| 戦略 | 名前空間 | 内容 |
|---|---|---|
| semantic | `/npcpc/{actorId}` | 事実 |
| summary | `/npcpc/{actorId}/session/{sessionId}` | 会話の要約 |

- `actorId` は `npc/<NPC>/pc/<PC>` にした。`actorId` には `/` と `:` が使える。
- 会話は 3 組で試した。リカード × アリス、リカード × ボブ、ミラ × アリス。

### 結果

- **抽出**: イベントを登録してから約 75 秒で、長期の記憶ができた。日本語の会話から、日本語の事実が抽出された。
  - 例: 「ユーザーは玉ねぎが苦手である。」「ユーザーは次の祭りまでに竜の鱗を一枚持ってくると約束した。」
  - 「宿代をまけてくれ」のような依頼は、事実としては残らなかった。
- **分離**: リカード × ボブの名前空間で「竜の鱗の約束」を検索しても、アリスの記憶は出なかった。
- **1 件の撤回**: `DeleteMemoryRecord` で消すと、一覧からも検索からもすぐに消えた。
  - 同じ会話に新しい発言を足して抽出を走らせ直しても、消した事実は戻らなかった。
- **修正**: `BatchUpdateMemoryRecords` で本文を書き換えると、検索にもすぐ反映された。新しい本文で検索に当たる。
- **DM による追加**: `BatchCreateMemoryRecords` で、名前空間と戦略を指定して記憶を足せた。
- **まとめての削除**: 会話の記録（イベント）は `DeleteEvent` で、記憶は `BatchDeleteMemoryRecords` で消せた。一覧から消えるまで 15 秒以内だった。
- **一覧**: `ListActors` と `ListSessions` で、actor と会話の一覧が取れる。
- **名前空間の一致**
  - `ListMemoryRecords` の `namespace` は完全一致だった。`/npcpc/npc/ricardo` や `/npcpc/npc/ricardo/` を指定すると 0 件になった。
  - `namespacePath` を使うと、その階層の下がまとめて取れた。例: `/npcpc/npc/ricardo/` で、リカードの全 PC の記憶と要約。
  - `RetrieveMemoryRecords` も、`namespacePath` で PC をまたいで検索できる。

### カスタム変数

2 つ目の Memory では、カスタム変数を使った。
- `namespaceKeys` に `npc` と `pc` を定義し、正規表現 `^[a-z0-9][a-z0-9-]{0,62}$` で検証する。
- semantic 戦略の名前空間は `/npc/{npc}/pc/{pc}/` にした。
- 変数の値は、`CreateEvent` の `extractionConfig.namespaceVariables` で渡す。

結果は次のとおり。
- 記憶は `/npc/ricardo/pc/pc-alice/` と `/npc/mira/pc/pc-alice/` に分かれてできた。
- 大文字や `../` を含む値は、AWS 側で `ValidationException` になった。
- 変数が足りないイベントや、`extractionConfig` のないイベントも受け付けられる。ただし、長期の記憶はできなかった（文書どおり）。
  - 文書によると、このときはメトリクス `NamespaceResolutionFailure` が出る。

### 設計への反映

- **鍵**: カスタム変数を使い、`/npc/{npc}/pc/{pc}/` とする（末尾に `/` を付ける。文書の推奨で、前方一致の衝突を防ぐため）。
  - 値には、MCPWiki の記事 ID（`[a-z0-9-]`、64 文字まで）がそのまま入る。
  - `actorId` は Wiki の利用者、`sessionId` は 1 回の入室にする。
  - `NamespaceResolutionFailure` にはアラームを付ける。
- **会話中の検索**: 会話中の検索は、その組の `namespace` だけにする。
  - `namespacePath` で上の階層を検索すると、ほかの PC の記憶が混ざる。そのため、DM の画面とデータの寿命の処理だけで使う。
  - IAM でも縛る。文書によると、条件キー `bedrock-agentcore:namespace` と `bedrock-agentcore:namespacePath` で絞り込める（**未確認**。ロールの作成が要るため）。
- **撤回の範囲**: 事実の記憶を消しても、**要約（summary）の記憶は別に残る**（試験では「玉ねぎ」が要約に残った）。そのため、DM の撤回の画面は、事実と要約の両方を対象にする。要約は修正（書き換え）で直す。
- **データの寿命**
  - PC 単位の削除: `namespacePath=/npc/*/pc/<PC>/` のような横断はできない。そのため、NPC ごとに `namespacePath=/npc/<NPC>/pc/<PC>/` を順に消す。
  - NPC 単位の削除: `namespacePath=/npc/<NPC>/` で一覧を取り、`BatchDeleteMemoryRecords` で消す。
  - 会話の記録（イベント）は、`ListActors`、`ListSessions`、`ListEvents` で集めて `DeleteEvent` で消す。期限（`EventExpiryDuration`、3〜365 日）でも消える。
- **世界の暦**
  - 抽出は**現実の日付**で考える。試験では「来週返す」が「2026年10月23日頃に返す」になった。
  - 世界内の日時は、イベントの本文に明示する（例: 発言の前に「【世界の暦: 共通暦 576 年 春 3 日】」を付ける）。もう 1 つの方法は、custom 戦略の指示文で現実の日付を書かないよう指示すること。
- **視点**
  - 組み込みの戦略は「ユーザーは…」という書き方で残す。
  - 会話に入れる前に、サーバーが「ユーザー = この PC」と読み替えて入れれば、初版はこれで足りる。
  - NPC の視点（「アリスは常連で、約束を守る人だ」など）で残したい場合は、custom 戦略を試す（未確認の項目）。
- **CloudFormation と CDK**: `AWS::BedrockAgentCore::Memory` は us-west-2 にある。aws-cdk-lib 2.273.0 には L1 の `CfnMemory` がある。
  - `Name` と `EncryptionKeyArn` は作成時にしか決められない。変えると作り直しになり、記憶は消える。
  - `NamespaceKeys`、`IndexedKeys`、`Tags` を指定できる。
- **Memory の名前**: `PersonaChatSpike-XU1S4UHQLP` のように、名前の後ろにランダムな接尾辞が付く。名前には `-` が使えなかったので、ガードの名前による拒否は `memory/PersonaChat_prod*` の形で合っている。

## 2. Bedrock のモデル（us-west-2）

- Anthropic のモデルは、すべて `inferenceTypesSupported = INFERENCE_PROFILE` だった。モデル ID を直接指定すると、`ValidationException: ... on-demand throughput isn't supported` になる。
- 推論プロファイルは 2 種類ある。

| プロファイル | 振り分け先 |
|---|---|
| `us.` | us-east-1、us-east-2、us-west-2 の基盤モデル |
| `global.` | リージョンを持たない基盤モデルの ARN（`arn:aws:bedrock:::foundation-model/...`）と us-west-2 |

- `anthropic.claude-haiku-5-5` は、このアカウントで利用できる状態だった（`authorizationStatus = AUTHORIZED`、利用規約は同意済み）。
- `us.anthropic.claude-haiku-5-5` への Converse は、入力 31 トークン、出力 67 トークン、約 1.2 秒だった。

**ガードへの反映**
- ガードの `DenyOtherModels` は、次の 2 つを許可している。
  - `arn:aws:bedrock:*::foundation-model/<ID>`（どのリージョンの基盤モデルも合う）
  - `arn:aws:bedrock:*:<アカウント>:inference-profile/us.<ID>`
- これは `us.` プロファイルの呼び出しに要る ARN と合っている。`global.` プロファイルは許可していない（会話のデータを US の外に出さないため）。
- dev で使うモデルは、`devBedrockModels: ["anthropic.claude-haiku-5-5"]` から始めるのがよい。

## 3. バンドル用 S3 と、本体の CloudFront の権限（文書）

S3 を OAC（Origin Access Control）でオリジンにするには、バケットポリシーに配信の ARN（`AWS:SourceArn`）が要る。一方、配信の側にはバケットのドメインが要る。2 つを同じ CloudFormation の参照でつなぐと循環する。CDK は、KMS のキーポリシーでは `distribution/*` のワイルドカードで回避している。

ここでは、**スタックの間を CloudFormation の参照でつながない**ことで循環を避ける。

1. MCPWiki の配信は、すでにある（dev も prod も）。
2. 拡張のスタックは、配信の ARN を**入力**として受け取る。値は環境ごとなので、GitHub のシークレットに置く。拡張のスタックは、その ARN だけを `StringEquals` で許すバケットポリシーを作る。
3. MCPWiki の `extensions` 設定に、バケットのドメインを書いて配備する。

順序は、拡張を先に、本体を後にする。外すときは逆にする。

- 配信が作り直されて ARN が変わると、拒否の側に倒れる。バンドルが読めなくなるだけで、権限は広がらない。
- 配信の ID はログに出さない。今の `redact.mjs` は、配信のドメイン（`d....cloudfront.net`）は伏せるが、ID（`E` で始まる 13〜14 文字）は伏せない。Task 4 で伏せる対象に足す。

**SRI について（Task 3 への申し送り）**
- `import()` には `integrity` を付けられない。
- `<script type="module" integrity="sha384-...">` を `src` 付きで差し込めば、`script-src 'self'` のままでハッシュを照合できる。
- import map の `integrity` を使う方法もあるが、Firefox は 138 以降でしか使えない。

## 4. WebSocket の認証（文書）

API Gateway の WebSocket の前提:
- 認可（Lambda の REQUEST オーソライザ）は `$connect` でだけ動く。
- 接続は最長 2 時間で、操作がないと 10 分で切れる。
- ブラウザの `WebSocket` は、任意のヘッダを付けられない。

| 方式 | 評価 |
|---|---|
| アクセストークンを query string に載せる | 使わない。URL は、ログ、履歴、プロキシに残りやすい |
| `Sec-WebSocket-Protocol` にトークンを載せる | 使わない。サブプロトコルを、本来とは違う用途に使うことになり、応答でサブプロトコルを返す処理も要る。値はヘッダとして記録されることもある |
| 接続してから、最初のメッセージで認証する | 使わない。`$connect` を誰でも通れるので、未認証の接続が API Gateway と Lambda の費用になる |
| **短命チケットを query string に載せる** | **採用**（下記） |

採用する方式の流れ:
1. 本人の Cognito のアクセストークンを付けて、拡張の HTTPS の API にチケットを頼む。
2. 拡張の API は、ランダムで 1 回だけ使える、有効期限 30 秒程度のチケットを発行する。
3. ブラウザは `wss://...?ticket=...` で接続する。`$connect` のオーソライザが、DynamoDB の条件付き削除でチケットを消費する。

URL にチケットが残っても、使い終わったものか、期限切れのものしか残らない。アクセスログの書式には、query string を含めない。

- 2 時間の上限の前に、クライアントからチケットを取り直して、つなぎ直させる（計画の L1）。
- **任意の確認**: WebSocket を MCPWiki の CloudFront を通して同じオリジンで受けられれば、execute-api のドメインを外に出さず、CSP の `connect-src` に足す値も要らなくなる。CloudFront は WebSocket を通せる。ただし、`connect-src 'self'` が `wss:` に合うかはブラウザによって違う可能性がある。そのため、Task 4〜5 で実機で比べる。

## 残った未確認の点

| 点 | 確かめる時期 | 必要なもの |
|---|---|---|
| custom 戦略（NPC の視点での抽出、世界の暦の扱い） | Task 9 の前 | 実行用の IAM ロール（`bedrock-agentcore.amazonaws.com` が引き受け、`bedrock:InvokeModel` を `us.anthropic.claude-haiku-5-5` に限る）。管理者の作成が要る |
| IAM の条件キー `bedrock-agentcore:namespace` による絞り込み | Task 9 | 試験用のロール |
| 顧客管理の KMS キーでの暗号化（`EncryptionKeyArn`） | Task 9 | KMS キー（作成時にしか決められない） |
| WebSocket を CloudFront 経由で受けるか | Task 4〜5 | dev の配備 |
