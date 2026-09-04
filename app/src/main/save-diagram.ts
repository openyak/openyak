export interface DiagramSaveDialogResult {
  canceled: boolean
  filePath?: string
}

type ChooseDiagramPath = () => Promise<DiagramSaveDialogResult>
type WriteDiagramFile = (filePath: string, data: string) => Promise<void>

const MAX_SVG_LENGTH = 20 * 1024 * 1024

export async function saveDiagramSvg(
  value: unknown,
  choosePath: ChooseDiagramPath,
  writeFile: WriteDiagramFile,
): Promise<boolean> {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SVG_LENGTH ||
    !/^<svg(?:\s|>)/i.test(value.trimStart())
  ) {
    throw new Error('Expected a valid SVG diagram')
  }

  const result = await choosePath()
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, value)
  return true
}
