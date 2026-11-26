import React from 'react'
import styles from '../terminal.module.css'
import { folderBaseName, formatRelativeAge } from '../utils/format.ts'

export type ActiveView = 'overview' | 'activity' | 'settings'

export interface TabBarProps {
  activeView: ActiveView
  onSelectView: (view: ActiveView) => void
  activeWorkspaceRoot: string
  lastSyncedAt: number | null
  now: number
  isRefreshing: boolean
  onRefresh: () => void
}

export const TabBar: React.FC<TabBarProps> = ({
  activeView,
  onSelectView,
  activeWorkspaceRoot,
  lastSyncedAt,
  now,
  isRefreshing,
  onRefresh,
}) => {
  const updatedText = lastSyncedAt !== null ? formatRelativeAge(lastSyncedAt, now) : null

  return (
    <header className={styles.tabBar}>
      <nav className={styles.navTabs} aria-label="Pulse views">
        <button
          type="button"
          className={`${styles.navTab} ${activeView === 'overview' ? styles.navTabActive : ''}`}
          onClick={() => onSelectView('overview')}
        >
          <span>Usage</span>
        </button>

        <button
          type="button"
          className={`${styles.navTab} ${activeView === 'activity' ? styles.navTabActive : ''}`}
          onClick={() => onSelectView('activity')}
        >
          <span>Activity</span>
        </button>

        <button
          type="button"
          className={`${styles.navTab} ${activeView === 'settings' ? styles.navTabActive : ''}`}
          onClick={() => onSelectView('settings')}
        >
          <span>Settings</span>
        </button>
      </nav>

      <div className={styles.tabBarRight}>
        {updatedText && (
          <span
            className={`${styles.updatedAge} ${styles.tabular}`}
            title={
              lastSyncedAt !== null
                ? `Updated ${new Date(lastSyncedAt).toLocaleTimeString()}`
                : undefined
            }
          >
            updated {updatedText}
          </span>
        )}

        <button
          type="button"
          className={styles.iconBtn}
          disabled={isRefreshing}
          onClick={onRefresh}
          aria-label={isRefreshing ? 'Refreshing' : 'Refresh'}
          title={updatedText ? `Refresh (updated ${updatedText})` : 'Refresh'}
        >
          {isRefreshing ? (
            <span className={styles.runningSpinner} aria-hidden="true" />
          ) : (
            <span aria-hidden="true">↻</span>
          )}
        </button>

        {activeWorkspaceRoot ? (
          <span className={styles.workspacePill} title={activeWorkspaceRoot}>
            {folderBaseName(activeWorkspaceRoot)}
          </span>
        ) : null}
      </div>
    </header>
  )
}
