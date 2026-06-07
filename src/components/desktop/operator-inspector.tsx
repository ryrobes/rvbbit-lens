"use client"

import { Plus, Trash2 } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  defaultNode,
  toStepTemplate,
  type PythonEnv,
  type PythonHandler,
  type RvbbitOperator,
  type RvbbitSpecialist,
  type NodeKind,
  type OpStep,
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

interface OperatorInspectorProps {
  op: RvbbitOperator
  isNew: boolean
  selectedNodeId: string | null
  specialists: RvbbitSpecialist[]
  mcpServers: McpServerOverview[]
  mcpTools: McpToolLite[]
  pythonEnvs: PythonEnv[]
  pythonHandlers: PythonHandler[]
  mcpGatewayReady: boolean
  onOpenMcpGateway?: () => void
  onChange: (next: RvbbitOperator) => void
  /** Select a node/region (e.g. jump to a modifier's options on enable). */
  onSelectNode?: (id: string | null) => void
}

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
  mcpGatewayReady,
  onOpenMcpGateway,
  onChange,
  onSelectNode,
}: OperatorInspectorProps) {
  return (
    <div className="flex h-full flex-col overflow-auto bg-chrome-bg/40 text-[12px] text-chrome-text">
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
        mcpGatewayReady={mcpGatewayReady}
        onOpenMcpGateway={onOpenMcpGateway}
        onChange={onChange}
      />
    </div>
  )
}

const NODE_KINDS: NodeKind[] = ["llm", "specialist", "python", "code", "sql", "mcp"]

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
    <div className="px-3 py-2">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-chrome-text/55">
        Flow control
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
      {op.steps ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-chrome-text/55">add node:</span>
          {NODE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() =>
                onChange({
                  ...op,
                  steps: [
                    ...(op.steps ?? []),
                    defaultNode(kind, `node${(op.steps?.length ?? 0) + 1}`),
                  ],
                })
              }
              className="inline-flex items-center gap-0.5 rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] hover:bg-foreground/[0.06]"
            >
              <Plus className="h-2.5 w-2.5" />
              {kind}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded border px-2 py-0.5 text-[11px]",
        on
          ? "border-rvbbit-accent/50 bg-rvbbit-bg text-rvbbit-accent"
          : "border-chrome-border bg-secondary-background text-chrome-text/70 hover:text-foreground",
      )}
    >
      {on ? "✓ " : ""}
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
    <span className="inline-flex items-center gap-1 rounded border border-chrome-border bg-secondary-background px-1 py-0.5 text-[10px]">
      <button type="button" onClick={onRemove} className="px-1 hover:text-foreground" disabled={n === 0}>
        −
      </button>
      <span className="tabular-nums text-chrome-text/80">
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
  return <OperatorMetaEditor op={op} isNew={isNew} onChange={onChange} />
}

function OperatorMetaEditor({
  op,
  isNew,
  onChange,
}: {
  op: RvbbitOperator
  isNew: boolean
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
      <Field label="model">
        <input
          value={op.model}
          onChange={(e) => onChange({ ...op, model: e.target.value })}
          className={inputCls}
        />
      </Field>
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
          <Field label="model">
            <input
              value={step.model ?? ""}
              onChange={(e) => onChange({ ...step, model: e.target.value })}
              className={inputCls}
            />
          </Field>
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
      ) : (
        <>
          <Field label="SQL — a SELECT, with $1..$N placeholders">
            <textarea
              value={step.sql ?? ""}
              onChange={(e) => onChange({ ...step, sql: e.target.value })}
              rows={3}
              className={cn(areaCls, "font-mono")}
            />
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

/** Key→template editor for a node's `inputs` map. */
function InputsEditor({
  inputs,
  onChange,
}: {
  inputs: Record<string, string>
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
      <span className="mb-0.5 block text-[10px] text-chrome-text/60">inputs (key → template)</span>
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

const inputCls =
  "h-7 w-full rounded border border-chrome-border bg-doc-bg px-2 text-[12px] text-foreground outline-none focus:border-main/60"
const areaCls =
  "w-full rounded border border-chrome-border bg-doc-bg px-2 py-1 text-[11px] leading-snug text-foreground outline-none focus:border-main/60"
const tabCls =
  "rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] text-chrome-text/70"
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
        <span className="truncate text-[10px] font-medium uppercase tracking-wide text-chrome-text/55">
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] text-chrome-text/60">{label}</span>
      {children}
    </label>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2">{children}</div>
}
