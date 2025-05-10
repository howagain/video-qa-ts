## openrouter.ts

Built a one-file OpenRouter client — figured I'd open-source it.

We deal with a lot of dynamic structured data, where different LLM calls have different priorities — sometimes speed, sometimes latency, sometimes cost.
After a year of using OpenRouter heavily in production, I ran into plenty of real-world issues — bad providers, unreliable fallbacks, weird edge cases — so I baked all of that into this.
We needed strong guarantees on output and simple, reliable handling around it.
Also worth mentioning: OpenAI (and by extension OpenRouter) have their own quirks when dealing with Zod-based structured outputs — plenty of edge cases there too.

The primary motivations:  
- Explicit structure enforcement (Zod + JSON Schema)  
- Fallback cleanly to JSON mode (180+ models)  
- Fine-tune per call — optimize for speed, latency, or price  
- Ignore bad providers (beyond account settings)  
- Add new models declaratively, no client changes needed

It handles:  
- Strict structured outputs (`zod-to-json-schema`)  
- Fallback to JSON if needed  
- Provider sorting and fallback models  
- Unified one-line abstraction (`makeLLMCall`)  
- Real error handling and dynamic model swapping

We run over 50k OpenRouter requests/day through this in production.  
Tried to make it stupid simple to read and extend - coming up with the best API abstractions I could.

---

**Usage:**

```
npm install zod zod-to-json-schema 
```

```typescript
// override routing to prioritize latency
const data = await makeLLMCall({
  systemPrompt: "Be fast.",
  userPrompt: "Summarize this article.",
  primaryModel: Models.GPT4o,
  routingOptions: { providerSort: 'latency' },
  schema: z.object({ summary: z.string() }).strict(),
});
```

// structured output with a Zod schema
```typescript
const result = await makeLLMCall({
  userPrompt: "Give me a list of top 3 startups.",
  primaryModel: Models.GeminiPro,
  schema: z.object({ startups: z.array(z.string()) }).strict(),
});
```
// raw JSON mode (no schema)
```typescript
const json = await makeLLMCall({
  userPrompt: "Return a JSON object with name and age fields.",
  primaryModel: Models.QwenQwq32B,
  forceJsonMode: true,
});
```
---

Shared as a gist — feel free to copy, modify, or distribute.  
Hope it's useful.

---
Gotchas:
* https://openrouter.ai/models?fmt=cards&supported_parameters=structured_outputs
* https://openrouter.ai/models?fmt=cards&supported_parameters=response_format
* This was a bitch. Only use strict objects, no `anyOf` at the root and `passthrough()` isn't supported - https://platform.openai.com/docs/guides/structured-outputs?api-mode=responses&example=structured-data#supported-schemas

```ts
/**
 * OpenRouter API configuration and client for LLM tasks
 */
import { z, ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const OPENROUTER_DEFAULT_HEADERS = {
  "HTTP-Referer": process.env.SITE_URL,
  "X-Title": process.env.SITE_NAME,
};

/**
 * Interface for storing detailed information about each supported LLM model.
 */
export interface ModelInfo {
  id: string; // OpenRouter model identifier
  supportsStructuredOutput: boolean; // Whether the model is verified to support structured output (json_schema)
  defaultRoutingOptions?: { // Nested object for default routing
    providerSort?: 'price' | 'throughput' | 'latency'; 
    providerOrder?: string[]; 
    ignoredProviders?: string[];
  };
}

/**
 * Optional routing preferences that can override the defaults set in ModelInfo.
 */
export interface RoutingOptions {
  providerSort?: 'price' | 'throughput' | 'latency'; 
  providerOrder?: string[];
  ignoredProviders?: string[];
}

/**
 * OpenRouter model identifiers that support structured outputs
 * All these models have been verified to support structured_outputs parameter
 */
export const Models: Record<string, ModelInfo> = {
  // OpenAI models
  GPT4o: {
    id: "openai/chatgpt-4o-latest",
    supportsStructuredOutput: true,
  },
  GPT4_1Mini: {
    id: "openai/gpt-4.1-mini",
    supportsStructuredOutput: true,
  },
  GPT4_1Nano: {
    id: "openai/gpt-4.1-nano",
    supportsStructuredOutput: true,
  },
  GPT35Turbo: {
    id: "openai/gpt-3.5-turbo-0125",
    supportsStructuredOutput: false,
  },
  O3Mini: {
    id: "openai/o3-mini",
    supportsStructuredOutput: true,
  },

  // Google models
  GeminiPro: {
    id: "google/gemini-pro-1.5",
    supportsStructuredOutput: true,
  },
  GeminiFlash: {
    id: "google/gemini-2.0-flash-001",
    supportsStructuredOutput: true,
  },

  // Anthropic models
  Claude: {
    id: "anthropic/claude-3.5-sonnet",
    supportsStructuredOutput: true,
  },
  
  // Deepseek models
  DeepseekR1: {
    id: "deepseek/deepseek-r1",
    supportsStructuredOutput: true,
    defaultRoutingOptions: { 
      providerSort: 'price',
      ignoredProviders: ['InferenceNet'],
    }
  },
  DeepseekV3: {
    id: "deepseek/deepseek-chat-v3-0324",
    supportsStructuredOutput: true,
    defaultRoutingOptions: { 
      providerSort: 'price',
      ignoredProviders: ['InferenceNet'],
    }
  },
  DeepseekR1DistillLlama70B: {
    id: "deepseek/deepseek-r1-distill-llama-70b",
    supportsStructuredOutput: true,
    defaultRoutingOptions: { 
      providerSort: 'price',
      ignoredProviders: ['InferenceNet'],
      // providerOrder: ['DeepInfra'], // DeepInfra is awesome but expensive
    }
  },
  DeepseekR1DistillQwen32B: {
    id: "deepseek/deepseek-r1-distill-qwen-32b",
    supportsStructuredOutput: false,
    defaultRoutingOptions: { 
      ignoredProviders: ['InferenceNet'],
    }
  },

  // Qwen models
  QwenQwq32B: {
    id: "qwen/qwq-32b",
    supportsStructuredOutput: true,
  },
};

/**
 * Builds the provider preferences and fallback model list for the OpenRouter request.
 * Allows overriding default model routing options.
 */
function _buildRoutingOptions(
  primaryModel: ModelInfo, 
  backupModels: ModelInfo[],
  overrideOptions?: RoutingOptions // Add optional override parameter
): {
  provider: Record<string, any>;
  models: string[];
} {
  // Build provider preferences object, always requiring parameter support for structured output
  const providerPrefs: Record<string, any> = {
    require_parameters: true, 
  };

  // Apply overrides first, then model defaults if no override exists
  const finalSort = overrideOptions?.providerSort ?? primaryModel.defaultRoutingOptions?.providerSort;
  const finalOrder = overrideOptions?.providerOrder ?? primaryModel.defaultRoutingOptions?.providerOrder;
  const finalIgnore = overrideOptions?.ignoredProviders ?? primaryModel.defaultRoutingOptions?.ignoredProviders;

  if (finalSort) {
    providerPrefs.sort = finalSort;
  }
  if (finalOrder && finalOrder.length > 0) {
    providerPrefs.order = finalOrder;
  }
  if (finalIgnore && finalIgnore.length > 0) {
    providerPrefs.ignore = finalIgnore;
  }

  // Prepare fallback model IDs (always an array, empty if no backups)
  const fallbackModelIds = (backupModels && backupModels.length > 0)
    ? backupModels.map(model => model.id)
    : [];

  return { provider: providerPrefs, models: fallbackModelIds };
}

/**
 * Helper function to make the actual API call to OpenRouter.
 * Handles fetch request, headers, basic response validation, and extracts content string.
 */
async function makeOpenrouterCall(requestBody: any): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set in environment variables");
  }

  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        ...OPENROUTER_DEFAULT_HEADERS,
      },
      body: JSON.stringify(requestBody),
    });

    // Handle successful response first
    if (response.ok) {
      const data = await response.json();

      // Check for valid content in the successful response
      if (!data.choices || data.choices.length === 0 || !data.choices[0].message?.content) {
        console.warn('OpenRouter Warning: Response OK but no content generated.', data);
        throw new Error('OpenRouter response was successful (200 OK) but contained no valid choices or content. This might be due to model warm-up, scaling, or content filtering. Consider retrying, adjusting prompts, or using a different model/provider.');
      }
      // Success: return the content string directly
      return data.choices[0].message.content;
    }

    // --- Error Handling for non-OK responses --- 
    // https://openrouter.ai/docs/api-reference/errors
    let errorCode: number | string = response.status;
    let errorMessage = response.statusText;
    let errorDetails: any = null; 

    try {
      const errorJson = await response.json();
      if (errorJson && errorJson.error) {
        errorCode = errorJson.error.code || errorCode;
        errorMessage = errorJson.error.message || errorMessage;
        errorDetails = { code: errorCode, message: errorMessage, metadata: errorJson.error.metadata };
        console.error('OpenRouter API Structured Error:', errorDetails);
      } else {
        errorDetails = errorJson;
        console.error(`OpenRouter API Error (${response.status}): Non-standard JSON response`, errorDetails);
      }
    } catch (jsonError) {
      try {
        errorDetails = await response.text();
      } catch (textError) {
        errorDetails = "<Could not read error body>";
      }
      console.error(`OpenRouter API Error (${response.status}): Raw text response`, errorDetails);
    }

    const finalErrorMessage = `OpenRouter API request failed (${errorCode}): ${errorMessage}`;
    // console.debug(`Openrouter request body that failed: ${JSON.stringify(requestBody, null, 2)}`); 
    throw new Error(finalErrorMessage);

  } catch (error) {
    // Catch fetch errors or errors thrown from response handling
    console.error('Error during _makeOpenrouterCall execution:', error);
    if (error instanceof Error) {
      throw error; // Re-throw the original error
    } else {
      throw new Error('An unknown error occurred during the OpenRouter API call process.');
    }
  }
}

/**
 * Makes an LLM call to OpenRouter using fetch, supporting structured outputs (JSON Schema)
 * and model fallbacks. Allows specifying provider sorting and ordering preferences.
 */
export async function _callInStructuredOutputMode<T extends ZodType>({
  systemPrompt,
  userPrompt,
  primaryModel,
  backupModels = [],
  schema,
  schemaName = "response",
  routingOptions,
}: {
  systemPrompt: string;
  userPrompt: string;
  primaryModel: ModelInfo;
  backupModels?: ModelInfo[];
  schema: T;
  schemaName?: string;
  routingOptions?: RoutingOptions;
}): Promise<z.infer<T>> {

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ];

  // Generate the JSON schema object using zod-to-json-schema default strategy
  // The default behavior should set additionalProperties: false for object schemas
  const finalJsonSchema = zodToJsonSchema(schema as any);

  // Get provider preferences and fallback models using the helper function
  const { provider: providerPrefs, models: fallbackModelIds } = _buildRoutingOptions(
    primaryModel, 
    backupModels,
    routingOptions
  );

  // OpenRouter request body
  const requestBody: any = {
    model: primaryModel.id,
    messages: messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true, // OpenRouter specific strict flag
        schema: finalJsonSchema, // Pass the generated (and potentially modified) JSON schema
      },
    },
    provider: providerPrefs, // Assign the provider object
    models: fallbackModelIds, // Include fallback models (will be empty array if none)
  };

  // Make the OpenRouter API call using the helper function
  try {
    // Receives the content string directly from the helper function
    const contentString = await makeOpenrouterCall(requestBody);

    let parsedContent: any;
    try {
      parsedContent = JSON.parse(contentString);
    } catch (parseError) {
      console.error('Failed to parse JSON content string from OpenRouter response:', contentString, parseError);
      throw new Error('Failed to parse structured output from LLM response.');
    }

    // Validate the parsed content against the original Zod schema
    const validationResult = schema.safeParse(parsedContent);
    if (!validationResult.success) {
      console.error('Zod validation failed for OpenRouter response:', validationResult.error.format());
      console.error(`Raw content: ${contentString} and parsed content: ${JSON.stringify(parsedContent, null, 2)}`);
      throw new Error(`LLM response failed Zod validation: ${validationResult.error.message}`);
    }
    return validationResult.data;

  } catch (error) {
    // The error from _makeOpenrouterCall is caught here
    console.error('Error processing OpenRouter response in makeStructuredLLMCall:', error);
    // Optional: Log the request body that led to the failure if needed for debugging
    // console.debug(`Openrouter request body that failed: ${JSON.stringify(requestBody, null, 2)}`); 
    if (error instanceof Error) {
      throw error; // Re-throw the original error
    } else {
      throw new Error('An unknown error occurred processing the LLM API response.');
    }
  }
}

/**
 * Makes an LLM call to OpenRouter requesting raw JSON output (using json_object mode).
 * This does not enforce a specific schema but ensures the output is valid JSON.
 */
export async function _callInJSONMode({
  systemPrompt,
  userPrompt,
  primaryModel,
  backupModels = [],
  routingOptions,
}: {
  systemPrompt?: string;
  userPrompt: string;
  primaryModel: ModelInfo;
  backupModels?: ModelInfo[];
  routingOptions?: RoutingOptions;
}): Promise<any> { // Return type is any as we don't validate against a specific schema
  
  // Standard system prompt for JSON mode
  const actualSystemPrompt = systemPrompt || "You are an AI assistant. Your task is to respond STRICTLY with valid JSON format. Do NOT include any explanations, introductory text, or markdown code fences (like ```json). Only output the raw JSON object.";

  const messages = [
    { role: "system" as const, content: actualSystemPrompt },
    { role: "user" as const, content: userPrompt },
  ];

  // Get provider preferences and fallback models
  const { provider: providerPrefs, models: fallbackModelIds } = _buildRoutingOptions(
    primaryModel, 
    backupModels,
    routingOptions
  );

  // Build the request body for JSON mode
  const requestBody: any = {
    model: primaryModel.id,
    messages: messages,
    response_format: { type: "json_object" }, // Use JSON mode
    provider: providerPrefs,
    models: fallbackModelIds,
  };

  try {
    // Get the raw string response from the helper
    const rawContentString = await makeOpenrouterCall(requestBody);

    // Clean the string to remove potential markdown fences
    const cleanedContent = rawContentString
      .replace(/^```json\n?/, '') // Remove starting ```json with optional newline
      .replace(/\n?```$/, '')    // Remove optional newline and ending ```
      .trim();

    try {
      // Attempt to parse the cleaned string
      const parsedJson = JSON.parse(cleanedContent);
      return parsedJson;
    } catch (parseError) {
      console.error('Failed to parse JSON content string from OpenRouter JSON mode response:', parseError);
      console.error('Cleaned Content that failed parsing:', cleanedContent);
      console.error('Raw Content received:', rawContentString);
      throw new Error('Failed to parse JSON output from LLM response even after cleaning.');
    }

  } catch (error) {
    // Catch errors from makeOpenrouterCall or the parsing block
    console.error('Error during makeJSONLLMCall:', error);
    // Log the request body that might have caused the failure (excluding potentially sensitive prompts if needed)
    // console.debug(`Openrouter request body that failed in makeJSONLLMCall: ${JSON.stringify({...requestBody, messages: '[MESSAGES OMITTED]'}, null, 2)}`);
    if (error instanceof Error) {
      throw error; // Re-throw the original error
    } else {
      throw new Error('An unknown error occurred during the JSON LLM API call.');
    }
  }
}

/**
 * Unified LLM call function that intelligently chooses between structured output
 * (if model supports it and schema is provided) and basic JSON mode.
 */
export async function makeLLMCall<T extends ZodType>({
  systemPrompt,
  userPrompt,
  primaryModel,
  backupModels = [],
  schema,
  schemaName = "response",
  forceJsonMode = false,
  routingOptions,
}: {
  systemPrompt?: string;
  userPrompt: string;
  primaryModel: ModelInfo;
  backupModels?: ModelInfo[];
  schema?: T;
  schemaName?: string;
  forceJsonMode?: boolean;
  routingOptions?: RoutingOptions;
}): Promise<any> { // Returns any due to potential fallback modes

  // Use structured output first
  if (primaryModel.supportsStructuredOutput && schema && !forceJsonMode) {
    console.log(`Using structured output mode for model: ${primaryModel.id}`);
    const actualSystemPrompt = systemPrompt || "You are a helpful AI assistant designed to output structured data according to the provided schema.";
    
    try {
      return await _callInStructuredOutputMode({
        systemPrompt: actualSystemPrompt, 
        userPrompt,
        primaryModel,
        backupModels,
        schema,
        schemaName,
        routingOptions,
      });
    } catch (error) {
      console.error(`Structured output call failed for model ${primaryModel.id}. Falling back to JSON mode. Error:`, error);

      // Swap the primary model with the first backup model for safer fallback
      if (backupModels && backupModels.length > 0) {
        primaryModel = backupModels[0];
        backupModels = backupModels.length > 1 ? backupModels.slice(1) : [];
        console.log(`Swapped primary model to ${primaryModel.id} for JSON mode fallback.`);
      }
    }
  }

  // Determine why JSON mode was forced and log the reason
  // (due to forceJsonMode, model support, or missing schema)
  if (forceJsonMode) {
    console.log(`forceJsonMode is true. Forcing JSON object mode for model: ${primaryModel.id}`);
  } else if (!primaryModel.supportsStructuredOutput) {
    console.warn(`Model ${primaryModel.id} does not support structured output. Falling back to JSON object mode.`);
  } else if (!schema) {
      console.warn(`Schema not provided. Falling back to JSON object mode for model: ${primaryModel.id}.`);
  }
  

  // Add schema as a hint if provided
  let promptForJsonMode = userPrompt;
  if (schema) {
    try {
      const jsonSchemaForHint = zodToJsonSchema(schema as any, {
        removeAdditionalStrategy: "strict",
      });
      promptForJsonMode += `\n\n--- JSON STRUCTURE HINT --- Please try to follow this structure:\n${JSON.stringify(jsonSchemaForHint, null, 2)}\n--- END JSON STRUCTURE HINT ---`;
      console.log(`Added schema hint to prompt for JSON object mode.`);
    } catch (schemaError) {
      console.error("Failed to generate JSON schema for hint, proceeding without hint:", schemaError); 
    }
  }

  // Call the JSON mode helper
  return _callInJSONMode({
    systemPrompt, 
    userPrompt: promptForJsonMode,
    primaryModel,
    backupModels,
    routingOptions,
  });
}
```