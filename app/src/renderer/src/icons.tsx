import type { SVGProps } from 'react'
import spriteUrl from './assets/openai-icons.svg?url'

type Props = SVGProps<SVGSVGElement> & { size?: number }

type OfficialIconName =
  | 'ComposeEditSquare'
  | 'Folder'
  | 'MagnifyingGlassSearch'
  | 'Plus'
  | 'HandRaised'
  | 'ChevronSmallDown'
  | 'ArrowUpSm'
  | 'ArrowDownSm'
  | 'StopSm'
  | 'Check'
  | 'Copy'
  | 'Regenerate'
  | 'PlayTriangle'
  | 'SparkleDouble'
  | 'SpeedometerLatencySpeed'
  | 'MemoryFilledSm'
  | 'DotsHorizontal'
  | 'ChevronUpDown'
  | 'Delete'
  | 'Terminal'
  | 'FileBlank'
  | 'ChevronRight'
  | 'X'
  | 'Paperclip'
  | 'ImageSquare'
  | 'Warning'
  | 'Lightbulb'
  | 'ShieldLock'
  | 'Bolt'
  | 'Desktop'
  | 'Chat'
  | 'SettingsCog'
  | 'BookOpen'
  | 'Tools'
  | 'TextShorter'

function OfficialIcon({
  name,
  viewBox = '0 0 24 24',
  size = 16,
  className,
  ...rest
}: Props & { name: OfficialIconName; viewBox?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={viewBox}
      data-icon-shape="non-circular"
      focusable="false"
      className={['icon', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      {...rest}
    >
      <use href={`${spriteUrl}#${name}`} fill="currentColor" />
    </svg>
  )
}

function icon(name: OfficialIconName, viewBox?: string) {
  return function Icon(props: Props) {
    return <OfficialIcon {...props} name={name} viewBox={viewBox} />
  }
}

// Preserve the app's icon API while sourcing every glyph from OpenAI Apps SDK UI.
/**
 * Sidebar toggle: a panel outline at rest; on hover a chevron surfaces inside the
 * content pane pointing the way the sidebar will move (left = collapse, right = expand).
 * The chevron rotates between the two states so the flip reads as one motion.
 */
export function IconSidebarToggle({
  open,
  size = 18,
  className,
  ...rest
}: Props & { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      className={['icon', 'icon-sidebar-toggle', open ? 'is-open' : 'is-closed', className]
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
      {...rest}
    >
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
      <path className="icon-sidebar-toggle-chevron" d="M16.25 9.75 14 12l2.25 2.25" />
    </svg>
  )
}
export const IconEdit = icon('ComposeEditSquare')
export const IconFolder = icon('Folder', '0 0 20 20')
export const IconSearch = icon('MagnifyingGlassSearch')
export const IconPlus = icon('Plus')
export const IconHand = icon('HandRaised')
export const IconChevronDown = icon('ChevronSmallDown')
export const IconArrowUp = icon('ArrowUpSm')
export const IconArrowDown = icon('ArrowDownSm')
export const IconStop = icon('StopSm')
export const IconCheck = icon('Check')
export const IconCopy = icon('Copy')
export const IconRetry = icon('Regenerate')
export const IconPlay = icon('PlayTriangle')
export const IconSparkle = icon('SparkleDouble')
export const IconGauge = icon('SpeedometerLatencySpeed')
export const IconChip = icon('MemoryFilledSm')
export const IconMore = icon('DotsHorizontal')
export const IconSort = icon('ChevronUpDown')
export const IconTrash = icon('Delete')
export const IconTerminal = icon('Terminal')
export const IconFile = icon('FileBlank')
export const IconChevronRight = icon('ChevronRight')
export const IconClose = icon('X')
export const IconPaperclip = icon('Paperclip')
export const IconImage = icon('ImageSquare')
export const IconWarning = icon('Warning')
export const IconBulb = icon('Lightbulb')
export const IconShield = icon('ShieldLock')
export const IconBolt = icon('Bolt')
export const IconDesktop = icon('Desktop')
export const IconChat = icon('Chat')
export const IconSettings = icon('SettingsCog')
export const IconBookOpen = icon('BookOpen')
export const IconTools = icon('Tools')
export const IconTextShorter = icon('TextShorter')
