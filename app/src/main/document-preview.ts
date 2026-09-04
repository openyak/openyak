import mammoth from 'mammoth'

/** Convert DOCX into semantic HTML. It is always displayed in a scriptless iframe. */
export async function renderDocx(file: string): Promise<string> {
  const result = await mammoth.convertToHtml({ path: file })
  return result.value
}
