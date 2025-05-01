/**
 * LLM Translator Service for Midscene Smart-Shopping Assistant
 * - Maintains conversation history for context
 * - Uses few-shot examples with clear delimiters
 */

import { Anthropic } from "@anthropic-ai/sdk";
import { useEnvConfig } from "../store";

export interface TranslatorResponse {
  goal: string;
  midscene_prompt: string;
  summary: string[];
}

// Enhanced examples covering different shopping contexts
const EXAMPLES: Array<{input: string; output: TranslatorResponse}> = [
  // Context: User starting fresh (assumed home page)
  {
    input: "搜索蓝牙耳机",
    output: {
      goal: "搜索蓝牙耳机",
      midscene_prompt: "type \"蓝牙耳机\" in search box, press Enter",
      summary: ["搜索蓝牙耳机", "查看搜索结果"]
    }
  },
  // Key example: User searches for milk, then specifies a brand
  {
    input: "买牛奶",
    output: {
      goal: "买牛奶",
      midscene_prompt: "type \"牛奶\" in search box, press Enter",
      summary: ["搜索牛奶", "查看结果"]
    }
  },
  // On search results page, selecting a brand
  {
    input: "Horizon",
    output: {
      goal: "选择Horizon品牌",
      midscene_prompt: "click \"Horizon\"",
      summary: ["选择Horizon品牌"]
    }
  },
  // Context: User on search results page
  {
    input: "点击第一个",
    output: {
      goal: "点击第一个",
      midscene_prompt: "click the first product",
      summary: ["点击第一个商品", "查看详情"]
    }
  },
  // Context: User on product page selecting options
  {
    input: "选择蓝色",
    output: {
      goal: "选择蓝色",
      midscene_prompt: "click \"蓝色\"",
      summary: ["选择蓝色款式"]
    }
  },
  // Context: User on product page selecting quantity
  {
    input: "数量改为3",
    output: {
      goal: "数量改为3",
      midscene_prompt: "click \"数量\", type \"3\", click \"确定\"",
      summary: ["设置购买数量", "改为3个"]
    }
  },
  // Context: User finally ready to add to cart (only after selecting options)
  {
    input: "加入购物车",
    output: {
      goal: "加入购物车",
      midscene_prompt: "click \"加入购物车\"",
      summary: ["加入购物车"]
    }
  }
];

const { ANTHROPIC_API_KEY } = useEnvConfig.getState().config;

const anthropic = new Anthropic({
  /** 🔒 Proxy this in prod instead of exposing the key */ 
  apiKey: ANTHROPIC_API_KEY ?? "",
});

// Store conversation history
const conversationHistory: Array<{role: 'user' | 'assistant', content: string}> = [];
const MAX_HISTORY_TURNS = 3; // Keep track of recent interactions

/**
 * Translates user goal with conversation context
 */
export async function translateUserGoal(
  userInput: string,
): Promise<TranslatorResponse> {
  const messages = buildMessages(userInput);

  const completion = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    messages: [
      { role: "user", content: `System: ${messages.system}` },
      ...messages.conversation
    ],
    temperature: 0.2,
    max_tokens: 1000
  });

  // Safety checks for response
  const content = completion.content[0].type === 'text' ? completion.content[0].text : '';
  if (!content) {
    throw new Error("Model returned empty response");
  }

  if (!content.startsWith("{")) {
    throw new Error("Model did not return valid JSON");
  }  

  const parsed = JSON.parse(content) as TranslatorResponse;
  const result = cleanResponse(parsed, userInput);
  
  // Store this interaction in history
  conversationHistory.push({ role: 'user', content: userInput });
  conversationHistory.push({ role: 'assistant', content: JSON.stringify(result) });
  
  // Trim history if it gets too long
  while (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
    conversationHistory.shift();
  }
  
  return result;
}

/**
 * Clear conversation history (e.g., when starting a new shopping session)
 */
export function clearConversationHistory(): void {
  conversationHistory.length = 0;
}

/* ---------- helpers ---------- */

function buildMessages(userInput: string) {
  // System message for Anthropic API
  const systemMessage = 
    "You are MidsceneTranslator. Convert Chinese shopping instructions to JSON with focused, single-step actions.\n\n" +
    "IMPORTANT RULES:\n" +
    "1. Provide ONLY ONE STEP at a time - do not chain multiple actions.\n" +
    "2. PAY ATTENTION TO CONTEXT - if user previously searched for a product, treat single words as selections from search results, not new searches.\n" +
    "3. If input starts with words like '搜索', '查找', or is a full request, search for it.\n" +
    "4. If input is a brand name, product name, or short phrase after a search, CLICK it instead of searching again.\n" +
    "5. Never automatically add 'add to cart' unless explicitly requested.\n" +
    "6. Make summary match exactly what the command will do - no more, no less.\n\n" +
    "7. ALWAYS respond with **only** a single JSON object with exactly the format {\"goal\": string, \"midscene_prompt\": string, \"summary\": string[]}. No explanations, no comments, just the JSON.\n\n" +
    "==== EXAMPLES (NOT ACTUAL CONVERSATION) ====\n";

  // Build conversation messages array for Anthropic API
  const conversationMsgs: Array<{role: 'user' | 'assistant', content: string}> = [];

  // Add few-shot examples
  for (const ex of EXAMPLES) {
    conversationMsgs.push({ role: 'user', content: ex.input });
    conversationMsgs.push({ role: 'assistant', content: JSON.stringify(ex.output) });
  }
  
  // Add conversation history if available
  if (conversationHistory.length > 0) {
    conversationMsgs.push(...conversationHistory);
  }
  
  // Add current request
  conversationMsgs.push({ role: 'user', content: userInput });
  
  return {
    system: systemMessage,
    conversation: conversationMsgs
  };
}

function cleanResponse(
  res: TranslatorResponse,
  original: string,
): TranslatorResponse {
  const summary = res.summary.map((s) => (s.length <= 14 ? s : s.slice(0, 14) + "..."));
  const prompt = res.midscene_prompt
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*then\s*/gi, ", ")
    .trim();
  return { goal: res.goal || original, midscene_prompt: prompt, summary };
}

/**
 * Regenerates a midscene_prompt based on user-edited summary steps
 */
export async function regeneratePlanFromSummary(
  editedSummary: string[],
  originalGoal: string,
  originalPrompt?: string // Pass the original prompt for context
): Promise<TranslatorResponse> {
  const systemPrompt = 
    "You are MidsceneTranslator, converting shopping instructions to precise browser automation commands.\n\n" +
    "The user has edited the summary steps of an automation plan. You need to generate a new midscene_prompt " +
    "that accomplishes exactly these edited steps.\n\n" +
    "Rules:\n" +
    "1. ONLY generate the midscene_prompt field - the summary is already finalized by the user\n" +
    "2. Each step in the summary must be reflected in your generated midscene_prompt\n" +
    "3. Your midscene_prompt must use valid browser commands like 'click', 'type', 'wait', etc.\n" +
    "4. Separate commands with commas\n" +
    "5. Keep focused on the edited steps - don't add extra actions\n\n" +
    "RESPOND WITH STRICTLY ONLY THIS JSON OBJECT FORMAT - {\"midscene_prompt\": \"your commands here\"}\n" +
    "Do not add ANY text before or after the JSON. No explanations, no comments, just pure JSON.";

  const userMessage = 
    `Original goal: ${originalGoal}\n` +
    `${originalPrompt ? `Original midscene_prompt: ${originalPrompt}\n` : ''}` +
    `User-edited summary steps: ${JSON.stringify(editedSummary)}\n\n` +
    `Create a new midscene_prompt that matches these edited steps exactly.`;

  try {
    const completion = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: `System: ${systemPrompt}` },
        { role: "user", content: userMessage }
      ],
      temperature: 0.2,
      max_tokens: 1000
    });

    // Get response content
    const content = completion.content[0].type === 'text' ? completion.content[0].text : '';
    if (!content || !content.startsWith("{")) {
      throw new Error("Model did not return valid JSON");
    }  

    // Parse just the midscene_prompt from the response
    const parsedResponse = JSON.parse(content);
    const newPrompt = parsedResponse.midscene_prompt;
    
    if (!newPrompt || typeof newPrompt !== 'string') {
      throw new Error("Missing or invalid midscene_prompt in response");
    }

    // Clean up the prompt similar to how we do in translateUserGoal
    const cleanedPrompt = newPrompt
      .replace(/\s*,\s*/g, ", ")
      .replace(/\s*then\s*/gi, ", ")
      .trim();

    // Return the new response with user-edited summary
    return {
      goal: originalGoal,
      midscene_prompt: cleanedPrompt,
      summary: editedSummary // Keep the user's edited summary as-is
    };
  } catch (error) {
    console.error("Error regenerating plan:", error);
    throw new Error(`Failed to regenerate plan: ${error instanceof Error ? error.message : String(error)}`);
  }
}