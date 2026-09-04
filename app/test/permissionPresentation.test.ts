import test from 'node:test'
import assert from 'node:assert/strict'
import { codexApproval } from '../src/main/runtime/approval.ts'
import { permissionPresentation } from '../src/renderer/src/permissionPresentation.ts'
import type { PermissionRequest } from '../src/shared/protocol.ts'

const request = (value: object): PermissionRequest => ({ request_id: 'r', task_id: 't', agent: 'codex', title: '', tool_call: {}, options: [], ...value })

test('Codex approval labels describe scope without exposing protocol enums', () => {
  const approval = codexApproval('item/fileChange/requestApproval', {}, undefined)
  assert.deepEqual(approval.options.map(o => o.label), ['Allow once', 'Allow for this session', 'Reject this operation', 'Cancel this turn'])
  assert.equal(approval.options[1].kind, 'allow_session')
  assert.equal(approval.options[3].kind, 'cancel')
})

test('file approval joins item changes without inventing a diff when unavailable', () => {
  const approval = codexApproval('item/fileChange/requestApproval', { itemId: 'f', reason: 'Save the report' }, {
    type: 'tool_call', id: 'f', title: 'fileChange', raw_input: { changes: [{ path: '/project/report.md', kind: { type: 'add' }, diff: '+# Report' }] },
  })
  assert.equal(approval.title, 'Allow changes to report.md?')
  assert.equal(approval.details.reason, 'Save the report')
  assert.deepEqual(approval.details.files, [{ path: '/project/report.md', diff: '+# Report' }])
  assert.deepEqual(codexApproval('item/fileChange/requestApproval', {}, undefined).details.files, [])
})

test('command and policy amendments retain their exact scope', () => {
  const approval = codexApproval('item/commandExecution/requestApproval', { command: 'pnpm test', cwd: '/project', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['pnpm', 'test'] } }, 'cancel'] }, undefined)
  assert.equal(approval.details.command, 'pnpm test')
  assert.equal(approval.details.cwd, '/project')
  assert.match(approval.options[1].label, /pnpm test/)
  assert.equal(approval.options[1].kind, 'allow_always')
})

test('unsupported native decisions cannot become approval choices', () => {
  const approval = codexApproval('item/commandExecution/requestApproval', { availableDecisions: [{ futureGrant: {} }] }, undefined)
  assert.equal(approval.options[0].kind, 'unsupported')
  assert.equal(permissionPresentation(request(approval)).initialOptionId, null)
})
test('network policy and additional permissions remain visible and scoped', () => {
  const approval = codexApproval('item/commandExecution/requestApproval', {
    networkApprovalContext: { host: 'example.com', protocol: 'https' },
    additionalPermissions: { network: { enabled: true } },
    availableDecisions: [{ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'deny' } } }],
  }, undefined)
  assert.equal(approval.title, 'Allow network access to example.com?')
  assert.equal(approval.options[0].kind, 'reject_always')
  assert.equal(approval.options[0].label, 'Deny future access to example.com')
  assert.ok(approval.details.input)
  assert.equal(permissionPresentation(request(approval)).initialOptionId, null)
})

test('generic ACP options retain provider labels and rejection semantics', () => {
  const model = permissionPresentation(request({ title: 'Apply patch?', options: [
    { id: 'y', kind: 'allow_once', label: 'Apply patch' },
    { id: 'n', kind: 'reject_once', label: 'Skip patch' },
  ], tool_call: { content: [{ type: 'diff', path: '/project/a.ts', oldText: 'old', newText: 'new' }] } }))
  assert.equal(model.options[1].label, 'Skip patch')
  assert.equal(model.cancelOptionId, null)
  assert.equal(model.initialOptionId, 'y')
  assert.deepEqual(model.details.files, [{ path: '/project/a.ts', before: 'old', after: 'new' }])
})

test('no persistent grant is preselected; explicit cancel stays separate', () => {
  const model = permissionPresentation(request({ options: [
    { id: 'session', kind: 'allow_session', label: 'Allow for this session' },
    { id: 'cancel', kind: 'cancel', label: 'Cancel this turn' },
  ] }))
  assert.equal(model.initialOptionId, null)
  assert.equal(model.cancelOptionId, 'cancel')
  assert.equal(model.options.length, 1)
})
