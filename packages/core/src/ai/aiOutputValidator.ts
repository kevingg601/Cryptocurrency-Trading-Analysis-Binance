import type { AIAnalysisResult, AIDirection, AIDataSnapshot } from './aiTypes.ts';

const FORBIDDEN_FIELDS = [
  'entryPrice', 'stopLoss', 'takeProfit', 'takeProfit1', 'takeProfit2',
  'quantity', 'positionSize', 'leverage', 'riskPct', 'maxPositions',
  'feeBps', 'slippageBps', 'latencyMs', 'suggestedPrice', 'overrideLevels'
];

export interface RawAIOutput {
  direction?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  bullishEvidence?: unknown;
  bearishEvidence?: unknown;
  risks?: unknown;
  [key: string]: unknown;
}

export function validateAIModelOutput(
  raw: unknown,
  snapshot: AIDataSnapshot,
  meta: {
    model: string;
    promptVersion: string;
    ruleVersion: string;
    now?: number;
  }
): AIAnalysisResult {
  if (!snapshot.essentialDataValid) throw new Error('AI snapshot essential data is incomplete');
  // Helper to extract JSON from string (handling markdown fences)
  const parseJsonString = (str: string): any => {
    const cleaned = str.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  };

  let parsed: any;
  if (typeof raw === 'string') {
    try {
      parsed = parseJsonString(raw);
    } catch (err) {
      throw new Error(`AI CLI returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw as RawAIOutput;
  } else {
    throw new Error('AI CLI returned non-object output');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI CLI returned non-object output');

  // Check if CLI returned an error envelope (e.g. { error: { message: ... } } or { error: string })
  if (parsed.error) {
    const errMsg = typeof parsed.error === 'object' && parsed.error !== null
      ? (parsed.error as any).message || JSON.stringify(parsed.error)
      : String(parsed.error);
    throw new Error(`AI CLI returned error: ${errMsg}`);
  }

  // Check if CLI wrapped model output inside a response/output/candidates/text field
  // e.g. Gemini CLI headless -o json: { "session_id": "...", "response": "{\n  \"direction\": \"LONG\", ...\n}" }
  const envelopeContent = parsed.response ?? parsed.output ?? parsed.text ?? (Array.isArray(parsed.candidates) ? (parsed.candidates[0] as any)?.content?.parts?.[0]?.text : undefined);
  if (envelopeContent !== undefined) {
    if (typeof envelopeContent === 'string') {
      try {
        parsed = parseJsonString(envelopeContent);
      } catch (err) {
        throw new Error(`AI CLI model envelope returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    } else if (typeof envelopeContent === 'object' && envelopeContent !== null) {
      parsed = envelopeContent as RawAIOutput;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI CLI returned non-object output');
  // Security guard: Ensure model output does NOT attempt to alter trading parameters or risk controls
  for (const forbidden of FORBIDDEN_FIELDS) {
    if (parsed[forbidden] !== undefined) {
      throw new Error(`AI model output attempted illegal parameter modification: ${forbidden}`);
    }
  }

  // Validate direction
  const rawDirection = parsed.direction;
  if (rawDirection !== 'LONG' && rawDirection !== 'SHORT' && rawDirection !== 'NEUTRAL') {
    throw new Error(`Invalid AI direction: "${parsed.direction}". Must be LONG, SHORT, or NEUTRAL.`);
  }
  const direction = rawDirection as AIDirection;

  const requiredFields = ['direction', 'confidence', 'reasoning', 'bullishEvidence', 'bearishEvidence', 'risks'];
  const unexpectedFields = Object.keys(parsed).filter(key => !requiredFields.includes(key));
  if (unexpectedFields.length) throw new Error(`AI output contains unexpected field: ${unexpectedFields[0]}`);
  const missingFields = requiredFields.filter(key => !Object.hasOwn(parsed, key));
  if (missingFields.length) throw new Error(`AI output missing required field: ${missingFields[0]}`);

  const confidence = parsed.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new Error('AI confidence must be a finite number from 0 to 100');
  }

  // Validate reasoning
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
    ? parsed.reasoning.trim()
    : undefined;
  if (!reasoning || reasoning.length > 2000) throw new Error('AI reasoning must contain 1 to 2000 characters');

  // Validate evidence arrays
  const toStringArray = (field: string, val: unknown): string[] => {
    if (!Array.isArray(val) || val.length > 20) throw new Error(`AI ${field} must be an array with at most 20 items`);
    if (!val.every(item => typeof item === 'string' && item.trim().length > 0 && item.trim().length <= 500)) {
      throw new Error(`AI ${field} items must contain 1 to 500 characters`);
    }
    return val.map(item => item.trim());
  };

  const bullishEvidence = toStringArray('bullishEvidence', parsed.bullishEvidence);
  const bearishEvidence = toStringArray('bearishEvidence', parsed.bearishEvidence);
  const risks = toStringArray('risks', parsed.risks);
  if (direction === 'LONG' && bullishEvidence.length === 0) throw new Error('LONG output requires bullish evidence');
  if (direction === 'SHORT' && bearishEvidence.length === 0) throw new Error('SHORT output requires bearish evidence');

  const generatedAt = meta.now ?? Date.now();
  // Plan requirement: "分析有效期為資料快照截止時間起二十分鐘。"
  const expiresAt = snapshot.validUntil;

  return {
    schemaVersion: 1,
    id: `analysis-${snapshot.marketType}-${snapshot.symbol}-${generatedAt}-${globalThis.crypto.randomUUID()}`,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    symbol: snapshot.symbol,
    marketType: snapshot.marketType,
    model: meta.model,
    promptVersion: meta.promptVersion,
    ruleVersion: meta.ruleVersion,
    generatedAt,
    expiresAt,
    direction,
    confidence,
    reasoning,
    bullishEvidence,
    bearishEvidence,
    risks,
    missingData: [...snapshot.missingData],
    degraded: snapshot.degraded,
  };
}
