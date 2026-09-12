// DeepThink Eval Center — drift detection
// Three signals: input distribution (embedding centroid cosine distance),
// prompt template (normalized hash overlap), retrieval corpus (top-k overlap).

import crypto from 'node:crypto';
import { embedText, cosineSim, getEmbeddingConfig } from '../embedding.js';
import { logger } from '../logger.js';
import {
  listTestCases, upsertCaseEmbedding, getCaseEmbeddings, createDriftReport,
} from './eval-db.js';
import type { DatasetVersionRow } from './eval-types.js';

// Embed all active case inputs in a version and persist to eval_case_embedding.
async function embedVersionInputs(versionId: string): Promise<boolean> {
  if (!getEmbeddingConfig()) {
    logger.warn({ versionId }, 'drift: embedding not configured, skipping embedding-based drift');
    return false;
  }
  const cases = await listTestCases(versionId, { status: 'active' });
  for (const c of cases) {
    try {
      const emb = await embedText(c.input_text);
      if (emb && emb.length > 0) {
        await upsertCaseEmbedding(c.id, versionId, Array.from(emb), getEmbeddingConfig()!.model);
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message, caseId: c.id }, 'drift: embed case failed');
    }
  }
  return true;
}

function centroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  return sum.map(x => x / vectors.length);
}

function parsePgVector(text: string): number[] {
  // pgvector text format: [0.1,0.2,...]
  const m = text.match(/^\[([\d\s.,eE+-]+)\]$/);
  if (!m) return [];
  return m[1].split(',').map(s => parseFloat(s.trim())).filter(n => !Number.isNaN(n));
}

export async function detectDrift(currentVersion: DatasetVersionRow, baselineVersionId: string): Promise<{
  inputDistribution: any; promptTemplate: any; retrievalCorpus: any;
}> {
  // 1. Input distribution drift (embedding centroid cosine distance)
  let inputDrift: any = { drift_score: 0, is_drifted: false, detail: { reason: 'embedding unavailable' } };
  const embeddedOk = await embedVersionInputs(currentVersion.id);
  if (embeddedOk) {
    const cur = await getCaseEmbeddings(currentVersion.id);
    const base = await getCaseEmbeddings(baselineVersionId);
    if (cur.length > 0 && base.length > 0) {
      const curVecs = cur.map(e => parsePgVector(e.embedding)).filter(v => v.length > 0);
      const baseVecs = base.map(e => parsePgVector(e.embedding)).filter(v => v.length > 0);
      const c1 = centroid(curVecs); const c2 = centroid(baseVecs);
      if (c1 && c2 && c1.length === c2.length) {
        // cosine distance = 1 - cosineSim; drift_score = cosine distance (0=identical, 2=opposite)
        const a32 = Float32Array.from(c1); const b32 = Float32Array.from(c2);
        const sim = cosineSim(a32, b32);
        const dist = 1 - sim; // 0..2, normalize to 0..1 for drift_score
        const driftScore = Math.min(1, Math.max(0, dist));
        inputDrift = {
          drift_score: Math.round(driftScore * 1000) / 1000,
          is_drifted: driftScore > 0.3,
          detail: { cosine_similarity: sim, cosine_distance: dist, cur_cases: cur.length, base_cases: base.length },
        };
      } else {
        inputDrift = { drift_score: 0, is_drifted: false, detail: { reason: 'dimension mismatch or empty' } };
      }
    }
  }

  // 2. Prompt template drift (normalized input hash overlap)
  const curCases = await listTestCases(currentVersion.id, { status: 'active' });
  const baseCases = await listTestCases(baselineVersionId, { status: 'active' });
  const normHash = (s: string) => crypto.createHash('sha256')
    .update(s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)).digest('hex').slice(0, 16);
  const curHashes = new Set(curCases.map(c => normHash(c.input_text)));
  const baseHashes = new Set(baseCases.map(c => normHash(c.input_text)));
  const overlap = [...curHashes].filter(h => baseHashes.has(h)).length;
  const templateDriftScore = curHashes.size > 0 ? 1 - (overlap / curHashes.size) : 0;
  const promptTemplate = {
    drift_score: Math.round(templateDriftScore * 1000) / 1000,
    is_drifted: templateDriftScore > 0.3,
    detail: { baseline_templates: baseHashes.size, current_templates: curHashes.size, overlap, new_templates: curHashes.size - overlap },
  };

  // 3. Retrieval corpus drift (top-k overlap of context.retrieved_docs)
  const ctxDocs = (cases: any[]) => cases.flatMap(c => {
    const ctx = c.context ?? {};
    const docs = ctx.retrieved_docs ?? ctx.docs ?? [];
    return Array.isArray(docs) ? docs.map((d: any) => typeof d === 'string' ? d : (d?.id ?? d?.title ?? '')).filter(Boolean) : [];
  });
  const curDocs = ctxDocs(curCases); const baseDocs = ctxDocs(baseCases);
  const curSet = new Set(curDocs); const baseSet = new Set(baseDocs);
  const docOverlap = [...curSet].filter(d => baseSet.has(d)).length;
  const retrievalScore = curSet.size > 0 ? 1 - (docOverlap / curSet.size) : 0;
  const retrievalCorpus = {
    drift_score: Math.round(retrievalScore * 1000) / 1000,
    is_drifted: retrievalScore > 0.3,
    detail: { baseline_docs: baseSet.size, current_docs: curSet.size, overlap: docOverlap },
  };

  // Persist reports
  await createDriftReport({ datasetVersionId: currentVersion.id, reportType: 'input_distribution', driftScore: inputDrift.drift_score, detail: inputDrift.detail, baselineRef: baselineVersionId, isDrifted: inputDrift.is_drifted });
  await createDriftReport({ datasetVersionId: currentVersion.id, reportType: 'prompt_template', driftScore: promptTemplate.drift_score, detail: promptTemplate.detail, baselineRef: baselineVersionId, isDrifted: promptTemplate.is_drifted });
  await createDriftReport({ datasetVersionId: currentVersion.id, reportType: 'retrieval_corpus', driftScore: retrievalCorpus.drift_score, detail: retrievalCorpus.detail, baselineRef: baselineVersionId, isDrifted: retrievalCorpus.is_drifted });

  return { inputDistribution: inputDrift, promptTemplate, retrievalCorpus };
}
