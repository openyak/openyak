import type { Part, PermissionDetails, PermissionOption } from '../../shared/protocol.ts'
import { array, object, string, type ObjectValue } from './protocol.ts'

/** Labels are presentation, never the decisions sent to the provider. */
function decisionOption(decision: unknown, index: number): PermissionOption {
  const id = String(index)
  switch (decision) {
    case 'accept': return { id, label: 'Allow once', kind: 'allow_once' }
    case 'acceptForSession': return { id, label: 'Allow for this session', kind: 'allow_session' }
    case 'decline': return { id, label: 'Reject this operation', kind: 'reject_once' }
    case 'cancel': return { id, label: 'Cancel this turn', kind: 'cancel' }
  }
  const value = object(decision)
  const amendment = object(value.acceptWithExecpolicyAmendment).execpolicy_amendment
  if (Array.isArray(amendment) && amendment.length && amendment.every(v => typeof v === 'string')) {
    return { id, label: `Allow commands starting with ${amendment.join(' ')}`, kind: 'allow_always',
      _meta: { description: 'Saves a command-prefix rule for future requests.' } }
  }
  const network = object(object(value.applyNetworkPolicyAmendment).network_policy_amendment)
  if (typeof network.host === 'string' && (network.action === 'allow' || network.action === 'deny')) {
    return { id, label: `${network.action === 'allow' ? 'Allow' : 'Deny'} future access to ${network.host}`,
      kind: network.action === 'allow' ? 'allow_always' : 'reject_always' }
  }
  // Future protocol variants must not silently become one-time grants.
  return { id, label: 'Unsupported permission option', kind: 'unsupported' }
}

export function codexApproval(method: string, params: ObjectValue, part: Part | undefined) {
  const item = part?.type === 'tool_call' ? object(part.raw_input) : {}
  const decisions: unknown[] = Array.isArray(params.availableDecisions)
    ? params.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel']
  const files = array(item.changes ?? params.changes).flatMap(change =>
    typeof change.path === 'string' ? [{ path: change.path, ...(typeof change.diff === 'string' ? { diff: change.diff } : {}) }] : [])
  const command = string(params.command) || string(item.command)
  const cwd = string(params.cwd) || string(item.cwd)
  const network = object(params.networkApprovalContext)
  const target = string(network.host)
  const isFile = method === 'item/fileChange/requestApproval'
  const context = Object.fromEntries(['grantRoot', 'additionalPermissions', 'environment', 'networkApprovalContext']
    .filter(key => params[key] != null).map(key => [key, params[key]]))
  const details: PermissionDetails = {
    kind: target ? 'network' : isFile ? 'files' : 'command',
    reason: string(params.reason) || undefined,
    command: command || undefined, cwd: cwd || undefined, target: target || undefined, files,
    ...(Object.keys(context).length ? { input: context } : {}),
  }
  const title = target ? `Allow network access to ${target}?` : isFile
    ? files.length === 1 ? `Allow changes to ${files[0].path.split(/[\\/]/).pop()}?`
      : files.length ? `Allow changes to ${files.length} files?` : 'Allow file changes?'
    : params.kind === 'writeStdin' ? 'Allow input to the running command?' : 'Allow this command to run?'
  const options = decisions.map(decisionOption).map(option => option.kind === 'allow_session'
    ? { ...option, _meta: { description: isFile
      ? 'Future changes to these same files in this session.'
      : 'Matching requests in this session; not all commands.' } } : option)
  return { title, details, tool_call: params, decisions, options }
}
