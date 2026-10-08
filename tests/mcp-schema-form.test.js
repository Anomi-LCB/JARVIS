import test from 'node:test';
import assert from 'node:assert/strict';
import {schemaFields,renderSchemaForm,parseSchemaForm} from '../src/ui/connections/schema-form.js';
const schema={type:'object',required:['n','enabled'],properties:{n:{type:'integer',title:'수량'},enabled:{type:'boolean'},tags:{type:'array',items:{type:'string'}},config:{type:'object',properties:{choice:{type:'string',enum:['a','b']}}}}};
const entries = values => schemaFields(schema).fields.map(field=>[field.name,values[field.path.join('.')] ?? '']);
test('typed controls preserve numbers, booleans, arrays and nested enum values',()=>{
  assert.deepEqual(parseSchemaForm(schema,entries({n:'0',enabled:'false',tags:'a\nb','config.choice':'"b"'})),{n:0,enabled:false,tags:['a','b'],config:{choice:'b'}});
  assert.ok(renderSchemaForm(schema,'test').includes('수량'));assert.ok(!renderSchemaForm(schema,'test').includes('name="arguments"'));
});
test('missing required values, fractional integer and invalid enums never dispatch',()=>{
  for(const values of [{n:'',enabled:'true'},{n:'1.5',enabled:'true'},{n:'2',enabled:'true','config.choice':'"malicious"'}])assert.throws(()=>parseSchemaForm(schema,entries(values)));
});
test('schema labels are escaped and unsupported or prototype fields cannot become a form',()=>{
  assert.ok(renderSchemaForm({type:'object',properties:{x:{type:'string',title:'<script>alert(1)</script>'}}},'a').includes('&lt;script&gt;'));
  for(const node of [{type:'object',properties:{x:{$ref:'#/defs/x'}}},JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')])assert.equal(schemaFields(node).supported,false);
  assert.equal({}.polluted,undefined);
});
