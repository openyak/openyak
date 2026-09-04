import { defaultUrlTransform } from 'react-markdown'
import { markdownFileReference } from './fileReferencePresentation.ts'

/** Preserve local link destinations for the task-scoped click handler, not image sources. */
export function markdownUrlTransform(url: string, key: string): string {
  return key === 'href' && markdownFileReference(url) ? url : defaultUrlTransform(url)
}
