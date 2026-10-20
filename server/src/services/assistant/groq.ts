import { config } from '../../config.js';
import { AppError } from '../../lib.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const aiConfigured = () => !!config.groqApiKey;

export async function groqChat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatMessage> {
  if (!aiConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'The AI assistant is not set up yet (missing GROQ_API_KEY on the server).');
  }
  const body = JSON.stringify({
    model: config.groqModel,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.1,
    max_tokens: 1500,
    // gpt-oss models "think" before answering; low effort saves tokens against the free per-minute limit.
    ...(config.groqModel.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
  });
  const send = () => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqApiKey}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  let res: Response;
  try {
    res = await send();
    // A short per-minute limit clears in seconds: wait it out once instead of failing the question.
    const wait = Number(res.headers.get('retry-after'));
    if (res.status === 429 && wait > 0 && wait <= config.groqRetryMaxWaitSec) {
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      res = await send();
    }
  } catch {
    throw new AppError(504, 'AI_UNREACHABLE', 'Could not reach the AI service. Please try again.');
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg: string = json?.error?.message ?? `status ${res.status}`;
    if (res.status === 401) throw new AppError(502, 'AI_AUTH', 'The Groq API key was rejected. Check GROQ_API_KEY.');
    if (res.status === 429) {
      const wait = res.headers.get('retry-after');
      throw new AppError(429, 'AI_BUSY', `The free AI limit was reached. Please try again${wait ? ` in about ${wait} seconds` : ' in a minute'}.`);
    }
    if (res.status === 413 || /too large|context|tokens/i.test(msg)) {
      throw new AppError(413, 'AI_TOO_LARGE', 'That question needs too much data for the free AI limits. Select fewer files or ask something narrower.');
    }
    // Groq reports malformed tool calls as 400 "tool_use_failed"; let the caller retry.
    if (res.status === 400 && /tool_use_failed|failed to call a function/i.test(`${json?.error?.code} ${msg}`)) {
      throw new AppError(422, 'AI_TOOL_FAILED', msg);
    }
    throw new AppError(502, 'AI_ERROR', `The AI service returned an error: ${msg}`);
  }
  const message = json?.choices?.[0]?.message;
  if (!message) throw new AppError(502, 'AI_ERROR', 'The AI service returned an empty response.');
  return message as ChatMessage;
}
