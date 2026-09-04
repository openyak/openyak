/** Use exactly the same cwd authority as agent execution, including projectless Chats. */
export async function taskFileRoot(
  taskId: unknown,
  request: (method: string, params: unknown) => Promise<unknown>,
): Promise<string> {
  if (typeof taskId !== 'string' || !taskId) throw new Error('A task is required to open a file')
  const value = await request('task.context', { task_id: taskId })
  const context = value as { task_id?: unknown; cwd?: unknown } | null
  if (context?.task_id !== taskId || typeof context.cwd !== 'string' || !context.cwd) {
    throw new Error('Task file context is unavailable')
  }
  return context.cwd
}
