import test from 'node:test';
import assert from 'node:assert/strict';
import {PolicyAsCodeCompiler} from '../apps/policy-security/src/policy-as-code.js';
import {DataClassifier} from '../apps/policy-security/src/policy-runtime.js';
import {SensitiveMemoryMinimizer} from '../apps/growth-memory/src/growth-runtime.js';

test('compiled secret detection keeps explicit secrets while excluding sk substring in ordinary task IDs',()=>{
 const compiled=new PolicyAsCodeCompiler().compile();assert.equal(compiled.success,true);
 const classifier=new DataClassifier({compiledPolicy:compiled}), minimizer=new SensitiveMemoryMinimizer({dataClassifier:classifier});
 const benign=['evidence_mission-task-12345678abcdef','task-abcdefghijklmnop','C:/synthetic/task-12345678/result-1.txt'];
 for(const text of benign){assert.ok(!classifier.classify(text).sensitiveFlags.includes('secret'),text);assert.equal(minimizer.containsSensitive({text}),false,text);}
 const secrets=['sk-testonly12345678','"sk-testonly12345678"','key: sk-testonly12345678',
  'ghp_testonly12345678','github_pat_testonly12345678','xoxb-testonly12345678','AIza-testonly12345678',
  'AKIA0000000000000000','Bearer testonly12345678','api_key=synthetic-testonly-value',
  'password: synthetic-testonly-value','비밀번호는 synthetic-testonly-value','token: embeddedsk-testonly12345678'];
 for(const text of secrets){assert.ok(classifier.classify(text).sensitiveFlags.includes('secret'),text);assert.equal(minimizer.containsSensitive({text}),true,text);}
});
