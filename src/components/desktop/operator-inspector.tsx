"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, GitBranch, Globe, Plus, Search, Trash2 } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  defaultNode,
  toStepTemplate,
  type LlmModel,
  type MemoryService,
  type N8nWorkflow,
  type PythonEnv,
  type PythonHandler,
  type RvbbitOperator,
  type RvbbitSpecialist,
  type NodeKind,
  type OpStep,
  type AgentToolRef,
  type AgentBudget,
  type AgentMemoryConfig,
  type RetryPlan,
  type TakesPlan,
  type Validator,
  type Ward,
  type WardsPlan,
} from "@/lib/rvbbit/operators"
import {
  schemaType,
  type McpServerOverview,
  type McpToolLite,
} from "@/lib/rvbbit/mcp"
import { SqlEditor } from "./sql-editor"

interface OperatorInspectorProps {
  op: RvbbitOperator
  isNew: boolean
  selectedNodeId: string | null
  specialists: RvbbitSpecialist[]
  mcpServers: McpServerOverview[]
  mcpTools: McpToolLite[]
  pythonEnvs: PythonEnv[]
  pythonHandlers: PythonHandler[]
  llmModels: LlmModel[]
  memoryServices: MemoryService[]
  n8nWorkflows: N8nWorkflow[]
  mcpGatewayReady: boolean
  onOpenMcpGateway?: () => void
  onChange: (next: RvbbitOperator) => void
  /** Select a node/region (e.g. jump to a modifier's options on enable). */
  onSelectNode?: (id: string | null) => void
}

// The inspector is a deliberately-black "code editor" surface, so it pins the
// dark token values locally — that keeps text/syntax readable on black even
// under the light theme (and feeds the embedded CodeMirror its dark palette).
const CODE_PANEL_VARS = {
  "--foreground": "oklch(92% 0.006 80)",
  "--chrome-text": "oklch(70% 0.006 78)",
  "--doc-bg": "oklch(15% 0.008 70)",
  "--main": "oklch(80% 0.12 75)",
  "--danger": "oklch(65% 0.22 25)",
  "--syntax-foreground": "oklch(89% 0.01 260)",
  "--syntax-keyword": "oklch(76% 0.12 308)",
  "--syntax-function": "oklch(81% 0.11 190)",
  "--syntax-string": "oklch(82% 0.11 44)",
  "--syntax-number": "oklch(86% 0.11 95)",
  "--syntax-comment": "oklch(58% 0.03 262)",
  "--syntax-operator": "oklch(76% 0.08 239)",
  "--syntax-identifier": "oklch(82% 0.1 149)",
} as React.CSSProperties

/** Build-mode editing panel — flow-control toggles + the selected node's form. */
export function OperatorInspector({
  op,
  isNew,
  selectedNodeId,
  specialists,
  mcpServers,
  mcpTools,
  pythonEnvs,
  pythonHandlers,
  llmModels,
  memoryServices,
  n8nWorkflows,
  mcpGatewayReady,
  onOpenMcpGateway,
  onChange,
  onSelectNode,
}: OperatorInspectorProps) {
  return (
    <div
      className="flex h-full flex-col overflow-auto bg-[#0a0b0d] font-mono text-[12px] text-chrome-text group-data-[focused=false]/window:bg-[#0a0b0d]/70"
      style={CODE_PANEL_VARS}
    >
      <FlowControls op={op} onChange={onChange} onSelectNode={onSelectNode} />
      <div className="border-t border-chrome-border" />
      <SelectedEditor
        op={op}
        isNew={isNew}
        selectedNodeId={selectedNodeId}
        specialists={specialists}
        mcpServers={mcpServers}
        mcpTools={mcpTools}
        pythonEnvs={pythonEnvs}
        pythonHandlers={pythonHandlers}
        llmModels={llmModels}
        memoryServices={memoryServices}
        n8nWorkflows={n8nWorkflows}
        mcpGatewayReady={mcpGatewayReady}
        onOpenMcpGateway={onOpenMcpGateway}
        onChange={onChange}
      />
    </div>
  )
}

const NODE_KINDS: NodeKind[] = ["llm", "specialist", "python", "code", "sql", "mcp", "n8n", "agent"]

// ── Flow-control toggles ────────────────────────────────────────────

function FlowControls({
  op,
  onChange,
  onSelectNode,
}: {
  op: RvbbitOperator
  onChange: (n: RvbbitOperator) => void
  onSelectNode?: (id: string | null) => void
}) {
  const firstArg = op.arg_names[0] ?? "text"
  const toggleRetry = () => {
    if (op.retry) {
      onChange({ ...op, retry: null })
      onSelectNode?.(null)
      return
    }
    onChange({
      ...op,
      retry: {
        until: { sql: "length(btrim($output)) > 0" },
        max_attempts: 3,
        instructions: "",
      },
    })
    // Jump straight to the retry options so they're editable on enable.
    onSelectNode?.("retry")
  }
  const toggleTakes = () => {
    if (op.takes) {
      onChange({ ...op, takes: null })
      onSelectNode?.(null)
      return
    }
    onChange({ ...op, takes: { factor: 3, reduce: "vote" } })
    onSelectNode?.("takes")
  }
  const toggleSteps = () =>
    onChange({
      ...op,
      steps: op.steps
        ? null
        : [
            {
              name: "step1",
              kind: "llm",
              model: op.model,
              system: toStepTemplate(op.system_prompt, op.arg_names),
              user: toStepTemplate(op.user_prompt, op.arg_names),
            },
          ],
    })
  const wardCount = (phase: "pre" | "post") => op.wards?.[phase]?.length ?? 0
  const addWard = (phase: "pre" | "post") => {
    const ward: Ward = {
      validator: {
        sql:
          phase === "pre"
            ? `length(btrim($inputs->>'${firstArg}')) > 0`
            : "length(btrim($output)) > 0",
      },
      mode: "blocking",
    }
    const wards: WardsPlan = { ...(op.wards ?? {}) }
    const index = wards[phase]?.length ?? 0
    wards[phase] = [...(wards[phase] ?? []), ward]
    onChange({ ...op, wards })
    // Open the new ward's editor immediately.
    onSelectNode?.(`ward-${phase}-${index}`)
  }
  const removeWard = (phase: "pre" | "post") => {
    const cur = op.wards?.[phase] ?? []
    if (cur.length === 0) return
    const wards: WardsPlan = { ...(op.wards ?? {}) }
    wards[phase] = cur.slice(0, -1)
    const empty = (wards.pre?.length ?? 0) === 0 && (wards.post?.length ?? 0) === 0
    onChange({ ...op, wards: empty ? null : wards })
  }

  return (
    <div className="border-b border-foreground/10 px-3 py-2">
      <div
        className="mb-1.5 text-[10px] uppercase tracking-wider"
        style={{ color: "var(--syntax-keyword)" }}
      >
        flow control
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Toggle label="Multi-step" on={!!op.steps} onClick={toggleSteps} />
        <Toggle label="Retry loop" on={!!op.retry} onClick={toggleRetry} />
        <Toggle label="Takes" on={!!op.takes} onClick={toggleTakes} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Counter
          label="pre-wards"
          n={wardCount("pre")}
          onAdd={() => addWard("pre")}
          onRemove={() => removeWard("pre")}
        />
        <Counter
          label="post-wards"
          n={wardCount("post")}
          onAdd={() => addWard("post")}
          onRemove={() => removeWard("post")}
        />
      </div>
    </div>
  )
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-[11px] transition-colors",
        on
          ? "border-main/40 bg-main/[0.08] text-main"
          : "border-foreground/10 text-chrome-text/55 hover:text-foreground",
      )}
    >
      <span className="opacity-90">{on ? "[x]" : "[ ]"}</span>
      {label}
    </button>
  )
}

function Counter({
  label,
  n,
  onAdd,
  onRemove,
}: {
  label: string
  n: number
  onAdd: () => void
  onRemove: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[3px] border border-foreground/10 px-1 py-0.5 text-[10px] text-chrome-text/70">
      <button type="button" onClick={onRemove} className="px-1 hover:text-foreground disabled:opacity-30" disabled={n === 0}>
        −
      </button>
      <span className="tabular-nums">
        {n} {label}
      </span>
      <button type="button" onClick={onAdd} className="px-1 hover:text-foreground">
        +
      </button>
    </span>
  )
}

// ── Selected-element editor ─────────────────────────────────────────

function swap<T>(arr: T[], i: number, j: number): T[] {
  const next = [...arr]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

function SelectedEditor({
  op,
  isNew,
  selectedNodeId,
  specialists,
  mcpServers,
  mcpTools,
  pythonEnvs,
  pythonHandlers,
  llmModels,
  memoryServices,
  n8nWorkflows,
  mcpGatewayReady,
  onOpenMcpGateway,
  onChange,
}: {
  op: RvbbitOperator
  isNew: boolean
  selectedNodeId: string | null
  specialists: RvbbitSpecialist[]
  mcpServers: McpServerOverview[]
  mcpTools: McpToolLite[]
  pythonEnvs: PythonEnv[]
  pythonHandlers: PythonHandler[]
  llmModels: LlmModel[]
  memoryServices: MemoryService[]
  n8nWorkflows: N8nWorkflow[]
  mcpGatewayReady: boolean
  onOpenMcpGateway?: () => void
  onChange: (n: RvbbitOperator) => void
}) {
  const id = selectedNodeId

  if (id === "retry" && op.retry) {
    return <RetryEditor retry={op.retry} onChange={(r) => onChange({ ...op, retry: r })} />
  }
  if ((id === "takes" || id === "takes-reduce") && op.takes) {
    return (
      <TakesEditor
        takes={op.takes}
        specialists={specialists}
        onChange={(t) => onChange({ ...op, takes: t })}
      />
    )
  }
  if (id === "takes-filter" && op.takes) {
    return (
      <Section title="Takes filter">
        <ValidatorEditor
          value={op.takes.filter ?? { sql: "$output <> ''" }}
          onChange={(v) => onChange({ ...op, takes: { ...op.takes!, filter: v } })}
        />
      </Section>
    )
  }
  if (id?.startsWith("ward-")) {
    const phase = id.startsWith("ward-pre") ? "pre" : "post"
    const index = Number(id.split("-")[2])
    const ward = op.wards?.[phase]?.[index]
    if (ward) {
      return (
        <WardEditor
          ward={ward}
          phase={phase}
          onChange={(w) => {
            const wards: WardsPlan = { ...(op.wards ?? {}) }
            const arr = [...(wards[phase] ?? [])]
            arr[index] = w
            wards[phase] = arr
            onChange({ ...op, wards })
          }}
        />
      )
    }
  }
  // a heterogeneous take node
  const takeNodeMatch = id?.match(/^take-node-(\d+)$/)
  if (takeNodeMatch && op.takes?.nodes) {
    const ni = Number(takeNodeMatch[1])
    const nodes = op.takes.nodes
    const node = nodes[ni]
    if (node) {
      const setNodes = (next: OpStep[]) =>
        onChange({ ...op, takes: { ...op.takes!, nodes: next } })
      return (
        <StepEditor
          step={node}
          label={`Take node · ${node.name}`}
          specialists={specialists}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          pythonEnvs={pythonEnvs}
          pythonHandlers={pythonHandlers}
          llmModels={llmModels}
          memoryServices={memoryServices}
          n8nWorkflows={n8nWorkflows}
          mcpGatewayReady={mcpGatewayReady}
          onOpenMcpGateway={onOpenMcpGateway}
          onChange={(s) => setNodes(nodes.map((x, i) => (i === ni ? s : x)))}
          onRemove={nodes.length > 1 ? () => setNodes(nodes.filter((_, i) => i !== ni)) : undefined}
          onMoveUp={ni > 0 ? () => setNodes(swap(nodes, ni, ni - 1)) : undefined}
          onMoveDown={ni < nodes.length - 1 ? () => setNodes(swap(nodes, ni, ni + 1)) : undefined}
        />
      )
    }
  }
  // a pipeline step
  const stepMatch = id?.match(/step-(\d+)$/)
  if (stepMatch && op.steps) {
    const si = Number(stepMatch[1])
    const steps = op.steps
    const step = steps[si]
    if (step) {
      const setSteps = (next: OpStep[]) => onChange({ ...op, steps: next })
      return (
        <StepEditor
          step={step}
          label={`Node · ${step.name}`}
          specialists={specialists}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          pythonEnvs={pythonEnvs}
          pythonHandlers={pythonHandlers}
          llmModels={llmModels}
          memoryServices={memoryServices}
          n8nWorkflows={n8nWorkflows}
          mcpGatewayReady={mcpGatewayReady}
          onOpenMcpGateway={onOpenMcpGateway}
          onChange={(s) => setSteps(steps.map((x, i) => (i === si ? s : x)))}
          onRemove={steps.length > 1 ? () => setSteps(steps.filter((_, i) => i !== si)) : undefined}
          onMoveUp={si > 0 ? () => setSteps(swap(steps, si, si - 1)) : undefined}
          onMoveDown={si < steps.length - 1 ? () => setSteps(swap(steps, si, si + 1)) : undefined}
        />
      )
    }
  }
  if (id === "output") {
    return <OutputEditor op={op} onChange={onChange} />
  }
  return <OperatorMetaEditor op={op} isNew={isNew} llmModels={llmModels} onChange={onChange} />
}

function OperatorMetaEditor({
  op,
  isNew,
  llmModels,
  onChange,
}: {
  op: RvbbitOperator
  isNew: boolean
  llmModels: LlmModel[]
  onChange: (n: RvbbitOperator) => void
}) {
  return (
    <Section title={op.steps ? "Operator" : "Operator · LLM call"}>
      {isNew ? (
        <Field label="name">
          <input
            value={op.name}
            onChange={(e) =>
              onChange({ ...op, name: e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase() })
            }
            placeholder="operator_name"
            className={inputCls}
          />
        </Field>
      ) : (
        <Field label="name">
          <div className="font-mono text-[12px] text-foreground">rvbbit.{op.name}</div>
        </Field>
      )}
      <Field label="description">
        <input
          value={op.description ?? ""}
          onChange={(e) => onChange({ ...op, description: e.target.value || null })}
          placeholder="what this operator does"
          className={inputCls}
        />
      </Field>
      {isNew ? (
        <>
          <Field label="arguments (comma-separated)">
            <input
              value={op.arg_names.join(", ")}
              onChange={(e) => {
                const names = e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                onChange({
                  ...op,
                  arg_names: names,
                  arg_types: names.map((_, i) => op.arg_types[i] ?? "text"),
                })
              }}
              className={inputCls}
            />
          </Field>
          <Row>
            <Field label="shape">
              <select
                value={op.shape}
                onChange={(e) => onChange({ ...op, shape: e.target.value as RvbbitOperator["shape"] })}
                className={inputCls}
              >
                <option value="scalar">scalar</option>
                <option value="aggregate">aggregate</option>
                <option value="dimension">dimension</option>
                <option value="rowset">rowset (pipeline)</option>
              </select>
            </Field>
            <Field label="return type">
              <select
                value={op.return_type}
                onChange={(e) => onChange({ ...op, return_type: e.target.value })}
                className={inputCls}
              >
                <option value="text">text</option>
                <option value="bool">bool</option>
                <option value="float8">float8</option>
                <option value="jsonb">jsonb</option>
              </select>
            </Field>
          </Row>
        </>
      ) : null}
      <ModelField
        value={op.model}
        models={llmModels}
        onChange={(v) => onChange({ ...op, model: v })}
      />
      {op.steps ? (
        <p className="text-[10px] text-chrome-text/55">
          This is a multi-step operator — select a step node to edit its prompt.
        </p>
      ) : (
        <>
          <Field label="system prompt">
            <textarea
              value={op.system_prompt}
              onChange={(e) => onChange({ ...op, system_prompt: e.target.value })}
              rows={4}
              className={areaCls}
            />
          </Field>
          <Field label="user prompt">
            <textarea
              value={op.user_prompt}
              onChange={(e) => onChange({ ...op, user_prompt: e.target.value })}
              rows={4}
              className={areaCls}
            />
          </Field>
          <Row>
            <Field label="max tokens">
              <input
                type="number"
                value={op.max_tokens}
                onChange={(e) => onChange({ ...op, max_tokens: Number(e.target.value) || 0 })}
                className={inputCls}
              />
            </Field>
            <Field label="temperature">
              <input
                value={op.temperature ?? ""}
                onChange={(e) =>
                  onChange({
                    ...op,
                    temperature: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                placeholder="default"
                className={inputCls}
              />
            </Field>
          </Row>
        </>
      )}
    </Section>
  )
}

function OutputEditor({
  op,
  onChange,
}: {
  op: RvbbitOperator
  onChange: (n: RvbbitOperator) => void
}) {
  return (
    <Section title="Output">
      <Field label="return type">
        <div className="font-mono text-[12px] text-foreground">{op.return_type}</div>
      </Field>
      <Field label="parser">
        <select
          value={op.parser}
          onChange={(e) => onChange({ ...op, parser: e.target.value })}
          className={inputCls}
        >
          <option value="strip">strip</option>
          <option value="raw_text">raw_text</option>
          <option value="yes_no">yes_no</option>
          <option value="score_0_1">score_0_1</option>
          <option value="json">json</option>
          <option value="sql">sql (synth)</option>
        </select>
      </Field>
    </Section>
  )
}

function StepEditor({
  step,
  label,
  specialists,
  mcpServers,
  mcpTools,
  pythonEnvs,
  pythonHandlers,
  llmModels,
  memoryServices,
  n8nWorkflows,
  mcpGatewayReady,
  onOpenMcpGateway,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: OpStep
  label: string
  specialists: RvbbitSpecialist[]
  mcpServers: McpServerOverview[]
  mcpTools: McpToolLite[]
  pythonEnvs: PythonEnv[]
  pythonHandlers: PythonHandler[]
  llmModels: LlmModel[]
  memoryServices: MemoryService[]
  n8nWorkflows: N8nWorkflow[]
  mcpGatewayReady: boolean
  onOpenMcpGateway?: () => void
  onChange: (s: OpStep) => void
  onRemove?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  return (
    <Section title={label} onRemove={onRemove} onMoveUp={onMoveUp} onMoveDown={onMoveDown}>
      <Row>
        <Field label="name">
          <input
            value={step.name}
            onChange={(e) => onChange({ ...step, name: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="kind">
          <select
            value={step.kind}
            onChange={(e) => onChange(defaultNode(e.target.value as NodeKind, step.name))}
            className={inputCls}
          >
            {NODE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
      </Row>
      {step.kind === "llm" ? (
        <>
          <ModelField
            value={step.model ?? ""}
            models={llmModels}
            onChange={(v) => onChange({ ...step, model: v })}
          />
          <Field label="system">
            <textarea
              value={step.system ?? ""}
              onChange={(e) => onChange({ ...step, system: e.target.value })}
              rows={3}
              className={areaCls}
            />
          </Field>
          <Field label="user">
            <textarea
              value={step.user ?? ""}
              onChange={(e) => onChange({ ...step, user: e.target.value })}
              rows={3}
              className={areaCls}
            />
          </Field>
        </>
      ) : step.kind === "code" ? (
        <>
          <Field label="fn">
            <input
              value={step.fn ?? ""}
              onChange={(e) => onChange({ ...step, fn: e.target.value })}
              placeholder="trim, lowercase, validate_one_of, …"
              className={inputCls}
            />
          </Field>
          <InputsEditor
            inputs={step.inputs ?? {}}
            onChange={(inputs) => onChange({ ...step, inputs })}
          />
        </>
      ) : step.kind === "specialist" ? (
        <>
          <Field label="specialist backend">
            <SpecialistSelect
              value={step.specialist ?? ""}
              specialists={specialists}
              onChange={(v) => onChange({ ...step, specialist: v })}
            />
          </Field>
          <InputsEditor
            inputs={step.inputs ?? {}}
            onChange={(inputs) => onChange({ ...step, inputs })}
          />
        </>
      ) : step.kind === "python" ? (
        <>
          <Row>
            <Field label={`env — ${pythonEnvs.length} registered`}>
              <input
                value={step.env ?? ""}
                onChange={(e) => onChange({ ...step, env: e.target.value })}
                placeholder="analytics"
                list="op-python-envs"
                className={inputCls}
              />
              <datalist id="op-python-envs">
                {pythonEnvs.map((en) => (
                  <option key={en.name} value={en.name}>
                    {[en.pythonVersion ? `py ${en.pythonVersion}` : null, en.status]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="handler">
              <input
                value={step.handler ?? ""}
                onChange={(e) => onChange({ ...step, handler: e.target.value })}
                placeholder="ticket_score"
                list="op-python-handlers"
                className={inputCls}
              />
              <datalist id="op-python-handlers">
                {pythonHandlers
                  .filter((h) => !step.env || h.env === step.env)
                  .map((h) => (
                    <option key={h.name} value={h.name}>
                      {[h.entrypoint ? `${h.entrypoint}()` : null, h.description]
                        .filter(Boolean)
                        .join(" — ")}
                    </option>
                  ))}
              </datalist>
            </Field>
          </Row>
          <Field label="timeout (ms)">
            <input
              type="number"
              value={step.timeout_ms ?? ""}
              onChange={(e) => onChange({ ...step, timeout_ms: e.target.value ? Number(e.target.value) : undefined })}
              placeholder="1000"
              className={inputCls}
            />
          </Field>
          <InputsEditor
            inputs={step.inputs ?? {}}
            onChange={(inputs) => onChange({ ...step, inputs })}
          />
          <p className="px-1 text-[10px] leading-relaxed text-chrome-text/50">
            Runs a managed CPython handler in a sidecar venv. Define the env
            and handler in SQL (<span className="font-mono">rvbbit.create_python_env</span>,{" "}
            <span className="font-mono">rvbbit.create_python_handler</span>); the runtime is a
            registered execution endpoint (Python Runtimes in Warren).
          </p>
        </>
      ) : step.kind === "mcp" ? (
        <McpFields
          step={step}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          mcpGatewayReady={mcpGatewayReady}
          onOpenMcpGateway={onOpenMcpGateway}
          onChange={onChange}
        />
      ) : step.kind === "n8n" ? (
        <N8nFields step={step} workflows={n8nWorkflows} onChange={onChange} />
      ) : step.kind === "agent" ? (
        <AgentFields
          step={step}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          llmModels={llmModels}
          memoryServices={memoryServices}
          onChange={onChange}
        />
      ) : (
        <>
          <Field label="SQL — a SELECT, with $1..$N placeholders">
            <div className="overflow-hidden rounded-[3px] border border-foreground/10 focus-within:border-main/50">
              <SqlEditor
                value={step.sql ?? ""}
                onChange={(v) => onChange({ ...step, sql: v })}
                height={120}
                fontSize={12}
              />
            </div>
          </Field>
          <Field label="params (one template per line, fills $1, $2…)">
            <textarea
              value={(step.params ?? []).join("\n")}
              onChange={(e) =>
                onChange({
                  ...step,
                  params: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                })
              }
              rows={2}
              placeholder="{{ inputs.id }}"
              className={cn(areaCls, "font-mono")}
            />
          </Field>
        </>
      )}
    </Section>
  )
}

/** A backend dropdown for `specialist` nodes — picks a registered model. */
function SpecialistSelect({
  value,
  specialists,
  onChange,
}: {
  value: string
  specialists: RvbbitSpecialist[]
  onChange: (v: string) => void
}) {
  if (specialists.length === 0) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="backend name"
        className={inputCls}
      />
    )
  }
  const known = specialists.some((s) => s.name === value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">— pick a backend —</option>
      {!known && value ? <option value={value}>{value} (not registered)</option> : null}
      {specialists.map((s) => (
        <option key={s.name} value={s.name}>
          {s.name} · {s.transport}
        </option>
      ))}
    </select>
  )
}

/**
 * Editor for an mcp-kind step — server picker, tool picker (filtered to
 * the chosen server), the tool's input-schema hint, and the inputs map.
 * Changing the server resets the tool; changing the tool prefills any
 * schema-property keys that aren't already in `inputs`.
 */
function McpFields({
  step,
  mcpServers,
  mcpTools,
  mcpGatewayReady,
  onOpenMcpGateway,
  onChange,
}: {
  step: OpStep
  mcpServers: McpServerOverview[]
  mcpTools: McpToolLite[]
  mcpGatewayReady: boolean
  onOpenMcpGateway?: () => void
  onChange: (s: OpStep) => void
}) {
  const server = step.server ?? ""
  const tool = step.tool ?? ""
  const serverNames = mcpServers.map((s) => s.name)
  const tools = mcpTools.filter((t) => t.server === server)
  const selected = tools.find((t) => t.name === tool)
  const setServer = (next: string) => {
    onChange({ ...step, server: next, tool: "" })
  }
  const setTool = (next: string) => {
    const picked = mcpTools.find((x) => x.server === server && x.name === next)
    const props = picked?.inputSchema?.properties ?? {}
    const existing = step.inputs ?? {}
    const inputs: Record<string, string> = { ...existing }
    for (const k of Object.keys(props)) {
      if (!(k in inputs)) inputs[k] = `{{ inputs.${k} }}`
    }
    onChange({ ...step, tool: next, inputs })
  }
  const knownServer = serverNames.includes(server)
  return (
    <>
      {!mcpGatewayReady ? (
        <div className="rounded border border-warning/35 bg-warning/10 p-2 text-[10px] text-warning">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">MCP Gateway runtime is not ready.</span>
            {onOpenMcpGateway ? (
              <button
                type="button"
                onClick={onOpenMcpGateway}
                className="rounded border border-warning/45 px-1.5 py-0.5 text-[9px] hover:bg-warning/15"
              >
                Install
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <Field label="mcp server">
        {mcpServers.length === 0 ? (
          <input
            value={server}
            onChange={(e) => onChange({ ...step, server: e.target.value })}
            placeholder={mcpGatewayReady ? "no servers registered — type a name" : "install MCP Gateway first"}
            className={inputCls}
          />
        ) : (
          <select
            value={server}
            onChange={(e) => setServer(e.target.value)}
            className={inputCls}
          >
            <option value="">— pick a server —</option>
            {!knownServer && server ? (
              <option value={server}>{server} (not registered)</option>
            ) : null}
            {mcpServers.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} · {s.transport}
              </option>
            ))}
          </select>
        )}
      </Field>
      {server ? (
        <Field label="tool">
          {tools.length === 0 ? (
            <input
              value={tool}
              onChange={(e) => onChange({ ...step, tool: e.target.value })}
              placeholder="tool name (refresh server to discover)"
              className={cn(inputCls, "font-mono")}
            />
          ) : (
            <select
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              className={inputCls}
            >
              <option value="">— pick a tool —</option>
              {tool && !tools.find((t) => t.name === tool) ? (
                <option value={tool}>{tool} (not discovered)</option>
              ) : null}
              {tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      {selected?.description ? (
        <p className="text-[10px] leading-snug text-chrome-text/65">{selected.description}</p>
      ) : null}
      {selected?.inputSchema?.properties &&
      Object.keys(selected.inputSchema.properties).length > 0 ? (
        <div>
          <span className="mb-0.5 block text-[9px] uppercase tracking-wider text-chrome-text/45">
            schema
          </span>
          <div className="flex flex-wrap gap-1">
            {Object.entries(selected.inputSchema.properties).map(([k, p]) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded bg-foreground/[0.06] px-1 py-px font-mono text-[9px] text-chrome-text/80"
                title={p.description ?? ""}
              >
                <span>{k}</span>
                <span className="text-chrome-text/45">{schemaType(p)}</span>
                {selected.inputSchema?.required?.includes(k) ? (
                  <span className="text-rvbbit-accent">*</span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <InputsEditor
        inputs={step.inputs ?? {}}
        onChange={(inputs) => onChange({ ...step, inputs })}
      />
    </>
  )
}

function N8nFields({
  step,
  workflows,
  onChange,
}: {
  step: OpStep
  workflows: N8nWorkflow[]
  onChange: (s: OpStep) => void
}) {
  const options = workflows.flatMap((workflow) => {
    const paths = workflow.triggerPaths.length > 0 ? workflow.triggerPaths : [""]
    return paths.map((path) => ({ workflow, path, key: `${workflow.workflowId}\u0000${path}` }))
  })
  const currentKey =
    step.workflow_id && step.webhook != null ? `${step.workflow_id}\u0000${step.webhook}` : ""
  const setWorkflow = (key: string) => {
    const picked = options.find((o) => o.key === key)
    if (!picked) return
    const method = n8nMethodForPath(picked.workflow, picked.path) ?? step.method ?? "POST"
    onChange({
      ...step,
      workflow_id: picked.workflow.workflowId,
      workflow_name: picked.workflow.workflowName,
      webhook: picked.path,
      method,
      runtime: step.runtime ?? "default",
      inputs: Object.keys(step.inputs ?? {}).length > 0 ? step.inputs : { text: "{{ inputs.text }}" },
    })
  }
  const selected = workflows.find((w) => w.workflowId === step.workflow_id)
    ?? workflows.find((w) => w.triggerPaths.includes(step.webhook ?? ""))

  return (
    <>
      <Row>
        <Field label="runtime">
          <input
            value={step.runtime ?? "default"}
            onChange={(e) => onChange({ ...step, runtime: e.target.value })}
            placeholder="default"
            className={inputCls}
          />
        </Field>
        <Field label="method">
          <select
            value={(step.method ?? "POST").toUpperCase()}
            onChange={(e) => onChange({ ...step, method: e.target.value })}
            className={inputCls}
          >
            {["POST", "GET", "PUT", "PATCH", "DELETE"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </Row>
      {options.length > 0 ? (
        <Field label="discovered workflow">
          <select value={currentKey} onChange={(e) => setWorkflow(e.target.value)} className={inputCls}>
            <option value="">— pick a workflow webhook —</option>
            {currentKey && !options.some((o) => o.key === currentKey) ? (
              <option value={currentKey}>
                {step.workflow_name ?? step.workflow_id} · {step.webhook || "manual path"}
              </option>
            ) : null}
            {options.map(({ workflow, path, key }) => (
              <option key={key} value={key}>
                {workflow.active === false ? "inactive · " : ""}
                {workflow.workflowName || workflow.workflowId} · {path || "(no path)"}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <div className="rounded border border-foreground/10 bg-foreground/[0.025] p-2 text-[10px] text-chrome-text/55">
          No n8n workflow table detected. Type the production webhook path manually.
        </div>
      )}
      <Field label="webhook path">
        <input
          value={step.webhook ?? ""}
          onChange={(e) => onChange({ ...step, webhook: e.target.value })}
          placeholder="my-workflow/webhook-path"
          className={cn(inputCls, "font-mono")}
        />
      </Field>
      {selected ? (
        <div className="flex flex-wrap gap-1">
          <span className="inline-flex items-center gap-1 rounded border border-foreground/10 bg-foreground/[0.03] px-1.5 py-0.5 text-[9px] text-chrome-text/65">
            <GitBranch className="h-3 w-3" />
            {selected.active === false ? "inactive" : "active"}
          </span>
          {selected.triggerPaths.map((path) => (
            <span
              key={path}
              className="rounded border border-foreground/10 bg-foreground/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-chrome-text/65"
            >
              {n8nMethodForPath(selected, path) ?? "POST"} {path}
            </span>
          ))}
        </div>
      ) : null}
      <InputsEditor
        inputs={step.inputs ?? {}}
        label="body (key → template)"
        onChange={(inputs) => onChange({ ...step, inputs })}
      />
      <InputsEditor
        inputs={step.headers ?? {}}
        label="headers (optional)"
        onChange={(headers) => onChange({ ...step, headers })}
      />
      <Field label="timeout (ms)">
        <input
          type="number"
          value={step.timeout_ms ?? ""}
          onChange={(e) => onChange({ ...step, timeout_ms: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="60000"
          className={inputCls}
        />
      </Field>
    </>
  )
}

function n8nMethodForPath(workflow: N8nWorkflow, path: string): string | null {
  for (const node of workflow.webhookNodes) {
    const nodePath = typeof node.path === "string" ? node.path : ""
    if (nodePath === path) {
      const method = typeof node.method === "string" ? node.method : null
      return method?.toUpperCase() ?? null
    }
  }
  return null
}

/** Editor for an `agent` node — a bounded tool-calling loop. */
function AgentFields({
  step,
  mcpServers,
  mcpTools,
  llmModels,
  memoryServices,
  onChange,
}: {
  step: OpStep
  mcpServers: McpServerOverview[]
  mcpTools: McpToolLite[]
  llmModels: LlmModel[]
  memoryServices: MemoryService[]
  onChange: (s: OpStep) => void
}) {
  const tools = step.tools ?? []
  const budget = step.budget ?? {}
  const memory = normalizeAgentMemory(step.memory)
  const memoryAvailable = memoryServices.some((s) => s.provider === "hindsight" && s.status === "ready")
  const readyMemoryServices = memoryServices.filter((s) => s.provider === "hindsight" && s.status === "ready")
  const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v))
  const setTool = (i: number, next: AgentToolRef) => {
    const arr = tools.slice()
    arr[i] = next
    onChange({ ...step, tools: arr })
  }
  const removeTool = (i: number) => onChange({ ...step, tools: tools.filter((_, j) => j !== i) })
  const addQuery = () => {
    if (tools.some((t) => "builtin" in t && t.builtin === "query")) return
    onChange({ ...step, tools: [...tools, { builtin: "query" }] })
  }
  const addMcp = () => onChange({ ...step, tools: [...tools, { server: "", tool: "" }] })
  const setBudget = (k: keyof AgentBudget, v: number | undefined) => {
    const next: AgentBudget = { ...budget }
    if (v === undefined) delete next[k]
    else next[k] = v
    onChange({ ...step, budget: next })
  }
  const setMemoryEnabled = (enabled: boolean) => {
    if (!enabled) {
      const next = { ...step }
      delete next.memory
      onChange(next)
      return
    }
    onChange({
      ...step,
      memory: {
        enabled: true,
        provider: "hindsight",
        service: memory?.service ?? readyMemoryServices[0]?.name ?? "hindsight_default",
        context: memory?.context ?? "",
        allow_tools: memory?.allow_tools ?? true,
        recall_before_run: memory?.recall_before_run ?? true,
        retain_final: memory?.retain_final ?? true,
        required: memory?.required ?? true,
        limit: memory?.limit ?? 6,
        max_chars: memory?.max_chars ?? 4000,
      },
    })
  }
  const setMemory = (patch: Partial<AgentMemoryConfig>) => {
    const base: AgentMemoryConfig = {
      enabled: true,
      provider: "hindsight",
      service: readyMemoryServices[0]?.name ?? "hindsight_default",
      allow_tools: true,
      recall_before_run: true,
      retain_final: true,
      required: true,
      limit: 6,
      max_chars: 4000,
      ...memory,
    }
    onChange({ ...step, memory: { ...base, ...patch } })
  }
  return (
    <>
      <ModelField
        value={step.model ?? ""}
        models={llmModels}
        onChange={(v) => onChange({ ...step, model: v })}
      />
      <Field label="system — standing instructions + grounding">
        <textarea
          value={step.system ?? ""}
          onChange={(e) => onChange({ ...step, system: e.target.value })}
          rows={5}
          className={areaCls}
        />
      </Field>
      <Field label="task — the request (templated; {{ inputs.x }})">
        <textarea
          value={step.task ?? ""}
          onChange={(e) => onChange({ ...step, task: e.target.value })}
          rows={3}
          className={areaCls}
        />
      </Field>

      <div className="rounded border border-foreground/10 bg-foreground/[0.025] p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            memory
          </span>
          <Toggle label="Hindsight" on={memory != null} onClick={() => setMemoryEnabled(memory == null)} />
        </div>
        {memory ? (
          <div className="space-y-2">
              <Row>
                <Field label="service">
                  {memoryServices.length > 0 ? (
                    <select
                      value={memory.service ?? ""}
                      onChange={(e) => setMemory({ service: e.target.value })}
                      className={inputCls}
                    >
                      {memory.service && !memoryServices.find((s) => s.name === memory.service) ? (
                        <option value={memory.service}>{memory.service}</option>
                      ) : null}
                      {memoryServices.map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.name}{s.status !== "ready" ? ` · ${s.status}` : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={memory.service ?? ""}
                      onChange={(e) => setMemory({ service: e.target.value })}
                      placeholder="hindsight_default"
                      className={inputCls}
                    />
                  )}
                </Field>
                <Field label="context">
                  <input
                    value={memory.context ?? ""}
                    onChange={(e) => setMemory({ context: e.target.value })}
                    placeholder="{{ inputs.customer_id }}"
                    className={inputCls}
                  />
                </Field>
              </Row>
              <div className="grid grid-cols-2 gap-1">
                <CheckRow label="recall first" checked={memory.recall_before_run !== false} onChange={(v) => setMemory({ recall_before_run: v })} />
                <CheckRow label="agent tools" checked={memory.allow_tools !== false} onChange={(v) => setMemory({ allow_tools: v })} />
                <CheckRow label="retain final" checked={memory.retain_final !== false} onChange={(v) => setMemory({ retain_final: v })} />
                <CheckRow label="allow fallback" checked={memory.required === false} onChange={(v) => setMemory({ required: !v })} />
              </div>
              <Row>
                <Field label="limit">
                  <input
                    type="number"
                    value={memory.limit ?? ""}
                    onChange={(e) => setMemory({ limit: num(e.target.value) })}
                    placeholder="6"
                    className={inputCls}
                  />
                </Field>
                <Field label="memory chars">
                  <input
                    type="number"
                    value={memory.max_chars ?? ""}
                    onChange={(e) => setMemory({ max_chars: num(e.target.value) })}
                    placeholder="4000"
                    className={inputCls}
                  />
                </Field>
              </Row>
            {memoryAvailable ? null : (
              <p className="px-1 text-[10px] leading-relaxed text-warning/80">
                Hindsight is enabled, but no ready service is registered. This node will fail unless fallback is allowed or a service comes online.
              </p>
            )}
          </div>
        ) : (
          <p className="px-1 text-[10px] leading-relaxed text-chrome-text/45">
            Enable Hindsight to give this agent node scoped recall and retention.
          </p>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            tools — the loop may call
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={addQuery}
              className="rounded border border-foreground/15 px-1.5 py-0.5 text-[9px] hover:bg-foreground/10"
            >
              + query
            </button>
            <button
              type="button"
              onClick={addMcp}
              className="rounded border border-foreground/15 px-1.5 py-0.5 text-[9px] hover:bg-foreground/10"
            >
              + MCP tool
            </button>
          </div>
        </div>
        {tools.length === 0 ? (
          <p className="px-1 text-[10px] text-warning/80">
            No tools — the agent can only answer from the task. Add the read-only{" "}
            <span className="font-mono">query</span> tool.
          </p>
        ) : (
          <div className="space-y-1">
            {tools.map((t, i) =>
              "builtin" in t ? (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded border border-foreground/10 bg-foreground/[0.03] px-2 py-1"
                >
                  <span className="font-mono text-[10px] text-chrome-text/85">query</span>
                  <span className="min-w-0 flex-1 truncate text-[9px] text-chrome-text/50">
                    built-in · read-only SQL, 200-row cap
                  </span>
                  <button
                    type="button"
                    onClick={() => removeTool(i)}
                    className="text-chrome-text/40 hover:text-danger"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <AgentMcpToolRow
                  key={i}
                  value={t}
                  mcpServers={mcpServers}
                  mcpTools={mcpTools}
                  onChange={(next) => setTool(i, next)}
                  onRemove={() => removeTool(i)}
                />
              ),
            )}
          </div>
        )}
      </div>

      <Row>
        <Field label="max iterations">
          <input
            type="number"
            value={step.max_iters ?? ""}
            onChange={(e) => onChange({ ...step, max_iters: num(e.target.value) })}
            placeholder="8"
            className={inputCls}
          />
        </Field>
        <Field label="tool result max chars">
          <input
            type="number"
            value={step.tool_result_max_chars ?? ""}
            onChange={(e) => onChange({ ...step, tool_result_max_chars: num(e.target.value) })}
            placeholder="8000"
            className={inputCls}
          />
        </Field>
      </Row>
      <div>
        <span className="mb-0.5 block text-[9px] uppercase tracking-wider text-chrome-text/45">
          budget — first cap to trip ends the loop
        </span>
        <Row>
          <Field label="max tokens">
            <input
              type="number"
              value={budget.tokens ?? ""}
              onChange={(e) => setBudget("tokens", num(e.target.value))}
              placeholder="—"
              className={inputCls}
            />
          </Field>
          <Field label="max cost (USD)">
            <input
              type="number"
              step="0.01"
              value={budget.cost_usd ?? ""}
              onChange={(e) => setBudget("cost_usd", num(e.target.value))}
              placeholder="0.50"
              className={inputCls}
            />
          </Field>
          <Field label="wall (ms)">
            <input
              type="number"
              value={budget.wall_ms ?? ""}
              onChange={(e) => setBudget("wall_ms", num(e.target.value))}
              placeholder="120000"
              className={inputCls}
            />
          </Field>
        </Row>
      </div>
      <p className="px-1 text-[10px] leading-relaxed text-chrome-text/50">
        A bounded tool-calling loop: the model gets the system prompt + task, calls tools, and each
        result is fed back until it answers with no tool call — or a cap trips. Every turn is recorded
        in <span className="font-mono">rvbbit.agent_messages</span> (see the Messages app). Agent
        operators bypass the result cache automatically.
      </p>
    </>
  )
}

function normalizeAgentMemory(memory: OpStep["memory"]): AgentMemoryConfig | null {
  if (memory === true) return { enabled: true, provider: "hindsight" }
  if (memory && typeof memory === "object" && memory.enabled !== false) {
    return { provider: "hindsight", ...memory, enabled: true }
  }
  return null
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-1.5 rounded border border-foreground/10 bg-foreground/[0.025] px-2 py-1 text-[10px] text-chrome-text/70">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-main"
      />
      <span>{label}</span>
    </label>
  )
}

/** One MCP-tool row in an agent's tool list — a server + tool picker. */
function AgentMcpToolRow({
  value,
  mcpServers,
  mcpTools,
  onChange,
  onRemove,
}: {
  value: { server: string; tool: string }
  mcpServers: McpServerOverview[]
  mcpTools: McpToolLite[]
  onChange: (next: { server: string; tool: string }) => void
  onRemove: () => void
}) {
  const tools = mcpTools.filter((t) => t.server === value.server)
  return (
    <div className="flex items-center gap-1 rounded border border-foreground/10 bg-foreground/[0.03] px-1.5 py-1">
      <Globe className="h-3 w-3 shrink-0 text-chrome-text/40" />
      {mcpServers.length === 0 ? (
        <input
          value={value.server}
          onChange={(e) => onChange({ server: e.target.value, tool: "" })}
          placeholder="server"
          className={cn(inputCls, "h-6 flex-1")}
        />
      ) : (
        <select
          value={value.server}
          onChange={(e) => onChange({ server: e.target.value, tool: "" })}
          className={cn(inputCls, "h-6 flex-1")}
        >
          <option value="">— server —</option>
          {value.server && !mcpServers.find((s) => s.name === value.server) ? (
            <option value={value.server}>{value.server}</option>
          ) : null}
          {mcpServers.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {tools.length === 0 ? (
        <input
          value={value.tool}
          onChange={(e) => onChange({ ...value, tool: e.target.value })}
          placeholder="tool"
          className={cn(inputCls, "h-6 flex-1 font-mono")}
        />
      ) : (
        <select
          value={value.tool}
          onChange={(e) => onChange({ ...value, tool: e.target.value })}
          className={cn(inputCls, "h-6 flex-1")}
        >
          <option value="">— tool —</option>
          {value.tool && !tools.find((t) => t.name === value.tool) ? (
            <option value={value.tool}>{value.tool}</option>
          ) : null}
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="text-chrome-text/40 hover:text-danger"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  )
}

/** Key→template editor for a node's `inputs` map. */
function InputsEditor({
  inputs,
  label = "inputs (key → template)",
  onChange,
}: {
  inputs: Record<string, string>
  label?: string
  onChange: (inputs: Record<string, string>) => void
}) {
  const entries = Object.entries(inputs)
  const setEntry = (idx: number, key: string, val: string) => {
    const next: Record<string, string> = {}
    entries.forEach(([k, v], i) => {
      if (i === idx) next[key] = val
      else next[k] = v
    })
    onChange(next)
  }
  const remove = (idx: number) => {
    const next: Record<string, string> = {}
    entries.forEach(([k, v], i) => {
      if (i !== idx) next[k] = v
    })
    onChange(next)
  }
  return (
    <div>
      <span className="mb-0.5 block text-[10px] text-chrome-text/60">{label}</span>
      <div className="space-y-1">
        {entries.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              value={k}
              onChange={(e) => setEntry(i, e.target.value, v)}
              placeholder="key"
              className={cn(inputCls, "w-24 shrink-0 font-mono")}
            />
            <input
              value={v}
              onChange={(e) => setEntry(i, k, e.target.value)}
              placeholder="{{ inputs.text }}"
              className={cn(inputCls, "font-mono")}
            />
            <button
              type="button"
              onClick={() => remove(i)}
              className="shrink-0 px-1 text-[11px] text-danger hover:bg-danger/10"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange({ ...inputs, [`key${entries.length + 1}`]: "" })}
        className="mt-1 inline-flex items-center gap-0.5 rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] hover:bg-foreground/[0.06]"
      >
        <Plus className="h-2.5 w-2.5" />
        add input
      </button>
    </div>
  )
}

function WardEditor({
  ward,
  phase,
  onChange,
}: {
  ward: Ward
  phase: "pre" | "post"
  onChange: (w: Ward) => void
}) {
  return (
    <Section title={`${phase}-ward`}>
      <Field label="mode">
        <select
          value={ward.mode ?? "blocking"}
          onChange={(e) => onChange({ ...ward, mode: e.target.value as Ward["mode"] })}
          className={inputCls}
        >
          <option value="blocking">blocking — fail the call</option>
          <option value="advisory">advisory — warn & continue</option>
        </select>
      </Field>
      <Field label="validator">
        <ValidatorEditor value={ward.validator} onChange={(v) => onChange({ ...ward, validator: v })} />
      </Field>
    </Section>
  )
}

function RetryEditor({
  retry,
  onChange,
}: {
  retry: RetryPlan
  onChange: (r: RetryPlan) => void
}) {
  return (
    <Section title="Retry loop">
      <Field label="until (output must satisfy)">
        <ValidatorEditor value={retry.until} onChange={(v) => onChange({ ...retry, until: v })} />
      </Field>
      <Field label="max attempts">
        <input
          type="number"
          value={retry.max_attempts ?? 3}
          onChange={(e) => onChange({ ...retry, max_attempts: Number(e.target.value) || 1 })}
          className={inputCls}
        />
      </Field>
      <Field label="retry instructions (appended on each retry)">
        <textarea
          value={retry.instructions ?? ""}
          onChange={(e) => onChange({ ...retry, instructions: e.target.value })}
          rows={3}
          className={areaCls}
        />
      </Field>
    </Section>
  )
}

function TakesEditor({
  takes,
  specialists,
  onChange,
}: {
  takes: TakesPlan
  specialists: RvbbitSpecialist[]
  onChange: (t: TakesPlan) => void
}) {
  const hetero = !!takes.nodes
  const nodes = takes.nodes ?? []

  const toHomogeneous = () =>
    onChange({ factor: takes.factor ?? 3, models: takes.models, reduce: takes.reduce, filter: takes.filter, evaluator: takes.evaluator })
  const toHeterogeneous = () =>
    onChange({
      nodes: nodes.length > 0 ? nodes : [defaultNode("llm", "take1"), defaultNode("specialist", "take2")],
      reduce: takes.reduce,
      filter: takes.filter,
      evaluator: takes.evaluator,
    })
  const setNodes = (next: OpStep[]) => onChange({ ...takes, nodes: next })

  return (
    <Section title="Takes ensemble">
      <Field label="mode">
        <div className="flex gap-1">
          <button type="button" onClick={toHomogeneous} className={cn(tabCls, !hetero && tabActiveCls)}>
            homogeneous
          </button>
          <button type="button" onClick={toHeterogeneous} className={cn(tabCls, hetero && tabActiveCls)}>
            heterogeneous
          </button>
        </div>
      </Field>

      {hetero ? (
        <Field label="ensemble nodes — click one in the graph to edit it">
          <div className="space-y-1">
            {nodes.map((n, i) => (
              <div
                key={i}
                className="flex items-center gap-1 rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5"
              >
                <span className="rounded bg-foreground/10 px-1 text-[8px] uppercase text-chrome-text/70">
                  {n.kind}
                </span>
                <span className="flex-1 truncate font-mono text-[10px] text-foreground">{n.name}</span>
                <button
                  type="button"
                  onClick={() => i > 0 && setNodes(swap(nodes, i, i - 1))}
                  disabled={i === 0}
                  className="px-0.5 text-[10px] text-chrome-text/70 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => i < nodes.length - 1 && setNodes(swap(nodes, i, i + 1))}
                  disabled={i === nodes.length - 1}
                  className="px-0.5 text-[10px] text-chrome-text/70 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => nodes.length > 1 && setNodes(nodes.filter((_, j) => j !== i))}
                  disabled={nodes.length <= 1}
                  className="px-0.5 text-[10px] text-danger disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {NODE_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setNodes([...nodes, defaultNode(kind, `take${nodes.length + 1}`)])}
                className="inline-flex items-center gap-0.5 rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] hover:bg-foreground/[0.06]"
              >
                <Plus className="h-2.5 w-2.5" />
                {kind}
              </button>
            ))}
          </div>
        </Field>
      ) : (
        <>
          <Field label="factor (attempts)">
            <input
              type="number"
              value={takes.factor ?? 3}
              onChange={(e) => onChange({ ...takes, factor: Number(e.target.value) || 1 })}
              className={inputCls}
            />
          </Field>
          <Field label="model pool (one per line, optional)">
            <textarea
              value={(takes.models ?? []).join("\n")}
              onChange={(e) =>
                onChange({
                  ...takes,
                  models: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                })
              }
              rows={2}
              className={cn(areaCls, "font-mono")}
            />
          </Field>
        </>
      )}

      <Field label="reduce">
        <select
          value={takes.reduce ?? "vote"}
          onChange={(e) => onChange({ ...takes, reduce: e.target.value as TakesPlan["reduce"] })}
          className={inputCls}
        >
          <option value="vote">vote</option>
          <option value="first_valid">first_valid</option>
          <option value="evaluator">evaluator</option>
        </select>
      </Field>
      {takes.reduce === "evaluator" ? (
        <Field label="evaluator instructions">
          <textarea
            value={takes.evaluator?.instructions ?? ""}
            onChange={(e) =>
              onChange({ ...takes, evaluator: { ...takes.evaluator, instructions: e.target.value } })
            }
            rows={3}
            className={areaCls}
          />
        </Field>
      ) : null}
      {/* specialists list is available for node editing in the graph */}
      {hetero && specialists.length === 0 ? (
        <p className="text-[9px] text-chrome-text/45">No specialist backends registered.</p>
      ) : null}
    </Section>
  )
}

function ValidatorEditor({
  value,
  onChange,
}: {
  value: Validator
  onChange: (v: Validator) => void
}) {
  const isFn = typeof value === "string" || (typeof value === "object" && "function" in value)
  const sqlText = typeof value === "object" && "sql" in value ? value.sql : ""
  const fnText =
    typeof value === "string" ? value : typeof value === "object" && "function" in value ? value.function : ""
  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => onChange({ sql: sqlText || "length(btrim($output)) > 0" })}
          className={cn(tabCls, !isFn && tabActiveCls)}
        >
          SQL expr
        </button>
        <button
          type="button"
          onClick={() => onChange({ function: fnText || "schema.fn" })}
          className={cn(tabCls, isFn && tabActiveCls)}
        >
          Function
        </button>
      </div>
      {isFn ? (
        <input
          value={fnText}
          onChange={(e) => onChange({ function: e.target.value })}
          placeholder="schema.check_fn"
          className={cn(inputCls, "font-mono")}
        />
      ) : (
        <textarea
          value={sqlText}
          onChange={(e) => onChange({ sql: e.target.value })}
          rows={2}
          placeholder="$output ~ '^[0-9]+$'"
          className={cn(areaCls, "font-mono")}
        />
      )}
      <p className="text-[9px] text-chrome-text/45">
        Bound: <span className="font-mono">$output</span> (text),{" "}
        <span className="font-mono">$inputs</span> (jsonb).
      </p>
    </div>
  )
}

// ── Field primitives ────────────────────────────────────────────────

// Code-editor field look: a faint recessed inset with a dim hairline border
// (so editable spots read clearly without bright outlines); focus warms the
// border + inset slightly instead of flashing a ring.
const inputCls =
  "h-7 w-full rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-chrome-text/30 focus:border-main/50 focus:bg-foreground/[0.06]"
const areaCls =
  "w-full rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 py-1 font-mono text-[11px] leading-snug text-foreground outline-none transition-colors placeholder:text-chrome-text/30 focus:border-main/50 focus:bg-foreground/[0.06]"
const tabCls =
  "rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-1.5 py-0.5 text-[10px] text-chrome-text/60 hover:text-foreground"
const tabActiveCls = "border-main/50 bg-main/15 text-main"

function Section({
  title,
  onRemove,
  onMoveUp,
  onMoveDown,
  children,
}: {
  title: string
  onRemove?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1">
        <span
          className="truncate text-[10px] uppercase tracking-wider"
          style={{ color: "var(--syntax-keyword)" }}
        >
          {title}
        </span>
        <div className="flex-1" />
        {onMoveUp || onMoveDown ? (
          <>
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!onMoveUp}
              title="Move earlier"
              className="rounded px-1 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.06] disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!onMoveDown}
              title="Move later"
              className="rounded px-1 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.06] disabled:opacity-30"
            >
              ↓
            </button>
          </>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-0.5 rounded px-1 text-[10px] text-danger hover:bg-danger/10"
          >
            <Trash2 className="h-2.5 w-2.5" />
            remove
          </button>
        ) : null}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/** Model picker — a searchable dropdown of usable provider/model targets
 *  (cloud + Warren-hosted local LLMs), grouped by provider. The current value
 *  stays valid even if it isn't in the catalog (existing operators / models
 *  pending a refresh). The popover portals to <body>, carrying the dark code
 *  tokens so it reads consistently anywhere. */
export function ModelField({
  value,
  models,
  onChange,
}: {
  value: string
  models: LlmModel[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, ready: false })

  const q = query.trim().toLowerCase()
  const filtered = q
    ? models.filter(
        (m) =>
          m.model.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          `${m.provider}/${m.model}`.toLowerCase().includes(q) ||
          (m.displayName ?? "").toLowerCase().includes(q),
      )
    : models
  const groups = new Map<string, LlmModel[]>()
  for (const m of filtered) {
    const arr = groups.get(m.provider) ?? []
    arr.push(m)
    groups.set(m.provider, arr)
  }
  const inCatalog = models.some((m) => m.model === value)

  // close on click-away / Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  // place under the trigger; flip up on overflow
  useLayoutEffect(() => {
    if (!open) return
    const b = btnRef.current?.getBoundingClientRect()
    const el = panelRef.current
    if (!b || !el) return
    const m = 8
    const h = el.offsetHeight
    let top = b.bottom + 4
    if (top + h > window.innerHeight - m) {
      const above = b.top - h - 4
      top = above >= m ? above : Math.max(m, window.innerHeight - h - m)
    }
    setPos({ left: b.left, top, width: b.width, ready: true })
  }, [open, query, filtered.length])

  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
    setQuery("")
  }

  return (
    <Field label={models.length > 0 ? `model — ${models.length} available` : "model"}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(inputCls, "flex items-center justify-between gap-2 text-left")}
      >
        <span className={cn("truncate", !value && "text-chrome-text/40")}>
          {value || "select a model…"}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              style={{
                ...CODE_PANEL_VARS,
                position: "fixed",
                left: pos.left,
                top: pos.top,
                width: pos.width,
                opacity: pos.ready ? 1 : 0,
                background: "#0e0f13",
              }}
              className="z-[120] overflow-hidden rounded-md border border-foreground/15 font-mono text-[12px] text-chrome-text shadow-2xl"
            >
              <div className="flex items-center gap-1.5 border-b border-foreground/10 px-2 py-1.5">
                <Search className="h-3 w-3 shrink-0 text-chrome-text/45" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="search models…"
                  className="w-full bg-transparent text-[12px] text-foreground outline-none placeholder:text-chrome-text/35"
                />
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {!inCatalog && value ? (
                  <Option label={`${value}  (current)`} active onClick={() => pick(value)} />
                ) : null}
                {filtered.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-chrome-text/45">no matches</div>
                ) : (
                  [...groups].map(([provider, ms]) => (
                    <div key={provider}>
                      <div
                        className="px-2 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider"
                        style={{ color: "var(--syntax-keyword)" }}
                      >
                        {provider}
                        {ms[0].selfHosted ? " · local" : ""}
                      </div>
                      {ms.map((m) => {
                        const v = m.model
                        return (
                          <Option
                            key={`${m.provider}:${m.model}`}
                            label={m.model}
                            sub={m.displayName ?? undefined}
                            active={v === value}
                            onClick={() => pick(v)}
                          />
                        )
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </Field>
  )
}

function Option({
  label,
  sub,
  active,
  onClick,
}: {
  label: string
  sub?: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition-colors hover:bg-foreground/[0.06]",
        active ? "text-main" : "text-chrome-text/85",
      )}
    >
      <span className="w-3 shrink-0 text-center">{active ? "›" : ""}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {sub ? <span className="shrink-0 truncate text-chrome-text/40">{sub}</span> : null}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px]" style={{ color: "var(--syntax-comment)" }}>
        {label}
      </span>
      {children}
    </label>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2">{children}</div>
}
