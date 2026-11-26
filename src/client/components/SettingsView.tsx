import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  GOOGLE_AI_PLANS,
  MODEL_PRICING_PRESETS,
  resolveModelPricing,
} from '../../shared/pricing.ts'
import {
  type CostPricingOverrides,
  type GoogleAiPlanId,
  type ModelPricingOverride,
  type ShellId,
  type ShellInfo,
  type TerminalConfig,
} from '../../shared/types.ts'
import styles from '../terminal.module.css'
import { formatBytes, formatDuration } from '../utils/format.ts'

export interface SettingsViewProps {
  visible: boolean
  config: TerminalConfig
  shells: ShellInfo[]
  platform: string
  daemonVersion: string
  workerAvailable: boolean
  workerPath?: string
  dedupEntryCount: number
  onPatchConfig: (patch: Partial<TerminalConfig>) => Promise<TerminalConfig>
  onResetConfig: () => Promise<TerminalConfig>
  onRefreshShells: () => Promise<void>
}

const CONFIG_KEYS: ReadonlyArray<keyof TerminalConfig> = [
  'defaultShell',
  'defaultTimeoutMs',
  'maxTimeoutMs',
  'maxInlineBytes',
  'maxSpillBytes',
  'autoPromoteOnTimeout',
  'enableReadDedup',
  'enableJsonDigest',
  'enableCredentialFence',
  'enableDownloadGuard',
  'downloadGuardTemplate',
  'spillRetentionDays',
  'spillMaxTotalMb',
  'sessionRetentionDays',
  'sessionMaxCount',
  'googleAiPlan',
]

function overridesEqual(
  a?: CostPricingOverrides | null,
  b?: CostPricingOverrides | null,
): boolean {
  const recA = a ?? {}
  const recB = b ?? {}
  const keysA = Object.keys(recA)
  const keysB = Object.keys(recB)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    const va = recA[k]
    const vb = recB[k]
    if (!va || !vb) return false
    if (
      va.inputPerMillion !== vb.inputPerMillion ||
      va.cacheReadPerMillion !== vb.cacheReadPerMillion ||
      va.outputPerMillion !== vb.outputPerMillion
    ) {
      return false
    }
  }
  return true
}

function diffConfig(base: TerminalConfig, next: TerminalConfig): Partial<TerminalConfig> {
  const patch: Partial<TerminalConfig> = {}
  for (const key of CONFIG_KEYS) {
    if (base[key] !== next[key]) {
      ;(patch as Record<string, unknown>)[key] = next[key]
    }
  }
  if (!overridesEqual(base.costPricingOverrides, next.costPricingOverrides)) {
    patch.costPricingOverrides = next.costPricingOverrides ?? {}
  }
  return patch
}

function configsEqual(a: TerminalConfig, b: TerminalConfig): boolean {
  return Object.keys(diffConfig(a, b)).length === 0
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  visible,
  config,
  shells,
  platform,
  daemonVersion,
  workerAvailable,
  workerPath,
  dedupEntryCount,
  onPatchConfig,
  onResetConfig,
  onRefreshShells,
}) => {
  const [draft, setDraft] = useState<TerminalConfig>(config)
  const [externalChanged, setExternalChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoringDefaults, setRestoringDefaults] = useState(false)
  const [refreshingShells, setRefreshingShells] = useState(false)
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'err' | 'neutral' } | null>(
    null,
  )

  const lastLoadedRef = useRef<TerminalConfig>(config)
  const isDirty = useMemo(() => !configsEqual(draft, lastLoadedRef.current), [draft])
  const isDirtyRef = useRef(isDirty)
  isDirtyRef.current = isDirty

  // Guard against background WS state-update clobbering unsaved edits while dirty.
  useEffect(() => {
    if (configsEqual(config, lastLoadedRef.current)) {
      return
    }
    if (isDirtyRef.current) {
      setExternalChanged(true)
      return
    }
    lastLoadedRef.current = config
    setDraft(config)
    setExternalChanged(false)
  }, [config])

  const updateNum = (field: keyof TerminalConfig, raw: string) => {
    const parsed = Number.parseInt(raw, 10)
    setDraft((prev) => ({
      ...prev,
      [field]: Number.isFinite(parsed) ? parsed : 0,
    }))
    setStatus(null)
  }

  const updateCostRate = (
    modelKey: string,
    probeModel: string,
    field: keyof ModelPricingOverride,
    raw: string,
  ) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000) return
    const builtin = resolveModelPricing(probeModel)
    setDraft((prev) => {
      const currentOverrides = prev.costPricingOverrides ?? {}
      const existing = currentOverrides[modelKey] ?? {
        inputPerMillion: builtin.inputPerMillion,
        cacheReadPerMillion: builtin.cacheReadPerMillion,
        outputPerMillion: builtin.outputPerMillion,
      }
      const nextEntry: ModelPricingOverride = {
        ...existing,
        [field]: Math.round(parsed * 10_000) / 10_000,
      }
      const nextOverrides: CostPricingOverrides = { ...currentOverrides }
      const matchesDefault =
        Math.abs(nextEntry.inputPerMillion - builtin.inputPerMillion) < 1e-6 &&
        Math.abs(nextEntry.cacheReadPerMillion - builtin.cacheReadPerMillion) < 1e-6 &&
        Math.abs(nextEntry.outputPerMillion - builtin.outputPerMillion) < 1e-6
      if (matchesDefault) {
        delete nextOverrides[modelKey]
      } else {
        nextOverrides[modelKey] = nextEntry
      }
      return { ...prev, costPricingOverrides: nextOverrides }
    })
    setStatus(null)
  }

  const handleResetCostRates = () => {
    setDraft((prev) => ({ ...prev, costPricingOverrides: {} }))
    setStatus(null)
  }

  const customCostCount = Object.keys(draft.costPricingOverrides ?? {}).length

  const handleReloadExternal = () => {
    lastLoadedRef.current = config
    setDraft(config)
    setExternalChanged(false)
    setStatus({ text: 'Reloaded latest config.', kind: 'neutral' })
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (draft.defaultTimeoutMs < 1000 || draft.defaultTimeoutMs > 165000) {
      setStatus({ text: 'Default timeout must be 1,000–165,000 ms.', kind: 'err' })
      return
    }
    if (draft.maxTimeoutMs < 5000 || draft.maxTimeoutMs > 165000) {
      setStatus({ text: 'Max foreground timeout must be 5,000–165,000 ms.', kind: 'err' })
      return
    }
    if (draft.maxTimeoutMs < draft.defaultTimeoutMs) {
      setStatus({
        text: 'Max foreground timeout must be >= default timeout.',
        kind: 'err',
      })
      return
    }
    if (draft.maxInlineBytes < 1024 || draft.maxInlineBytes > 8800) {
      setStatus({ text: 'Max inline bytes must be between 1,024 and 8,800.', kind: 'err' })
      return
    }
    if (draft.spillRetentionDays < 1 || draft.spillRetentionDays > 90) {
      setStatus({ text: 'Spill retention must be 1–90 days.', kind: 'err' })
      return
    }
    if (draft.spillMaxTotalMb < 16 || draft.spillMaxTotalMb > 4096) {
      setStatus({ text: 'Spill storage budget must be 16–4,096 MB.', kind: 'err' })
      return
    }
    if (draft.sessionRetentionDays < 1 || draft.sessionRetentionDays > 90) {
      setStatus({ text: 'Session retention must be 1–90 days.', kind: 'err' })
      return
    }
    if (draft.sessionMaxCount < 5 || draft.sessionMaxCount > 200) {
      setStatus({ text: 'Max stored sessions must be 5–200.', kind: 'err' })
      return
    }

    const patch = diffConfig(lastLoadedRef.current, draft)
    if (Object.keys(patch).length === 0) {
      setStatus({ text: 'No changes to save.', kind: 'neutral' })
      return
    }

    setSaving(true)
    setStatus(null)
    try {
      const saved = await onPatchConfig(patch)
      lastLoadedRef.current = saved
      setDraft(saved)
      setExternalChanged(false)
      setStatus({ text: 'Saved.', kind: 'ok' })
    } catch (err) {
      setStatus({
        text: err instanceof Error ? err.message : 'Failed to save.',
        kind: 'err',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setDraft(lastLoadedRef.current)
    setStatus(null)
  }

  const handleRestoreDefaults = async () => {
    setRestoringDefaults(true)
    setStatus(null)
    try {
      const reset = await onResetConfig()
      lastLoadedRef.current = reset
      setDraft(reset)
      setExternalChanged(false)
      setStatus({ text: 'Defaults restored.', kind: 'ok' })
    } catch (err) {
      setStatus({
        text: err instanceof Error ? err.message : 'Failed to restore defaults.',
        kind: 'err',
      })
    } finally {
      setRestoringDefaults(false)
    }
  }

  const handleRefreshShells = async () => {
    setRefreshingShells(true)
    try {
      await onRefreshShells()
    } finally {
      setRefreshingShells(false)
    }
  }

  const shellOptions: { value: ShellId; label: string }[] = [
    { value: 'auto', label: 'Auto-detect' },
    ...shells.map((sh) => ({
      value: sh.id as ShellId,
      label: `${sh.label}${sh.available ? '' : ' (not found)'}`,
    })),
  ]

  const busy = saving || restoringDefaults

  return (
    <section
      className={`${styles.settingsShell} ${!visible ? styles.hiddenPane : ''}`}
      aria-label="Settings and diagnostics"
    >
      <form onSubmit={(e) => void handleSave(e)} className={styles.settingsShellForm} noValidate>
        <div className={styles.settingsScrollBody}>
          <div className={styles.settingsInner}>
            {externalChanged && (
              <div className={styles.externalChangeBar} role="status">
                <span>Config updated externally while editing.</span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSm}`}
                  onClick={handleReloadExternal}
                >
                  Reload
                </button>
              </div>
            )}

            <div className={styles.panel}>
              <div className={`${styles.panelHeader} ${styles.panelHeaderDivided}`}>
                <div className={styles.panelTitle}>General &amp; safety</div>
              </div>

              <div className={styles.settingList}>
                <div className={styles.settingRow}>
                  <div className={styles.settingRowText}>
                    <span className={styles.settingRowTitle}>Default shell</span>
                    <span className={styles.settingRowSub}>
                      Shell used when exec does not specify one.
                    </span>
                  </div>
                  <select
                    className={`${styles.selectInput} ${styles.settingSelect}`}
                    value={draft.defaultShell}
                    aria-label="Default shell"
                    onChange={(e) => {
                      setDraft((prev) => ({ ...prev, defaultShell: e.target.value as ShellId }))
                      setStatus(null)
                    }}
                  >
                    {shellOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={styles.settingRow}>
                  <div className={styles.settingRowText}>
                    <span className={styles.settingRowTitle}>Google AI plan</span>
                    <span className={styles.settingRowSub}>
                      Compare estimated API dollar value against your monthly subscription.
                    </span>
                  </div>
                  <select
                    className={`${styles.selectInput} ${styles.settingSelect}`}
                    value={draft.googleAiPlan ?? 'pro'}
                    aria-label="Google AI plan"
                    onChange={(e) => {
                      setDraft((prev) => ({
                        ...prev,
                        googleAiPlan: e.target.value as GoogleAiPlanId,
                      }))
                      setStatus(null)
                    }}
                  >
                    {GOOGLE_AI_PLANS.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.label}
                      </option>
                    ))}
                    <option value="none">Hide plan comparison</option>
                  </select>
                </div>

                <label className={styles.settingRow}>
                  <div className={styles.settingRowText}>
                    <span className={styles.settingRowTitle}>Read deduplication</span>
                    <span className={styles.settingRowSub}>
                      Skip re-sending unchanged file ranges already read in this session.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    role="switch"
                    className={styles.toggleSwitch}
                    checked={draft.enableReadDedup}
                    onChange={(e) => {
                      setDraft((prev) => ({ ...prev, enableReadDedup: e.target.checked }))
                      setStatus(null)
                    }}
                  />
                </label>

                <label className={styles.settingRow}>
                  <div className={styles.settingRowText}>
                    <span className={styles.settingRowTitle}>Auto-promote on timeout</span>
                    <span className={styles.settingRowSub}>
                      Move long commands to background jobs before the 180s MCP timeout.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    role="switch"
                    className={styles.toggleSwitch}
                    checked={draft.autoPromoteOnTimeout}
                    onChange={(e) => {
                      setDraft((prev) => ({ ...prev, autoPromoteOnTimeout: e.target.checked }))
                      setStatus(null)
                    }}
                  />
                </label>

                <label className={styles.settingRow}>
                  <div className={styles.settingRowText}>
                    <span className={styles.settingRowTitle}>JSON structural digest</span>
                    <span className={styles.settingRowSub}>
                      Summarize large JSON outputs with schema preview and spillover ref.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    role="switch"
                    className={styles.toggleSwitch}
                    checked={draft.enableJsonDigest}
                    onChange={(e) => {
                      setDraft((prev) => ({ ...prev, enableJsonDigest: e.target.checked }))
                      setStatus(null)
                    }}
                  />
                </label>

                <label className={styles.settingRow}>
                  <div className={styles.settingRowText}>
                    <span className={styles.settingRowTitle}>Credential fence</span>
                    <span className={styles.settingRowSub}>
                      Block reads and redact paths matching keys, secrets, and env files.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    role="switch"
                    className={styles.toggleSwitch}
                    checked={draft.enableCredentialFence}
                    onChange={(e) => {
                      setDraft((prev) => ({ ...prev, enableCredentialFence: e.target.checked }))
                      setStatus(null)
                    }}
                  />
                </label>

                <label className={styles.settingRow}>
                  <div className={styles.settingRowText}>
                    <span className={styles.settingRowTitle}>Download guard</span>
                    <span className={styles.settingRowSub}>
                      Intercept slow bulk download commands with a faster replacement template.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    role="switch"
                    className={styles.toggleSwitch}
                    checked={draft.enableDownloadGuard}
                    onChange={(e) => {
                      setDraft((prev) => ({ ...prev, enableDownloadGuard: e.target.checked }))
                      setStatus(null)
                    }}
                  />
                </label>

                {draft.enableDownloadGuard && (
                  <div className={styles.settingSubRow}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Download replacement template</span>
                      <input
                        type="text"
                        className={`${styles.textInput} ${styles.mono}`}
                        placeholder="aria2c -x 8 -o {file} {url}"
                        value={draft.downloadGuardTemplate}
                        onChange={(e) => {
                          setDraft((prev) => ({ ...prev, downloadGuardTemplate: e.target.value }))
                          setStatus(null)
                        }}
                      />
                    </label>
                  </div>
                )}

                <details className={styles.advancedDetails}>
                  <summary className={styles.advancedSummary}>
                    <span className={styles.advancedTitle}>Advanced limits</span>
                    <span className={styles.advancedHint}>Auto-tuned</span>
                  </summary>
                  <div className={styles.advancedBody}>
                    <p className={styles.advancedNote}>
                      Foreground timeouts stay under Antigravity&apos;s 180 s MCP limit so long
                      commands promote into unbounded background jobs automatically.
                    </p>
                    <div className={styles.fieldGrid}>
                      <label className={styles.field}>
                        <span className={styles.fieldLabelRow}>
                          <span className={styles.fieldLabel}>Default timeout (ms)</span>
                          <span className={`${styles.fieldHint} ${styles.tabular}`}>
                            {formatDuration(draft.defaultTimeoutMs)}
                          </span>
                        </span>
                        <input
                          type="number"
                          min={1000}
                          max={165000}
                          step={1000}
                          className={`${styles.textInput} ${styles.tabular}`}
                          value={draft.defaultTimeoutMs}
                          onChange={(e) => updateNum('defaultTimeoutMs', e.target.value)}
                        />
                      </label>

                      <label className={styles.field}>
                        <span className={styles.fieldLabelRow}>
                          <span className={styles.fieldLabel}>Max foreground timeout (ms)</span>
                          <span className={`${styles.fieldHint} ${styles.tabular}`}>
                            {formatDuration(draft.maxTimeoutMs)}
                          </span>
                        </span>
                        <input
                          type="number"
                          min={5000}
                          max={165000}
                          step={5000}
                          className={`${styles.textInput} ${styles.tabular}`}
                          value={draft.maxTimeoutMs}
                          onChange={(e) => updateNum('maxTimeoutMs', e.target.value)}
                        />
                      </label>

                      <label className={styles.field}>
                        <span className={styles.fieldLabelRow}>
                          <span className={styles.fieldLabel}>Max inline output (B)</span>
                          <span className={`${styles.fieldHint} ${styles.tabular}`}>
                            {formatBytes(draft.maxInlineBytes)}
                          </span>
                        </span>
                        <input
                          type="number"
                          min={1024}
                          max={8800}
                          step={256}
                          className={`${styles.textInput} ${styles.tabular}`}
                          value={draft.maxInlineBytes}
                          onChange={(e) => updateNum('maxInlineBytes', e.target.value)}
                        />
                      </label>

                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Spill retention (1–90 days)</span>
                        <input
                          type="number"
                          min={1}
                          max={90}
                          className={`${styles.textInput} ${styles.tabular}`}
                          value={draft.spillRetentionDays}
                          onChange={(e) => updateNum('spillRetentionDays', e.target.value)}
                        />
                      </label>

                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Spill budget (16–4,096 MB)</span>
                        <input
                          type="number"
                          min={16}
                          max={4096}
                          step={16}
                          className={`${styles.textInput} ${styles.tabular}`}
                          value={draft.spillMaxTotalMb}
                          onChange={(e) => updateNum('spillMaxTotalMb', e.target.value)}
                        />
                      </label>

                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Session retention (1–90 days)</span>
                        <input
                          type="number"
                          min={1}
                          max={90}
                          step={1}
                          className={`${styles.textInput} ${styles.tabular}`}
                          value={draft.sessionRetentionDays}
                          onChange={(e) => updateNum('sessionRetentionDays', e.target.value)}
                        />
                      </label>

                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Max stored sessions (5–200)</span>
                        <input
                          type="number"
                          min={5}
                          max={200}
                          step={1}
                          className={`${styles.textInput} ${styles.tabular}`}
                          value={draft.sessionMaxCount}
                          onChange={(e) => updateNum('sessionMaxCount', e.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                </details>

                <details className={styles.advancedDetails}>
                  <summary className={styles.advancedSummary}>
                    <span className={styles.advancedTitle}>Advanced cost rates</span>
                    <span className={styles.advancedHint}>
                      {customCostCount > 0 ? `Custom (${customCostCount})` : 'Official defaults'}
                    </span>
                  </summary>
                  <div className={styles.advancedBody}>
                    <div className={styles.costAdvancedTop}>
                      <p className={styles.advancedNote}>
                        Override API token rates (USD per 1M tokens) if Google or providers update
                        pricing. Unchanged rows stay on built-in defaults.
                      </p>
                      {customCostCount > 0 && (
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSm}`}
                          onClick={handleResetCostRates}
                        >
                          Reset rates
                        </button>
                      )}
                    </div>

                    <div className={styles.costTable}>
                      <div className={styles.costHeaderRow}>
                        <span>Model</span>
                        <span>In</span>
                        <span>Cache</span>
                        <span>Out</span>
                      </div>
                      {MODEL_PRICING_PRESETS.map((preset) => {
                        const builtin = resolveModelPricing(preset.probeModel)
                        const override = draft.costPricingOverrides?.[preset.key]
                        const rate = override ?? builtin
                        const isCustom = Boolean(override)
                        return (
                          <div
                            key={preset.key}
                            className={`${styles.costRow} ${isCustom ? styles.costRowCustom : ''}`}
                          >
                            <span className={styles.costModelCell} title={preset.label}>
                              {preset.label}
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={1000}
                              step="any"
                              aria-label={`${preset.label} input USD per 1M`}
                              className={`${styles.textInput} ${styles.costInput} ${styles.tabular}`}
                              value={rate.inputPerMillion}
                              onChange={(e) =>
                                updateCostRate(
                                  preset.key,
                                  preset.probeModel,
                                  'inputPerMillion',
                                  e.target.value,
                                )
                              }
                            />
                            <input
                              type="number"
                              min={0}
                              max={1000}
                              step="any"
                              aria-label={`${preset.label} cache read USD per 1M`}
                              className={`${styles.textInput} ${styles.costInput} ${styles.tabular}`}
                              value={rate.cacheReadPerMillion}
                              onChange={(e) =>
                                updateCostRate(
                                  preset.key,
                                  preset.probeModel,
                                  'cacheReadPerMillion',
                                  e.target.value,
                                )
                              }
                            />
                            <input
                              type="number"
                              min={0}
                              max={1000}
                              step="any"
                              aria-label={`${preset.label} output USD per 1M`}
                              className={`${styles.textInput} ${styles.costInput} ${styles.tabular}`}
                              value={rate.outputPerMillion}
                              onChange={(e) =>
                                updateCostRate(
                                  preset.key,
                                  preset.probeModel,
                                  'outputPerMillion',
                                  e.target.value,
                                )
                              }
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </details>
              </div>
            </div>

            <div className={styles.panel}>
              <div className={`${styles.panelHeader} ${styles.panelHeaderDivided}`}>
                <div className={styles.panelTitle}>Runtime</div>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSm}`}
                  disabled={refreshingShells}
                  onClick={() => void handleRefreshShells()}
                >
                  {refreshingShells ? 'Scanning...' : 'Refresh shells'}
                </button>
              </div>

              <div className={styles.runtimeStrip}>
                <div className={styles.runtimeMetric}>
                  <span className={styles.summaryMetricLabel}>Daemon</span>
                  <span className={styles.runtimeValueRow}>
                    <span className={`${styles.runtimeMetricValue} ${styles.tabular}`}>
                      v{daemonVersion || '1.0.0'}
                    </span>
                    <span className={styles.runtimeInlineSub}>{platform || 'host'}</span>
                  </span>
                </div>

                <div className={styles.runtimeMetric}>
                  <span className={styles.summaryMetricLabel}>agy-pulse-worker</span>
                  <span
                    className={styles.runtimeValueRow}
                    title={workerPath || 'agy-pulse-worker binary not found'}
                  >
                    <span
                      className={`${styles.runtimeMetricValue} ${
                        workerAvailable ? styles.statusTextOk : styles.runtimeStatusWarn
                      }`}
                    >
                      {workerAvailable ? 'Ready' : 'Fallback'}
                    </span>
                  </span>
                </div>

                <div className={styles.runtimeMetric}>
                  <span className={styles.summaryMetricLabel}>Dedup cache</span>
                  <span className={styles.runtimeValueRow}>
                    <span className={`${styles.runtimeMetricValue} ${styles.tabular}`}>
                      {dedupEntryCount.toLocaleString()}
                    </span>
                    <span className={styles.runtimeInlineSub}>
                      range{dedupEntryCount === 1 ? '' : 's'}
                    </span>
                  </span>
                </div>
              </div>

              <div className={styles.shellsTableWrap}>
                <table className={styles.shellsTable}>
                  <thead>
                    <tr>
                      <th>Shell</th>
                      <th className={styles.statusCol}>Status</th>
                      <th className={styles.versionCol}>Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shells.length === 0 ? (
                      <tr>
                        <td colSpan={3} className={styles.statusText}>
                          No shells detected.
                        </td>
                      </tr>
                    ) : (
                      shells.map((sh) => (
                        <tr key={sh.id} title={sh.executable || sh.notes || undefined}>
                          <td className={styles.shellCell}>
                            <div className={styles.shellName}>{sh.label}</div>
                            <div className={styles.shellId}>{sh.id}</div>
                          </td>
                          <td className={styles.statusCol}>
                            <span
                              className={`${styles.statusLabel} ${
                                sh.available
                                  ? sh.isDefault
                                    ? styles.statusLabelInfo
                                    : styles.statusLabelOk
                                  : styles.statusLabelMuted
                              }`}
                            >
                              {sh.available
                                ? sh.isDefault
                                  ? 'Default'
                                  : 'Available'
                                : 'Unavailable'}
                            </span>
                          </td>
                          <td
                            className={`${styles.mono} ${styles.tabular} ${styles.versionCell} ${styles.versionCol}`}
                          >
                            {sh.version || '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.settingsStickyFooter}>
          <div className={styles.settingsStickyInner}>
            <div
              className={`${styles.statusText} ${
                status?.kind === 'ok'
                  ? styles.statusTextOk
                  : status?.kind === 'err'
                    ? styles.statusTextErr
                    : ''
              }`}
              role="status"
              aria-live="polite"
            >
              {status ? status.text : isDirty ? 'Unsaved changes' : ''}
            </div>
            <div className={styles.cardActionGroup}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm}`}
                disabled={busy}
                onClick={() => void handleRestoreDefaults()}
              >
                {restoringDefaults ? 'Restoring...' : 'Defaults'}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm}`}
                disabled={!isDirty || busy}
                onClick={handleReset}
              >
                Revert
              </button>
              <button
                type="submit"
                className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                disabled={!isDirty || busy}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  )
}
