import {
  Button,
  IconCloseOutline16,
  IconPanelLeftOutline16,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExperienceMode } from './workspace-model.js'
import css from './workspace.module.css'

const DEFAULT_INSPECTOR_WIDTH = 400
const MIN_INSPECTOR_WIDTH = 320
const MAX_INSPECTOR_WIDTH = 720
const COMPACT_INSPECTOR_BREAKPOINT = 1080

/** Stable five-region Experience Tab shell. */
export function ExperienceShell({
  mode,
  taskLabel,
  managementLabel,
  pendingLabel,
  pendingCount,
  inspectorLabel,
  inspectorOpen,
  onModeChange,
  onInspectorOpenChange,
  context,
  navigation,
  workbench,
  inspector,
  status,
}: {
  readonly mode: ExperienceMode
  readonly taskLabel: string
  readonly managementLabel: string
  readonly pendingLabel: string
  readonly pendingCount: number
  readonly inspectorLabel: string
  readonly inspectorOpen: boolean
  readonly onModeChange: (mode: ExperienceMode) => void
  readonly onInspectorOpenChange: (open: boolean) => void
  readonly context: ReactNode
  readonly navigation: ReactNode
  readonly workbench: ReactNode
  readonly inspector: ReactNode
  readonly status: ReactNode
}) {
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH)
  const dragStart = useRef<{ readonly x: number; readonly width: number } | null>(null)
  const shellRef = useRef<HTMLElement>(null)
  const initialResponsiveStateApplied = useRef(false)
  useLayoutEffect(() => {
    const element = shellRef.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined || entry.contentRect.width === 0 || initialResponsiveStateApplied.current) return
      initialResponsiveStateApplied.current = true
      if (entry.contentRect.width <= COMPACT_INSPECTOR_BREAKPOINT) onInspectorOpenChange(false)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [onInspectorOpenChange])
  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent): void => {
      const start = dragStart.current
      if (start === null) return
      setInspectorWidth(clampInspectorWidth(start.width + start.x - event.clientX))
    }
    const onEnd = (): void => { dragStart.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [])
  const beginResize = (event: PointerEvent<HTMLDivElement>): void => {
    dragStart.current = { x: event.clientX, width: inspectorWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  return (
    <section
      ref={shellRef}
      className={css.shell}
      data-experience-mode={mode}
      data-inspector-open={inspectorOpen || undefined}
      style={{ '--experience-inspector-width': `${inspectorWidth}px` } as React.CSSProperties}
    >
      <header className={css.contextBar}>
        <div className={css.contextSummary}>{context}</div>
        <div className={css.modeSwitch} role="group" aria-label={`${taskLabel} / ${managementLabel}`}>
          <Pill active={mode === 'task'} onClick={() => onModeChange('task')}>{taskLabel}</Pill>
          <Pill active={mode === 'management'} onClick={() => onModeChange('management')}>{managementLabel}</Pill>
        </div>
        <span className={css.pendingSummary}>{pendingLabel} {pendingCount}</span>
        {!inspectorOpen ? (
          <Button
            size="sm"
            variant="toolbar"
            icon={<IconPanelLeftOutline16 />}
            aria-label={inspectorLabel}
            onClick={() => onInspectorOpenChange(true)}
          >{inspectorLabel}</Button>
        ) : null}
      </header>
      <div className={css.shellBody}>
        <nav className={css.primaryNavigation}>{navigation}</nav>
        <main className={css.workbench}>{workbench}</main>
        {!inspectorOpen ? null : (
          <>
            <div
              className={css.inspectorResize}
              role="separator"
              aria-label={inspectorLabel}
              aria-orientation="vertical"
              aria-valuemin={MIN_INSPECTOR_WIDTH}
              aria-valuemax={MAX_INSPECTOR_WIDTH}
              aria-valuenow={inspectorWidth}
              tabIndex={0}
              onDoubleClick={() => setInspectorWidth(DEFAULT_INSPECTOR_WIDTH)}
              onPointerDown={beginResize}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') setInspectorWidth(value => clampInspectorWidth(value + 16))
                if (event.key === 'ArrowRight') setInspectorWidth(value => clampInspectorWidth(value - 16))
                if (event.key === 'Home') setInspectorWidth(MIN_INSPECTOR_WIDTH)
                if (event.key === 'End') setInspectorWidth(MAX_INSPECTOR_WIDTH)
              }}
            />
            <aside className={css.inspector} aria-label={inspectorLabel}>
              <header className={css.inspectorHeader}>
                <h3>{inspectorLabel}</h3>
                <Button
                  size="sm"
                  variant="toolbar"
                  icon={<IconCloseOutline16 />}
                  aria-label={inspectorLabel}
                  onClick={() => onInspectorOpenChange(false)}
                />
              </header>
              <div className={css.inspectorContent}>{inspector}</div>
            </aside>
          </>
        )}
      </div>
      <footer className={css.localStatus}>{status}</footer>
    </section>
  )
}

function clampInspectorWidth(width: number): number {
  return Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, width))
}
