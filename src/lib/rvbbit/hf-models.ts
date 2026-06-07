/**
 * Hugging Face model inference — the keystone for "generic HF deploy".
 *
 * Given just a model id, we read the Hub's published metadata (the
 * models API + config.json) and infer everything the rest of the
 * pipeline needs:
 *   - which `hf-rvbbit-fastapi` handler serves it,
 *   - the operator signature (arg names/types, return, parser),
 *   - the label vocabulary + sigmoid/softmax mode for classifiers,
 *   - context length, gated status, cross-encoder vs bi-encoder.
 *
 * The shared sidecar image is already parameterized purely by
 * RVBBIT_CAPABILITY_MODEL + RVBBIT_CAPABILITY_HANDLER, so deploying a
 * new model is "pick the handler + pass the id" — no new pack files.
 * This module is the part that turns an id into those two values plus a
 * ready-to-create operator signature.
 *
 * `inferHfModel` is pure (testable, runs either side). `fetchHfModel`
 * is the browser helper that calls our /hf-inspect proxy then infers.
 */

/** Handlers the hf-rvbbit-fastapi template implements (main.py dispatch). */
export type HfHandler =
  | "embedding"
  | "sequence_classification"
  | "zero_shot_classification"
  | "token_classification"
  | "question_answering"
  | "summarization"
  | "table_question_answering"

/** Raw, lightly-normalized metadata from the /hf-inspect proxy. */
export interface HfRawMeta {
  id: string
  pipelineTag: string | null
  libraryName: string | null
  tags: string[]
  gated: boolean | string
  config: {
    architectures?: string[]
    id2label?: Record<string, string>
    num_labels?: number
    problem_type?: string | null
    max_position_embeddings?: number
  } | null
  // descriptive fields (do not affect inference)
  downloads?: number
  likes?: number
  author?: string | null
  license?: string | null
  languages?: string[]
  params?: number | null
  lastModified?: string | null
  description?: string | null
}

/** Human-facing detail about a model, surfaced in the deploy card. */
export interface HfModelCard {
  description: string | null
  params: number | null
  author: string | null
  license: string | null
  languages: string[]
  downloads: number
  likes: number
  lastModified: string | null
  tags: string[]
}

/** The operator signature inferred for the model's task. */
export interface HfOperatorSignature {
  argNames: string[]
  argTypes: string[]
  returnType: string
  parser: string
}

export interface HfModelInference {
  id: string
  supported: boolean
  handler: HfHandler | null
  pipelineTag: string | null
  library: string | null
  gated: boolean
  /** Human task label, e.g. "Text classification". */
  task: string
  /** Classifier label vocabulary (id2label values), null otherwise. */
  labels: string[] | null
  numLabels: number | null
  /** sigmoid (multi-label) | softmax (single-label) | null (n/a). */
  sequenceMode: "sigmoid" | "softmax" | null
  maxLength: number | null
  /** A num_labels==1 sequence classifier → query/text relevance scorer. */
  isCrossEncoder: boolean
  signature: HfOperatorSignature | null
  /** Caveats worth surfacing in the confirm UI. */
  notes: string[]
  /** Why the model is unsupported (when supported === false). */
  reason: string | null
  /** Human-facing detail (description, stats, license, tags). */
  card: HfModelCard
}

const PIPELINE_TO_HANDLER: Record<string, HfHandler> = {
  "feature-extraction": "embedding",
  "sentence-similarity": "embedding",
  "text-classification": "sequence_classification",
  "zero-shot-classification": "zero_shot_classification",
  "token-classification": "token_classification",
  "question-answering": "question_answering",
  "summarization": "summarization",
  "table-question-answering": "table_question_answering",
}

const TASK_LABEL: Record<HfHandler, string> = {
  embedding: "Embedding",
  sequence_classification: "Text classification",
  zero_shot_classification: "Zero-shot classification",
  token_classification: "Token classification / NER",
  question_answering: "Extractive QA",
  summarization: "Summarization",
  table_question_answering: "Table QA",
}

/** Fallback when pipeline_tag is absent — infer from model architecture. */
function handlerFromArchitecture(architectures: string[]): HfHandler | null {
  const a = architectures.join(" ")
  if (/ForSequenceClassification/.test(a)) return "sequence_classification"
  if (/ForQuestionAnswering/.test(a)) return "question_answering"
  if (/ForTokenClassification/.test(a)) return "token_classification"
  if (/ForConditionalGeneration|Bart|Pegasus|T5|Marian/.test(a)) return "summarization"
  return null
}

function signatureFor(
  handler: HfHandler,
  isCrossEncoder: boolean,
): HfOperatorSignature {
  switch (handler) {
    case "embedding":
      return { argNames: ["text"], argTypes: ["text"], returnType: "jsonb", parser: "json" }
    case "sequence_classification":
      return isCrossEncoder
        ? { argNames: ["query", "text"], argTypes: ["text", "text"], returnType: "jsonb", parser: "json" }
        : { argNames: ["text"], argTypes: ["text"], returnType: "jsonb", parser: "json" }
    case "zero_shot_classification":
      return { argNames: ["text", "categories"], argTypes: ["text", "text"], returnType: "jsonb", parser: "json" }
    case "token_classification":
      return { argNames: ["text"], argTypes: ["text"], returnType: "jsonb", parser: "json" }
    case "question_answering":
      return { argNames: ["question", "context"], argTypes: ["text", "text"], returnType: "jsonb", parser: "json" }
    case "summarization":
      return { argNames: ["text"], argTypes: ["text"], returnType: "text", parser: "strip" }
    case "table_question_answering":
      return { argNames: ["table", "question"], argTypes: ["jsonb", "text"], returnType: "jsonb", parser: "json" }
  }
}

function isGated(gated: boolean | string): boolean {
  return gated === true || gated === "auto" || gated === "manual"
}

/** Pure: raw Hub metadata → an inference the deploy UI can confirm. */
export function inferHfModel(raw: HfRawMeta): HfModelInference {
  const tags = raw.tags ?? []
  const cfg = raw.config ?? {}
  const id2label = cfg.id2label ?? {}
  const labelVals = Object.values(id2label)
  const numLabels = labelVals.length || cfg.num_labels || null
  const maxLength = cfg.max_position_embeddings ?? null
  const gated = isGated(raw.gated)

  const card: HfModelCard = {
    description: raw.description ?? null,
    params: raw.params ?? null,
    author: raw.author ?? null,
    license: raw.license ?? null,
    languages: raw.languages ?? [],
    downloads: raw.downloads ?? 0,
    likes: raw.likes ?? 0,
    lastModified: raw.lastModified ?? null,
    tags: raw.tags ?? [],
  }

  // pipeline_tag is the strongest signal; cross-encoders carry
  // text-classification and resolve to sequence_classification here
  // (num_labels==1 then marks them as scorers below).
  let handler: HfHandler | null = raw.pipelineTag
    ? PIPELINE_TO_HANDLER[raw.pipelineTag] ?? null
    : null
  if (
    !handler &&
    (raw.libraryName === "sentence-transformers" || tags.includes("sentence-transformers"))
  ) {
    handler = "embedding"
  }
  if (!handler && cfg.architectures) {
    handler = handlerFromArchitecture(cfg.architectures)
  }

  if (!handler) {
    return {
      id: raw.id,
      supported: false,
      handler: null,
      pipelineTag: raw.pipelineTag,
      library: raw.libraryName,
      gated,
      task: "Unsupported",
      labels: null,
      numLabels,
      sequenceMode: null,
      maxLength,
      isCrossEncoder: false,
      signature: null,
      notes: [],
      reason: raw.pipelineTag
        ? `Task “${raw.pipelineTag}” isn't served by the hf-rvbbit-fastapi handlers. Generative LLMs deploy via the vLLM path instead.`
        : "Could not determine the model's task from Hub metadata (no pipeline_tag or recognizable architecture).",
      card,
    }
  }

  const isCrossEncoder = handler === "sequence_classification" && numLabels === 1
  const sequenceMode: HfModelInference["sequenceMode"] =
    handler === "sequence_classification" && !isCrossEncoder
      ? cfg.problem_type === "multi_label_classification"
        ? "sigmoid"
        : "softmax"
      : null

  const notes: string[] = []
  if (handler === "zero_shot_classification")
    notes.push("Pass candidate labels at call time via the `categories` argument.")
  if (isCrossEncoder)
    notes.push("Cross-encoder reranker — scores (query, text) relevance, not a class label.")
  if (sequenceMode === "sigmoid")
    notes.push("Multi-label (sigmoid): returns an independent score per label.")
  if (gated)
    notes.push("Gated on Hugging Face — set HF_TOKEN on the deploy target so the agent can pull it.")

  return {
    id: raw.id,
    supported: true,
    handler,
    pipelineTag: raw.pipelineTag,
    library: raw.libraryName,
    gated,
    task: TASK_LABEL[handler],
    labels:
      handler === "sequence_classification" && !isCrossEncoder && labelVals.length
        ? labelVals
        : null,
    numLabels,
    sequenceMode,
    maxLength,
    isCrossEncoder,
    signature: signatureFor(handler, isCrossEncoder),
    notes,
    reason: null,
    card,
  }
}

// ── inference → deployable manifest ─────────────────────────────────

const TASK_PREFIX: Record<HfHandler, string> = {
  embedding: "embed",
  sequence_classification: "classify",
  zero_shot_classification: "classify",
  token_classification: "extract",
  question_answering: "qa",
  summarization: "summarize",
  table_question_answering: "table_qa",
}

const TAG_FOR: Record<HfHandler, string[]> = {
  embedding: ["embedding", "retrieval"],
  sequence_classification: ["classify"],
  zero_shot_classification: ["classify", "zero-shot"],
  token_classification: ["extract", "ner"],
  question_answering: ["qa"],
  summarization: ["summarize"],
  table_question_answering: ["tables", "qa"],
}

/** Slugify "BAAI/bge-small-en-v1.5" → "bge_small_en_v1_5". */
export function hfModelSlug(id: string): string {
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id
  return (
    tail
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_{2,}/g, "_") || "model"
  )
}

/** A friendly, callable operator/backend name for an inferred model. */
export function hfOperatorName(inf: HfModelInference): string {
  const slug = hfModelSlug(inf.id)
  const prefix = inf.handler ? TASK_PREFIX[inf.handler] : "hf"
  const xenc = inf.isCrossEncoder ? "rerank" : prefix
  return slug.startsWith(xenc) ? slug : `${xenc}_${slug}`
}

export interface HfDeployOptions {
  device?: string
  batchSize?: number
  maxConcurrent?: number
  timeoutMs?: number
  /** Override the generated operator/backend name. */
  nameOverride?: string
}

const SAMPLE_ARG: Record<string, string> = {
  text: "hello world",
  query: "refund request",
  categories: "billing, shipping, account",
  question: "what is this about?",
  context: "Rvbbit deploys Hugging Face models as SQL operators.",
  table: '{"col":["a","b"]}',
}

/**
 * Synthesize the same Manifest shape the curated packs use, so a
 * from-id deploy reuses every downstream renderer (scaffold, compose,
 * register SQL, warren). One base specialist operator is generated from
 * the inferred signature; curated convenience operators stay pack-craft.
 *
 * Returns null for unsupported models (caller should guard on
 * `inf.supported`).
 */
export function buildHfManifest(
  inf: HfModelInference,
  opts: HfDeployOptions = {},
): import("./capabilities").Manifest | null {
  if (!inf.supported || !inf.handler || !inf.signature) return null
  const name = (opts.nameOverride?.trim() || hfOperatorName(inf)).replace(
    /[^a-z0-9_]/g,
    "_",
  )
  const sig = inf.signature
  const env: Record<string, string> = {}
  if (inf.sequenceMode) env.RVBBIT_SEQUENCE_MODE = inf.sequenceMode

  const inputs: Record<string, string> = {}
  for (const arg of sig.argNames) inputs[arg] = `{{ inputs.${arg} }}`

  const sampleRow: Record<string, string> = {}
  for (const arg of sig.argNames) sampleRow[arg] = SAMPLE_ARG[arg] ?? "sample"
  const callArgs = sig.argNames
    .map((arg) => `'${(SAMPLE_ARG[arg] ?? "sample").replace(/'/g, "''")}'`)
    .join(", ")

  return {
    api_version: "rvbbit.capability/v1",
    kind: "hf_backend",
    name,
    title: inf.id,
    description: `${inf.task} model ${inf.id}, deployed via the generic Hugging Face backend.`,
    license: null,
    tags: [...TAG_FOR[inf.handler], "huggingface"],
    source: {
      provider: "huggingface",
      model: inf.id,
      url: `https://huggingface.co/${inf.id}`,
    },
    runtime: {
      template: "hf-rvbbit-fastapi",
      handler: inf.handler,
      device: opts.device ?? "auto",
      ...(Object.keys(env).length ? { env } : {}),
    },
    backend: {
      name,
      transport: "rvbbit",
      batch_size: opts.batchSize ?? 32,
      max_concurrent: opts.maxConcurrent ?? 4,
      timeout_ms: opts.timeoutMs ?? 120000,
      description: `${inf.id} (${inf.task}).`,
    },
    operators: [
      {
        name,
        description: `${inf.task} via ${inf.id}.`,
        arg_names: sig.argNames,
        arg_types: sig.argTypes,
        return_type: sig.returnType,
        parser: sig.parser,
        inputs,
      },
    ],
    smoke: {
      inputs: [sampleRow],
      sql: [`SELECT rvbbit.${name}(${callArgs});`],
    },
  }
}

// ── Hub browse (public, keyless) ────────────────────────────────────

export interface HfSearchHit {
  id: string
  pipelineTag: string | null
  downloads: number
  likes: number
  library: string | null
  gated: boolean | string
}

/** A browsable task: a friendly label + the HF pipeline tags it maps to. */
export interface HfBrowseTask {
  key: HfHandler
  label: string
  pipelineTags: string[]
}

/** The safe-to-serve tasks, mapped to the Hub pipeline tags we query. */
export const HF_BROWSE_TASKS: HfBrowseTask[] = [
  { key: "embedding", label: "Embedding", pipelineTags: ["feature-extraction", "sentence-similarity"] },
  { key: "sequence_classification", label: "Classify / Rerank", pipelineTags: ["text-classification"] },
  { key: "zero_shot_classification", label: "Zero-shot", pipelineTags: ["zero-shot-classification"] },
  { key: "token_classification", label: "NER / Token", pipelineTags: ["token-classification"] },
  { key: "question_answering", label: "Extractive QA", pipelineTags: ["question-answering"] },
  { key: "summarization", label: "Summarize", pipelineTags: ["summarization"] },
  { key: "table_question_answering", label: "Table QA", pipelineTags: ["table-question-answering"] },
]

export interface HfSearchParams {
  pipelineTags: string[]
  search?: string
  sort?: "downloads" | "likes"
  limit?: number
}

/** Browser helper: list Hub models for the given task tags. */
export async function searchHfModels(
  params: HfSearchParams,
): Promise<HfSearchHit[] | { error: string }> {
  const p = new URLSearchParams()
  p.set("pipeline_tag", params.pipelineTags.join(","))
  if (params.search) p.set("search", params.search)
  if (params.sort) p.set("sort", params.sort)
  if (params.limit) p.set("limit", String(params.limit))
  let res: Response
  try {
    res = await fetch(`/api/rvbbit/capabilities/hf-search?${p.toString()}`)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  const body = (await res.json().catch(() => null)) as
    | { ok: true; hits: HfSearchHit[] }
    | { ok: false; error: string }
    | null
  if (!body) return { error: `hf-search returned no body (${res.status})` }
  if (!body.ok) return { error: body.error }
  return body.hits
}

/** Browser helper: proxy-fetch the Hub metadata, then infer. */
export async function fetchHfModel(
  id: string,
): Promise<HfModelInference | { error: string }> {
  const trimmed = id.trim()
  if (!trimmed) {
    return { error: "Enter a Hugging Face model id (e.g. BAAI/bge-small-en-v1.5)." }
  }
  let res: Response
  try {
    res = await fetch(`/api/rvbbit/capabilities/hf-inspect?id=${encodeURIComponent(trimmed)}`)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  const body = (await res.json().catch(() => null)) as
    | { ok: true; meta: HfRawMeta }
    | { ok: false; error: string }
    | null
  if (!body) return { error: `hf-inspect returned no body (${res.status})` }
  if (!body.ok) return { error: body.error }
  return inferHfModel(body.meta)
}
