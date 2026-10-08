import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/evaluation-restore-20261007',observedAt=new Date().toISOString();
const initial=await readFile(prefix+'-initial.txt','utf8'),legacy=await readFile(prefix+'-legacy.txt','utf8');
if(!initial.includes('ℹ pass 30')||!initial.includes('ℹ fail 0')||!legacy.includes('ℹ pass 1')||!legacy.includes('ℹ fail 0'))throw Error('Required execution evidence missing');
const paths=['tests/evaluation-stage-recovery.test.js','packages/core/src/capabilities/comparative-capability-evaluator.js','packages/core/src/capabilities/container-capability-package-evaluator.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 比較評価の再起動復元・旧結果チャネル拒否

観測 ${observedAt}。公式100項目は60 verified/20進行/20待機。今回製品機能の新規有効化なし。既存の自動改善評価が、再起動復元でも前回の結果チャネル保護を迂回しないことを実測した。

## 実行と結果

既存比較評価・stage recoveryの30検査がすべて通過（失敗0）。固定ケース、現行評価器、実Docker、別OSプロセスで実行した。比較復元は保存済み集約だけを信じず、baseline/candidate各3回の個別receiptをrestoreCompletedで再検査し、集約と照合する。

追加のlegacy-channel反例1件も実Docker6呼出し後、実SQLiteの個別receiptからresultChannelVersionを削除しJSONハッシュと予算receipt参照を整合させたうえで別PIDに再起動した。復元はA_EVALUATION_RESULT_CHANNEL_REEVALUATION_REQUIREDで拒否。新たなDocker呼出し、oracle、factory、fetchは0、予算残0、元のactivePackageを維持し自動承認・再評価しない。30件と別の追加1件で合計31件、重複加算なし。これは既存コードの保護が比較復元にも届く追加証拠であり、新たな製品欠陥修正とは報告しない。

候補定義・証拠を同期し出典監視6件は変更0/reset0/error0。[Node24.8公式worker文書](https://nodejs.org/download/release/v24.8.0/docs/api/worker_threads.html)を再確認した。共有メモリのあるworker自体を敵対コードの完全隔離と扱わない。新モデル・追加ライブラリ・有料呼出し・外部送信・実アカウント変更0。F/cognition実業務記憶は変更しない。

## 限界と次の実装

本試験は合成候補と固定決定型オラクルで、一般自然言語品質・競合製品との優劣・製品p50/p95・モデル/PC費用は未測定。旧運用履歴全件を再監査したものではなく、このフィクスチャの拒否証拠。SHA一致は意味品質の独立検証ではない。ソース実装の変更なし、検査追加のみなので製品buildの再実行は不要。検査変更の復元は追加legacy-channelケースを外すだけで、原帳・予算・署名記録は変更しない。

次のコード課題はFileMoveToolAdapterの事前検査後の宛先出現による上書きと途中失敗時の効果記録。現行copyFile/renameは遅れて作られた宛先を上書きし得る。未修正・未実証として残し、ディレクトリ/跨volume対応を黙って狭めず、Core/E/B/Gの部分効果と復旧まで含めて修正する。実アカウント・クラウド予算・実機・30日観測など元の100項目も保持する。
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'evaluation-restore-20261007',candidateId:'m12-signed-promotion-journal-and-recovery',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'比較評価の再起動復元が各個別receiptの現行結果チャネル検査を通すなら、整合ハッシュを持つ旧結果の復元も再評価要求で拒否できる。',lesson:'集約結果の復元は個別実行証拠を現行境界で再検査する必要がある。予算を自動増額した再実行で履歴不備を隠さない。',limitations:'既存30検査と追加旧チャネル1検査のみ。合成候補・実Docker/別PID。一般意味評価・全運用履歴・実アカウント/製品有効化未実施。公式60%。',evidencePaths:['-report.md','-source.json','-initial.txt','-legacy.txt','-queue.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n最新 ${prefix}-report.md: 比較/復元30成功＋実Docker6呼出後の旧チャネル別PID復元拒否1成功。新規実装欠陥修正0・公式60維持。次はforward moveの遅延宛先衝突/部分効果の再現修正。\n`);
